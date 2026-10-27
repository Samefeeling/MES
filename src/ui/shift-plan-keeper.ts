// The plan of record of each shift (PMD_ShiftPlan), kept while it runs.
//
// Planning.csv is re-exported over the plan it replaces, and Epicor moves an
// order under way to start at the export's "now": the morning export takes
// the night's in-progress order out of the night that ran it. So each
// shift's plan is kept once the shift is under way, by whichever device
// that writes is open first; sign-off keeps it too, for a shift nobody had
// a device open in, by which time it may be too late.

import type { PmdDataLayer } from '../dal';
import { currentShift, shiftBounds } from '../core/shifts';

/** Minutes into a shift before its plan is kept — room for an export made
 *  at the shift change to reach the app, so a shift is not kept from the
 *  file of the shift before. */
export const KEEP_AFTER_START_MIN = 30;

const CHECK_EVERY_MS = 10 * 60_000;

/** The shift whose plan is due to be kept at `now`, or null while the
 *  current shift is still in its first KEEP_AFTER_START_MIN minutes. */
export function shiftToKeep(now: Date = new Date()): string | null {
  const { shiftId } = currentShift(now);
  const bounds = shiftBounds(shiftId);
  if (!bounds) return null;
  return now.getTime() - bounds.start.getTime() >= KEEP_AFTER_START_MIN * 60_000 ? shiftId : null;
}

/**
 * Keep the current shift's plans once per shift from this page, checking
 * every ten minutes. `write` is asked each time: only a device that writes
 * (an iPad, or with a supervisor signed in) keeps anything.
 */
export function startShiftPlanKeeper(dal: PmdDataLayer, write: () => boolean): void {
  const keep = dal.keepShiftPlans?.bind(dal);
  if (!keep) return;
  let kept = '';
  let busy = false;
  const tick = async (): Promise<void> => {
    const shiftId = shiftToKeep();
    if (!shiftId || shiftId === kept || busy || !write()) return;
    busy = true;
    try {
      if (await keep(shiftId)) kept = shiftId;
    } catch (e) {
      console.warn('[pmd] PMD_ShiftPlan keep failed (retried in ten minutes):', e);
    } finally {
      busy = false;
    }
  };
  // Spread the devices out, so they seldom keep the same shift at once.
  const jitter = Math.round(Math.random() * 60_000);
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), CHECK_EVERY_MS);
  }, 8_000 + jitter);
}
