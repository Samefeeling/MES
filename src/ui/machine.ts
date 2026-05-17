import type { PmdDataLayer } from '../dal';
import type {
  BdCode,
  PlanningOrder,
  ProductionRecord,
  ShiftCode,
  StatusCode,
} from '../types';
import {
  SLOTS_PER_SHIFT,
  buildShiftId,
  currentShift,
  currentSlotIndex,
  shiftBounds,
  slotClock,
  slotLabel,
  SHIFTS,
} from '../core/shifts';
import {
  ABNORMAL_CODES,
  DIE_CHANGE_CODES,
  STATUSES,
  STATUS_MAP,
} from '../core/status';
import { isSlotInPlan } from '../core/planning';
import { detectConflicts, slotGuard } from '../core/conflicts';
import { canLock, isShiftLocked } from '../core/lock';
import { toast } from './toast';
import { openModal, closeModal, escapeHtml } from './modal';

interface MState {
  mc: string;
  viewDate: Date;
  shiftCode: ShiftCode;
  selJob: string | null;
  orders: PlanningOrder[];
  prod: ProductionRecord[];
  bdCodes: BdCode[];
  operators: string[];
  supervisors: string[];
  selOperator: string;
  selSupervisor: string;
}

let S: MState | null = null;
let dalRef: PmdDataLayer;

function shiftId(): string {
  return buildShiftId(S!.viewDate, S!.shiftCode);
}

function recAt(job: string, slot: number): ProductionRecord | undefined {
  return S!.prod.find(
    (r) => r.jobNumber === job && r.slotIndex === slot && r.statusCode !== '',
  );
}

function canonical(job: string): ProductionRecord | undefined {
  return S!.prod.find((r) => r.jobNumber === job && r.slotIndex === 0);
}

function blankRecord(job: string, slot: number): ProductionRecord {
  const nowIso = new Date().toISOString();
  return {
    id: 0,
    machineCode: S!.mc,
    shiftId: shiftId(),
    jobNumber: job,
    slotIndex: slot,
    statusCode: '',
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
    operator: S!.selOperator,
    supervisor: S!.selSupervisor,
    bdIssue: '',
    mangoTicket: '',
    handoverNote: '',
    locked: false,
    lockedBy: '',
    lockedAt: '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

async function reload(): Promise<void> {
  const sid = shiftId();
  S!.prod = await dalRef.listProduction({ machineCode: S!.mc, shiftId: sid });
  // Seed selected operator/supervisor from existing records.
  const withOp = S!.prod.find((r) => r.operator);
  const withSup = S!.prod.find((r) => r.supervisor);
  if (withOp && !S!.selOperator) S!.selOperator = withOp.operator;
  if (withSup && !S!.selSupervisor) S!.selSupervisor = withSup.supervisor;
  render();
}

function ordersForShift(): PlanningOrder[] {
  const b = shiftBounds(shiftId());
  if (!b) return [];
  return S!.orders
    .filter((o) => o.released)
    .filter((o) => {
      const ps = new Date(o.plannedStart).getTime();
      const pe = new Date(o.plannedEnd).getTime();
      return pe > b.start.getTime() && ps < b.end.getTime();
    })
    .sort(
      (a, b2) =>
        new Date(a.plannedStart).getTime() - new Date(b2.plannedStart).getTime(),
    );
}

function ganttRow(o: PlanningOrder, locked: boolean, conflicts: Set<number>): string {
  const sid = shiftId();
  const sel = S!.selJob === o.jobNumber ? ' selected' : '';
  const dc = o.isDieChange ? ' diechg' : '';
  const nextSlot = currentSlotIndex(sid, new Date());
  let cells = '';
  for (let i = 0; i < SLOTS_PER_SHIFT; i++) {
    const rec = recAt(o.jobNumber, i);
    const inPlan = isSlotInPlan(o, sid, i);
    const cls = ['sb'];
    if (!inPlan) cls.push('outplan');
    if (conflicts.has(i) && rec) cls.push('conflict');
    let inner = '<span class="sc" style="opacity:.3">·</span>';
    let style = '';
    if (rec) {
      const def = STATUS_MAP[rec.statusCode];
      style = `background:${def?.color ?? '#fff'};color:${def?.text ?? '#1e293b'}`;
      inner = `<span class="sc">${rec.statusCode}</span>`;
    } else if (
      !locked &&
      S!.selJob === o.jobNumber &&
      nextSlot === i &&
      inPlan
    ) {
      cls.push('next');
    }
    cells += `<button class="${cls.join(
      ' ',
    )}" style="${style}" data-job="${escapeHtml(o.jobNumber)}" data-slot="${i}">${inner}</button>`;
  }
  const meta = o.isDieChange
    ? '🔧 Die change'
    : `${escapeHtml(o.partNumber)} · ${o.jobRequired} pcs · ${o.duration}h`;
  return `<div class="gantt-row"><div class="gantt-bar${sel}${dc}" data-selectjob="${escapeHtml(
    o.jobNumber,
  )}">
    <div class="gb-head"><span class="gb-job">${
      o.isDieChange ? '🔧 ' : ''
    }${escapeHtml(o.jobNumber)}</span><span class="gb-meta">${meta}</span></div>
    <div class="gb-slots">${cells}</div>
  </div></div>`;
}

function impactBlock(): string {
  if (!S!.selJob) return '';
  const o = S!.orders.find((x) => x.jobNumber === S!.selJob);
  if (!o) return '';
  const recs = S!.prod.filter((r) => r.jobNumber === o.jobNumber && r.statusCode);
  const run = recs.filter((r) => r.statusCode === 'R').length * 0.5;
  const bd = recs.filter((r) => STATUS_MAP[r.statusCode]?.kind === 'downtime').length * 0.5;
  const other = recs.length * 0.5 - run - bd;
  const planH = o.duration;
  const verdict = run >= planH ? 'On track' : bd > 0 ? 'Behind' : 'Ahead';
  const cls = verdict === 'On track' || verdict === 'Ahead' ? 'ok' : 'warn';
  return `<div class="impact ${cls}"><b>${escapeHtml(
    o.jobNumber,
  )}</b>: Plan ${planH}h · Run ${run}h · BD ${bd}h · Other ${other.toFixed(
    1,
  )}h · ${verdict}</div>`;
}

function jobBlock(o: PlanningOrder, locked: boolean): string {
  const c = canonical(o.jobNumber);
  const cs = c?.countStart ?? '';
  const ce = c?.countEnd ?? '';
  let rejObj: Record<string, number> = {};
  try {
    rejObj = c?.rejects ? JSON.parse(c.rejects) : {};
  } catch {
    rejObj = {};
  }
  const rejRows = Object.entries(rejObj)
    .filter(([, v]) => v)
    .map(
      ([code, v]) =>
        `<div class="rej-row"><span class="rj-cat">${escapeHtml(code)}</span><span class="rj-qty">${v}</span>${
          locked ? '' : `<button data-rmrej="${escapeHtml(o.jobNumber)}" data-code="${escapeHtml(code)}">×</button>`
        }</div>`,
    )
    .join('');
  const totRej = Object.values(rejObj).reduce((a, v) => a + (v || 0), 0);
  const good =
    cs !== '' && ce !== '' ? Math.max(0, Number(ce) - Number(cs) - totRej) : 0;
  const dis = locked ? 'disabled' : '';

  if (o.isDieChange) {
    const tally = S!.prod.filter(
      (r) => r.jobNumber === o.jobNumber && r.statusCode,
    ).length * 0.5;
    return `<div class="job-block"><div class="jb-head"><span class="jb-job">🔧 ${escapeHtml(
      o.jobNumber,
    )}</span><span class="jb-meta">Die change · ${tally}h logged</span></div></div>`;
  }

  return `<div class="job-block">
    <div class="jb-head"><span class="jb-job">${escapeHtml(
      o.jobNumber,
    )}</span><span class="jb-meta">${escapeHtml(o.partNumber)} · req ${o.jobRequired}</span></div>
    <div class="jb-counts">
      <div class="jb-cell"><label>Count Start</label><input type="number" data-cnt="start" data-job="${escapeHtml(
        o.jobNumber,
      )}" value="${cs}" ${dis}></div>
      <div class="jb-cell"><label>Count End</label><input type="number" data-cnt="end" data-job="${escapeHtml(
        o.jobNumber,
      )}" value="${ce}" ${dis}></div>
      <div class="jb-cell"><label>Good (shift)</label><input type="text" value="${good}" disabled></div>
    </div>
    <div class="jb-good">Reject total this job: <b>${totRej}</b></div>
    ${
      locked
        ? ''
        : `<div class="rej-picker">
      <div class="rp-cat"><label>Reject category</label><select data-rejcat="${escapeHtml(
        o.jobNumber,
      )}"><option value="">— pick —</option>${rejectOptions()}</select></div>
      <div class="rp-qty"><label>Qty</label><input type="number" min="1" value="1" data-rejqty="${escapeHtml(
        o.jobNumber,
      )}"></div>
      <button data-addrej="${escapeHtml(o.jobNumber)}">Add</button>
    </div>`
    }
    ${rejRows}
  </div>`;
}

let rejectCats: { code: string; label: string }[] = [];
function rejectOptions(): string {
  return rejectCats
    .map(
      (r) =>
        `<option value="${escapeHtml(r.code)}">${escapeHtml(r.code)} — ${escapeHtml(
          r.label,
        )}</option>`,
    )
    .join('');
}

function render(): void {
  const app = document.getElementById('app')!;
  const sid = shiftId();
  const locked = isShiftLocked(S!.prod);
  const orders = ordersForShift();
  if (S!.selJob && !orders.some((o) => o.jobNumber === S!.selJob)) S!.selJob = null;
  if (!S!.selJob && orders.length) S!.selJob = orders[0].jobNumber;

  const conflicts = detectConflicts(S!.prod);
  const conflictSlots = new Set(conflicts.map((c) => c.slotIndex));

  const tabs = SHIFTS.map(
    (s) =>
      `<button class="${s.code === S!.shiftCode ? 'a' : ''}" data-shift="${s.code}">${s.label}</button>`,
  ).join('');

  const lockBan = locked
    ? `<div class="lockban">🔒 Shift confirmed by ${escapeHtml(
        S!.prod.find((r) => r.lockedBy)?.lockedBy ?? 'supervisor',
      )} — entries are locked</div>`
    : '';

  const confBan = conflicts.length
    ? `<div class="confban">⚠ ${conflicts.length} conflicted slot(s): ${conflicts
        .map((c) => `${slotClock(sid, c.slotIndex)} (${c.jobNumbers.join(' vs ')})`)
        .join('; ')}</div>`
    : '';

  const gantt = orders.length
    ? `<div class="gantt">${orders
        .map((o) => ganttRow(o, locked, conflictSlots))
        .join('')}</div>
       <div class="ta">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) =>
         i % 2 === 0 ? `<span>${slotClock(sid, i).slice(0, 5)}</span>` : '<span></span>',
       ).join('')}</div>`
    : `<div class="muted">No orders released for this shift. Contact planning.</div>`;

  const legend = `<div class="leg">${STATUSES.map(
    (s) =>
      `<span><i style="background:${s.color};border-color:${s.border}"></i>${s.code} ${s.label}</span>`,
  ).join('')}</div>`;

  const opOpts = ['', ...S!.operators]
    .map(
      (o) =>
        `<option value="${escapeHtml(o)}"${
          o === S!.selOperator ? ' selected' : ''
        }>${o ? escapeHtml(o) : '— operator —'}</option>`,
    )
    .join('');
  const supOpts = ['', ...S!.supervisors]
    .map(
      (o) =>
        `<option value="${escapeHtml(o)}"${
          o === S!.selSupervisor ? ' selected' : ''
        }>${o ? escapeHtml(o) : '— supervisor —'}</option>`,
    )
    .join('');

  const handover = canonical(S!.selJob ?? '')?.handoverNote ?? '';
  const lockCheck = canLock(S!.prod, S!.selSupervisor);

  app.innerHTML = `
    <div class="dnav">
      <button data-day="-1">◀</button>
      <span class="cur">${S!.viewDate.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })}</span>
      <button data-day="1">▶</button>
      <button class="today-btn" data-today>Now</button>
    </div>
    <div class="sec">
      <div class="stabs">${tabs}</div>
      ${lockBan}
      ${gantt}
      ${confBan}
      ${impactBlock()}
      ${legend}
    </div>
    <div class="sec">
      <div class="stl">Shift totals & sign-off</div>
      <div class="foot-row">
        <div><label>Operator</label><select data-self="op" ${
          locked ? 'disabled' : ''
        }>${opOpts}</select></div>
        <div><label>Supervisor sign-off</label><select data-self="sup" ${
          locked ? 'disabled' : ''
        }>${supOpts}</select></div>
      </div>
      ${orders.map((o) => jobBlock(o, locked)).join('')}
      <label class="kl">Shift handover note</label>
      <textarea class="handover" data-handover ${
        locked ? 'disabled' : ''
      } placeholder="Handover note for next shift…">${escapeHtml(handover)}</textarea>
      <button class="btn-primary" data-savehandover ${
        locked ? 'disabled' : ''
      } style="margin-top:6px">Save handover</button>
      ${
        locked
          ? `<button class="btn-ghost" data-unlock style="width:100%;margin-top:8px">🔓 Unlock shift</button>`
          : `<button class="btn-lock" data-lock ${
              lockCheck.ok ? '' : 'disabled'
            } title="${escapeHtml(lockCheck.reason ?? '')}">🔒 Confirm & Lock shift</button>`
      }
    </div>`;

  wire();
}

function wire(): void {
  const app = document.getElementById('app')!;
  app.querySelectorAll<HTMLElement>('[data-shift]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.shiftCode = b.dataset.shift as ShiftCode;
      void reload();
    }),
  );
  app.querySelectorAll<HTMLElement>('[data-day]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.viewDate.setDate(S!.viewDate.getDate() + Number(b.dataset.day));
      S!.viewDate = new Date(S!.viewDate);
      void reload();
    }),
  );
  app.querySelector('[data-today]')?.addEventListener('click', () => {
    const cs = currentShift(new Date());
    S!.viewDate = new Date();
    S!.viewDate.setHours(0, 0, 0, 0);
    S!.shiftCode = cs.code;
    void reload();
  });
  app.querySelectorAll<HTMLElement>('[data-selectjob]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sb')) return;
      S!.selJob = el.dataset.selectjob!;
      render();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('.sb').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onSlotTap(b.dataset.job!, Number(b.dataset.slot));
    }),
  );
  app.querySelector<HTMLSelectElement>('[data-self="op"]')?.addEventListener(
    'change',
    (e) => {
      S!.selOperator = (e.target as HTMLSelectElement).value;
    },
  );
  app.querySelector<HTMLSelectElement>('[data-self="sup"]')?.addEventListener(
    'change',
    (e) => {
      S!.selSupervisor = (e.target as HTMLSelectElement).value;
      render(); // re-evaluate lock gate
    },
  );
  app.querySelectorAll<HTMLInputElement>('[data-cnt]').forEach((inp) =>
    inp.addEventListener('change', () =>
      saveCount(inp.dataset.job!, inp.dataset.cnt as 'start' | 'end', inp.value),
    ),
  );
  app.querySelectorAll<HTMLElement>('[data-addrej]').forEach((btn) =>
    btn.addEventListener('click', () => addReject(btn.dataset.addrej!)),
  );
  app.querySelectorAll<HTMLElement>('[data-rmrej]').forEach((btn) =>
    btn.addEventListener('click', () =>
      removeReject(btn.dataset.rmrej!, btn.dataset.code!),
    ),
  );
  app.querySelector('[data-savehandover]')?.addEventListener('click', saveHandover);
  app.querySelector('[data-lock]')?.addEventListener('click', doLock);
  app.querySelector('[data-unlock]')?.addEventListener('click', doUnlock);
}

function lockedToast(): boolean {
  if (isShiftLocked(S!.prod)) {
    toast('Shift locked by supervisor — entries cannot be changed', 'warn');
    return true;
  }
  return false;
}

function onSlotTap(job: string, slot: number): void {
  S!.selJob = job;
  if (lockedToast()) return;
  const existing = recAt(job, slot);
  if (existing) {
    openEditModal(job, slot, existing);
    return;
  }
  // §5.4 real-time guard
  const blocker = slotGuard(S!.prod, slot, job);
  if (blocker) {
    toast(
      `Slot taken by ${blocker.jobNumber} (${blocker.statusCode}). Clear it first.`,
      'err',
    );
    return;
  }
  openSlotModal(job, slot);
}

function pillGrid(codes: StatusCode[], job: string, slot: number): string {
  return `<div class="ab-grid">${codes
    .map((c) => {
      const d = STATUS_MAP[c];
      return `<button class="ab-pill" style="background:${d.color};border-color:${d.border};color:${d.text}" data-pick="${c}" data-job="${escapeHtml(
        job,
      )}" data-slot="${slot}"><span class="ab-cd">${c}</span><span class="ab-lb">${escapeHtml(
        d.label,
      )}</span></button>`;
    })
    .join('')}</div>`;
}

function openSlotModal(job: string, slot: number): void {
  const o = S!.orders.find((x) => x.jobNumber === job);
  const isDC = !!o?.isDieChange;
  const sid = shiftId();
  const codes = isDC ? DIE_CHANGE_CODES : ABNORMAL_CODES;
  const head = isDC
    ? `<p class="sub">Die change in progress — pick the change type:</p>`
    : `<button class="bb cf full" data-confirmrun data-job="${escapeHtml(
        job,
      )}" data-slot="${slot}">✓ Confirm running</button><p class="ab-label">Or report abnormal:</p>`;
  const mc = openModal(`
    <h2>${escapeHtml(job)}</h2>
    <p class="sub">${slotLabel(sid, slot)}</p>
    ${head}
    ${pillGrid(codes, job, slot)}
    <div class="mdl-actions"><button class="btn-ghost" data-cancel>Cancel</button></div>
  `);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-confirmrun]')?.addEventListener('click', () =>
    void writeSlot(job, slot, 'R'),
  );
  mc.querySelectorAll<HTMLElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.dataset.pick as StatusCode;
      if (code === 'B') openBdModal(job, slot);
      else void writeSlot(job, slot, code);
    }),
  );
}

function openEditModal(job: string, slot: number, rec: ProductionRecord): void {
  const sid = shiftId();
  const mc = openModal(`
    <h2>${escapeHtml(job)}</h2>
    <p class="sub">${slotLabel(sid, slot)} · current: <b>${rec.statusCode}</b> ${escapeHtml(
      STATUS_MAP[rec.statusCode]?.label ?? '',
    )}</p>
    ${pillGrid(
      (S!.orders.find((x) => x.jobNumber === job)?.isDieChange
        ? DIE_CHANGE_CODES
        : ABNORMAL_CODES),
      job,
      slot,
    )}
    <div class="mdl-actions">
      <button class="btn-ghost" data-clear>Clear slot</button>
      <button class="btn-ghost" data-cancel>Close</button>
    </div>
  `);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-clear]')?.addEventListener('click', () =>
    void clearSlot(rec),
  );
  mc.querySelectorAll<HTMLElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.dataset.pick as StatusCode;
      if (code === 'B') openBdModal(job, slot);
      else void writeSlot(job, slot, code);
    }),
  );
}

function openBdModal(job: string, slot: number): void {
  // §8.3 — pre-fill from previous slot if it was also B (sticky).
  const prev = recAt(job, slot - 1);
  const sticky = prev?.statusCode === 'B' ? prev.bdIssue : '';
  const groups = new Map<string, BdCode[]>();
  for (const b of S!.bdCodes) {
    const g = b.subCategory ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(b);
  }
  const opts = [...groups.entries()]
    .map(
      ([g, list]) =>
        `<optgroup label="${escapeHtml(g)}">${list
          .map(
            (b) =>
              `<option value="${escapeHtml(b.code)}"${
                b.code === sticky ? ' selected' : ''
              }>${escapeHtml(b.code)} — ${escapeHtml(b.label)}</option>`,
          )
          .join('')}</optgroup>`,
    )
    .join('');
  const mc = openModal(`
    <h2>Report breakdown — Slot ${slot + 1}</h2>
    <label class="kl">BD failure mode</label>
    <select data-bd>${opts}</select>
    <label class="kl">Mango ticket (optional)</label>
    <input data-mango placeholder="MAN-…">
    <div class="mdl-actions">
      <button class="btn-ghost" data-cancel>Cancel</button>
      <button class="btn-primary" data-savebd>Save</button>
    </div>
  `);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-savebd]')?.addEventListener('click', () => {
    const bd = mc.querySelector<HTMLSelectElement>('[data-bd]')!.value;
    const mango = mc.querySelector<HTMLInputElement>('[data-mango]')!.value;
    void writeSlot(job, slot, 'B', bd, mango);
  });
}

async function writeSlot(
  job: string,
  slot: number,
  code: StatusCode,
  bd = '',
  mango = '',
): Promise<void> {
  const existing = S!.prod.find(
    (r) => r.jobNumber === job && r.slotIndex === slot,
  );
  const base = existing ?? blankRecord(job, slot);
  const rec: ProductionRecord = {
    ...base,
    statusCode: code,
    bdIssue: code === 'B' ? bd : '',
    mangoTicket: code === 'B' ? mango : '',
    operator: S!.selOperator || base.operator,
  };
  try {
    await dalRef.upsertProductionRecord(rec);
    closeModal();
    toast('Saved', 'ok');
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

async function clearSlot(rec: ProductionRecord): Promise<void> {
  try {
    if (rec.id > 0) await dalRef.deleteProductionRecord(rec.id);
    closeModal();
    toast('Slot cleared', 'ok');
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

async function persistCanonical(
  job: string,
  mutate: (r: ProductionRecord) => void,
): Promise<void> {
  const existing = canonical(job);
  const rec = existing ? { ...existing } : blankRecord(job, 0);
  mutate(rec);
  try {
    await dalRef.upsertProductionRecord(rec);
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

function saveCount(job: string, which: 'start' | 'end', value: string): void {
  if (lockedToast()) return;
  const n = value === '' ? null : Number(value);
  void persistCanonical(job, (r) => {
    if (which === 'start') r.countStart = n;
    else r.countEnd = n;
  });
}

function addReject(job: string): void {
  if (lockedToast()) return;
  const app = document.getElementById('app')!;
  const cat = app.querySelector<HTMLSelectElement>(`[data-rejcat="${cssEsc(job)}"]`)?.value;
  const qty = Number(
    app.querySelector<HTMLInputElement>(`[data-rejqty="${cssEsc(job)}"]`)?.value ?? '0',
  );
  if (!cat || qty <= 0) {
    toast('Pick a category and qty', 'warn');
    return;
  }
  void persistCanonical(job, (r) => {
    let obj: Record<string, number> = {};
    try {
      obj = r.rejects ? JSON.parse(r.rejects) : {};
    } catch {
      obj = {};
    }
    obj[cat] = (obj[cat] || 0) + qty;
    r.rejects = JSON.stringify(obj);
    r.rejectCount = Object.values(obj).reduce((a, v) => a + v, 0);
  });
}

function removeReject(job: string, code: string): void {
  if (lockedToast()) return;
  void persistCanonical(job, (r) => {
    let obj: Record<string, number> = {};
    try {
      obj = r.rejects ? JSON.parse(r.rejects) : {};
    } catch {
      obj = {};
    }
    delete obj[code];
    r.rejects = JSON.stringify(obj);
    r.rejectCount = Object.values(obj).reduce((a, v) => a + v, 0);
  });
}

function saveHandover(): void {
  if (lockedToast()) return;
  if (!S!.selJob) return;
  const ta = document.querySelector<HTMLTextAreaElement>('[data-handover]');
  const note = ta?.value ?? '';
  void persistCanonical(S!.selJob, (r) => {
    r.handoverNote = note;
  });
  toast('Handover saved', 'ok');
}

async function doLock(): Promise<void> {
  const chk = canLock(S!.prod, S!.selSupervisor);
  if (!chk.ok) {
    toast(chk.reason!, 'err');
    return;
  }
  if (
    !window.confirm(
      'Lock this shift? All blocks, counts, rejects, and notes will be FROZEN. Only a supervisor can unlock. Proceed?',
    )
  )
    return;
  await dalRef.lockShift(S!.mc, shiftId(), S!.selSupervisor, S!.selOperator);
  toast('Shift locked', 'ok');
  await reload();
}

async function doUnlock(): Promise<void> {
  if (!window.confirm('Unlock this shift? Entries will become editable again.'))
    return;
  await dalRef.unlockShift(S!.mc, shiftId());
  toast('Shift unlocked', 'ok');
  await reload();
}

function cssEsc(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

export async function renderMachine(
  dal: PmdDataLayer,
  machineCode: string,
  now: Date = new Date(),
): Promise<void> {
  dalRef = dal;
  const cs = currentShift(now);
  const [orders, bd, ops, sups, rcats] = await Promise.all([
    dal.listPlanning({ machineCode, released: true }),
    dal.listBdCodes(),
    dal.listOperators(),
    dal.listSupervisors(),
    dal.listRejectCategories(),
  ]);
  rejectCats = rcats.map((r) => ({ code: r.code, label: r.label }));
  const vd = new Date(now);
  vd.setHours(0, 0, 0, 0);
  S = {
    mc: machineCode,
    viewDate: vd,
    shiftCode: cs.code,
    selJob: null,
    orders,
    prod: [],
    bdCodes: bd,
    operators: ops.map((o) => o.operatorName),
    supervisors: sups.map((s) => s.operatorName),
    selOperator: '',
    selSupervisor: '',
  };
  await reload();
}

export function machinePollTick(): void {
  if (S) void reload();
}
