import type { PmdDataLayer } from '../dal';
import { canSyncPlanning } from '../dal';
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
import { bdLabelFor } from '../core/breakdown';
import { openBreakdownCascade } from './breakdown';
import { toast } from './toast';
import { closeModal, escapeHtml, openModal } from './modal';
import { renderOutputRejectChart } from './charts';

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
  /** 1 = single-shift detail (editable); 2 = today's 3 shifts;
   *  3 = past 7 days; 4 = past 30 days. Levels 2-4 are read-only summaries. */
  viewLevel: number;
  /** Sum of Good across all shifts of selJob — drives the cross-shift Job Left. */
  jobTotalGood: number;
  /** Multi-fill mode: tap/drag status cells to build a range, then pick one code. */
  multiSel: boolean;
  selSet: Set<number>;
}

let S: OpState | null = null;
let dalRef: PmdDataLayer;
let nowTimer: ReturnType<typeof setInterval> | undefined;

const SLOT_PX = 64; // touch target for the half-hour status cell on 10" iPad

const VIEW_LEVELS: Array<{ level: number; label: string }> = [
  { level: 1, label: 'Shift' },
  { level: 2, label: 'Today (3 shifts)' },
  { level: 3, label: 'Past 7 days' },
  { level: 4, label: 'Past 30 days' },
];

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
  await refreshJobTotal();
  render();
}

/**
 * Job Left = JobRequired − sum(Good) across ALL shifts of this job
 * (matches the .bas Master rollup: each shift contributes one row).
 */
async function refreshJobTotal(): Promise<void> {
  if (!S!.selJob) {
    S!.jobTotalGood = 0;
    return;
  }
  const all = await dalRef.listProduction({ jobNumber: S!.selJob });
  const seen = new Set<string>();
  let total = 0;
  for (const r of all) {
    if (r.slotIndex !== 0) continue;
    const key = `${r.machineCode}|${r.shiftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = Number(r.countStart ?? 0);
    const ce = Number(r.countEnd ?? 0);
    const gross = Math.max(0, ce - cs);
    let rej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      rej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      rej = Number(r.rejectCount) || 0;
    }
    total += Math.max(0, gross - rej);
  }
  S!.jobTotalGood = total;
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

function buildActionBar(): string {
  const dateIso = S!.viewDate.toISOString().slice(0, 10);
  const tabs = SHIFTS.map(
    (s) =>
      `<button class="shift-btn${s.code === S!.shiftCode ? ' a' : ''}" data-shift="${s.code}">${escapeHtml(
        s.label,
      )}</button>`,
  ).join('');
  return `<div class="op-actionbar">
    <div class="ab-date">
      <button class="dnav-btn" data-day="-1" title="Previous day">◀</button>
      <input type="date" class="ab-date-input" data-meta="date" value="${dateIso}">
      <button class="dnav-btn" data-day="1" title="Next day">▶</button>
      <button class="today-btn" data-today>Now</button>
    </div>
    <div class="ab-shifts">${tabs}</div>
    <div class="ab-right">
      <div class="zoom" title="+ = zoom in to single-shift detail · − = zoom out to today / week / month">
        <button data-zoom="1" ${S!.viewLevel >= 4 ? 'disabled' : ''} title="Zoom out">−</button>
        <span>${escapeHtml(VIEW_LEVELS[S!.viewLevel - 1]?.label ?? 'Shift')}</span>
        <button data-zoom="-1" ${S!.viewLevel <= 1 ? 'disabled' : ''} title="Zoom in">+</button>
      </div>
      <button class="btn-multi${S!.multiSel ? ' a' : ''}" data-multisel title="Tap or drag status cells to select a range, then pick one code">🖌 Multi-fill${S!.multiSel ? ` (${S!.selSet.size})` : ''}</button>
      <button class="btn-load" data-refresh title="Re-pull planning from SharePoint &amp; recompute Job Left">⟳ Refresh</button>
      <button class="btn-save" data-saveclear>✅ Sign off &amp; Save</button>
    </div>
  </div>`;
}

function buildMeta(): string {
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
  // Date moved into the action bar — meta is now strictly "who/what is running".
  return `<div class="op-meta">
    <label class="m-mc">Machine <select data-meta="machine">${machineOpts}</select></label>
    <label class="m-job">Job# <select data-meta="job">${jobOpts}</select></label>
    <label class="m-part">Part# <input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label class="m-desc wide">Product Description <input type="text" disabled value="${escapeHtml(o?.partDescription ?? '')}"></label>
    <label class="m-op">Operator <select data-meta="operator">${selOpts(
      S!.operators,
      S!.selOperator,
      'operator',
    )}</select></label>
    <label class="m-sup">Supervisor <select data-meta="supervisor">${selOpts(
      S!.supervisors,
      S!.selSupervisor,
      'supervisor',
    )}</select></label>
  </div>`;
}

function statusCellHtml(
  slot: number,
  code: StatusCode | '',
  bdIssue: string,
  isNow: boolean,
): string {
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
  const tip =
    code === 'B' && bdIssue ? ` title="${escapeHtml(bdIssue)} — ${escapeHtml(bdLabelFor(bdIssue))}"` : '';
  const tag =
    code === 'B' && bdIssue
      ? `<span class="bd-tag">${escapeHtml(bdIssue.split('-')[0])}</span>`
      : '';
  let cls = `status-cell${isNow ? ' is-now' : ''}`;
  if (S!.multiSel && S!.selSet.has(slot)) cls += ' multisel';
  // Multi-fill mode: render a button (no native select); single-tap toggles
  // selection, drag across cells extends it (handled in wire()).
  if (S!.multiSel) {
    return `<td class="${cls}"${tip}><button type="button" class="slot-cell" style="${style}" data-slot="${slot}" data-row="status">${code || '·'}</button>${tag}</td>`;
  }
  return `<td class="${cls}"${tip}><select class="slot-status" style="${style}" data-slot="${slot}" data-row="status">${opts}</select>${tag}</td>`;
}

function buildGrid(): string {
  const headers = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const lbl = slotClock(sid(), i).replace('–', '-');
    return `<th class="slot-head">${escapeHtml(lbl)}</th>`;
  }).join('');

  const recs = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => slotRec(i));

  // §2 — highlight the slot that the live wall clock falls in (only when
  // viewing the active shift on today).
  const liveShiftId = currentShift(new Date()).shiftId;
  const nowSlot = liveShiftId === sid() ? currentSlotIndex(sid(), new Date()) : null;

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs
      .map((r, i) =>
        statusCellHtml(i, r?.statusCode ?? '', r?.bdIssue ?? '', nowSlot === i),
      )
      .join('') +
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

  return `<div class="op-grid-wrap" style="--slot-w:${SLOT_PX}px">
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
  const { rej: totalReject, other: totalOther } = jobTotals();
  const good = Math.max(0, cn - totalReject);
  const o = selectedOrder();
  // §7 — Job Left = JobRequired - Σ Good across ALL shifts, not just this one.
  const jobLeft =
    o && !o.isDieChange
      ? Math.max(0, o.jobRequired - (S!.jobTotalGood + good))
      : '—';
  const purge = c?.purgeKg ?? '';
  const h = parseHandover(c);
  return `<aside class="op-side">
    <div class="sk"><label>Job left</label><b>${jobLeft}</b></div>
    <div class="sk"><label>Count Start</label><input type="number" data-meta="cstart" value="${cs}"></div>
    <div class="sk"><label>Count End</label><input type="number" data-meta="cend" value="${ce}"></div>
    <div class="sk"><label>Total Good</label><b class="g">${good}</b></div>
    <div class="sk sk-pair">
      <span class="sk-pair-cell"><label>Total Reject</label><b class="r">${totalReject}</b></span>
      <span class="sk-pair-cell"><label>Purge(kg)</label><input type="number" step="0.1" data-meta="purge" value="${purge}"></span>
    </div>
    <div class="sk other-line"><span>(Other # logged: <b>${totalOther}</b> — mapped into reject codes on save)</span></div>
    <div class="handover">
      <div class="handover-title">Handover / Journey — supervisor notes</div>
      <div class="handover-grid">
        <label><span>👥 People</span><textarea data-meta="hand-people" placeholder="Staffing, swaps, training, fatigue…">${escapeHtml(h.people)}</textarea></label>
        <label><span>🏭 Plant</span><textarea data-meta="hand-plant" placeholder="Utilities, services, ambient, housekeeping…">${escapeHtml(h.plant)}</textarea></label>
        <label><span>🛠 Machine</span><textarea data-meta="hand-machine" placeholder="Press state, mould, robot, breakdown follow-ups…">${escapeHtml(h.machine)}</textarea></label>
        <label><span>📦 Material</span><textarea data-meta="hand-material" placeholder="Material lot, dryer, regrind, masterbatch…">${escapeHtml(h.material)}</textarea></label>
      </div>
    </div>
  </aside>`;
}

interface SummaryBucket {
  label: string;
  shiftId: string;
  goCs: number;
  goCe: number;
  good: number;
  rej: number;
  downHrs: number; // B + M slots × 0.5
  setupHrs: number; // C + D + I + P + S slots × 0.5
}

async function loadProdRange(from: Date, to: Date): Promise<ProductionRecord[]> {
  // Lex-from prefix is enough for date-only filtering (IDs start with YYYY-MM-DD).
  const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toKey = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}￿`;
  return dalRef.listProduction({
    machineCode: S!.mc,
    shiftIdFrom: fromKey,
    shiftIdTo: toKey,
  });
}

function rollup(label: string, shiftId: string, rows: ProductionRecord[]): SummaryBucket {
  let good = 0;
  let rej = 0;
  let goCs = 0;
  let goCe = 0;
  let down = 0;
  let setup = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    // Down / setup slot counts ignore SlotIndex grouping — each filled slot
    // contributes 30 min.
    if (r.statusCode === 'B' || r.statusCode === 'M') down++;
    else if (
      r.statusCode === 'C' ||
      r.statusCode === 'D' ||
      r.statusCode === 'I' ||
      r.statusCode === 'P' ||
      r.statusCode === 'S'
    )
      setup++;
    if (r.slotIndex !== 0) continue;
    const key = `${r.jobNumber}|${r.shiftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = Number(r.countStart ?? 0);
    const ce = Number(r.countEnd ?? 0);
    const gross = Math.max(0, ce - cs);
    let jobRej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      jobRej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      jobRej = Number(r.rejectCount) || 0;
    }
    goCs += cs;
    goCe += ce;
    rej += jobRej;
    good += Math.max(0, gross - jobRej);
  }
  return {
    label,
    shiftId,
    goCs,
    goCe,
    good,
    rej,
    downHrs: down * 0.5,
    setupHrs: setup * 0.5,
  };
}

let summaryCache: { level: number; buckets: SummaryBucket[] } | null = null;

function buildSummary(): string {
  const lvl = S!.viewLevel;
  // Kick off async fetch; render placeholder, then replace on resolve.
  if (!summaryCache || summaryCache.level !== lvl) {
    void rebuildSummary();
    return `<div class="summary-loading">Loading ${escapeHtml(
      VIEW_LEVELS[lvl - 1]?.label ?? '',
    )} summary…</div>`;
  }
  const rows = summaryCache.buckets
    .map(
      (b) =>
        `<tr data-jump-shift="${escapeHtml(b.shiftId)}">
          <th>${escapeHtml(b.label)}</th>
          <td class="num">${b.good}</td>
          <td class="num r">${b.rej}</td>
          <td class="num">${b.goCe - b.goCs}</td>
          <td class="num">${b.downHrs.toFixed(1)}h</td>
          <td class="num">${b.setupHrs.toFixed(1)}h</td>
        </tr>`,
    )
    .join('');
  const title = VIEW_LEVELS[lvl - 1]?.label ?? '';
  const chart = renderOutputRejectChart(
    summaryCache.buckets.map((b) => ({
      label: b.label.split(' — ')[0],
      good: b.good,
      reject: b.rej,
    })),
  );
  return `<div class="summary-wrap">
    <h3 class="summary-title">${escapeHtml(title)} — ${escapeHtml(S!.mc)}</h3>
    <p class="bd-sub">Read-only roll-up · tap a row to drill into that shift.</p>
    <div class="summary-chart">${chart}</div>
    <table class="summary-table">
      <thead><tr>
        <th>Bucket</th><th>Good</th><th>Reject</th><th>Output (gross)</th><th>Down</th><th>Setup</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No data</td></tr>'}</tbody>
    </table>
  </div>`;
}

async function rebuildSummary(): Promise<void> {
  const lvl = S!.viewLevel;
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const buckets: SummaryBucket[] = [];
  if (lvl === 2) {
    // Today × 3 shifts. Night actually starts at 23:00 today (its shiftId
    // date is today), so we pull a 24h window starting at today 00:00.
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const rows = await loadProdRange(today, tomorrow);
    for (const code of ['Day', 'Afternoon', 'Night'] as const) {
      const sid = buildShiftId(today, code);
      buckets.push(
        rollup(`${code} — ${sid.slice(0, 10)}`, sid, rows.filter((r) => r.shiftId === sid)),
      );
    }
  } else {
    const days = lvl === 3 ? 7 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    const rows = await loadProdRange(from, today);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const datePart = d.toISOString().slice(0, 10);
      const dayRows = rows.filter((r) => r.shiftId.startsWith(`${datePart}-`));
      const label = d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      // shiftId target for click-through: jump to Day shift of that date.
      buckets.push(rollup(label, `${datePart}-Day`, dayRows));
    }
  }
  summaryCache = { level: lvl, buckets };
  render();
}

function buildLegend(): string {
  return `<div class="op-legend">${STATUSES.map(
    (s) =>
      `<span><i style="background:${s.color};border-color:${s.border}"></i>${s.code}: ${escapeHtml(s.label)}</span>`,
  ).join('')}</div>`;
}

function applyShiftTheme(): void {
  // Day → blue (102,204,255); Afternoon → green (131,226,142); Night → yellow (255,255,0).
  // Drives CSS variables in styles.css, including the top bar.
  const cls = `shift-${S!.shiftCode.toLowerCase()}`;
  if (document.body.className !== cls) document.body.className = cls;
}

function render(): void {
  applyShiftTheme();
  const app = document.getElementById('app')!;
  const detail =
    S!.viewLevel === 1
      ? `<div class="op-grid-row">${buildGrid()}${buildSide()}</div>${buildLegend()}`
      : buildSummary();
  app.innerHTML = `<div class="op-sheet">
    ${buildActionBar()}
    ${buildMeta()}
    ${detail}
  </div>`;
  wire();
  if (S!.viewLevel === 1) renderNowLine();
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

  // View level (+/-): shift → today → week → month (§9 — read-only summary above level 1).
  app.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const dz = Number(b.dataset.zoom);
      const next = Math.max(1, Math.min(4, S!.viewLevel + dz));
      if (next === S!.viewLevel) return;
      S!.viewLevel = next;
      summaryCache = null; // force fresh fetch for the new level
      render();
    }),
  );
  // Drill from a summary row back into single-shift detail.
  app.querySelectorAll<HTMLElement>('[data-jump-shift]').forEach((row) =>
    row.addEventListener('click', () => {
      const sid = row.dataset.jumpShift!;
      const m = /^(\d{4})-(\d{2})-(\d{2})-(Day|Afternoon|Night)$/.exec(sid);
      if (!m) return;
      S!.viewDate = new Date(+m[1], +m[2] - 1, +m[3]);
      S!.shiftCode = m[4] as ShiftCode;
      S!.viewLevel = 1;
      summaryCache = null;
      S!.selJob = '';
      void reload();
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

  // Status cells — picking B triggers the breakdown cascade.
  app.querySelectorAll<HTMLSelectElement>('.slot-status').forEach((sel) =>
    sel.addEventListener('change', () => {
      const slot = Number(sel.dataset.slot);
      const newCode = sel.value as StatusCode | '';
      const cur = slotRec(slot);
      const prev = (cur?.statusCode ?? '') as StatusCode | '';
      if (newCode === 'B') {
        // Revert visual until the cascade confirms — render() restores it on save.
        sel.value = prev;
        const lbl = `Slot ${slot + 1}/${SLOTS_PER_SHIFT} · ${slotClock(sid(), slot)}`;
        openBreakdownCascade(lbl, cur?.bdIssue ?? '', (pick) => {
          void upsertSlot(slot, (r) => {
            r.statusCode = 'B';
            r.bdIssue = pick.code;
            if (pick.note) r.mangoTicket = pick.note;
          });
        });
        return;
      }
      // TS narrowed newCode away from 'B' above; clearing BD context is
      // always safe here since this branch is the non-B path.
      void upsertSlot(slot, (r) => {
        r.statusCode = newCode;
        r.bdIssue = '';
        r.mangoTicket = '';
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
  app.querySelector('[data-refresh]')?.addEventListener('click', () => void refreshAll());
  app.querySelector('[data-saveclear]')?.addEventListener('click', () => openSaveSignoffModal());
  app.querySelector('[data-multisel]')?.addEventListener('click', () => {
    S!.multiSel = !S!.multiSel;
    S!.selSet.clear();
    render();
  });
  wireMultiFillDrag();
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
      summaryCache = null; // cache is per-machine
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
    case 'hand-people':
    case 'hand-plant':
    case 'hand-machine':
    case 'hand-material': {
      const field = key.slice('hand-'.length) as 'people' | 'plant' | 'machine' | 'material';
      void upsertSlot(0, (r) => {
        const obj = parseHandover(r);
        obj[field] = val;
        r.handoverNote = JSON.stringify(obj);
      });
      break;
    }
  }
}

interface Handover {
  people: string;
  plant: string;
  machine: string;
  material: string;
}

function parseHandover(r: ProductionRecord | undefined): Handover {
  const blank: Handover = { people: '', plant: '', machine: '', material: '' };
  if (!r || !r.handoverNote) return blank;
  // New shape: JSON {people,plant,machine,material}.
  // Legacy: plain string — surface it under "people" so nothing is lost.
  try {
    const j = JSON.parse(r.handoverNote) as Partial<Handover>;
    return { ...blank, ...j };
  } catch {
    return { ...blank, people: r.handoverNote };
  }
}

/**
 * Refresh (§7): pull the latest planning from the data source (real
 * backend = SharePoint Schedule master via the DAL) and re-fetch this
 * shift's production records + the cross-shift Good total used by Job Left.
 */
async function refreshAll(): Promise<void> {
  // Real backend (§7.1): pull the Excel "Planning" sheet from the SP site,
  // clear PMD_Planning, repopulate. Mock backend: skip the sync, just reload.
  if (canSyncPlanning(dalRef)) {
    try {
      toast('Syncing planning from Excel…', 'warn');
      const { inserted, skipped } = await dalRef.syncPlanningFromExcel();
      toast(`Planning synced · ${inserted} rows in, ${skipped} skipped`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Excel sync failed: ${(e as Error).message}`, 'err');
    }
  }
  S!.planning = await dalRef.listPlanning({});
  summaryCache = null;
  await reload();
  toast(`Refreshed · ${shiftOrders().length} job(s) for this shift`, 'ok');
}

/**
 * Sign-off + Save in one modal (§5). Replaces the separate checkbox.
 * Pre-flight = same gates as the .bas btnSaveAndClear_Click:
 *   - Supervisor selected
 *   - countEnd >= countStart (when both present)
 * Confirming locks the shift records and clears the in-form selection.
 */
function openSaveSignoffModal(): void {
  if (!S!.selSupervisor) {
    toast('Pick a Supervisor before signing off', 'err');
    return;
  }
  const c = canonical();
  const cs = Number(c?.countStart ?? 0);
  const ce = Number(c?.countEnd ?? 0);
  if (c?.countEnd != null && c?.countStart != null && ce < cs) {
    toast('Count End must be ≥ Count Start', 'err');
    return;
  }
  const totalRej = jobTotals().rej;
  const good = Math.max(0, ce - cs - totalRej);
  const o = selectedOrder();

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">✅ Sign off &amp; Save</h2>
    <p class="bd-sub">${escapeHtml(sid())} · ${escapeHtml(S!.mc)} · job ${escapeHtml(S!.selJob || '—')}</p>
    <div class="signoff-summary">
      <div><span>Operator</span><b>${escapeHtml(S!.selOperator || '—')}</b></div>
      <div><span>Supervisor</span><b>${escapeHtml(S!.selSupervisor)}</b></div>
      <div><span>Part</span><b>${escapeHtml(o?.partNumber ?? '—')}</b></div>
      <div><span>Required</span><b>${o && !o.isDieChange ? o.jobRequired : '—'}</b></div>
      <div><span>Count Start → End</span><b>${cs} → ${ce}</b></div>
      <div><span>Good (this shift)</span><b class="g">${good}</b></div>
      <div><span>Total Reject</span><b class="r">${totalRej}</b></div>
    </div>
    <p class="bd-sub">By signing off you confirm the above figures are correct and lock the shift records.</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
      <button class="btn-primary-big" data-confirm-save>Sign off as ${escapeHtml(S!.selSupervisor)}</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-confirm-save]')?.addEventListener('click', () => {
    void doSignoffSave();
  });
}

// ---------- Multi-fill (drag-to-select + same-as-previous) ----------

function wireMultiFillDrag(): void {
  if (!S!.multiSel) return;
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;

  let anchor: number | null = null;

  const slotAt = (clientX: number, clientY: number): number | null => {
    const el = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-slot][data-row="status"]');
    if (!el) return null;
    return Number(el.dataset.slot);
  };

  const setRange = (a: number, b: number): void => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    S!.selSet = new Set<number>();
    for (let i = lo; i <= hi; i++) S!.selSet.add(i);
    paintSelection();
  };

  wrap.addEventListener('pointerdown', (e) => {
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null) return;
    anchor = slot;
    if (e.shiftKey && S!.selSet.size > 0) {
      // Shift-click extends from the lowest currently-selected slot.
      const lo = Math.min(...S!.selSet);
      setRange(lo, slot);
    } else {
      // Toggle on plain tap; drag will overwrite the set.
      if (S!.selSet.has(slot)) S!.selSet.delete(slot);
      else S!.selSet.add(slot);
      paintSelection();
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', (e) => {
    if (anchor == null || e.pressure === 0) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null || slot === anchor) return;
    setRange(anchor, slot);
  });

  wrap.addEventListener('pointerup', () => {
    anchor = null;
    paintFillBar();
  });

  paintSelection();
  paintFillBar();
}

function paintSelection(): void {
  document.querySelectorAll<HTMLElement>('[data-slot][data-row="status"]').forEach((el) => {
    const slot = Number(el.dataset.slot);
    const td = el.closest<HTMLElement>('.status-cell');
    if (!td) return;
    if (S!.selSet.has(slot)) td.classList.add('multisel');
    else td.classList.remove('multisel');
  });
  paintFillBar();
}

function paintFillBar(): void {
  let bar = document.getElementById('multifill-bar');
  if (S!.selSet.size === 0) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'multifill-bar';
    bar.className = 'multifill-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="mf-count">${S!.selSet.size} slot${S!.selSet.size === 1 ? '' : 's'} selected</span>
    <button class="btn-ghost-big" data-mf-clear>Clear</button>
    <button class="btn-primary-big" data-mf-fill>Fill with…</button>
  `;
  bar.querySelector('[data-mf-clear]')?.addEventListener('click', () => {
    S!.selSet.clear();
    paintSelection();
  });
  bar.querySelector('[data-mf-fill]')?.addEventListener('click', openMultiFillPicker);
}

/** Find the most recent filled slot with index < min(selSet). */
function previousFilled(beforeSlot: number): ProductionRecord | undefined {
  for (let i = beforeSlot - 1; i >= 0; i--) {
    const r = slotRec(i);
    if (r && r.statusCode) return r;
  }
  return undefined;
}

function openMultiFillPicker(): void {
  if (S!.selSet.size === 0) return;
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  const slots = [...S!.selSet].sort((a, b) => a - b);
  const prev = previousFilled(slots[0]);
  const sameAsPrev = prev
    ? `<button class="bd-cause" data-pick-same>
        <span class="bd-code">↪ ${escapeHtml(prev.statusCode)}</span>
        <span class="bd-cause-text">Same as previous (${escapeHtml(prev.statusCode)} ${escapeHtml(STATUS_MAP[prev.statusCode as StatusCode]?.label ?? '')})</span>
      </button>`
    : '';
  const codes: StatusCode[] = ['R', 'B', 'C', 'D', 'I', 'M', 'O', 'P', 'S'];
  const pills = codes
    .map((c) => {
      const d = STATUS_MAP[c];
      return `<button class="ab-pill" style="background:${d.color};border-color:${d.border};color:${d.text}" data-pick="${c}">
        <span class="ab-cd">${c}</span><span class="ab-lb">${escapeHtml(d.label)}</span>
      </button>`;
    })
    .join('');

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">🖌 Fill ${slots.length} slot${slots.length === 1 ? '' : 's'}</h2>
    <p class="bd-sub">Slots: ${slots.map((s) => `${s + 1}`).join(', ')}</p>
    ${sameAsPrev ? `<div class="bd-cause-list">${sameAsPrev}</div>` : ''}
    <div class="ab-grid">${pills}</div>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-pick-same]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, prev!.statusCode as StatusCode, prev!.bdIssue, prev!.mangoTicket);
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.dataset.pick as StatusCode;
      if (code === 'B') {
        openBreakdownCascade(`${slots.length} slot${slots.length === 1 ? '' : 's'}`, '', (pick) => {
          void multiFillApply(slots, 'B', pick.code, pick.note);
        });
        return;
      }
      closeModal();
      void multiFillApply(slots, code, '', '');
    }),
  );
}

async function multiFillApply(
  slots: number[],
  code: StatusCode,
  bdIssue: string,
  mangoNote: string,
): Promise<void> {
  // Sequential upserts — keep simple; could batch later if needed.
  for (const slot of slots) {
    await upsertSlotNoReload(slot, (r) => {
      r.statusCode = code;
      r.bdIssue = code === 'B' ? bdIssue : '';
      if (code === 'B' && mangoNote) r.mangoTicket = mangoNote;
      else if (code !== 'B') r.mangoTicket = '';
    });
  }
  S!.selSet.clear();
  S!.multiSel = false; // exit mode after fill
  toast(`Filled ${slots.length} slot${slots.length === 1 ? '' : 's'} with ${code}`, 'ok');
  await reload();
}

/** Like upsertSlot but doesn't call reload — caller batches the final render. */
async function upsertSlotNoReload(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) return;
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
  await dalRef.upsertProductionRecord(rec);
}

async function doSignoffSave(): Promise<void> {
  try {
    await dalRef.lockShift(S!.mc, sid(), S!.selSupervisor, S!.selOperator);
    closeModal();
    toast(`Signed off · ${S!.selJob || 'shift'} saved to Master`, 'ok');
    S!.selJob = '';
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

function jobTotals(): { rej: number; other: number } {
  let rej = 0;
  let other = 0;
  for (const r of S!.prod.filter((x) => x.jobNumber === S!.selJob)) {
    const obj = parseRejects(r);
    rej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    other += Number(r.otherCount) || 0;
  }
  return { rej, other };
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
    viewLevel: 1,
    jobTotalGood: 0,
    multiSel: false,
    selSet: new Set<number>(),
  };
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(renderNowLine, 30_000);
  await reload();
}

export function operatorPollTick(): void {
  if (S) renderNowLine();
}
