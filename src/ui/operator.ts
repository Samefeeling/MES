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
  dateKey,
  previousShift,
  shiftBounds,
  slotClock,
} from '../core/shifts';
import { STATUSES, STATUS_MAP } from '../core/status';
import { bdLabelFor } from '../core/breakdown';
import { type Handover, parseHandover as sharedParseHandover } from '../core/handover';
import { openBreakdownCascade } from './breakdown';
import { toast } from './toast';
import { closeModal, escapeHtml, openModal } from './modal';
import { renderOutputRejectChart } from './charts';
import { clearSupervisor, isSupervisor } from './supervisor-auth';

// PMD Operator Production Sheet — Excel-style rebuild of modPMDOperator.bas.
// One machine + one shift + one job at a time. 16 half-hour slots horizontally;
// rows are: Machine Status / 10 defect rows (D01-D10).

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
  rejCats: RejectCategory[];
  selOperator: string;
  selSupervisor: string;
  /** 1 = single-shift detail (editable); 2 = today's 3 shifts;
   *  3 = past 7 days; 4 = past 30 days. Levels 2-4 are read-only summaries. */
  viewLevel: number;
  /** Sum of Good across all shifts of selJob — drives the cross-shift Job Left. */
  jobTotalGood: number;
  /** Slots currently highlighted for status entry (tap or hold-and-drag). */
  selSet: Set<number>;
  /** Part # → die / paint hex colour, read from PMD_ProductDieColor on
   *  boot. Drives the swatch shown on the Product Description meta cell
   *  so the operator can see the colour they're meant to be running. */
  dieColors: Map<string, { hex: string; name: string }>;
}

let S: OpState | null = null;
let dalRef: PmdDataLayer;
let nowTimer: ReturnType<typeof setInterval> | undefined;

// Per-tab persistence of which shift the operator was last looking at.
// Without this, switching to KPIs and back resets viewDate / shiftCode to
// today's live shift — and an iPad operator who'd been reviewing 02/06
// loses their place every time they tap a top-nav link by accident.
const UI_KEY = 'pmd_op_view_v1';
interface PersistedView {
  mc: string;
  viewDateIso: string;
  shiftCode: ShiftCode;
  selJob: string;
  selOperator: string;
  selSupervisor: string;
}
export function loadSavedOperatorView(): PersistedView | null {
  try {
    const raw = sessionStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as PersistedView) : null;
  } catch {
    return null;
  }
}
function loadView(): PersistedView | null {
  return loadSavedOperatorView();
}
function saveView(): void {
  if (!S) return;
  try {
    sessionStorage.setItem(
      UI_KEY,
      JSON.stringify({
        mc: S.mc,
        viewDateIso: S.viewDate.toISOString(),
        shiftCode: S.shiftCode,
        selJob: S.selJob,
        selOperator: S.selOperator,
        selSupervisor: S.selSupervisor,
      }),
    );
  } catch {
    /* storage blocked — best effort */
  }
}

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
  // Resolve the planning order for the selected job once so the slot
  // carries JobHead_PartNum — PMD_Production / PMD_LiveStatus persist
  // the colour-lookup key per row instead of relying on a planning join.
  const order = S!.planning.find((o) => o.jobNumber === S!.selJob);
  return {
    id: 0,
    machineCode: S!.mc,
    shiftId: sid(),
    jobNumber: S!.selJob,
    partNumber: order?.partNumber ?? '',
    slotIndex: slot,
    statusCode: '',
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
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

function isPastShift(): boolean {
  // A shift is "past" if its calendar date is strictly before today, OR
  // if it's today but earlier than the live shift. The Job# dropdown for
  // past shifts is restricted to jobs that were actually worked on, since
  // the planning list only reflects the current Epicor state.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (S!.viewDate < today) return true;
  if (S!.viewDate > today) return false;
  const liveShiftId = currentShift(new Date()).shiftId;
  return sid() !== liveShiftId;
}

function shiftOrders(): PlanningOrder[] {
  // Historical jobs — every JobNum that appears on PMD_Production rows for
  // the currently-viewed shift. Always derived from S!.prod so it works for
  // both signed-off shifts and unsaved edits.
  const historicalIds = Array.from(
    new Set(S!.prod.map((r) => r.jobNumber).filter((j) => !!j)),
  );
  const historicalOrder = (j: string): PlanningOrder => ({
    id: 0,
    jobNumber: j,
    machineCode: '',
    originalMachine: '',
    partNumber: S!.prod.find((r) => r.jobNumber === j && r.partNumber)?.partNumber ?? '',
    partDescription: '(historical)',
    plannedStart: '',
    plannedEnd: '',
    jobRequired: 0,
    qtyPerHr: 0,
    duration: 0,
    released: false,
    isDieChange: false,
    manuallyAdded: true,
    source: 'Manual',
  });

  // Past shifts: only show the jobs actually worked on — the planning list
  // reflects current Epicor state and would otherwise drown the dropdown
  // with unrelated active orders.
  if (isPastShift()) {
    return historicalIds.map(historicalOrder);
  }

  // Active / future shift: all PMD-released orders (sorted plannedStart,
  // closest-to-now first), plus any historical id not in planning (e.g.
  // a job that just got closed in Epicor).
  const planned = S!.planning.slice().sort(
    (a, b2) =>
      new Date(a.plannedStart).getTime() - new Date(b2.plannedStart).getTime(),
  );
  const knownIds = new Set(planned.map((o) => o.jobNumber));
  const extras = historicalIds.filter((j) => !knownIds.has(j)).map(historicalOrder);
  return [...planned, ...extras];
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
  // Defence-in-depth lock guard: a signed-off (machine, shift, job) is
  // immutable until a supervisor reopens it via Unlock. Without this,
  // a stray tap on a slot would put a NEW slot record into editCache,
  // and the next pushLiveSnapshot would re-broadcast the (locked) shift
  // as live — polluting PMD_LiveStatus and resetting the timeline. The
  // UI already disables the inputs, but inputs can still emit events
  // when re-enabled by devtools or a flaky disabled-attribute paint;
  // belt-and-braces stop here.
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor to edit', 'warn');
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
  // Sync-update local state so concurrent upsertSlot() calls don't race on a
  // stale S!.prod — without this, typing CountStart then immediately tabbing
  // to CountEnd would have CountEnd's upsert clone the pre-CountStart record
  // and overwrite it on flush.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
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
  // Don't clear a manually-typed JobNum just because it isn't in Planning
  // yet — the operator may be entering an order that was released in Epicor
  // after the most recent sync.
  if (!S!.selJob) {
    // Prefer the job already showing live activity on this press —
    // PMD_LiveStatus rows surface in S!.prod as unsigned (locked=false)
    // slot records with a non-empty statusCode. The job whose latest
    // filled slot is furthest along the shift is what the press is
    // running right now, so default to that when the operator switches
    // machines. They can still re-pick a different order from the
    // datalist if needed.
    const lastSlotByJob = new Map<string, number>();
    for (const r of S!.prod) {
      if (!r.locked && r.statusCode && r.jobNumber) {
        const cur = lastSlotByJob.get(r.jobNumber) ?? -1;
        if (r.slotIndex > cur) lastSlotByJob.set(r.jobNumber, r.slotIndex);
      }
    }
    let bestJob = '';
    let bestSlot = -1;
    for (const [j, s] of lastSlotByJob) {
      if (s > bestSlot) {
        bestSlot = s;
        bestJob = j;
      }
    }
    if (bestJob) S!.selJob = bestJob;
    else if (orders.length) S!.selJob = orders[0].jobNumber;
  }
  const c = canonical();
  if (c) {
    // For a signed-off shift the canonical row carries the authoritative
    // operator/supervisor pair from the moment Sign Off & Save fired;
    // overwrite any leftover selection from the previous shift so the UI
    // shows those names instead of whatever was last touched. Live shifts
    // keep the existing behaviour — fill empty selections only.
    if (c.locked) {
      S!.selOperator = c.operator;
      S!.selSupervisor = c.supervisor;
    } else {
      if (!S!.selOperator) S!.selOperator = c.operator;
      if (!S!.selSupervisor) S!.selSupervisor = c.supervisor;
    }
  }
  // Count Start auto-carry: a same-machine/same-job continuation from
  // the previous shift starts where the previous shift's counter ended
  // — Day 14000 → Afternoon 14000 (Count Start) → Afternoon 28000 (End)
  // → Night 28000 (Count Start). Only fires when the operator hasn't
  // typed anything yet (count Start null on the live shift) and we
  // have a non-null Count End from the immediately-preceding shift on
  // the same machine + job.
  await maybeCarryCountStart();
  await refreshJobTotal();
  saveView();
  render();
}

/**
 * Most recent canonical Count End for this (machine, job) on a shift
 * strictly before the one currently being viewed, looking back 7 days
 * (an arbitrary but reasonable bound — gaps longer than that are
 * almost certainly a brand-new run, not a continuation).
 *
 * One ranged listProduction instead of up to 21 sequential by-shiftId
 * round-trips — on iPad/SP that turns a 2-3 s "switch to a fresh
 * shift" lag into a single sub-200 ms call.
 */
async function prevShiftCountEnd(): Promise<number | null> {
  if (!S!.selJob) return null;
  const currentSid = buildShiftId(S!.viewDate, S!.shiftCode);
  const sevenDaysAgo = new Date(S!.viewDate);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const rows = await dalRef.listProduction({
    machineCode: S!.mc,
    jobNumber: S!.selJob,
    shiftIdFrom: dateKey(sevenDaysAgo),
    shiftIdTo: dateKey(S!.viewDate),
  });
  // Pick the canonical row whose shiftId is the largest one strictly
  // before the current shift. Lex-sort works because shiftIds are
  // `YYYY-MM-DD-<code>` and the codes sort Afternoon < Day < Night —
  // chronologically wrong, so we compute the previous shiftId via
  // previousShift() and walk a tiny in-memory list.
  let sid: string | null = previousShift(currentSid);
  const byShift = new Map<string, ProductionRecord>();
  for (const r of rows) {
    if (r.slotIndex === 0 && r.countEnd != null) byShift.set(r.shiftId, r);
  }
  for (let hops = 0; hops < 21 && sid; hops++) {
    const canon = byShift.get(sid);
    if (canon) return Number(canon.countEnd);
    sid = previousShift(sid);
  }
  return null;
}

async function maybeCarryCountStart(): Promise<void> {
  if (!S!.selJob) return;
  const c = canonical();
  // Don't touch signed-off shifts or shifts where the operator already
  // typed a Count Start (the existing value wins).
  if (c?.locked) return;
  if (c?.countStart != null) return;
  const prev = await prevShiftCountEnd();
  if (prev == null) return;
  console.info(
    `[pmd] auto-carry Count Start ← ${prev} (prev shift's Count End on ${S!.mc}/${S!.selJob})`,
  );
  // Use no-reload upsert so we don't recurse via reload().
  await upsertSlotNoReload(0, (r) => {
    r.countStart = prev;
  });
}

/**
 * Pieces still needed across every shift on this job, after subtracting
 * the canonical Good count we've already accumulated. Returns null for
 * die-change jobs (no piece target) and when there's no planning row.
 */
function jobLeftPieces(): number | null {
  const o = selectedOrder();
  if (!o || o.isDieChange) return null;
  const c = canonical();
  const cs = Number(c?.countStart ?? 0);
  const ce = Number(c?.countEnd ?? 0);
  const grossThis = Math.max(0, ce - cs);
  const goodThis = Math.max(0, grossThis - jobTotals());
  return Math.max(0, o.jobRequired - (S!.jobTotalGood + goodThis));
}

/**
 * Shift Target = pieces the operator should aim for this shift.
 *
 * The planning row's `qtyPerHr` field is sourced from Epicor's
 * `JobOper_ProdStandard` column, which on this tenant is expressed as
 * *hours per piece* (cycle time) — that's why the old "× pieces/hour"
 * formula was rounding to zero for every job, the value is in the
 * ~0.005 range.
 *
 * Operator-stated rule:
 *   if  JobLeft × CT  ≥  8h   →  target = floor(8 / CT)   (full shift)
 *   else                       →  target = JobLeft        (job will finish)
 *
 * Returns null when no planning rate is available.
 */
function shiftTarget(): number | null {
  const o = selectedOrder();
  if (!o || !o.qtyPerHr || o.qtyPerHr <= 0) return null;
  const ct = o.qtyPerHr; // hours per piece
  const jl = jobLeftPieces();
  if (jl == null) return null;
  return jl * ct >= 8 ? Math.floor(8 / ct) : jl;
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

/**
 * Live-update the Total Good / Total Reject / Job Left cells without a
 * re-render. Used by the canonical-slot edits (Count Start / End / Purge)
 * that now go through upsertSlotNoReload so the focused input is not
 * destroyed mid-typing.
 */
async function refreshJobTotalAndPaintSide(): Promise<void> {
  await refreshJobTotal();
  const c = canonical();
  const cs = Number(c?.countStart ?? 0);
  const ce = Number(c?.countEnd ?? 0);
  const gross = Math.max(0, ce - cs);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
  const o = selectedOrder();
  const jobLeft =
    o && !o.isDieChange
      ? Math.max(0, o.jobRequired - (S!.jobTotalGood + good))
      : null;
  // Patch by data-live tag — text-content matching used to live here,
  // but renaming a label silently broke the live update. Tags are set
  // in buildSide() on each <b> so this stays in sync with the layout.
  const set = (tag: string, v: string | null): void => {
    if (v == null) return;
    const el = document.querySelector<HTMLElement>(`.op-side [data-live="${tag}"]`);
    if (el) el.textContent = v;
  };
  set('jobLeft', jobLeft == null ? null : String(jobLeft));
  set('totalGood', String(good));
  set('totalReject', String(totalReject));
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
  const dateIso = dateKey(S!.viewDate);
  const tabs = SHIFTS.map(
    (s) =>
      `<button class="shift-btn${s.code === S!.shiftCode ? ' a' : ''}" data-shift="${s.code}">${escapeHtml(
        s.label,
      )}</button>`,
  ).join('');
  // Action bar trimmed for iPad portrait (≈810px wide): the explicit
  // "Now" button is redundant — tapping today on the date picker drops
  // you on the live shift anyway — and shortening the save label to
  // "Sign off" buys the ~80px needed for the bar to fit on one row.
  return `<div class="op-actionbar">
    <div class="ab-date">
      <input type="date" class="ab-date-input" data-meta="date" value="${dateIso}">
    </div>
    <div class="ab-shifts">${tabs}</div>
    <div class="ab-right">
      <button class="btn-load" data-refresh title="Re-pull planning from SharePoint &amp; recompute Job Left">⟳ Refresh</button>
      <button class="btn-save" data-saveclear>✅ Sign off</button>
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
  // datalist + text input — operators can pick a Released order from the
  // list (autocomplete) OR type a JobNum manually for the case where the
  // order was just released in Epicor and the 15-min sync hasn't run yet.
  const dataOpts = orders
    .map((o) => {
      const d = new Date(o.plannedStart);
      const when = isFinite(d.getTime())
        ? ` · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
        : '';
      const tag = o.manuallyAdded ? ' (history)' : '';
      const label = `${o.jobNumber}${when}${tag}`;
      return `<option value="${escapeHtml(o.jobNumber)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  const o = selectedOrder();
  // Past shifts (and non-supervisors) get a constrained <select> so they can
  // still switch between the jobs that were actually run on that shift, but
  // can't type a new JobNum and pollute historical data. Supervisors and
  // current/future shifts keep the free-text input + datalist autocomplete.
  const pastLocked = isPastShift() && !isSupervisor();
  let jobField: string;
  if (pastLocked) {
    const historical = orders;
    const selectOpts = historical.length
      ? historical
          .map(
            (h) =>
              `<option value="${escapeHtml(h.jobNumber)}"${
                h.jobNumber === S!.selJob ? ' selected' : ''
              }>${escapeHtml(h.jobNumber)}</option>`,
          )
          .join('')
      : '<option value="">— no records —</option>';
    jobField = `<select data-meta="job" title="Past shift — sign in as supervisor to edit">${selectOpts}</select>`;
  } else {
    jobField = `<input type="text" list="op-job-list" data-meta="job" value="${escapeHtml(
      S!.selJob,
    )}" placeholder="pick or type"><datalist id="op-job-list">${dataOpts}</datalist>`;
  }
  // Signed-off shifts: operator & supervisor are frozen to the values that
  // were recorded at sign-off. Without this an iPad tap on the dropdown
  // changes the canonical slot's operator/supervisor, but the rest of the
  // signed-off record stays — you end up looking at "the right numbers
  // signed off by the wrong name". Supervisor mode reveals the select
  // again so a correction can be made and re-signed off.
  const opSupLocked = lockInfo() !== null && !isSupervisor();
  const lockedOrSelect = (meta: 'operator' | 'supervisor', list: string[], value: string): string =>
    opSupLocked
      ? `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Signed off — sign in as supervisor to change">`
      : `<select data-meta="${meta}">${selOpts(list, value, meta)}</select>`;
  const opField = lockedOrSelect('operator', S!.operators, S!.selOperator);
  const supField = lockedOrSelect('supervisor', S!.supervisors, S!.selSupervisor);
  // Order Qty = JobRequired from planning. Shown in the meta row so the
  // operator reads it next to the Job# / Part# (which is the natural eye
  // path) rather than tucked away in the right side panel.
  const orderQty = o && !o.isDieChange ? o.jobRequired : '—';
  // Die / paint colour swatch from PMD_ProductDieColor, looked up by
  // the selected job's Part #. Planning.csv always carries
  // JobHead_PartNum, so the key comes from there directly. Upper-trim
  // both sides so any case / whitespace drift between PMD_ProductDieColor
  // and Planning.csv still resolves.
  const partKey = (o?.partNumber ?? '').trim().toUpperCase();
  const die = partKey ? S!.dieColors.get(partKey) : undefined;
  const swatch = die?.hex
    ? `<span class="m-die-swatch-inline" style="background:${die.hex}" title="${escapeHtml(die.name || die.hex)}"></span>`
    : '';
  return `<div class="op-meta">
    <label class="m-mc">Machine <select data-meta="machine">${machineOpts}</select></label>
    <label class="m-job">Job# ${jobField}</label>
    <label class="m-orderqty">Order Qty <input type="text" disabled value="${escapeHtml(String(orderQty))}"></label>
    <label class="m-part"><span class="m-part-title">Part# ${swatch}</span><input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label class="m-desc">Product Description <input type="text" disabled value="${escapeHtml(o?.partDescription ?? '')}"></label>
    <label class="m-op">Operator ${opField}</label>
    <label class="m-sup">Supervisor ${supField}</label>
  </div>`;
}

function statusCellHtml(
  slot: number,
  code: StatusCode | '',
  bdIssue: string,
  isNow: boolean,
): string {
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
  if (S!.selSet.has(slot)) cls += ' multisel';
  // Unified status entry — single-tap selects this slot, hold-and-drag across
  // cells selects a range; the picker opens automatically on finger-up.
  return `<td class="${cls}"${tip}><button type="button" class="slot-cell" style="${style}" data-slot="${slot}" data-row="status">${code || '·'}</button>${tag}</td>`;
}

function buildGrid(): string {
  const recs = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => slotRec(i));

  // §2 — highlight the slot that the live wall clock falls in (only when
  // viewing the active shift on today). The whole column (time header +
  // status + every reject row) is tinted so operators see which time to fill.
  const liveShiftId = currentShift(new Date()).shiftId;
  const nowSlot = liveShiftId === sid() ? currentSlotIndex(sid(), new Date()) : null;

  const headers = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const lbl = slotClock(sid(), i).replace('–', '-');
    const now = nowSlot === i ? ' is-now-col' : '';
    return `<th class="slot-head${now}">${escapeHtml(lbl)}</th>`;
  }).join('');

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs
      .map((r, i) =>
        statusCellHtml(i, r?.statusCode ?? '', r?.bdIssue ?? '', nowSlot === i),
      )
      .join('') +
    `</tr>`;

  const gridRdo = isJobLocked() ? ' disabled title="Signed off — sign in as supervisor and Unlock to edit"' : '';
  const rejRows = S!.rejCats
    .map((cat) => {
      const cells = recs
        .map((r, i) => {
          const v = parseRejects(r)[cat.code] ?? 0;
          const now = nowSlot === i ? ' is-now-col' : '';
          return `<td class="num-cell${now}"><input type="text" inputmode="numeric" pattern="[0-9]*" class="rej-input" data-row="named" data-code="${escapeHtml(
            cat.code,
          )}" data-slot="${i}" value="${v || ''}"${gridRdo}></td>`;
        })
        .join('');
      return `<tr class="row-named"><th class="rh">${escapeHtml(cat.code)} ${escapeHtml(
        cat.label,
      )}</th>${cells}</tr>`;
    })
    .join('');

  return `<div class="op-grid-wrap" style="--slot-w:${SLOT_PX}px">
    <table class="op-grid">
      <thead>
        <tr><th class="rh corner">Timeline</th>${headers}</tr>
      </thead>
      <tbody>
        ${statusRow}
        ${rejRows}
      </tbody>
    </table>
  </div>`;
}

function buildSide(): string {
  const c = canonical();
  const cs = c?.countStart ?? '';
  const ce = c?.countEnd ?? '';
  const cn = Number(c?.countEnd ?? 0) - Number(c?.countStart ?? 0);
  const totalReject = jobTotals();
  const good = Math.max(0, cn - totalReject);
  const o = selectedOrder();
  // §7 — Job Left = JobRequired - Σ Good across ALL shifts, not just this one.
  const jobLeft =
    o && !o.isDieChange
      ? Math.max(0, o.jobRequired - (S!.jobTotalGood + good))
      : '—';
  const purge = c?.purgeKg ?? '';
  const h = parseHandover(c);
  // When the (machine, shift, job) is signed off, every editable field
  // on the side panel is rendered read-only so the operator can't
  // accidentally type into a frozen shift — supervisor mode re-enables
  // them via the Unlock flow. Title tooltips explain what changed.
  const rdo = isJobLocked() ? 'disabled' : '';
  const rdoTitle = isJobLocked()
    ? ' title="Signed off — sign in as supervisor and Unlock to edit"'
    : '';
  // Shift Target: pieces the operator should aim for this shift. See
  // shiftTarget() for the rule — either a full 8h run at cycle time, or
  // just the remainder of the job if it'll finish in under 8h.
  const tgt = shiftTarget();
  const targetDisplay = tgt == null ? '—' : String(tgt);
  const targetTitle = tgt == null
    ? 'No JobOper_ProdStandard on the planning row — Shift Target cannot be computed.'
    : `Shift Target = if Job Left × ${o!.qtyPerHr} h/piece ≥ 8h then 8 ÷ ${o!.qtyPerHr}, else Job Left.`;
  return `<aside class="op-side">
    <div class="sk"><label>Job left</label><b data-live="jobLeft">${jobLeft}</b></div>
    <div class="sk"><label title="${escapeHtml(targetTitle)}">Shift Target</label><b title="${escapeHtml(targetTitle)}">${targetDisplay}</b></div>
    <div class="sk"><label>Count Start</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cstart" value="${cs}" ${rdo}${rdoTitle}></div>
    <div class="sk"><label>Count End</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cend" value="${ce}" ${rdo}${rdoTitle}></div>
    <div class="sk"><label>Total Reject</label><b class="r" data-live="totalReject">${totalReject}</b></div>
    <div class="sk"><label>Total Good</label><b class="g" data-live="totalGood">${good}</b></div>
    <div class="sk"><label>Purge (kg)</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="purge" value="${purge}" ${rdo}${rdoTitle}></div>
    <div class="handover">
      <div class="handover-title">Handover / Journey — supervisor notes</div>
      <div class="handover-grid">
        <label><span>👥 People</span><textarea data-meta="hand-people" placeholder="Staffing, swaps, training, fatigue…" ${rdo}${rdoTitle}>${escapeHtml(h.people)}</textarea></label>
        <label><span>🏭 Plant</span><textarea data-meta="hand-plant" placeholder="Utilities, services, ambient, housekeeping…" ${rdo}${rdoTitle}>${escapeHtml(h.plant)}</textarea></label>
        <label><span>🛠 Machine</span><textarea data-meta="hand-machine" placeholder="Press state, mould, robot, breakdown follow-ups…" ${rdo}${rdoTitle}>${escapeHtml(h.machine)}</textarea></label>
        <label><span>📦 Material</span><textarea data-meta="hand-material" placeholder="Material lot, dryer, regrind, masterbatch…" ${rdo}${rdoTitle}>${escapeHtml(h.material)}</textarea></label>
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
      const datePart = dateKey(d);
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

/**
 * True when the currently-viewed (machine, shift, job) is signed off
 * and the operator therefore can't edit it without a supervisor
 * Unlock. Supervisor sign-in transparently lifts the read-only state
 * so the supervisor can re-open the order via the lock banner's Unlock
 * button. Used to gate every input on the page (status picker, reject
 * cells, Count Start / End, Purge, handover textareas).
 */
function isJobLocked(): boolean {
  return lockInfo() !== null && !isSupervisor();
}

function lockInfo(): { lockedBy: string; lockedAt: string } | null {
  // Lock is scoped to (machine, shift, **job**). A signed-off SFM507017
  // does not lock SFM507018 — the press still has half a shift of run
  // time available and the operator needs to start the next order on
  // the remaining slots. Without the selJob filter the lock banner +
  // every gated edit (Operator/Supervisor fields, status grid via
  // pastLocked) would freeze the whole UI as soon as one job on this
  // shift got signed off.
  if (!S!.selJob) return null;
  for (const r of S!.prod) {
    if (r.jobNumber !== S!.selJob) continue;
    if (r.locked) return { lockedBy: r.lockedBy, lockedAt: r.lockedAt };
  }
  return null;
}

function buildLockBanner(): string {
  const info = lockInfo();
  if (!info) return '';
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  // The Unlock button only shows in supervisor mode — operators see an
  // explanatory note instead so they know who can re-open the shift and
  // why nothing happens when they tap.
  const action = isSupervisor()
    ? `<button type="button" class="lock-unlock-btn" data-unlock>🔓 Unlock</button>`
    : `<span class="lock-no-perm" title="Sign in via 🔓 Supervisor in the top nav to enable Unlock">Supervisor sign-in required</span>`;
  return `<div class="lock-banner">
    <div class="lock-text">
      <b>🔒 Signed off</b>
      <span>by ${escapeHtml(info.lockedBy || '—')}${when ? ' · ' + escapeHtml(when) : ''}</span>
    </div>
    ${action}
  </div>`;
}

function render(): void {
  applyShiftTheme();
  // Preserve the half-hour grid's horizontal scroll position across a
  // re-render — without this, filling slot 12 with R via the status
  // picker re-rendered the operator sheet and snapped the grid back
  // to slot 0, forcing the operator to scroll right again every time
  // on the 10" iPad.
  const prevWrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  const prevScrollLeft = prevWrap?.scrollLeft ?? 0;
  const prevScrollTop = prevWrap?.scrollTop ?? 0;

  const app = document.getElementById('app')!;
  const detail =
    S!.viewLevel === 1
      ? `<div class="op-grid-row">${buildGrid()}${buildSide()}</div>${buildLegend()}`
      : buildSummary();
  app.innerHTML = `<div class="op-sheet">
    ${buildActionBar()}
    ${buildLockBanner()}
    ${buildMeta()}
    ${detail}
  </div>`;
  wire();
  if (S!.viewLevel === 1) {
    const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
    if (wrap) {
      wrap.scrollLeft = prevScrollLeft;
      wrap.scrollTop = prevScrollTop;
    }
    renderNowLine();
  }
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

  // Shift tabs — keep selJob across shift moves: operators commonly
  // carry the same job from Day → Afternoon → Night and shouldn't have to
  // re-pick it. If the new shift has no rows for that job, the grid will
  // just show empty cells. (Day arrows are gone — the date input shows
  // today by default; past days are still reachable via the picker for
  // supervisors reviewing history.)
  app.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.shiftCode = b.dataset.shift as ShiftCode;
      void reload();
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

  // Status cells are picked via the unified hold-and-drag picker — see
  // wireStatusPicker() at the bottom of wire().

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

  // Digits-only sanitiser for every numeric input on the page (D01-D10
  // reject cells, Count Start / End, Purge). `inputmode="numeric"`
  // only hints the on-screen keyboard — an iPad with an attached
  // hardware keyboard, paste, or autofill can still inject '.' / ','
  // / letters, which would land in upsertSlot as NaN. Strip on the
  // `input` event so the value the operator sees and the value we
  // persist always match. Caret position is restored so editing in
  // the middle of a multi-digit count doesn't jump to the end.
  app
    .querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')
    .forEach((inp) =>
      inp.addEventListener('input', () => {
        const cleaned = inp.value.replace(/[^0-9]/g, '');
        if (cleaned === inp.value) return;
        const caret = (inp.selectionStart ?? cleaned.length) - (inp.value.length - cleaned.length);
        inp.value = cleaned;
        try {
          inp.setSelectionRange(caret, caret);
        } catch {
          /* type=number / browser rejection — caret restore is best-effort */
        }
      }),
    );

  // Buttons
  app.querySelector('[data-refresh]')?.addEventListener('click', () => void refreshAll());
  app.querySelector('[data-saveclear]')?.addEventListener('click', () => openSaveSignoffModal());
  app.querySelector('[data-unlock]')?.addEventListener('click', () => openUnlockModal());
  wireStatusPicker();
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
        void reload();
      }
      break;
    }
    case 'machine':
      S!.mc = val;
      // Machine change does clear selJob: a different press generally runs
      // a different order, and carrying the previous job number across
      // machines tends to mask the empty grid rather than help.
      S!.selJob = '';
      summaryCache = null; // cache is per-machine
      void reload();
      break;
    case 'job':
      S!.selJob = val;
      saveView();
      render();
      break;
    case 'operator':
      S!.selOperator = val;
      saveView();
      void upsertSlot(0, (r) => {
        r.operator = val;
      });
      break;
    case 'supervisor':
      S!.selSupervisor = val;
      saveView();
      void upsertSlot(0, (r) => {
        r.supervisor = val;
      });
      break;
    case 'purge':
    case 'cstart':
    case 'cend': {
      // Same race-protection as the handover textareas — a full reload
      // after each blur destroys the focused input the operator is
      // typing into next, e.g. tabbing from Count Start straight into
      // Count End would lose the second number when the first reload
      // re-rendered. upsertSlotNoReload keeps S!.prod in sync without
      // triggering render().
      const field = key as 'purge' | 'cstart' | 'cend';
      void upsertSlotNoReload(0, (r) => {
        // Force integer storage to match the digits-only keyboard /
        // sanitiser — Purge had been accepting decimals; the rest were
        // already conceptually whole counts.
        const v = val === '' ? null : Math.max(0, Math.floor(Number(val) || 0));
        if (field === 'purge') r.purgeKg = v;
        else if (field === 'cstart') r.countStart = v;
        else r.countEnd = v;
      });
      // Job Left / Total Good in the side panel depend on these numbers
      // but won't refresh without a render. Recompute the job total and
      // touch the visible cells directly so the operator still sees a
      // live total without losing focus.
      void refreshJobTotalAndPaintSide();
      break;
    }
    case 'hand-people':
    case 'hand-plant':
    case 'hand-machine':
    case 'hand-material': {
      const field = key.slice('hand-'.length) as 'people' | 'plant' | 'machine' | 'material';
      // Skip reload: a full re-render would destroy the textarea the operator
      // just tabbed into, losing whatever they're typing there.
      void upsertSlotNoReload(0, (r) => {
        const obj = parseHandover(r);
        obj[field] = val;
        r.handoverNote = JSON.stringify(obj);
      });
      break;
    }
  }
}

function parseHandover(r: ProductionRecord | undefined): Handover {
  return sharedParseHandover(r?.handoverNote);
}

/**
 * Refresh (§7): re-read PMD_Planning from SharePoint and recompute the
 * cross-shift Good total. The Excel→Planning sync itself is handled by
 * a Power Automate flow on the server (see docs/DEPLOYMENT.md § C) —
 * the in-browser Graph path can't reliably read PMD_Schedule_master
 * (10MB+ workbook with VLOOKUPs/macros times out at 504), so we don't
 * even try.
 */
async function refreshAll(): Promise<void> {
  S!.planning = await dalRef.listPlanning({});
  summaryCache = null;
  await reload();
  toast(`Refreshed · ${shiftOrders().length} job(s) for this shift`, 'ok');
}

/**
 * Sign-off + Save in one modal (§5). Replaces the separate checkbox.
 * Pre-flight = same gates as the .bas btnSaveAndClear_Click:
 *   - Supervisor selected
 *   - Machine Status has at least one filled slot (a shift with no
 *     status timeline records nothing useful and writes an empty
 *     header that later reads back as a blank, confusing record)
 *   - Count Start AND Count End are both entered — explicitly. Zero
 *     is valid data ("counter reset / no parts"); a blank field is
 *     not, because we can't tell "no parts" from "forgot to fill in".
 *   - countEnd >= countStart
 * Confirming locks the shift records and clears the in-form selection.
 */
function openSaveSignoffModal(): void {
  if (!S!.selSupervisor) {
    toast('Pick a Supervisor before signing off', 'err');
    return;
  }
  const hasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (!hasStatus) {
    toast('Machine Status is empty — fill in at least one time slot before signing off', 'err');
    return;
  }
  const c = canonical();
  if (c?.countStart == null || c?.countEnd == null) {
    toast('Count Start and Count End are required — enter 0 if no parts were counted', 'err');
    return;
  }
  const cs = Number(c.countStart);
  const ce = Number(c.countEnd);
  if (ce < cs) {
    toast('Count End must be ≥ Count Start', 'err');
    return;
  }
  const totalRej = jobTotals();
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

// ---------- Unified status picker (tap or hold-and-drag) ----------

function wireStatusPicker(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;

  // iPad Safari does not always report e.pressure > 0 during a finger
  // drag — guarding pointermove on pressure caused multi-select to fail
  // silently on the very devices we ship to. Use an explicit isDown flag
  // (set on pointerdown, cleared on pointerup / cancel / lostcapture)
  // and rely on the browser's pointer-capture to keep the events arriving
  // even when the finger drifts outside the original cell.
  let anchor: number | null = null;
  let isDown = false;
  let dragged = false;

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

  const release = (e?: PointerEvent): void => {
    if (e) {
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        /* not captured by this target — fine */
      }
    }
    isDown = false;
  };

  wrap.addEventListener('pointerdown', (e) => {
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null) return;
    // Signed-off shifts: no slot picker, no drag-range, nothing —
    // operator gets a one-shot toast explaining how to re-open it.
    if (isJobLocked()) {
      toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
      return;
    }
    anchor = slot;
    isDown = true;
    dragged = false;
    S!.selSet = new Set<number>([slot]);
    paintSelection();
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture optional */
    }
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!isDown || anchor == null) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null || slot === anchor) return;
    dragged = true;
    setRange(anchor, slot);
  });

  const finish = (e: PointerEvent): void => {
    if (anchor == null) {
      release(e);
      return;
    }
    release(e);
    anchor = null;
    // Open picker for both single-tap (selSet.size==1) and drag-range cases —
    // single tap is the most common path so it shouldn't need an extra click.
    if (S!.selSet.size > 0) openStatusPicker(dragged);
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', (e) => {
    release(e);
    anchor = null;
    S!.selSet.clear();
    paintSelection();
  });
  wrap.addEventListener('lostpointercapture', () => {
    isDown = false;
  });

  paintSelection();
}

function paintSelection(): void {
  document.querySelectorAll<HTMLElement>('[data-slot][data-row="status"]').forEach((el) => {
    const slot = Number(el.dataset.slot);
    const td = el.closest<HTMLElement>('.status-cell');
    if (!td) return;
    if (S!.selSet.has(slot)) td.classList.add('multisel');
    else td.classList.remove('multisel');
  });
}

/** Find the most recent filled slot with index < min(selSet). */
function previousFilled(beforeSlot: number): ProductionRecord | undefined {
  for (let i = beforeSlot - 1; i >= 0; i--) {
    const r = slotRec(i);
    if (r && r.statusCode) return r;
  }
  return undefined;
}

function openStatusPicker(isRange: boolean): void {
  if (S!.selSet.size === 0) return;
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    S!.selSet.clear();
    paintSelection();
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
  const title = isRange || slots.length > 1
    ? `🖌 Set status — ${slots.length} slots`
    : `Set status — slot ${slots[0] + 1}/${SLOTS_PER_SHIFT} (${slotClock(sid(), slots[0])})`;
  const slotsLine = slots.length > 1
    ? `<p class="bd-sub">Slots: ${slots.map((s) => `${s + 1}`).join(', ')}</p>`
    : '';

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">${title}</h2>
    ${slotsLine}
    ${sameAsPrev ? `<div class="bd-cause-list">${sameAsPrev}</div>` : ''}
    <div class="ab-grid">${pills}</div>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-clear>↺ Clear (back to blank)</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const cancel = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', cancel);
  mc.querySelector('[data-clear]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, '' as StatusCode, '', '');
  });
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
  toast(`Filled ${slots.length} slot${slots.length === 1 ? '' : 's'} with ${code}`, 'ok');
  // Skip reload() here. upsertSlotNoReload already mutated S!.prod in
  // memory, and a status edit cannot change anything reload() would
  // re-fetch — Job Left / Total Good are driven by Count Start/End and
  // Rejects, not by status; maybeCarryCountStart is a no-op once it's
  // already been carried; refreshJobTotal sums canonical countEnd
  // across shifts which a status edit doesn't touch. Skipping the SP
  // round-trip turns the iPad lag on "fill a status cell" from
  // 600-800 ms (REST + render) down to a single render.
  render();
  // Kick a live snapshot push so other iPads see the new status pattern
  // without waiting up to 60 s for the next poll tick. Fire-and-forget.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
}

/** Like upsertSlot but doesn't call reload — caller batches the final render. */
async function upsertSlotNoReload(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) return;
  // Same guard as upsertSlot — the side panel inputs are wired to
  // upsertSlotNoReload (Count Start / End / Purge / handover) and
  // must not write when the order is signed off and the user isn't
  // a supervisor.
  if (isJobLocked()) return;
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
  // Same sync-update as upsertSlot — keeps S!.prod consistent for the next
  // hand-* event without triggering a render() that would destroy the
  // textarea the operator is currently typing into.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}

async function doSignoffSave(): Promise<void> {
  try {
    // Scope sign-off to the order being reviewed: another job already
    // running on this press's remaining timeline slots (operator
    // started the next order mid-shift) must stay live and editable.
    await dalRef.lockShift(S!.mc, sid(), S!.selSupervisor, S!.selOperator, S!.selJob || undefined);
    closeModal();
    toast(`Signed off · ${S!.selJob || 'shift'} saved to Master`, 'ok');
    // Keep selJob: the next shift on the same job continues seamlessly
    // (operator keeps clicking ▶ to advance). Matches how Machine sticks
    // across shift navigation.
    // Supervisor sign-in is intentionally per-action: once a shift is
    // signed off and saved, the supervisor's elevated permission ends
    // automatically. They need to sign in again from the top nav for
    // the next unlock.
    if (isSupervisor()) clearSupervisor();
    await reload();
  } catch (e) {
    // Surface the actual SP/Graph failure so we don't blindly blame "network".
    // The full stack is in console; toast shows the first line for triage.
    console.error('[signoff] lockShift failed:', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Save failed: ${msg.slice(0, 140)}`, 'err');
  }
}

function openUnlockModal(): void {
  const info = lockInfo();
  if (!info) return;
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  openModal(`<div class="bd-modal">
    <h3 class="bd-title">🔓 Unlock this shift?</h3>
    <p class="bd-sub">
      Signed off by <b>${escapeHtml(info.lockedBy || '—')}</b>${when ? ' at ' + escapeHtml(when) : ''}.
      Unlocking lets operators edit the shift again. Someone must sign it off
      a second time once the changes are done — otherwise the master roll-up
      won't include the new numbers.
    </p>
    <div class="bd-actions">
      <button type="button" class="btn-ghost-big" data-mod="cancel">Cancel</button>
      <button type="button" class="btn-primary-big" data-mod="confirm">🔓 Unlock</button>
    </div>
  </div>`);
  document.querySelector('[data-mod="cancel"]')?.addEventListener('click', () => closeModal());
  document.querySelector('[data-mod="confirm"]')?.addEventListener('click', () => void doUnlock());
}

async function doUnlock(): Promise<void> {
  try {
    // Scope the unlock to the currently-viewed job so other signed-off
    // orders on the same shift stay locked — supervisor is unlocking
    // the order they're looking at, not the whole press.
    await dalRef.unlockShift(S!.mc, sid(), S!.selJob || undefined);
    closeModal();
    toast(
      S!.selJob
        ? `Unlocked ${S!.selJob}. Make your fixes, then sign off again.`
        : 'Shift unlocked. Make your fixes, then sign off again.',
      'ok',
    );
    await reload();
  } catch (e) {
    console.error('[unlock] failed', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Unlock failed: ${msg.slice(0, 140)}`, 'err');
  }
}

function jobTotals(): number {
  let rej = 0;
  for (const r of S!.prod.filter((x) => x.jobNumber === S!.selJob)) {
    const obj = parseRejects(r);
    rej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  }
  return rej;
}

export async function renderOperator(
  dal: PmdDataLayer,
  machineCode: string,
  now: Date = new Date(),
): Promise<void> {
  dalRef = dal;
  const [machines, planning, operators, supervisors, rcats, dieColorList] = await Promise.all([
    dal.listMachines(),
    dal.listPlanning({}),
    dal.listOperators(),
    dal.listSupervisors(),
    dal.listRejectCategories(),
    dal.listProductDieColors ? dal.listProductDieColors() : Promise.resolve([]),
  ]);
  // Key by upper-trimmed Part # so the swatch lookup is tolerant of
  // case / whitespace drift between PMD_ProductDieColor and
  // Planning.csv's JobHead_PartNum.
  const dieColors = new Map(
    dieColorList.map((c) => [
      c.partNumber.trim().toUpperCase(),
      { hex: c.hex, name: c.name },
    ]),
  );
  const cs = currentShift(now);
  const vd = new Date(now);
  vd.setHours(0, 0, 0, 0);

  // Resume the last per-tab view if the URL machine matches it. The route's
  // machineCode wins (operator deep-linked to a specific press), but date
  // / shift / selJob / selected operator+supervisor come back from
  // sessionStorage so an inadvertent tap on KPIs and back doesn't reset
  // their context.
  const saved = loadView();
  const startMc = machineCode || saved?.mc || machines[0]?.machineCode || '';
  let viewDate = vd;
  let shiftCode = cs.code;
  let selJob = '';
  let selOperator = '';
  let selSupervisor = '';
  if (saved && saved.mc === startMc) {
    const d = new Date(saved.viewDateIso);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      viewDate = d;
    }
    if (saved.shiftCode) shiftCode = saved.shiftCode;
    if (saved.selJob) selJob = saved.selJob;
    if (saved.selOperator) selOperator = saved.selOperator;
    if (saved.selSupervisor) selSupervisor = saved.selSupervisor;
  }

  S = {
    mc: startMc,
    viewDate,
    shiftCode,
    selJob,
    prod: [],
    planning,
    machines,
    operators: operators.map((o) => o.operatorName),
    supervisors: supervisors.map((s) => s.operatorName),
    rejCats: rcats,
    selOperator,
    selSupervisor,
    viewLevel: 1,
    jobTotalGood: 0,
    selSet: new Set<number>(),
    dieColors,
  };
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(renderNowLine, 30_000);
  await reload();
}

export function operatorPollTick(): void {
  if (!S) return;
  renderNowLine();
  // Best-effort cross-iPad visibility: push this iPad's editCache to
  // PMD_Production as a "live snapshot" so the Live Status view on
  // every other iPad picks up what we're doing right now. The DAL
  // call is fire-and-forget and won't slow the now-line refresh.
  if (dalRef.pushLiveSnapshot) {
    void dalRef.pushLiveSnapshot().catch(() => {
      /* logged inside the DAL; never propagate to the poll loop */
    });
  }
}
