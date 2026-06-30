import type { PmdDataLayer } from '../dal';
import type {
  Machine,
  Operator,
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
import { cavityGross } from '../core/metrics';
import { partsCoRun } from '../core/corun';
// Re-exported so existing importers (Trace view, tests) can keep pulling
// these from ./operator while the canonical definitions live in core.
import { jobLeftPiecesFor, shiftTargetFor } from '../core/targets';
export { jobLeftPiecesFor, shiftTargetFor } from '../core/targets';
import { bdLabelFor } from '../core/breakdown';
import { type Handover, parseHandover as sharedParseHandover } from '../core/handover';
import { openBreakdownCascade } from './breakdown';
import { toast } from './toast';
import { closeModal, escapeHtml, openModal } from './modal';
import { renderOutputRejectChart } from './charts';
import { clearSupervisor, isSupervisor } from './supervisor-auth';
import { isIpadDevice } from '../core/device';

/**
 * Device-class write rule (replaces the old per-device OwnerDevice claim
 * arbitration which caused fights between iPads on the floor):
 *   iPad → writable (it's the on-floor data-entry device)
 *   anything else → read-only, unless supervisor mode is signed in
 * Memoised iPad detection + live supervisor session → re-evaluated on
 * every call so a supervisor sign-in flips the UI immediately.
 */
function canWriteThisDevice(): boolean {
  return isIpadDevice() || isSupervisor();
}

/** Presses that can run a multi-cavity die — the only machines that show the
 *  Cavities dropdown on the operator sheet. Everywhere else the count is taken
 *  at face value (1 cavity). Edit this set if a die moves to another press. */
const CAVITY_MACHINES = new Set(['550T', '320T', '150T', '125T']);

/** Selectable cavity counts. A die makes this many identical parts per press
 *  cycle, so Total Good = (Count End − Count Start) × cavities − Reject. */
const CAVITY_OPTIONS = [1, 2, 4, 8];

function machineHasCavityOption(mc: string): boolean {
  return CAVITY_MACHINES.has(mc.trim());
}

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
  /** Full roster objects (carry .shift) so the dropdowns can narrow to
   *  the selected shift's people — see rosterNames(). */
  operators: Operator[];
  supervisors: Operator[];
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
  /** Part # → die / paint hex colour + physical die number, read from
   *  PMD_ProductDieColor on boot. Drives the swatch on the Product
   *  Description meta cell + the Die# pill so the operator can see the
   *  colour and which die to fit before starting the job. */
  dieColors: Map<string, { hex: string; name: string; dieNumber: string; coRun: boolean }>;
}

let S: OpState | null = null;
let dalRef: PmdDataLayer;
let nowTimer: ReturnType<typeof setInterval> | undefined;
// Guard against a double Sign Off. On a laggy iPad the supervisor used
// to tap the confirm button repeatedly (no feedback while lockShift's
// slow network round-trip ran) — each tap fired a fresh lockShift, and
// because editCache is cleared only at the END of lockShift the MERGE
// lookup couldn't see the in-flight POSTed row yet, so every tap POSTed
// a NEW PMD_Production row (SFM507208 landed 11× identical). The confirm
// button is also disabled on click; this flag is the belt-and-braces.
let signoffInFlight = false;

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
  return blankRecordForJob(slot, S!.selJob);
}

function blankRecordForJob(slot: number, job: string): ProductionRecord {
  const iso = new Date().toISOString();
  // Resolve the order for this job once so the slot carries
  // JobHead_PartNum — PMD_Production / PMD_LiveStatus persist the
  // colour-lookup key per row instead of relying on a planning join.
  // orderForJob() prefers PMD_Production for past shifts, so a
  // supervisor editing history still stamps the recorded Part #
  // rather than a blank (planning has long dropped the order).
  const order = orderForJob(job);
  const rec: ProductionRecord = {
    id: 0,
    machineCode: S!.mc,
    shiftId: sid(),
    jobNumber: job,
    partNumber: order?.partNumber ?? '',
    // Carry cycle time so it persists through editCache → sign-off even
    // if Epicor drops the order from planning before the shift is signed.
    cycleTime: order?.qtyPerHr ?? 0,
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
    qcBy: '',
    locked: false,
    lockedBy: '',
    lockedAt: '',
    createdAt: iso,
    updatedAt: iso,
  };
  // Freeze Job Left + Shift Target on the canonical slot the moment the
  // job starts on this (machine, shift). jobTotalGood is the Good already
  // made on every OTHER shift of the job, so order total − that = "how
  // many were still needed when this shift began". Frozen here (not
  // recomputed at sign-off) so it survives re-sign-off and out-of-order
  // edits, and so Trace can read demand-at-start per row. Live shifts
  // only — a supervisor editing a PAST shift clones the existing row
  // (which already carries its original frozen value) rather than
  // re-freezing against today's totals.
  // Only the SELECTED job freezes here: S!.jobTotalGood is the
  // cross-shift Good for the selected job, so freezing a co-run sibling
  // (created by the status mirror / seed) against it would use the wrong
  // total. The sibling instead gets its own freeze from
  // ensureJobLeftFrozen() when the operator opens it.
  if (slot === 0 && job === S!.selJob && order && !isPastShift()) {
    const jl = jobLeftPiecesFor(order, S!.jobTotalGood);
    if (jl != null) {
      rec.jobLeft = jl;
      const st = shiftTargetFor(order, jl);
      if (st != null) rec.shiftTarget = st;
    }
  }
  return rec;
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
  const historicalOrder = (j: string): PlanningOrder => {
    // Pull every denormalised field PMD_Production carries — the
    // canonical (slot 0) row is the truth for past shifts. Other
    // shifts on the same job (different machine / different shift)
    // also contribute partNumber via .find() so the dropdown still
    // names the part even if THIS shift's slot 0 hasn't been
    // canonical-row-ified yet.
    const canon = S!.prod.find((r) => r.jobNumber === j && r.slotIndex === 0);
    const anySlot = canon ?? S!.prod.find((r) => r.jobNumber === j);
    return {
      id: 0,
      jobNumber: j,
      machineCode: '',
      originalMachine: '',
      partNumber: anySlot?.partNumber ?? '',
      partDescription: canon?.partDescription ?? '(historical)',
      plannedStart: '',
      plannedEnd: '',
      // PMD_Production denormalises the order total into its JobRequired
      // column (see ProductionRecord.jobRequired) — surface it as both the
      // Order Qty total and the Job Left basis for orders Epicor has dropped.
      orderQty: canon?.jobRequired ?? 0,
      jobRequired: canon?.jobRequired ?? 0,
      // CycleTime persisted at sign-off → Shift Target recomputes for a
      // historical order even after Epicor drops it from planning.
      qtyPerHr: canon?.cycleTime ?? 0,
      duration: 0,
      released: false,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
    };
  };

  // Past shifts: only show the jobs actually worked on — the planning list
  // reflects current Epicor state and would otherwise drown the dropdown
  // with unrelated active orders.
  if (isPastShift()) {
    return historicalIds.map(historicalOrder);
  }

  // Active / future shift: filter to the orders whose [plannedStart,
  // plannedEnd] window overlaps a 2-day horizon starting at the
  // viewed date (i.e. today + tomorrow on a live shift). Epicor
  // releases far more orders than a press will touch in one shift,
  // and operators were scrolling past dozens of irrelevant entries
  // to find the order in front of them. With JobHead_StartTime now
  // layered onto JobHead_StartDate, the window is precise enough
  // that "next two days" actually means it.
  //
  // Orders missing a plannedStart (rare: legacy CSV row) fall
  // through the filter so the operator can still pick them.
  // Sorted plannedStart-ascending so the next-to-run order is at
  // the top of the dropdown.
  const windowStart = new Date(S!.viewDate);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 2);
  windowEnd.setHours(23, 59, 59, 999);
  const ws = windowStart.getTime();
  const we = windowEnd.getTime();
  const planned = S!.planning
    .slice()
    .filter((o) => {
      if (!o.plannedStart) return true;
      const s = Date.parse(o.plannedStart);
      if (!isFinite(s)) return true;
      const e = o.plannedEnd ? Date.parse(o.plannedEnd) : s;
      // Standard interval overlap: order is kept when its window
      // touches the horizon at any point.
      return s <= we && (!isFinite(e) || e >= ws);
    })
    .sort(
      (a, b2) =>
        new Date(a.plannedStart).getTime() - new Date(b2.plannedStart).getTime(),
    );
  const knownIds = new Set(planned.map((o) => o.jobNumber));
  const extras = historicalIds.filter((j) => !knownIds.has(j)).map(historicalOrder);
  return [...planned, ...extras];
}

function selectedOrder(): PlanningOrder | undefined {
  return orderForJob(S!.selJob);
}

/**
 * Resolve the PlanningOrder for an arbitrary job on the current view
 * (not just the selected one) — needed so the co-run mirror / seed can
 * stamp a sibling order's Part# / cycle time / Job-Left freeze. Same
 * precedence as the old selectedOrder: live/future shift prefers the
 * planning CSV (current Epicor state), past shift / dropped order falls
 * back to the denormalised PMD_Production rows in S!.prod.
 */
function orderForJob(job: string): PlanningOrder | undefined {
  if (!job) return undefined;
  // Planning.csv reflects the CURRENT Epicor state — it is only relevant
  // to the live and future shifts. Viewing a PAST shift/date means
  // "review what was actually recorded", so the order must be rebuilt
  // from PMD_Production (the List is the source of truth for history),
  // exactly like Trace's Job Number Search. Consulting planning here
  // would show today's remaining qty / cycle time against a shift that
  // ran days ago, and would disagree with Trace for the same tuple.
  if (!isPastShift()) {
    const fromPlanning = S!.planning.find((o) => o.jobNumber === job);
    if (fromPlanning) return fromPlanning;
  }
  // Synthetic order rebuilt from the PMD_Production rows already in
  // S!.prod. This is the only path for a past shift, and also the
  // present/future fallback for orders Epicor has dropped from active
  // planning (completed in ERP) but that the operator / supervisor is
  // reviewing or unlocking — the header bar (Order Qty / Part# / Product
  // Description) must still show the real denormalised values, not blanks.
  const canon = S!.prod.find(
    (r) => r.jobNumber === job && r.slotIndex === 0,
  );
  const anySlot = canon ?? S!.prod.find((r) => r.jobNumber === job);
  if (!anySlot) return undefined;
  return {
    id: 0,
    jobNumber: job,
    machineCode: anySlot.machineCode,
    originalMachine: '',
    partNumber: anySlot.partNumber ?? '',
    // partDescription / jobRequired are denormalised on slot 0 of
    // PMD_Production rows. Both default to '' / 0 when the tenant
    // hasn't added the corresponding column yet — the header shows
    // a blank / em-dash in that case, which is the same fallback
    // behaviour an order had pre-redesign.
    partDescription: canon?.partDescription ?? '',
    plannedStart: '',
    plannedEnd: '',
    orderQty: canon?.jobRequired ?? 0,
    jobRequired: canon?.jobRequired ?? 0,
    // CycleTime persisted at sign-off → Shift Target recomputes for a
    // past shift even after Epicor drops the order from planning.
    qtyPerHr: canon?.cycleTime ?? 0,
    duration: 0,
    released: false,
    isDieChange: false,
    manuallyAdded: true,
    source: 'Manual',
  };
}

function slotRec(slot: number): ProductionRecord | undefined {
  return S!.prod.find((r) => r.jobNumber === S!.selJob && r.slotIndex === slot);
}

/**
 * The earliest other-job row on (machine, shift) that already covers
 * this slot with a Machine Status, or null when this slot is free. Used
 * to lock cross-job overlap: once SFM507103 has been signed off with
 * R 15:00-16:00, picking SFM506888 must NOT let the operator overwrite
 * 15:00 with a second R block. Signed-off rows always block;
 * still-being-edited other jobs block too (the press can only be in one
 * state per slot — two operators sharing one press is a data error,
 * not a feature).
 */
function occupyingOtherJob(slot: number): ProductionRecord | null {
  for (const r of S!.prod) {
    if (r.slotIndex !== slot) continue;
    if (r.jobNumber === S!.selJob) continue;
    if (!r.statusCode) continue;
    // Co-running orders share one die on the same press, so they
    // legitimately occupy the SAME half-hour with the SAME machine
    // status — don't treat a co-runner as a blocking occupier. The
    // status is mirrored across the group, so the selected job has its
    // own copy on this slot anyway.
    if (coRunsWith(r.jobNumber, S!.selJob)) continue;
    return r;
  }
  return null;
}

// ---- Co-running orders (one die → 2-3 parts at once) ----------------
// A single die can run multiple parts simultaneously on one press, so
// the same (machine, shift) legitimately has 2-3 orders running at the
// exact same time. They share ONE machine-status timeline (it's the
// press) but keep their own Count Start/End, Rejects, Job Left and
// sign-off. Grouping is automatic by DieNumber (PMD_ProductDieColor) —
// no new UI, no new SP column. The status entered on any one of them is
// mirrored across the group; everything else stays per-order.

/** Part # for any job on the current view — from its PMD_Production
 *  rows first, then the planning CSV. */
function partNumberForJob(job: string): string {
  if (!job) return '';
  const fromProd = S!.prod.find((r) => r.jobNumber === job && r.partNumber)?.partNumber;
  if (fromProd) return fromProd;
  return S!.planning.find((o) => o.jobNumber === job)?.partNumber ?? '';
}

/** The PMD_ProductDieColor row for a job's part, or undefined. */
function dieRowForJob(job: string): { dieNumber: string; coRun: boolean } | undefined {
  const pn = partNumberForJob(job).trim().toUpperCase();
  if (!pn) return undefined;
  return S!.dieColors.get(pn);
}

/**
 * Two jobs co-run when they share the same non-empty die AND both parts
 * are flagged CoRun = Yes in PMD_ProductDieColor. The die match alone is
 * not enough: different colours share a die and are often scheduled
 * one-after-another rather than simultaneously, so the floor manually
 * marks the genuinely-simultaneous parts with CoRun. Only then does the
 * operator sheet mirror their machine status.
 */
function coRunsWith(jobA: string, jobB: string): boolean {
  if (!jobA || !jobB || jobA === jobB) return false;
  return partsCoRun(dieRowForJob(jobA), dieRowForJob(jobB));
}

/** Distinct OTHER jobs already recorded on this (machine, shift) that
 *  share the given job's die — the mirror targets. Signed-off siblings
 *  are excluded (we never write into a locked order). */
function coRunSiblings(job: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of S!.prod) {
    const j = r.jobNumber;
    if (!j || j === job || seen.has(j)) continue;
    if (!coRunsWith(j, job)) continue;
    seen.add(j);
    if (S!.prod.some((x) => x.jobNumber === j && x.locked)) continue;
    out.push(j);
  }
  return out;
}

function canonical(): ProductionRecord | undefined {
  return slotRec(0);
}

/**
 * True when the currently-selected job has meaningful in-progress data
 * that has NOT been signed off yet — i.e. leaving it now would strand
 * the JobLeft snapshot (it only lands in PMD_Production at sign-off).
 * Used to block a Job# / shift / machine switch until the operator
 * signs the current order off (per floor policy: every worked order
 * must be signed off before moving on, so Trace gets accurate Job Left).
 * Never fires on read-only devices (can't sign off anyway), past shifts
 * (history review, not the live production flow), or when a supervisor
 * is signed in — supervisors can unlock the discipline and navigate
 * freely to correct data.
 */
function currentJobNeedsSignoff(): boolean {
  if (!S!.selJob) return false;
  if (isReadOnlyDevice()) return false;
  if (isPastShift()) return false;
  if (isSupervisor()) return false; // supervisor unlocks the discipline
  const c = canonical();
  if (c?.locked) return false; // already signed off — data is safe
  const hasStatus = S!.prod.some((r) => r.jobNumber === S!.selJob && r.statusCode);
  const hasCounts = c?.countStart != null || c?.countEnd != null;
  return hasStatus || hasCounts;
}

/**
 * Modal that blocks navigation away from an unsigned in-progress order
 * and routes the operator straight into Sign Off & Save. "Cancel" keeps
 * them on the current order (the switch is abandoned).
 */
function promptSignoffBeforeLeaving(): void {
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">✋ Sign off the current order first</h2>
    <p class="bd-sub">Order <b>${escapeHtml(S!.selJob)}</b> has in-progress data that hasn't been signed off. Sign off &amp; Save it before switching — otherwise its Job Left isn't recorded.</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-stay>Cancel</button>
      <button class="btn-primary-big" data-go-signoff>Sign off &amp; Save</button>
    </div>
  </div>`);
  mc.querySelector('[data-stay]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-go-signoff]')?.addEventListener('click', () => {
    closeModal();
    openSaveSignoffModal();
  });
}

/**
 * Empty Machine-Status slots that must be filled before the selected
 * job can be signed off (floor policy: no gaps up to the current
 * half-hour for a live shift, or all 16 for a past shift). A slot held
 * by ANOTHER job on the same press counts as satisfied — it's that
 * job's responsibility, not this one's. When a different job takes over
 * the press right after this job's last slot, this job's run is
 * considered finished there and only its own slots are required to be
 * gap-free; otherwise (this is the only / last job) coverage must reach
 * the live cutoff. Assumes the caller already verified the job has at
 * least one filled slot. Returns 0-based slot indices.
 */
function slotGapsForSignoff(): number[] {
  const mineFilled = (i: number): boolean =>
    S!.prod.some((r) => r.jobNumber === S!.selJob && r.slotIndex === i && r.statusCode);
  let lastMine = -1;
  for (let i = 0; i < SLOTS_PER_SHIFT; i++) if (mineFilled(i)) lastMine = i;
  const globalCutoff = isPastShift()
    ? SLOTS_PER_SHIFT - 1
    : currentSlotIndex(sid(), new Date()) ?? SLOTS_PER_SHIFT - 1;
  // Did another job take over the press after this job's last slot?
  let otherTakesOver = false;
  for (let i = lastMine + 1; i < SLOTS_PER_SHIFT; i++) {
    if (occupyingOtherJob(i)) {
      otherTakesOver = true;
      break;
    }
  }
  const cutoff = otherTakesOver ? lastMine : globalCutoff;
  const gaps: number[] = [];
  for (let i = 0; i <= cutoff; i++) {
    if (mineFilled(i)) continue;
    if (occupyingOtherJob(i)) continue;
    gaps.push(i);
  }
  return gaps;
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
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
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
  hydrateOperatorSupervisor();
  // Count Start auto-carry: a same-machine/same-job continuation from
  // the previous shift starts where the previous shift's counter ended
  // — Day 14000 → Afternoon 14000 (Count Start) → Afternoon 28000 (End)
  // → Night 28000 (Count Start). Only fires when the operator hasn't
  // typed anything yet (count Start null on the live shift) and we
  // have a non-null Count End from the immediately-preceding shift on
  // the same machine + job.
  await maybeCarryCountStart();
  await refreshJobTotal();
  await seedStatusFromCoRunner();
  ensureJobLeftFrozen();
  saveView();
  render();
}

/**
 * When the operator opens an order that shares a die with one already
 * running this shift but has no machine status of its own yet, copy the
 * co-runner's timeline into it — they run together off the same die, so
 * the new order inherits the same status pattern. Only seeds a live,
 * writable, unsigned order that is genuinely empty (so it never
 * overwrites a status the operator has already entered, and never runs
 * on a past-shift review).
 */
async function seedStatusFromCoRunner(): Promise<void> {
  if (!S!.selJob || isPastShift() || isReadOnlyDevice() || isJobLocked()) return;
  const mineHasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (mineHasStatus) return;
  // Find a co-running sibling that DOES have a timeline to copy from.
  const sib = coRunSiblings(S!.selJob).find((j) =>
    S!.prod.some((r) => r.jobNumber === j && r.statusCode),
  );
  if (!sib) return;
  const sibSlots = S!.prod.filter((r) => r.jobNumber === sib && r.statusCode);
  for (const sr of sibSlots) {
    await upsertSlotForJob(S!.selJob, sr.slotIndex, (r) => {
      r.statusCode = sr.statusCode;
      r.bdIssue = sr.bdIssue;
      r.mangoTicket = sr.mangoTicket;
    });
  }
}

/**
 * Ensure the selected live order has Job Left / Shift Target frozen on
 * its canonical row. The normal path freezes in blankRecordForJob at
 * creation, but a co-run sibling's slot 0 is created by the mirror /
 * seed (which can't know that sibling's cross-shift Good), so its freeze
 * is deferred to here — by now refreshJobTotal() has computed
 * S!.jobTotalGood for the selected job, so the value is correct.
 */
function ensureJobLeftFrozen(): void {
  if (isPastShift() || isReadOnlyDevice() || isJobLocked()) return;
  const c = canonical();
  if (!c || c.locked || c.jobLeft != null) return;
  const order = selectedOrder();
  if (!order) return;
  const jl = jobLeftPiecesFor(order, S!.jobTotalGood);
  if (jl == null) return;
  void upsertSlotNoReload(0, (r) => {
    r.jobLeft = jl;
    const st = shiftTargetFor(order, jl);
    if (st != null) r.shiftTarget = st;
  });
}

/** True when THIS browser is forbidden from writing — non-iPad without
 *  supervisor sign-in. Distinct from isJobLocked() (a signed-off row);
 *  this is a device-class lock that applies to every shift/job opened
 *  here, past or live. Replaces the old per-device OwnerDevice claim
 *  arbitration which caused iPad-vs-iPad fights on the floor. */
function isReadOnlyDevice(): boolean {
  return !canWriteThisDevice();
}

/**
 * Operator / Supervisor always mirror the selected (machine, shift, job)
 * tuple's canonical slot-0 record — never a selection left over from a
 * previously-viewed date, machine, or order. Reported bug: switching to a
 * past shift kept the live selection, and switching back to today's order
 * showed an edited name instead of the one already chosen for that order.
 *
 * When the tuple has a canonical row (signed-off, unlocked, or a live shift
 * where someone has been picked), load its names; otherwise blank both —
 * nobody has been assigned to this tuple yet. Picking a name in the dropdown
 * writes slot 0 (onMetaChange), so the choice survives the reload that
 * follows and every subsequent slot edit (upsertSlot preserves slot 0's
 * operator/supervisor), which is why an unconditional load never wipes an
 * active operator's own selection.
 */
function hydrateOperatorSupervisor(): void {
  const c = canonical();
  S!.selOperator = c?.operator ?? '';
  S!.selSupervisor = c?.supervisor ?? '';
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
    // '-￿' suffix keeps same-day shifts inside the range: shiftIds are
    // 'YYYY-MM-DD-<code>' and a bare 'YYYY-MM-DD' upper bound sorts
    // BEFORE them, which silently dropped the Day shift when carrying
    // Count Start into the same day's Afternoon / Night shift.
    shiftIdTo: `${dateKey(S!.viewDate)}-￿`,
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
  if (!o) return null;
  const c = canonical();
  const grossThis = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, c?.cavities);
  const goodThis = Math.max(0, grossThis - jobTotals());
  return jobLeftPiecesFor(o, S!.jobTotalGood + goodThis);
}

/** Cavities frozen on the selected job's canonical row (1 when unset). */
function cavities(): number {
  const v = canonical()?.cavities;
  return v && v > 0 ? v : 1;
}

/**
 * Shift Target = pieces the operator should aim for this shift.
 * Thin wrapper over the shared core formula; see core/targets.ts.
 */
function shiftTarget(): number | null {
  const o = selectedOrder();
  if (!o) return null;
  const jl = jobLeftPieces();
  if (jl == null) return null;
  return shiftTargetFor(o, jl);
}

/**
 * Job Left = JobRequired − sum(Good) across all OTHER shifts of this job.
 * The current (S!.mc, sid()) tuple is EXCLUDED here because jobLeftPieces()
 * adds goodThis (this shift's good) on top of S!.jobTotalGood — counting
 * the current shift in both places double-subtracted it from JobRequired
 * and made Job Left collapse to 0 the moment Count End was filled in.
 */
async function refreshJobTotal(): Promise<void> {
  if (!S!.selJob) {
    S!.jobTotalGood = 0;
    return;
  }
  const all = await dalRef.listProduction({ jobNumber: S!.selJob });
  S!.jobTotalGood = sumOtherShiftGood(all, `${S!.mc}|${sid()}`);
}

/**
 * Σ good across every (machine, shift) tuple of this job EXCEPT the
 * currently-viewed one (`currentKey`), which jobLeftPieces() adds on
 * top via goodThis.
 *
 * good per tuple = gross − rejects, where:
 *   - gross (Count End − Count Start) lives ONLY on the canonical slot 0;
 *   - rejects are recorded per half-hour slot across the whole timeline.
 *
 * The previous version summed rejects from slot 0 only — but reject
 * events round-trip onto their own slot (see expandHeaderToSlots /
 * timelineToSlot), so any reject after the first half hour was invisible
 * here. A finished Day shift therefore handed the Afternoon shift its
 * GROSS count as "good", and Job Left came out too low once you switched
 * to Afternoon. Sum rejects across ALL slots of the tuple to fix that.
 */
export function sumOtherShiftGood(
  all: ProductionRecord[],
  currentKey: string,
): number {
  const grossByTuple = new Map<string, number>();
  const rejByTuple = new Map<string, number>();
  for (const r of all) {
    const key = `${r.machineCode}|${r.shiftId}`;
    if (key === currentKey) continue;
    if (r.slotIndex === 0) {
      grossByTuple.set(key, cavityGross(r.countStart, r.countEnd, r.cavities));
    }
    let rej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      rej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      rej = Number(r.rejectCount) || 0;
    }
    if (rej) rejByTuple.set(key, (rejByTuple.get(key) ?? 0) + rej);
  }
  let total = 0;
  for (const [key, gross] of grossByTuple) {
    total += Math.max(0, gross - (rejByTuple.get(key) ?? 0));
  }
  return total;
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
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, c?.cavities);
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

/**
 * Names from a roster that belong to the selected shift, so the
 * Operator / Supervisor dropdowns only list the people actually rostered
 * on (e.g. Day) instead of the whole plant. A roster entry matches when:
 *   - it has no shift tag (untagged data must never hide a needed name), or
 *   - its shift and the selected shift are prefixes of one another
 *     (tolerates "Day" vs "Day Shift" vs a single-letter "D").
 * `alwaysInclude` (the currently-selected name) is appended even when it
 * falls outside the shift, so switching shifts never drops the name a
 * record already holds. De-duplicated, original order preserved.
 */
export function rosterNames(
  roster: Operator[],
  shiftCode: ShiftCode,
  alwaysInclude: string,
): string[] {
  const want = shiftCode.trim().toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const o of roster) {
    const sh = (o.shift ?? '').trim().toLowerCase();
    const match = sh === '' || sh === want || want.startsWith(sh) || sh.startsWith(want);
    if (!match) continue;
    if (seen.has(o.operatorName)) continue;
    seen.add(o.operatorName);
    names.push(o.operatorName);
  }
  if (alwaysInclude && !seen.has(alwaysInclude)) names.push(alwaysInclude);
  return names;
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
  if (isReadOnlyDevice()) {
    // Non-iPad without supervisor sign-in: the Job# dropdown freezes on
    // whatever's currently selected. The device-class rule replaced the
    // old per-iPad OwnerDevice claim which was causing fights on the
    // floor — iPads write freely now, only PCs are read-only by default.
    jobField = `<input type="text" disabled value="${escapeHtml(S!.selJob)}" title="Read only — sign in as supervisor to edit">`;
  } else if (pastLocked) {
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
    isReadOnlyDevice()
      ? `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Read only — sign in as supervisor to edit">`
      : opSupLocked
        ? `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Signed off — sign in as supervisor to change">`
        : `<select data-meta="${meta}">${selOpts(list, value, meta)}</select>`;
  const opField = lockedOrSelect(
    'operator',
    rosterNames(S!.operators, S!.shiftCode, S!.selOperator),
    S!.selOperator,
  );
  const supField = lockedOrSelect(
    'supervisor',
    rosterNames(S!.supervisors, S!.shiftCode, S!.selSupervisor),
    S!.selSupervisor,
  );
  // Order Qty = total order quantity (Epicor JobHead_ProdQty), shown in the
  // meta row next to Job# / Part#. This is the whole-order size and stays
  // fixed; Job Left (side panel) counts down off Calculated_RemainingQty.
  const orderQty = o && !o.isDieChange ? o.orderQty : '—';
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
  // Physical die number from PMD_ProductDieColor.DieNumber, shown inline
  // next to the Product Description title so the floor knows which die
  // to fit before starting. ALWAYS rendered (em-dash when blank) so the
  // operator can tell at a glance whether the list has a value for this
  // part — silently hiding it made an empty cell indistinguishable from
  // a missing column.
  const dieNumber = die?.dieNumber || '';
  const dieNumberLabel = ` <span class="m-die-num" title="Die # for this part (from PMD_ProductDieColor.DieNumber)">Die# ${escapeHtml(dieNumber || '—')}</span>`;
  return `<div class="op-meta">
    <label class="m-mc">Machine <select data-meta="machine">${machineOpts}</select></label>
    <label class="m-job">Job# ${jobField}</label>
    <label class="m-orderqty">Order Qty <input type="text" disabled value="${escapeHtml(String(orderQty))}"></label>
    <label class="m-part"><span class="m-part-title">Part# ${swatch}</span><input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label class="m-desc"><span class="m-desc-title">Product Description${dieNumberLabel}</span><input type="text" disabled value="${escapeHtml(o?.partDescription ?? '')}"></label>
    <label class="m-op">Operator ${opField}</label>
    <label class="m-sup">Supervisor ${supField}</label>
  </div>`;
}

/** Short two-letter initials for a "First Last" name, used as the
 *  compact label on QC sign-off cells. Falls back to the first two
 *  characters when the name doesn't have two whitespace-separated
 *  words (single-word handles, codes). Exported so the Trace view
 *  labels QC cells with the same initials. */
export function initials(name: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Slots that require a supervisor QC sign-off rather than an operator
 * one. Production updated the cadence: instead of alternating
 * operator / supervisor every half-hour, supervisors check at three
 * fixed points per shift — start (slot 1 = ~07:30 on Day), middle
 * (slot 7 = ~10:30), and near end (slot 13 = ~13:30). The same indices
 * map onto Afternoon (15:30 / 18:30 / 21:30) and Night (23:30 / 02:30 /
 * 05:30) because every shift counts slots from 0 at its start.
 * Operators still do a QC every other slot.
 */
const SUPERVISOR_QC_SLOTS = new Set([1, 7, 13]);

/** Whose turn is it to QC this slot — supervisor at the 3 cadence slots
 *  per shift, operator on every other slot. */
function qcRoleFor(slot: number): 'operator' | 'supervisor' {
  return SUPERVISOR_QC_SLOTS.has(slot) ? 'supervisor' : 'operator';
}

/**
 * Shared QC-cell presentation — label / class / title — so the editable
 * operator grid and the read-only Trace card render the same content.
 * Both contexts compose this with their own wrapper element (operator: a
 * `<td>` with a tap-to-edit `<button>`; Trace: a `<div>` row above the
 * status timeline).
 */
export function qcCellPresentation(
  slot: number,
  name: string,
): { role: 'operator' | 'supervisor'; signed: boolean; label: string; title: string } {
  const role = qcRoleFor(slot);
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const signed = !!name;
  const label = signed ? `✓ ${escapeHtml(initials(name))}` : '—';
  const title = signed
    ? `${roleLabel} sign-off · ${escapeHtml(name)} · tap to change`
    : `${roleLabel} sign-off required · tap to confirm`;
  return { role, signed, label, title };
}

function qcCellHtml(slot: number, name: string, isNow: boolean): string {
  const p = qcCellPresentation(slot, name);
  const cls = `qc-cell${isNow ? ' is-now-col' : ''}${p.signed ? ' is-signed' : ''} qc-${p.role}`;
  return `<td class="${cls}"><button type="button" class="qc-btn" data-qc-slot="${slot}" title="${p.title}">${p.label}</button></td>`;
}

function statusCellHtml(
  slot: number,
  code: StatusCode | '',
  bdIssue: string,
  isNow: boolean,
): string {
  // If THIS job hasn't claimed the slot, surface any other job that has
  // — operator-side guard so 15:00 can't end up running for two orders.
  const occ = code ? null : occupyingOtherJob(slot);
  const occDef = occ?.statusCode ? STATUS_MAP[occ.statusCode] : undefined;
  const effectiveDef = code ? STATUS_MAP[code] : occDef;
  const style = effectiveDef
    ? `background:${effectiveDef.color};color:${effectiveDef.text};border-color:${effectiveDef.border}`
    : '';
  let tip = '';
  if (code === 'B' && bdIssue) {
    tip = ` title="${escapeHtml(bdIssue)} — ${escapeHtml(bdLabelFor(bdIssue))}"`;
  } else if (occ) {
    tip = ` title="${escapeHtml(slotClock(sid(), slot))} · already used by ${escapeHtml(occ.jobNumber)} (${escapeHtml(occ.statusCode)})"`;
  }
  const tag =
    code === 'B' && bdIssue
      ? `<span class="bd-tag">${escapeHtml(bdIssue.split('-')[0])}</span>`
      : '';
  let cls = `status-cell${isNow ? ' is-now' : ''}`;
  if (occ) cls += ' is-occupied';
  if (S!.selSet.has(slot)) cls += ' multisel';
  const btnAttrs = occ ? ' disabled aria-disabled="true"' : '';
  // Unified status entry — single-tap selects this slot, hold-and-drag across
  // cells selects a range; the picker opens automatically on finger-up.
  // Occupied cells render the occupier's code but are not selectable.
  const cellChar = code || (occ?.statusCode ?? '·');
  return `<td class="${cls}"${tip}><button type="button" class="slot-cell" style="${style}" data-slot="${slot}" data-row="status"${btnAttrs}>${cellChar}</button>${tag}</td>`;
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

  // Quality Checks row sits between the time-header and Machine Status.
  // Operator checks every half-hour; supervisor signs off at three
  // fixed cadence slots per shift (1 / 7 / 13 → ~07:30, ~10:30, ~13:30
  // for Day; same offsets for Afternoon / Night). Tap a cell to pick
  // the signing name. Signed cells show the initials of the picked
  // user so the supervisor can scan the row at a glance.
  const qcRow =
    `<tr class="row-qc"><th class="rh" title="Operator checks every 30 min; Supervisor checks at slots 1 / 7 / 13 per shift (Day: 07:30, 10:30, 13:30)">Quality Checks</th>` +
    recs
      .map((r, i) => qcCellHtml(i, r?.qcBy ?? '', nowSlot === i))
      .join('') +
    `</tr>`;

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs
      .map((r, i) =>
        statusCellHtml(i, r?.statusCode ?? '', r?.bdIssue ?? '', nowSlot === i),
      )
      .join('') +
    `</tr>`;

  const gridRdo = isReadOnlyDevice()
    ? ' disabled title="Read only — sign in as supervisor to edit"'
    : isJobLocked()
      ? ' disabled title="Signed off — sign in as supervisor and Unlock to edit"'
      : '';
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
        ${qcRow}
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
  const cav = cavities();
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, cav);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
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
  const rdo = isJobLocked() || isReadOnlyDevice() ? 'disabled' : '';
  const rdoTitle = isReadOnlyDevice()
    ? ' title="Read only — sign in as supervisor to edit"'
    : isJobLocked()
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
    <div class="side-title">Shift counters</div>
    <div class="sk"><label>Job left</label><b data-live="jobLeft">${jobLeft}</b></div>
    <div class="sk"><label title="${escapeHtml(targetTitle)}">Shift Target</label><b title="${escapeHtml(targetTitle)}">${targetDisplay}</b></div>
    <div class="sk"><label>Count Start</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cstart" value="${cs}" ${rdo}${rdoTitle}></div>
    <div class="sk"><label>Count End</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cend" value="${ce}" ${rdo}${rdoTitle}></div>
    ${
      machineHasCavityOption(S!.mc)
        ? `<div class="sk sk-cavity"><label title="Number of identical cavities on the die — pieces produced per press cycle. Total Good = (Count End − Count Start) × cavities − Reject.">Cavities</label><select class="cavity-sel" data-meta="cavity" ${rdo}${rdoTitle}>${CAVITY_OPTIONS.map(
            (n) => `<option value="${n}"${cav === n ? ' selected' : ''}>×${n}</option>`,
          ).join('')}</select></div>`
        : ''
    }
    <div class="sk"><label>Total Reject</label><b class="r" data-live="totalReject">${totalReject}</b></div>
    <div class="sk"><label${cav > 1 ? ` title="(Count End − Count Start) × ${cav} cavities − Reject"` : ''}>Total Good${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</label><b class="g" data-live="totalGood">${good}</b></div>
    <div class="sk"><label>Purge (kg)</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="purge" value="${purge}" ${rdo}${rdoTitle}></div>
    <div class="handover">
      <div class="handover-title">Handover</div>
      <div class="handover-grid">
        <label><span>🛠 Machine</span><textarea data-meta="hand-machine" placeholder="Press state, robot, hot runner, breakdown follow-ups…" ${rdo}${rdoTitle}>${escapeHtml(h.machine)}</textarea></label>
        <label><span>🧩 Mold</span><textarea data-meta="hand-mold" placeholder="Mould condition, slides, ejector, water lines, maintenance due…" ${rdo}${rdoTitle}>${escapeHtml(h.mold)}</textarea></label>
        <label><span>📦 Material</span><textarea data-meta="hand-material" placeholder="Material lot, dryer, regrind, masterbatch…" ${rdo}${rdoTitle}>${escapeHtml(h.material)}</textarea></label>
        <label><span>📋 Method</span><textarea data-meta="hand-method" placeholder="Cycle, settings, process changes, work instructions…" ${rdo}${rdoTitle}>${escapeHtml(h.method)}</textarea></label>
      </div>
    </div>
  </aside>`;
}

interface SummaryBucket {
  label: string;
  shiftId: string;
  goCs: number;
  goCe: number;
  /** Gross PIECES = Σ (Count End − Count Start) × cavities, so the
   *  "Output (gross)" column matches Good once a 2-cavity die is in play
   *  (goCe − goCs alone would under-count by half). */
  grossPieces: number;
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
  let grossPieces = 0;
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
    const gross = cavityGross(r.countStart, r.countEnd, r.cavities);
    let jobRej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      jobRej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      jobRej = Number(r.rejectCount) || 0;
    }
    goCs += cs;
    goCe += ce;
    grossPieces += gross;
    rej += jobRej;
    good += Math.max(0, gross - jobRej);
  }
  return {
    label,
    shiftId,
    goCs,
    goCe,
    grossPieces,
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
          <td class="num">${b.grossPieces}</td>
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

/**
 * Compact "View only" indicator shown on a non-iPad browser (a PC viewer)
 * with no supervisor signed in. The whole sheet is read-only behind it.
 * Deliberately tiny — earlier multi-line banner was too loud for what's
 * just a passive viewer state.
 */
function buildOwnerBanner(): string {
  if (!isReadOnlyDevice()) return '';
  return `<span class="view-only-pill" title="Read only — sign in as supervisor via 🔓 in the top nav to edit">👁 View only</span>`;
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
    ${buildOwnerBanner()}
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
      const next = b.dataset.shift as ShiftCode;
      if (next === S!.shiftCode) return;
      // Block moving to another shift while the current order is still
      // unsigned (per floor policy: sign off before the shift handover
      // so Job Left is recorded). State is untouched, so the active tab
      // stays put without a re-render.
      if (currentJobNeedsSignoff()) {
        promptSignoffBeforeLeaving();
        return;
      }
      S!.shiftCode = next;
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
    el.addEventListener('change', () => onMetaChange(el));
  });
  app
    .querySelector<HTMLTextAreaElement>('textarea[data-meta="comments"]')
    ?.addEventListener('blur', (e) => onMetaChange(e.target as HTMLElement));

  // Status cells are picked via the unified hold-and-drag picker — see
  // wireStatusPicker() at the bottom of wire().

  // Named reject inputs — use the no-reload upsert so tabbing from one
  // cell to the next doesn't trigger a full reload() → render() cycle
  // that destroys the input the operator just moved focus into. The
  // refreshJobTotalAndPaintSide call keeps the side-panel totals fresh
  // without rebuilding the grid.
  app.querySelectorAll<HTMLInputElement>('input[data-row="named"]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const slot = Number(inp.dataset.slot);
      const code = inp.dataset.code!;
      const qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      void upsertSlotNoReload(slot, (r) => {
        const obj = parseRejects(r);
        if (qty > 0) obj[code] = qty;
        else delete obj[code];
        r.rejects = JSON.stringify(obj);
      }).then(() => void refreshJobTotalAndPaintSide());
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

  // Quality Check picker: alternating operator / supervisor cadence —
  // even slot pops the operators list, odd slot the supervisors list.
  // Tap-then-pick lands the chosen name on the slot record's qcBy field
  // (no full reload — refreshes just the QC cell so a supervisor walking
  // the floor and signing one cell after another doesn't lose focus or
  // their place in the grid).
  app.querySelectorAll<HTMLButtonElement>('[data-qc-slot]').forEach((b) =>
    b.addEventListener('click', () => {
      const slot = Number(b.dataset.qcSlot);
      if (Number.isFinite(slot)) openQcPicker(slot);
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
      // Block leaving an unsigned in-progress order — render() reverts
      // the <select> back to the current machine.
      if (val !== S!.mc && currentJobNeedsSignoff()) {
        promptSignoffBeforeLeaving();
        render();
        break;
      }
      S!.mc = val;
      // Machine change does clear selJob: a different press generally runs
      // a different order, and carrying the previous job number across
      // machines tends to mask the empty grid rather than help.
      S!.selJob = '';
      summaryCache = null; // cache is per-machine
      void reload();
      break;
    case 'job':
      // Block leaving an unsigned in-progress order for a different one
      // — this is the main path that stranded Job Left (operator finishes
      // an order and starts the next without signing off). render()
      // reverts the input/select back to the current job. Switching
      // BETWEEN co-running orders (same die) is exempt: they run together
      // and the operator must hop between them to enter each one's counts
      // before any is signed off.
      if (
        val !== S!.selJob &&
        !coRunsWith(val, S!.selJob) &&
        currentJobNeedsSignoff()
      ) {
        promptSignoffBeforeLeaving();
        render();
        break;
      }
      S!.selJob = val;
      saveView();
      // Full reload, not just render(): Job Left / Total Good and the
      // Count Start auto-carry are per-job, so switching orders with a
      // bare re-render showed the PREVIOUS job's cross-shift total and
      // skipped the carry for the new one.
      void reload();
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
    case 'cavity': {
      // Cavities dropdown: parts produced per press cycle. Validate against the
      // allowed set, falling back to 1. Persist on the canonical slot, then
      // re-render so Total Good / Job Left / Shift Target and the ×N tag all
      // recompute. A select has no text focus to preserve, so a full render is fine.
      const n = CAVITY_OPTIONS.includes(Number(val)) ? Number(val) : 1;
      void upsertSlotNoReload(0, (r) => {
        r.cavities = n;
      }).then(() => render());
      break;
    }
    case 'hand-machine':
    case 'hand-mold':
    case 'hand-material':
    case 'hand-method': {
      const field = key.slice('hand-'.length) as 'machine' | 'mold' | 'material' | 'method';
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
  // No-gaps gate: every Machine-Status slot up to now (live) / all 16
  // (past) must be filled before sign-off, so a half-recorded shift
  // can't be locked in (the reported "worker skips slots, Job Left
  // data is wrong" problem). Slots held by another job on this press
  // are that job's responsibility and don't count as gaps here.
  // A signed-in supervisor bypasses the gate — they can sign off an
  // exceptional / partially-recorded shift when correcting data.
  const gaps = isSupervisor() ? [] : slotGapsForSignoff();
  if (gaps.length) {
    const list = gaps.map((i) => i + 1).join(', ');
    toast(
      `Fill every time slot up to now before signing off — missing slot ${list}`,
      'err',
    );
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
  const cav = cavities();
  const totalRej = jobTotals();
  const good = Math.max(0, (ce - cs) * cav - totalRej);
  const o = selectedOrder();

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">✅ Sign off &amp; Save</h2>
    <p class="bd-sub">${escapeHtml(sid())} · ${escapeHtml(S!.mc)} · job ${escapeHtml(S!.selJob || '—')}</p>
    <div class="signoff-summary">
      <div><span>Operator</span><b>${escapeHtml(S!.selOperator || '—')}</b></div>
      <div><span>Supervisor</span><b>${escapeHtml(S!.selSupervisor)}</b></div>
      <div><span>Part</span><b>${escapeHtml(o?.partNumber ?? '—')}</b></div>
      <div><span>Order Qty</span><b>${o && !o.isDieChange ? o.orderQty : '—'}</b></div>
      <div><span>Count Start → End</span><b>${cs} → ${ce}${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</b></div>
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
  const confirmBtn = mc.querySelector<HTMLButtonElement>('[data-confirm-save]');
  confirmBtn?.addEventListener('click', () => {
    // Disable immediately so a second tap on a laggy iPad can't fire a
    // second lockShift (the duplicate-row cause). doSignoffSave keeps the
    // modal open until the network round-trip resolves; on failure it
    // re-enables so the supervisor can retry.
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    void doSignoffSave(confirmBtn);
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
    const slot = Number(el.dataset.slot);
    // Slots already held by another job on this (machine, shift) are
    // not selectable — neither single-tap nor drag-range can pick them
    // up. Prevents the duplicate-15:00 case where two orders both
    // claim the same half-hour as Run time.
    if (occupyingOtherJob(slot)) return null;
    return slot;
  };

  const setRange = (a: number, b: number): void => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    S!.selSet = new Set<number>();
    // Skip slots already held by another job — drag-range across a
    // signed-off run mustn't sweep its slots into the selection.
    for (let i = lo; i <= hi; i++) {
      if (!occupyingOtherJob(i)) S!.selSet.add(i);
    }
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
    if (isReadOnlyDevice()) {
      toast('Read only — sign in as supervisor to edit', 'warn');
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
      <button class="btn-ghost-big" data-comments>💬 Comments</button>
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
  mc.querySelector('[data-comments]')?.addEventListener('click', () => {
    // Use cancel(), not closeModal(), so the slot selection clears —
    // the comments path doesn't apply a status, and a leftover
    // selection would confuse the next tap.
    closeModal();
    if (isJobLocked()) {
      toast('Order signed off — Unlock as supervisor to add comments', 'warn');
      S!.selSet.clear();
      paintSelection();
      return;
    }
    openCommentsModal();
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

/**
 * Free-text comment popped from the Machine Status modal. The line is
 * appended to the canonical slot's Handover Material field with a
 * `[HH:MM]` wall-clock prefix so it shows up alongside the existing
 * material-side handover notes the next shift reads.
 *
 * Material was the field the production line asked for explicitly —
 * the comment-during-status flow is most often a quick "saw a streak
 * in mix #4", which is material-side observation. If they want to
 * route to a different 4M slot later it's a one-line change here.
 *
 * The on-screen Handover Material textarea is patched directly so the
 * operator sees the line land without a full re-render (which would
 * destroy any in-flight focus in the side panel).
 */
function openCommentsModal(): void {
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">💬 Add comment</h2>
    <p class="bd-sub">Appended to Handover · 📦 Material with the current time.</p>
    <textarea class="comments-input" rows="4" placeholder="Type your note…" style="width:100%;font-family:inherit;font-size:15px;padding:8px;border:2px solid var(--bd);border-radius:8px;background:#fef9c3;resize:vertical"></textarea>
    <div class="bd-actions">
      <button class="btn-primary-big" data-save>Save</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const ta = mc.querySelector<HTMLTextAreaElement>('.comments-input');
  ta?.focus();
  const close = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', close);
  mc.querySelector('[data-save]')?.addEventListener('click', () => {
    const txt = (ta?.value ?? '').trim();
    if (!txt) {
      close();
      return;
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const line = `[${hh}:${mm}] ${txt}`;
    let nextMaterial = '';
    void upsertSlotNoReload(0, (r) => {
      const obj = parseHandover(r);
      obj.material = obj.material ? `${obj.material}\n${line}` : line;
      nextMaterial = obj.material;
      r.handoverNote = JSON.stringify(obj);
    });
    // Patch the visible textarea so the operator sees the line land.
    const live = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-meta="hand-material"]',
    );
    if (live) live.value = nextMaterial;
    toast('Comment added to Handover · Material', 'ok');
    close();
  });
}

async function multiFillApply(
  slots: number[],
  code: StatusCode,
  bdIssue: string,
  mangoNote: string,
): Promise<void> {
  const apply = (r: ProductionRecord): void => {
    r.statusCode = code;
    r.bdIssue = code === 'B' ? bdIssue : '';
    if (code === 'B' && mangoNote) r.mangoTicket = mangoNote;
    else if (code !== 'B') r.mangoTicket = '';
  };
  // Mirror the machine status across every co-running order on this die
  // (they share the press, so they share the timeline). Counts / rejects
  // / sign-off stay per-order — only the status row is mirrored.
  const siblings = coRunSiblings(S!.selJob);
  // Sequential upserts — keep simple; could batch later if needed.
  for (const slot of slots) {
    await upsertSlotNoReload(slot, apply);
    for (const sib of siblings) await upsertSlotForJob(sib, slot, apply);
  }
  S!.selSet.clear();
  const mirroredNote = siblings.length ? ` (+${siblings.length} co-run)` : '';
  toast(
    `Filled ${slots.length} slot${slots.length === 1 ? '' : 's'} with ${code}${mirroredNote}`,
    'ok',
  );
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
  // a supervisor, or when this is a read-only (non-iPad) device.
  if (isJobLocked() || isReadOnlyDevice()) return;
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

/**
 * Write one slot of an ARBITRARY job (not the selected one) — used by
 * the co-run status mirror / seed to copy the machine status onto each
 * sibling order sharing the die. Skips a sibling that's signed off
 * (never modify a locked order) and respects the read-only device rule.
 */
async function upsertSlotForJob(
  job: string,
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!job || isReadOnlyDevice()) return;
  if (S!.prod.some((r) => r.jobNumber === job && r.locked)) return;
  const existing = S!.prod.find((r) => r.jobNumber === job && r.slotIndex === slot);
  const rec = existing ? { ...existing } : blankRecordForJob(slot, job);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  const idx = S!.prod.findIndex((r) => r.jobNumber === job && r.slotIndex === slot);
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}

async function doSignoffSave(confirmBtn?: HTMLButtonElement): Promise<void> {
  if (isReadOnlyDevice()) {
    toast('Read only — sign in as supervisor to sign off here', 'warn');
    return;
  }
  // Reentrancy guard — a second concurrent sign-off would POST a
  // duplicate PMD_Production row (see signoffInFlight comment).
  if (signoffInFlight) return;
  signoffInFlight = true;
  try {
    // Scope sign-off to the order being reviewed: another job already
    // running on this press's remaining timeline slots (operator
    // started the next order mid-shift) must stay live and editable.
    // Pass the JobLeft frozen on the canonical row at job start so
    // PMD_Production.JobLeft records demand-at-start (for Trace), not the
    // live "remaining now". null for die-change jobs / rows with no frozen
    // value — the DAL then falls back to its tuple-only estimate.
    await dalRef.lockShift(
      S!.mc,
      sid(),
      S!.selSupervisor,
      S!.selOperator,
      S!.selJob || undefined,
      canonical()?.jobLeft ?? null,
    );
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
    // Re-enable the confirm button so the supervisor can retry after a
    // transient failure (the modal is still open on this path).
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Sign off as ${S!.selSupervisor}`;
    }
  } finally {
    signoffInFlight = false;
  }
}

function openQcPicker(slot: number): void {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
    return;
  }
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  const role = qcRoleFor(slot);
  const current = slotRec(slot)?.qcBy ?? '';
  // QC sign-off names are also narrowed to the shift's roster (current
  // sign-off always kept, even if from another shift).
  const roster = rosterNames(
    role === 'operator' ? S!.operators : S!.supervisors,
    S!.shiftCode,
    current,
  );
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const buttons = roster
    .map(
      (n) =>
        `<button class="bd-cause${n === current ? ' is-current' : ''}" data-qc-pick="${escapeHtml(n)}">
          <span class="bd-code">${escapeHtml(initials(n))}</span>
          <span class="bd-cause-text">${escapeHtml(n)}</span>
        </button>`,
    )
    .join('');
  const clearBtn = current
    ? `<button class="btn-ghost-big" data-qc-clear>↺ Clear sign-off</button>`
    : '';
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">🔍 Quality Check — slot ${slot + 1}/${SLOTS_PER_SHIFT} (${escapeHtml(
      slotClock(sid(), slot),
    )})</h2>
    <p class="bd-sub">${roleLabel} sign-off · ${escapeHtml(S!.mc)} · ${escapeHtml(S!.selJob)}${
      current ? ` · currently signed by <b>${escapeHtml(current)}</b>` : ''
    }</p>
    <div class="bd-cause-list">${buttons || '<p class="bd-sub">No names available — add them on the People list.</p>'}</div>
    <div class="bd-actions">
      ${clearBtn}
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-qc-clear]')?.addEventListener('click', () => {
    closeModal();
    void applyQc(slot, '');
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-qc-pick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      closeModal();
      void applyQc(slot, btn.dataset.qcPick ?? '');
    }),
  );
}

async function applyQc(slot: number, name: string): Promise<void> {
  await upsertSlotNoReload(slot, (r) => {
    r.qcBy = name;
  });
  // Live snapshot push so the floor view picks up the QC sign-off
  // without waiting for the operator poll tick.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
  // Repaint just the QC row so the grid scroll position + every input
  // currently focused stays untouched.
  repaintQcRow();
}

function repaintQcRow(): void {
  const row = document.querySelector<HTMLElement>('.op-grid tr.row-qc');
  if (!row) return;
  const cells = row.querySelectorAll<HTMLElement>('td');
  for (let i = 0; i < cells.length; i++) {
    const rec = slotRec(i);
    const name = rec?.qcBy ?? '';
    const role = qcRoleFor(i);
    const btn = cells[i].querySelector<HTMLButtonElement>('.qc-btn');
    if (!btn) continue;
    btn.textContent = name ? `✓ ${initials(name)}` : '—';
    cells[i].classList.toggle('is-signed', !!name);
    cells[i].title = name
      ? `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off · ${name} · tap to change`
      : `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off required · tap to confirm`;
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
      { hex: c.hex, name: c.name, dieNumber: c.dieNumber, coRun: c.coRun },
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
    operators,
    supervisors,
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
  void pollSync();
}

/**
 * Reentrancy guard for pollSync. The poll runs on a 60 s setInterval
 * and is fire-and-forget (void pollSync()); without this flag a slow
 * tick (CSV download + per-job upserts on flaky iPad Wi-Fi can take
 * > 60 s) would stack a second pollSync onto the first, then a third
 * onto that, until Safari's connection pool was saturated and the
 * page froze. Reported by floor: iPad9 freeze, especially night
 * shift. Belt-and-braces with the DAL's own snapshotInFlight guard.
 */
let pollSyncInFlight = false;

/**
 * Per-tick best-effort flush of this device's editCache to PMD_LiveStatus
 * so other devices see in-progress work. The DAL's pushLiveSnapshot is a
 * no-op on read-only devices (device-class write rule).
 */
async function pollSync(): Promise<void> {
  if (!S) return;
  if (pollSyncInFlight) return;
  pollSyncInFlight = true;
  try {
    if (dalRef.pushLiveSnapshot) {
      await dalRef.pushLiveSnapshot().catch(() => {
        /* logged inside the DAL; never propagate to the poll loop */
      });
    }
  } finally {
    pollSyncInFlight = false;
  }
}
