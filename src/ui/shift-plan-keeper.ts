// The plan of record of each shift (PMD_ShiftPlan), written ahead and kept
// up with Planning.csv while it runs.
//
// Each shift's plans are written an hour before it starts, by whichever
// device that writes is open (sign-off writes them too, for a shift nobody
// had a device open in). From then until the shift ends, every new export
// of Planning.csv is checked against them: where the file now asks for
// something else in what is left of the shift — an order added, taken off
// or resized — the row is rewritten from that moment on. What the shift was
// asked for before then is never rewritten: each export moves the order
// under way to start at the export, and judged by that a shift would never
// be charged for the time it lost (see replannedShiftPlan). Rows of shifts
// before last month are deleted once a day.

import type { PmdDataLayer } from '../dal';
import { currentShift, dateKey, nextShift, shiftBounds } from '../core/shifts';

/** Minutes before a shift starts that its plans are written. */
export const WRITE_BEFORE_START_MIN = 60;

const CHECK_EVERY_MS = 5 * 60_000;
/** How often to replan when the export's time cannot be read. */
const REPLAN_BLIND_MS = 15 * 60_000;

/** The shifts whose plans are looked after at `now`: the one under way and,
 *  in its last WRITE_BEFORE_START_MIN minutes, the next. */
export function shiftsToKeep(now: Date = new Date()): string[] {
  const { shiftId } = currentShift(now);
  const next = nextShift(shiftId);
  const start = next ? shiftBounds(next)?.start : null;
  const soon = !!start && start.getTime() - now.getTime() <= WRITE_BEFORE_START_MIN * 60_000;
  return next && soon ? [shiftId, next] : [shiftId];
}

/** The first shift date PMD_ShiftPlan keeps at `now`: the 1st of last month. */
export function keepShiftPlansFrom(now: Date = new Date()): string {
  return dateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

/**
 * Look after the plans of the shift under way and the next one from this
 * page, checking every five minutes. `write` is asked each time: only a
 * device that writes (an iPad, or with a supervisor signed in) touches
 * anything.
 */
export function startShiftPlanKeeper(dal: PmdDataLayer, write: () => boolean): void {
  const keep = dal.keepShiftPlans?.bind(dal);
  if (!keep) return;
  const replan = dal.replanShiftPlans?.bind(dal);
  const version = dal.planningVersion?.bind(dal);
  const prune = dal.pruneShiftPlans?.bind(dal);
  const kept = new Set<string>();
  /** The export each shift was last replanned from. */
  const replannedFrom = new Map<string, string>();
  let prunedOn = '';
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy || !write()) return;
    busy = true;
    try {
      const now = new Date();
      const due = shiftsToKeep(now);
      for (const sid of [...kept]) if (!due.includes(sid)) kept.delete(sid);
      for (const sid of [...replannedFrom.keys()]) if (!due.includes(sid)) replannedFrom.delete(sid);
      const seen =
        (version ? await version().catch(() => null) : null) ??
        `every ${Math.floor(now.getTime() / REPLAN_BLIND_MS)}`;
      for (const sid of due) {
        try {
          if (!kept.has(sid)) {
            if (!(await keep(sid))) continue;
            kept.add(sid);
          }
          if (replan && replannedFrom.get(sid) !== seen) {
            if (await replan(sid, now, seen)) replannedFrom.set(sid, seen);
          }
        } catch (e) {
          console.warn(`[pmd] PMD_ShiftPlan ${sid} not kept up (retried in five minutes):`, e);
        }
      }
      const today = dateKey(now);
      if (prune && prunedOn !== today) {
        await prune(keepShiftPlansFrom(now));
        prunedOn = today;
      }
    } catch (e) {
      console.warn('[pmd] PMD_ShiftPlan upkeep failed (retried in five minutes):', e);
    } finally {
      busy = false;
    }
  };
  // Spread the devices out, so they seldom work on the same shift at once.
  const jitter = Math.round(Math.random() * 60_000);
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), CHECK_EVERY_MS);
  }, 8_000 + jitter);
}
