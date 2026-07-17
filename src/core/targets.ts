import type { PlanningOrder } from '../types';

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

/**
 * Shift Target = pieces to aim for this shift.
 *
 * `qtyPerHr` is sourced from Epicor's `JobOper_ProdStandard`, which on
 * this tenant is *hours per piece* (cycle time, ~0.005 range) — that's
 * why the old "× pieces/hour" formula rounded to zero.
 *
 * Rule (operator-stated):
 *   if  JobLeft × CT ≥ 8 h  →  target = floor(8 / CT)   (a full shift)
 *   else                     →  target = JobLeft         (job finishes)
 *
 * Returns null when no cycle time is available.
 */
export function shiftTargetFor(o: PlanningOrder, jobLeft: number): number | null {
  if (!o.qtyPerHr || o.qtyPerHr <= 0) return null;
  const ct = o.qtyPerHr; // hours per piece
  return jobLeft * ct >= 8 ? Math.floor(8 / ct) : jobLeft;
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
