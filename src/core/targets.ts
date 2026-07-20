import type { PlanningOrder, ProductionRecord } from '../types';
import { SLOTS_PER_SHIFT, SLOT_MINUTES } from './shifts';

// Pure Job Left / Shift Target formulas. They live in core (not in the
// operator UI) so every layer — the operator side panel, the Trace
// page AND the SharePoint DAL (which denormalises ShiftTarget onto
// PMD_Production at sign-off) — shares one implementation and the three
// can never drift. Keeping them out of ui/operator.ts also avoids a
// DAL→UI import cycle (operator.ts imports the DAL).

/**
 * Job Left = order total − cumulative Good across every (machine, shift)
 * tuple of this job (caller passes that running total). Returns null for
 * die-change pseudo-orders (no piece target).
 *
 * The base is the ORDER TOTAL (orderQty, Epicor JobHead_ProdQty) — NOT
 * `jobRequired` (Epicor Calculated_RemainingQty). Epicor decrements the
 * remaining figure as production is reported back to it, so subtracting
 * PMD's own Good from it again double-counted every reported piece:
 * SFM507147 rendered Job Left 0 while 656 genuinely remained. Falls back
 * to jobRequired only for rows that never carried a total (legacy
 * exports); synthetic orders rebuilt from PMD_Production set both fields
 * to the denormalised total, so they are unaffected either way.
 */
export function jobLeftPiecesFor(o: PlanningOrder, jobGood: number): number | null {
  if (o.isDieChange) return null;
  const total = o.orderQty > 0 ? o.orderQty : o.jobRequired;
  return Math.max(0, total - jobGood);
}

const SLOT_HOURS = SLOT_MINUTES / 60; // 0.5 h per slot
const SHIFT_HOURS = SLOTS_PER_SHIFT * SLOT_HOURS; // 8

/** The recorded changeover statuses (die / colour / insert change) —
 *  the same trio the KPI Setup columns and core/standards.ts judge. */
const CHANGEOVER_CODES = new Set(['D', 'C', 'I']);

/**
 * Hours of ONE (machine, shift) that were NOT available for `jobNumber`
 * to produce in — the "Hours consumed by previous order + Changeover
 * time" part of the Shift Target formula. Callers pass every production
 * record of the (machine, shift), all jobs included. A half-hour slot is
 * unavailable when:
 *
 *   - it is held by ANOTHER order (any status — run, breakdown, smoko…:
 *     the press physically wasn't this job's during it). Die-change
 *     pseudo-orders are "another order" too, so a changeover logged on
 *     its own DC_… timeline is deducted here; or
 *   - THIS job spent it on a changeover (D / C / I).
 *
 * CO-RUN EXEMPTION: co-running orders (one die making 2-3 parts at once)
 * mirror the same statuses onto the same slots, so a slot held by both
 * this job AND another is the co-runner's mirror of simultaneous work,
 * not time lost to a previous order — it only counts when this job's own
 * status there is a changeover. Sequential orders can never legitimately
 * share a slot (the operator sheet blocks cross-job overlap), so this
 * both-hold-it test IS the co-run detection — no die/CoRun lookup needed.
 *
 * This job's own breakdown / smoko / startup / purge slots are NOT
 * deducted — like the standard-changeover rule in core/standards.ts,
 * time lost inside the job's own run must show up as a missed target,
 * not silently lower the bar.
 */
export function hoursUnavailableFor(
  records: ProductionRecord[],
  jobNumber: string,
): number {
  const ownHeld = new Set<number>();
  const ownChangeover = new Set<number>();
  const otherHeld = new Set<number>();
  for (const r of records) {
    if (!r.statusCode) continue;
    if (r.jobNumber === jobNumber) {
      ownHeld.add(r.slotIndex);
      if (CHANGEOVER_CODES.has(r.statusCode)) ownChangeover.add(r.slotIndex);
    } else if (r.jobNumber) {
      otherHeld.add(r.slotIndex);
    }
  }
  let slots = 0;
  for (let i = 0; i < SLOTS_PER_SHIFT; i++) {
    if (ownChangeover.has(i)) slots++;
    else if (!ownHeld.has(i) && otherHeld.has(i)) slots++;
  }
  return slots * SLOT_HOURS;
}

/**
 * Shift Target = pieces to aim for this shift.
 *
 * `qtyPerHr` is sourced from Epicor's `JobOper_ProdStandard`, which on
 * this tenant is *hours per piece* (cycle time, ~0.005 range) — that's
 * why the old "× pieces/hour" formula rounded to zero.
 *
 * Rule (operator-stated):
 *   avail    = 8 h − hours consumed by previous order(s), if any
 *                  − changeover time, if any        (`unavailableHrs`)
 *   capacity = floor(avail ÷ ProdStandard)
 *   if  JobLeft < capacity  →  target = JobLeft     (job finishes)
 *   else                    →  target = capacity    (what the press can
 *                                                    still make today)
 *
 * `unavailableHrs` is hoursUnavailableFor() of the shift's records; it
 * defaults to 0 (a job with the full shift to itself), which reproduces
 * the original whole-8h rule exactly. Returns null when no cycle time
 * is available.
 */
export function shiftTargetFor(
  o: Pick<PlanningOrder, 'qtyPerHr'>,
  jobLeft: number,
  unavailableHrs = 0,
): number | null {
  if (!o.qtyPerHr || o.qtyPerHr <= 0) return null;
  const ct = o.qtyPerHr; // hours per piece
  const avail = Math.max(0, SHIFT_HOURS - Math.max(0, unavailableHrs));
  const capacity = Math.floor(avail / ct);
  return jobLeft < capacity ? jobLeft : capacity;
}

/** A count more than 30% above the shift target is much more likely to be
 *  a Count Start / Count End entry error than genuine production. */
export const SHIFT_TARGET_WARNING_RATIO = 1.3;

export function totalGoodExceedsShiftTarget(
  totalGood: number,
  shiftTarget: number | null,
): boolean {
  if (
    shiftTarget == null ||
    !Number.isFinite(shiftTarget) ||
    shiftTarget < 0 ||
    !Number.isFinite(totalGood) ||
    totalGood < 0
  ) {
    return false;
  }
  return totalGood > shiftTarget * SHIFT_TARGET_WARNING_RATIO;
}
