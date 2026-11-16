// Operator sheet — reading the shift on the sheet: its orders, its half-hours,
// which orders run together, and what a sign-off still needs.
import {
  buildShiftId,
  currentShift,
  shiftBounds,
  msUntilShiftEnd,
  SLOTS_PER_SHIFT,
  currentSlotIndex,
} from '../../core/shifts';
import { S } from './state';
import type { ProductionRecord, PlanningOrder } from '../../types';
import { cavitySourceForJob, isCarried, isReadOnlyDevice } from './data';
import { planningOrderMatchesMachine } from '../../core/schedule';
import { compareOrdersByStart } from '../../core/planning';
import type { OrderFacts } from '../../core/order-history';
import { type DieCoRun, ordersCoRun } from '../../core/corun';
import { isSupervisor } from '../supervisor-auth';

export const SLOT_PX = 64; // touch target for the half-hour status cell on 10" iPad

export const VIEW_LEVELS: Array<{ level: number; label: string }> = [
  { level: 1, label: 'Shift' },
  { level: 2, label: 'Today (3 shifts)' },
  { level: 3, label: 'Past 7 days' },
  { level: 4, label: 'Past 30 days' },
];

export function sid(): string {
  return buildShiftId(S!.viewDate, S!.shiftCode);
}

export function blankRecord(slot: number): ProductionRecord {
  return blankRecordForJob(slot, S!.selJob);
}

export function blankRecordForJob(slot: number, job: string): ProductionRecord {
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
    // Carry cycle time + the ORDER TOTAL so they persist through
    // editCache → live mirror → sign-off even if Epicor drops the order
    // from planning before the shift is signed. jobRequired here is the
    // total (orderQty), matching the PMD_Production.JobRequired column —
    // NOT Epicor's decremented remaining qty.
    cycleTime: order?.qtyPerHr ?? 0,
    jobRequired: order && order.orderQty > 0 ? order.orderQty : undefined,
    // Cavities from the die register, stamped at birth so the row is
    // right without waiting for the load-time sync — and so a co-run
    // sibling written by upsertSlotForJob carries its own die's count.
    // Left undefined when the register has no answer, which reads as 1
    // and lets the sync fill it in once the toolroom does: a 1 stamped
    // here would be the row's own number and stick.
    cavities: (() => {
      const src = cavitySourceForJob(job);
      return src.known ? src.count : undefined;
    })(),
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
  // NOTE: Job Left / Shift Target are deliberately NOT stamped on the
  // record any more. The old "freeze at job start" snapshot captured
  // whatever the freezing device could see at that instant — stale live
  // shadows contaminated it, it round-tripped through PMD_LiveStatus to
  // every other device, and it could never self-correct (SFM507147's
  // phantom "200"). Both values are now derived on read from signed
  // PMD_Production rows, and the authoritative per-row columns are
  // recomputed from the same source at sign-off (see lockShift).
  return rec;
}

export function isPastShift(): boolean {
  // The RUNNING shift is never past — decisive for Night after midnight,
  // whose ShiftId date is YESTERDAY: the date-only rule below classified
  // the live 00:00–07:00 stretch as a past shift, which emptied the Job#
  // dropdown of planning orders (no new order could be started in the
  // early-morning hours) and made the sign-off gap gate demand all 16
  // slots mid-shift.
  const liveShiftId = currentShift(new Date()).shiftId;
  if (sid() === liveShiftId) return false;
  // Otherwise a shift is "past" if its calendar date is strictly before
  // today, or if it's today but not the live shift. The Job# dropdown for
  // past shifts is restricted to jobs that were actually worked on, since
  // the planning list only reflects the current Epicor state.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (S!.viewDate < today) return true;
  if (S!.viewDate > today) return false;
  return true;
}

const OPERATOR_FUTURE_ORDER_DAYS = 5;

const MANUAL_ORDER_DROPDOWN_TTL_MS = 48 * 60 * 60 * 1000;

/** Manual PMD_ManualOrders rows are a short-lived escape hatch, not a
 * permanent planning queue. Missing/malformed legacy Created values fail
 * open so an old row is not silently lost without a trustworthy clock. */
export function manualOrderDropdownVisible(
  order: PlanningOrder,
  now: Date = new Date(),
): boolean {
  if (!order.manuallyAdded || order.source !== 'Manual') return true;
  // A manual row without a trustworthy Created value cannot prove it is
  // inside the 48-hour escape-hatch window. Hide it instead of allowing a
  // legacy PMD_ManualOrders row to remain in the dropdown forever.
  if (!order.createdAt) return false;
  const created = new Date(order.createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created < MANUAL_ORDER_DROPDOWN_TTL_MS;
}

/** Operator Job# visibility by Epicor JobHead_StartDate (`plannedStart`).
 * There is deliberately no lower bound: an overdue order still present in
 * Planning is unfinished and must remain selectable. The upper bound is the
 * end of the fifth day after the selected live/future view date. Missing or
 * malformed legacy dates remain visible rather than hiding a real order. */
export function operatorOrderStartVisible(
  plannedStart: string,
  anchorDate: Date,
  showAll = false,
): boolean {
  if (showAll) return true;
  if (!plannedStart) return true;
  const start = Date.parse(plannedStart);
  if (!isFinite(start)) return true;
  const horizon = new Date(anchorDate);
  horizon.setHours(0, 0, 0, 0);
  horizon.setDate(horizon.getDate() + OPERATOR_FUTURE_ORDER_DAYS);
  horizon.setHours(23, 59, 59, 999);
  return start <= horizon.getTime();
}

/** Active/future Job# dropdown rule. ERP rows must belong to the selected
 * press; supervisor-created manual rows (which intentionally have no
 * machine) remain available everywhere. */
export function operatorPlanningOrderVisible(
  order: PlanningOrder,
  machineCode: string,
  anchorDate: Date,
  showAll = false,
  now: Date = new Date(),
): boolean {
  return (
    planningOrderMatchesMachine(order, machineCode, true) &&
    manualOrderDropdownVisible(order, now) &&
    operatorOrderStartVisible(order.plannedStart, anchorDate, showAll)
  );
}

/**
 * The selected shift hasn't started yet — its wall-clock start is still in
 * the future. The classic trap is a Night-shift supervisor working past
 * midnight who leaves the date on "today": a Night shift dated today doesn't
 * begin until 23:00 tonight, so production logged against it actually belongs
 * to the Night shift that started 23:00 *yesterday* (the one running now).
 * There is never real production for a shift that hasn't begun, so this is a
 * reliable mis-date signal. One local clock, same basis as currentShift().
 */
export function isFutureShift(now: Date = new Date()): boolean {
  const b = shiftBounds(sid());
  return b ? now < b.start : false;
}

/** "29 Jun 23:00 → 30 Jun 07:00" — the physical period a shift covers, so a
 *  night that crosses midnight is unambiguous about which calendar day it is. */
export function shiftWindowLabel(shiftId: string): string {
  const b = shiftBounds(shiftId);
  if (!b) return '';
  const day = (x: Date): string =>
    x.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
  const time = (x: Date): string =>
    x.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day(b.start)} ${time(b.start)} → ${day(b.end)} ${time(b.end)}`;
}

export function shiftOrders(): PlanningOrder[] {
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

  // Active / future shift: keep every planning order whose JobHead_StartDate
  // is in the past or falls within the next five days.
  // We only bound the FUTURE — Epicor releases far more upcoming orders
  // than a press will touch in one shift, and operators were scrolling
  // past dozens of not-yet-relevant entries. The PAST is left open: an
  // order that is still in the planning list is, by definition, not yet
  // complete (Epicor drops finished orders), so an overdue / long-running
  // job that started days ago must still appear — the operator is very
  // likely still running it. (Previously a lower `plannedEnd >= today`
  // bound hid exactly those unfinished historical orders.)
  //
  // Orders missing a plannedStart (rare: legacy CSV row) fall
  // through the filter so the operator can still pick them.
  // Sorted plannedStart-ascending so the next-to-run order is at
  // the top of the dropdown.
  const planned = S!.planning
    .slice()
    .filter((o) =>
      operatorPlanningOrderVisible(o, S!.mc, S!.viewDate, S!.showAllPlanningOrders),
    )
    .sort(compareOrdersByStart);
  const knownIds = new Set(planned.map((o) => o.jobNumber));
  const extras = historicalIds.filter((j) => !knownIds.has(j)).map(historicalOrder);
  for (const j of extras) knownIds.add(j.jobNumber);
  // Last shift's orders Planning.csv has dropped — still on the press.
  const carried = (S!.carried?.jobs ?? [])
    .filter((j) => isCarried(j) && !knownIds.has(j))
    .map(historicalOrder);
  return [...planned, ...extras, ...carried];
}

export function selectedOrder(): PlanningOrder | undefined {
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
export function orderForJob(job: string): PlanningOrder | undefined {
  if (!job) return undefined;
  // Planning.csv reflects the CURRENT Epicor state — it is only relevant
  // to the live and future shifts. Viewing a PAST shift/date means
  // "review what was actually recorded", so the order must be rebuilt
  // from PMD_Production (the List is the source of truth for history),
  // exactly like Trace's Job Number Search. Consulting planning here
  // would show today's remaining qty / cycle time against a shift that
  // ran days ago, and would disagree with Trace for the same tuple.
  if (!isPastShift()) {
    const jt = job.trim();
    const fromPlanning =
      S!.planning.find((o) => o.jobNumber === job) ??
      S!.planning.find((o) => o.jobNumber.trim() === jt);
    if (fromPlanning) return withOrderFacts(fromPlanning);
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
  // An order Planning.csv no longer holds and this shift has not touched
  // yet still has its own history to go on — an overrun order the press is
  // still running is exactly that.
  if (!anySlot) {
    const facts = factsFor(job);
    if (!facts?.partNumber) return undefined;
    return {
      id: 0,
      jobNumber: job,
      machineCode: S!.mc,
      originalMachine: '',
      partNumber: facts.partNumber,
      partDescription: facts.partDescription,
      plannedStart: '',
      plannedEnd: '',
      orderQty: facts.jobRequired,
      jobRequired: facts.jobRequired,
      qtyPerHr: facts.cycleTime,
      duration: 0,
      released: false,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
    };
  }
  return withOrderFacts({
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
  });
}

/** The selected order's signed history, when it has been read for `job`. */
function factsFor(job: string): OrderFacts | null {
  return S!.jobFacts && S!.jobFacts.job === job ? S!.jobFacts.facts : null;
}

/**
 * Fill what an order row is missing — Part #, description, Order Qty, cycle
 * time — from the order's own signed history. A supervisor's manual order
 * carries no cycle time and often no part; a row rebuilt from this shift's
 * records has none of them before the shift is signed. Values present are
 * never replaced.
 */
function withOrderFacts(o: PlanningOrder): PlanningOrder {
  const facts = factsFor(o.jobNumber);
  if (!facts || o.isDieChange) return o;
  const qty = o.orderQty > 0 ? o.orderQty : facts.jobRequired;
  return {
    ...o,
    partNumber: o.partNumber || facts.partNumber,
    partDescription: o.partDescription || facts.partDescription,
    orderQty: qty,
    // A planning row's jobRequired is Epicor's remaining qty, which may
    // rightly be 0; only an order with no quantity at all takes the total.
    jobRequired: o.jobRequired > 0 || o.orderQty > 0 ? o.jobRequired : qty,
    qtyPerHr: o.qtyPerHr > 0 ? o.qtyPerHr : facts.cycleTime,
  };
}

export function slotRec(slot: number): ProductionRecord | undefined {
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
export function occupyingOtherJob(slot: number): ProductionRecord | null {
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
/** Whether a Job# appears in the loaded Planning.csv (current Epicor state).
 *  Drives the "not in planning" warning that catches item numbers typed into
 *  the Job# box. */
export function jobInPlanning(job: string): boolean {
  const jt = job.trim();
  return !!jt && S!.planning.some((o) => o.jobNumber.trim() === jt);
}

export function partNumberForJob(job: string): string {
  if (!job) return '';
  const fromProd = S!.prod.find((r) => r.jobNumber === job && r.partNumber)?.partNumber;
  if (fromProd) return fromProd;
  return S!.planning.find((o) => o.jobNumber === job)?.partNumber ?? '';
}

/** The PMD_ProductDieColor row for a job's part — its die, CoRun flag and
 *  colour — or undefined. */
export function dieRowForJob(job: string): DieCoRun | undefined {
  const pn = partNumberForJob(job).trim().toUpperCase();
  if (!pn) return undefined;
  const row = S!.dieColors.get(pn);
  if (!row) return undefined;
  return {
    partNumber: pn,
    dieNumber: row.dieNumber,
    coRun: row.coRun,
    colour: row.name,
    hex: row.hex,
  };
}

/**
 * Two jobs co-run when they are two different parts on the same non-empty
 * die, both flagged CoRun = Yes in PMD_ProductDieColor, and the list does not
 * give the two parts different colours (see ordersCoRun). The die match alone
 * is not enough: different colours share a die and are scheduled
 * one-after-another. Order Quantity is not asked — an uneven pair runs
 * together until the smaller order is made, then that cavity is blocked
 * (buildCavityBlockBanner). Only a pair that passes has its machine status
 * mirrored.
 */
function coRunsWith(jobA: string, jobB: string): boolean {
  if (!jobA || !jobB || jobA === jobB) return false;
  return ordersCoRun(dieRowForJob(jobA), dieRowForJob(jobB));
}

/** Distinct OTHER jobs already recorded on this (machine, shift) that
 *  share the given job's die — the mirror targets. Signed-off siblings
 *  are excluded (we never write into a locked order). */
export function coRunSiblings(job: string): string[] {
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

/** Distinct OTHER jobs that co-run with `job` on this (machine, shift),
 *  whether already recorded OR merely planned for the shift. Drives the
 *  ⛓ Co-Run chips next to Job#, so the floor sees the linked order — and
 *  can hop to it — before any counts are entered. Unlike coRunSiblings
 *  (the mirror write target) this keeps signed-off siblings, so the link
 *  stays visible all shift. */
export function coRunLinks(job: string): string[] {
  if (!job) return [];
  const out: string[] = [];
  const seen = new Set<string>([job]);
  const consider = (j: string): void => {
    if (!j || seen.has(j) || !coRunsWith(j, job)) return;
    seen.add(j);
    out.push(j);
  };
  for (const o of shiftOrders()) consider(o.jobNumber);
  for (const r of S!.prod) consider(r.jobNumber);
  return out;
}

/**
 * Every order the die of `job` has on this (machine, shift) — recorded or
 * planned: the co-runners of coRunLinks and, with them, the OTHER orders for
 * the selected order's own part (never co-runners of it: one cavity makes
 * them one after another). Empty for an order that co-runs with nothing.
 * What the block-the-cavity reminder adds up by part.
 */
export function coRunDieJobs(job: string): string[] {
  const links = coRunLinks(job);
  if (!links.length) return [];
  const own = partNumberForJob(job).trim().toUpperCase();
  const out = [...links];
  const seen = new Set<string>([job, ...links]);
  const consider = (j: string): void => {
    if (!j || seen.has(j)) return;
    seen.add(j);
    if (own && partNumberForJob(j).trim().toUpperCase() === own) out.push(j);
  };
  for (const o of shiftOrders()) consider(o.jobNumber);
  for (const r of S!.prod) consider(r.jobNumber);
  return out;
}

export function canonical(): ProductionRecord | undefined {
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
export function currentJobNeedsSignoff(): boolean {
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

/** Minutes before shift end that the sign-off reminder starts nagging. */
const SIGNOFF_REMINDER_MIN = 5;

/**
 * True only in the final SIGNOFF_REMINDER_MIN of the LIVE shift. The floor
 * asked to be reminded to sign off near handover rather than blocked on every
 * navigation, so this is the one window where the reminder banner + one-shot
 * toast appear.
 */
export function inSignoffReminderWindow(now: Date = new Date()): boolean {
  if (currentShift(now).shiftId !== sid()) return false; // live shift only
  const ms = msUntilShiftEnd(sid(), now);
  return ms != null && ms > 0 && ms <= SIGNOFF_REMINDER_MIN * 60_000;
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
export function slotGapsForSignoff(): number[] {
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

export function parseRejects(r: ProductionRecord | undefined): Record<string, number> {
  if (!r || !r.rejects) return {};
  try {
    return JSON.parse(r.rejects) as Record<string, number>;
  } catch {
    return {};
  }
}
