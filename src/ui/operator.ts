import type { PmdDataLayer } from '../dal';
import type {
  Machine,
  PlanningOrder,
  ProductionRecord,
  RejectCategory,
  ShiftCode,
  StatusCode,
} from '../types';
import {
  SHIFTS,
  SLOTS_PER_SHIFT,
  buildShiftId,
  currentShift,
  currentSlotIndex,
  shiftBounds,
  slotClock,
} from '../core/shifts';
import { STATUSES, STATUS_MAP } from '../core/status';
import { toast } from './toast';
import { escapeHtml } from './modal';

// PMD Operator Production Sheet — Excel-style rebuild of modPMDOperator.bas.
// One machine + one shift + one job at a time. 16 half-hour slots horizontally;
// rows are: Machine Status / 5 named reject rows / Other (Drop Down) / Other #.

interface OpState {
  mc: string;
  viewDate: Date;
  shiftCode: ShiftCode;
  selJob: string;
  prod: ProductionRecord[];
  planning: PlanningOrder[];
  machines: Machine[];
  operators: string[];
  supervisors: string[];
  namedRej: RejectCategory[];
  otherRej: RejectCategory[];
  selOperator: string;
  selSupervisor: string;
  signedOff: boolean;
  zoom: number; // 1..4 — cell width multiplier
}

let S: OpState | null = null;
let dalRef: PmdDataLayer;
let nowTimer: ReturnType<typeof setInterval> | undefined;

const ZOOM_PX: Record<number, number> = { 1: 30, 2: 42, 3: 56, 4: 72 };

function sid(): string {
  return buildShiftId(S!.viewDate, S!.shiftCode);
}

function blankRecord(slot: number): ProductionRecord {
  const iso = new Date().toISOString();
  return {
    id: 0,
    machineCode: S!.mc,
    shiftId: sid(),
    jobNumber: S!.selJob,
    slotIndex: slot,
    statusCode: '',
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
    otherType: '',
    otherCount: 0,
    purgeKg: null,
    operator: S!.selOperator,
    supervisor: S!.selSupervisor,
    bdIssue: '',
    mangoTicket: '',
    handoverNote: '',
    locked: false,
    lockedBy: '',
    lockedAt: '',
    createdAt: iso,
    updatedAt: iso,
  };
}

function shiftOrders(): PlanningOrder[] {
  const b = shiftBounds(sid());
  if (!b) return [];
  return S!.planning
    .filter((o) => o.machineCode === S!.mc && o.released)
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

function selectedOrder(): PlanningOrder | undefined {
  return S!.planning.find((o) => o.jobNumber === S!.selJob);
}

function slotRec(slot: number): ProductionRecord | undefined {
  return S!.prod.find((r) => r.jobNumber === S!.selJob && r.slotIndex === slot);
}

function canonical(): ProductionRecord | undefined {
  return slotRec(0);
}

function parseRejects(r: ProductionRecord | undefined): Record<string, number> {
  if (!r || !r.rejects) return {};
  try {
    return JSON.parse(r.rejects) as Record<string, number>;
  } catch {
    return {};
  }
}

async function upsertSlot(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  const existing = S!.prod.find(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  const rec = existing ? { ...existing } : blankRecord(slot);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  try {
    await dalRef.upsertProductionRecord(rec);
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

async function reload(): Promise<void> {
  const id = sid();
  S!.prod = await dalRef.listProduction({ machineCode: S!.mc, shiftId: id });
  const orders = shiftOrders();
  const haveJob = (j: string): boolean =>
    orders.some((o) => o.jobNumber === j) ||
    S!.prod.some((r) => r.jobNumber === j);
  if (S!.selJob && !haveJob(S!.selJob)) S!.selJob = '';
  if (!S!.selJob && orders.length) S!.selJob = orders[0].jobNumber;
  const c = canonical();
  if (c) {
    if (!S!.selOperator) S!.selOperator = c.operator;
    if (!S!.selSupervisor) S!.selSupervisor = c.supervisor;
  }
  render();
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function selOpts(values: string[], selected: string, placeholder: string): string {
  return [`<option value="">— ${escapeHtml(placeholder)} —</option>`]
    .concat(
      values.map(
        (v) =>
          `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`,
      ),
    )
    .join('');
}

function buildHeader(): string {
  const cs = currentShift(new Date());
  const isLive = cs.shiftId === sid();
  return `<div class="op-title">
    <h2>PMD Operator Production Sheet</h2>
    <span class="op-shift-label">${escapeHtml(S!.shiftCode)} shift${
      isLive ? ' · live' : ''
    }</span>
    <button class="btn-load" data-loadjobs>Load Jobs</button>
    <button class="btn-save" data-saveclear>Save and Clear out</button>
  </div>`;
}

function buildMeta(): string {
  const dateIso = S!.viewDate.toISOString().slice(0, 10);
  const machineOpts = S!.machines
    .map(
      (m) =>
        `<option value="${escapeHtml(m.machineCode)}"${
          m.machineCode === S!.mc ? ' selected' : ''
        }>${escapeHtml(m.machineCode)}</option>`,
    )
    .join('');
  const orders = shiftOrders();
  const jobOpts = [`<option value="">—</option>`]
    .concat(
      orders.map(
        (o) =>
          `<option value="${escapeHtml(o.jobNumber)}"${
            o.jobNumber === S!.selJob ? ' selected' : ''
          }>${o.isDieChange ? '🔧 ' : ''}${escapeHtml(o.jobNumber)}</option>`,
      ),
    )
    .join('');
  const o = selectedOrder();
  const c = canonical();
  return `<div class="op-meta">
    <label>Date <input type="date" data-meta="date" value="${dateIso}"></label>
    <label>Machine <select data-meta="machine">${machineOpts}</select></label>
    <label>Job# <select data-meta="job">${jobOpts}</select></label>
    <label>Part <input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label>Operator <select data-meta="operator">${selOpts(
      S!.operators,
      S!.selOperator,
      'operator',
    )}</select></label>
    <label>Purge(kg) <input type="number" step="0.1" data-meta="purge" value="${
      c?.purgeKg ?? ''
    }"></label>
    <label class="op-signoff">Supervisor Sign-off
      <select data-meta="supervisor">${selOpts(
        S!.supervisors,
        S!.selSupervisor,
        'supervisor',
      )}</select>
      <span class="signoff-check">
        <input type="checkbox" data-meta="signoff"${S!.signedOff ? ' checked' : ''}>
        <span>Check by ${escapeHtml(S!.selSupervisor || '—')}</span>
      </span>
    </label>
  </div>`;
}

function buildNav(): string {
  const tabs = SHIFTS.map(
    (s) =>
      `<button class="shift-btn${s.code === S!.shiftCode ? ' a' : ''}" data-shift="${s.code}">${escapeHtml(
        s.label,
      )}</button>`,
  ).join('');
  return `<div class="op-nav">
    <button class="dnav-btn" data-day="-1">◀</button>
    <span class="cur-date">${fmtDate(S!.viewDate)}</span>
    <button class="dnav-btn" data-day="1">▶</button>
    <button class="today-btn" data-today>Now</button>
    <div class="shift-tabs">${tabs}</div>
    <div class="zoom">
      <button data-zoom="-1" ${S!.zoom <= 1 ? 'disabled' : ''}>−</button>
      <span>${S!.zoom}×</span>
      <button data-zoom="1" ${S!.zoom >= 4 ? 'disabled' : ''}>+</button>
    </div>
  </div>`;
}

function statusCellHtml(slot: number, code: StatusCode | ''): string {
  const opts = [`<option value="">·</option>`]
    .concat(
      STATUSES.map(
        (s) =>
          `<option value="${s.code}"${s.code === code ? ' selected' : ''}>${s.code}</option>`,
      ),
    )
    .join('');
  const def = code ? STATUS_MAP[code] : undefined;
  const style = def
    ? `background:${def.color};color:${def.text};border-color:${def.border}`
    : '';
  return `<td class="status-cell"><select class="slot-status" style="${style}" data-slot="${slot}" data-row="status">${opts}</select></td>`;
}

function buildGrid(): string {
  const headers = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const lbl = slotClock(sid(), i).replace('–', '-');
    return `<th class="slot-head">${escapeHtml(lbl)}</th>`;
  }).join('');

  const recs = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => slotRec(i));

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs.map((r, i) => statusCellHtml(i, r?.statusCode ?? '')).join('') +
    `</tr>`;

  const namedRows = S!.namedRej
    .map((cat) => {
      const cells = recs
        .map((r, i) => {
          const v = parseRejects(r)[cat.code] ?? 0;
          return `<td class="num-cell"><input type="number" min="0" step="1" class="rej-input" data-row="named" data-code="${escapeHtml(
            cat.code,
          )}" data-slot="${i}" value="${v || ''}"></td>`;
        })
        .join('');
      return `<tr class="row-named"><th class="rh">${escapeHtml(cat.code)} ${escapeHtml(
        cat.label,
      )}</th>${cells}</tr>`;
    })
    .join('');

  const otherTypeRow =
    `<tr class="row-other-type"><th class="rh">Other (Drop Down)</th>` +
    recs
      .map((r, i) => {
        const v = r?.otherType ?? '';
        const opts =
          `<option value=""${v === '' ? ' selected' : ''}>·</option>` +
          S!.otherRej
            .map(
              (c) =>
                `<option value="${escapeHtml(c.code)}"${
                  c.code === v ? ' selected' : ''
                }>${escapeHtml(c.label)}</option>`,
            )
            .join('');
        return `<td><select class="other-type-sel" data-row="othertype" data-slot="${i}">${opts}</select></td>`;
      })
      .join('') +
    `</tr>`;

  const otherCountRow =
    `<tr class="row-other-count"><th class="rh">Other #</th>` +
    recs
      .map((r, i) => {
        const v = r?.otherCount ?? 0;
        return `<td class="num-cell"><input type="number" min="0" step="1" class="rej-input" data-row="othercount" data-slot="${i}" value="${v || ''}"></td>`;
      })
      .join('') +
    `</tr>`;

  return `<div class="op-grid-wrap" style="--slot-w:${ZOOM_PX[S!.zoom]}px">
    <table class="op-grid">
      <thead>
        <tr><th class="rh corner">Timeline</th>${headers}</tr>
      </thead>
      <tbody>
        ${statusRow}
        ${namedRows}
        ${otherTypeRow}
        ${otherCountRow}
      </tbody>
    </table>
  </div>`;
}

function buildSide(): string {
  const c = canonical();
  const cs = c?.countStart ?? '';
  const ce = c?.countEnd ?? '';
  const cn = Number(c?.countEnd ?? 0) - Number(c?.countStart ?? 0);
  let totalRej = 0;
  let totalOther = 0;
  for (const r of S!.prod.filter((x) => x.jobNumber === S!.selJob)) {
    const obj = parseRejects(r);
    totalRej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    totalOther += Number(r.otherCount) || 0;
  }
  const totalReject = totalRej;
  const good = Math.max(0, cn - totalReject);
  const o = selectedOrder();
  const jobLeft =
    o && !o.isDieChange ? Math.max(0, o.jobRequired - good) : '—';
  const comments = c?.handoverNote ?? '';
  return `<aside class="op-side">
    <div class="sk"><label>Job left</label><b>${jobLeft}</b></div>
    <div class="sk"><label>Total Reject</label><b class="r">${totalReject}</b></div>
    <div class="sk other-line"><span>(Other # logged: <b>${totalOther}</b> — mapped into reject codes on save)</span></div>
    <div class="sk"><label>Count Start</label><input type="number" data-meta="cstart" value="${cs}"></div>
    <div class="sk"><label>Count End</label><input type="number" data-meta="cend" value="${ce}"></div>
    <div class="sk"><label>Total Good</label><b class="g">${good}</b></div>
    <div class="sk col"><label>Comments</label><textarea data-meta="comments" placeholder="Handover / notes…">${escapeHtml(comments)}</textarea></div>
  </aside>`;
}

function buildLegend(): string {
  return `<div class="op-legend">${STATUSES.map(
    (s) =>
      `<span><i style="background:${s.color};border-color:${s.border}"></i>${s.code}: ${escapeHtml(s.label)}</span>`,
  ).join('')}</div>`;
}

function render(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="op-sheet">
    ${buildHeader()}
    ${buildMeta()}
    ${buildNav()}
    <div class="op-grid-row">
      ${buildGrid()}
      ${buildSide()}
    </div>
    ${buildLegend()}
  </div>`;
  wire();
  renderNowLine();
}

function renderNowLine(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;
  const old = wrap.querySelector('.now-line');
  if (old) old.remove();
  const cs = currentShift(new Date());
  if (cs.shiftId !== sid()) return;
  const idx = currentSlotIndex(sid(), new Date());
  if (idx == null) return;
  const b = shiftBounds(sid())!;
  const frac = (Date.now() - b.start.getTime()) / (b.end.getTime() - b.start.getTime());
  const headFirst = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:first-of-type');
  const headLast = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:last-of-type');
  if (!headFirst || !headLast) return;
  const wRect = wrap.getBoundingClientRect();
  const startX = headFirst.getBoundingClientRect().left - wRect.left;
  const endX = headLast.getBoundingClientRect().right - wRect.left;
  const x = startX + Math.max(0, Math.min(1, frac)) * (endX - startX);
  const line = document.createElement('div');
  line.className = 'now-line';
  line.style.left = `${x}px`;
  line.title = `Now: ${new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
  wrap.appendChild(line);
}

function wire(): void {
  const app = document.getElementById('app')!;

  // Date navigation
  app.querySelectorAll<HTMLButtonElement>('[data-day]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.viewDate = new Date(S!.viewDate);
      S!.viewDate.setDate(S!.viewDate.getDate() + Number(b.dataset.day));
      S!.selJob = '';
      void reload();
    }),
  );
  app.querySelector('[data-today]')?.addEventListener('click', () => {
    const cs = currentShift(new Date());
    S!.viewDate = new Date();
    S!.viewDate.setHours(0, 0, 0, 0);
    S!.shiftCode = cs.code;
    S!.selJob = '';
    void reload();
  });

  // Shift tabs
  app.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.shiftCode = b.dataset.shift as ShiftCode;
      S!.selJob = '';
      void reload();
    }),
  );

  // Zoom
  app.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const dz = Number(b.dataset.zoom);
      S!.zoom = Math.max(1, Math.min(4, S!.zoom + dz));
      render();
    }),
  );

  // Meta fields
  app.querySelectorAll<HTMLElement>('[data-meta]').forEach((el) => {
    const ev = el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox' ? 'change' : 'change';
    el.addEventListener(ev, () => onMetaChange(el));
  });
  app
    .querySelector<HTMLTextAreaElement>('textarea[data-meta="comments"]')
    ?.addEventListener('blur', (e) => onMetaChange(e.target as HTMLElement));

  // Status cells
  app.querySelectorAll<HTMLSelectElement>('.slot-status').forEach((sel) =>
    sel.addEventListener('change', () => {
      const slot = Number(sel.dataset.slot);
      const code = sel.value as StatusCode | '';
      void upsertSlot(slot, (r) => {
        r.statusCode = code;
      });
    }),
  );

  // Named reject inputs
  app.querySelectorAll<HTMLInputElement>('input[data-row="named"]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const slot = Number(inp.dataset.slot);
      const code = inp.dataset.code!;
      const qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      void upsertSlot(slot, (r) => {
        const obj = parseRejects(r);
        if (qty > 0) obj[code] = qty;
        else delete obj[code];
        r.rejects = JSON.stringify(obj);
      });
    }),
  );

  // Other type dropdown
  app
    .querySelectorAll<HTMLSelectElement>('select[data-row="othertype"]')
    .forEach((sel) =>
      sel.addEventListener('change', () => {
        const slot = Number(sel.dataset.slot);
        const newType = sel.value;
        void upsertSlot(slot, (r) => {
          // Move any existing other-count under the new code key.
          const obj = parseRejects(r);
          if (r.otherType && r.otherType !== newType) {
            const moved = obj[r.otherType];
            if (moved) {
              delete obj[r.otherType];
              if (newType) obj[newType] = (obj[newType] || 0) + moved;
            }
          }
          r.otherType = newType;
          if (newType && r.otherCount > 0) obj[newType] = r.otherCount;
          r.rejects = JSON.stringify(obj);
        });
      }),
    );

  // Other count input
  app.querySelectorAll<HTMLInputElement>('input[data-row="othercount"]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const slot = Number(inp.dataset.slot);
      const qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      void upsertSlot(slot, (r) => {
        r.otherCount = qty;
        const obj = parseRejects(r);
        if (r.otherType) {
          if (qty > 0) obj[r.otherType] = qty;
          else delete obj[r.otherType];
          r.rejects = JSON.stringify(obj);
        }
      });
    }),
  );

  // Buttons
  app.querySelector('[data-loadjobs]')?.addEventListener('click', () => void loadJobs());
  app.querySelector('[data-saveclear]')?.addEventListener('click', () => void saveAndClear());
}

function onMetaChange(el: HTMLElement): void {
  const key = el.dataset.meta;
  const isCheckbox =
    el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox';
  const target = el as HTMLInputElement; // also works for select/textarea (.value)
  const val = isCheckbox ? String(target.checked) : target.value;
  switch (key) {
    case 'date': {
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        d.setHours(0, 0, 0, 0);
        S!.viewDate = d;
        S!.selJob = '';
        void reload();
      }
      break;
    }
    case 'machine':
      S!.mc = val;
      S!.selJob = '';
      void reload();
      break;
    case 'job':
      S!.selJob = val;
      render();
      break;
    case 'operator':
      S!.selOperator = val;
      void upsertSlot(0, (r) => {
        r.operator = val;
      });
      break;
    case 'supervisor':
      S!.selSupervisor = val;
      void upsertSlot(0, (r) => {
        r.supervisor = val;
      });
      break;
    case 'purge':
      void upsertSlot(0, (r) => {
        r.purgeKg = val === '' ? null : Number(val);
      });
      break;
    case 'signoff':
      S!.signedOff = target.checked;
      break;
    case 'cstart':
      void upsertSlot(0, (r) => {
        r.countStart = val === '' ? null : Number(val);
      });
      break;
    case 'cend':
      void upsertSlot(0, (r) => {
        r.countEnd = val === '' ? null : Number(val);
      });
      break;
    case 'comments':
      void upsertSlot(0, (r) => {
        r.handoverNote = val;
      });
      break;
  }
}

async function loadJobs(): Promise<void> {
  S!.planning = await dalRef.listPlanning({});
  toast(`Loaded ${shiftOrders().length} job(s) for this shift`, 'ok');
  render();
}

async function saveAndClear(): Promise<void> {
  // Mirrors btnSaveAndClear_Click in modPMDOperator.bas:
  //   1. require Supervisor sign-off
  //   2. validate count end >= count start
  //   3. persist (we already write-through, so this is a "commit" toast)
  //   4. clear the form ready for the next job
  if (!S!.selSupervisor) {
    toast('Missing Supervisor Signoff', 'err');
    return;
  }
  if (!S!.signedOff) {
    toast('Missing Supervisor Signoff (tick the checkbox)', 'err');
    return;
  }
  const c = canonical();
  const cs = Number(c?.countStart ?? 0);
  const ce = Number(c?.countEnd ?? 0);
  if (c?.countEnd != null && c?.countStart != null && ce < cs) {
    toast('Count End must be ≥ Count Start', 'err');
    return;
  }
  toast(`Saved ${S!.selJob || '(no job)'} to Master`, 'ok');
  S!.signedOff = false;
  S!.selJob = '';
  await reload();
}

export async function renderOperator(
  dal: PmdDataLayer,
  machineCode: string,
  now: Date = new Date(),
): Promise<void> {
  dalRef = dal;
  const [machines, planning, operators, supervisors, rcats] = await Promise.all([
    dal.listMachines(),
    dal.listPlanning({}),
    dal.listOperators(),
    dal.listSupervisors(),
    dal.listRejectCategories(),
  ]);
  const cs = currentShift(now);
  const vd = new Date(now);
  vd.setHours(0, 0, 0, 0);
  S = {
    mc: machineCode || machines[0]?.machineCode || '',
    viewDate: vd,
    shiftCode: cs.code,
    selJob: '',
    prod: [],
    planning,
    machines,
    operators: operators.map((o) => o.operatorName),
    supervisors: supervisors.map((s) => s.operatorName),
    namedRej: rcats.filter((r) => r.kind === 'named'),
    otherRej: rcats.filter((r) => r.kind === 'other'),
    selOperator: '',
    selSupervisor: '',
    signedOff: false,
    zoom: 2,
  };
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(renderNowLine, 30_000);
  await reload();
}

export function operatorPollTick(): void {
  if (S) renderNowLine();
}
