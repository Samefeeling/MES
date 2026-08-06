/**
 * Which half-hour may a reject be filed against?
 *
 * A reject is production data: it belongs to the half-hour of THIS order's
 * run in which the parts were actually scrapped. Two situations are
 * provably not that, and both were showing up on the floor as rejects
 * booked against the wrong time:
 *
 *  - **The half-hour is another order's.** The press can only be in one
 *    state at a time, so a half-hour already carrying another job's
 *    Machine Status is that job's production, not this one's. The status
 *    grid has refused those cells for a while (`occupyingOtherJob`); the
 *    reject row did not, so the same mis-tap that the status grid caught
 *    still landed silently one row further down.
 *
 *  - **The half-hour is over and this order never logged anything on
 *    it.** With no Machine Status there is no production to attribute the
 *    reject to — Trace draws a red marker under a blank column, and the
 *    hour it really happened in shows clean. The observed failure was
 *    three different orders on one day whose whole run sat in the last
 *    columns of the shift, each with its rejects parked on slot 0: the
 *    grid scrolls horizontally on the iPad and the leftmost cell is what
 *    a worker lands on when they lose their place.
 *
 * Two deliberate exemptions keep the guard from getting in the way:
 *
 *  - **The half-hour running right now** (and anything later) is never
 *    blocked for lack of a status. It is still in progress — the operator
 *    records a reject when they find it and sets the status when the
 *    half-hour ends, and that order of operations has to keep working.
 *
 *  - **A cell that already holds a number** stays editable, whatever the
 *    verdict on the slot. The rows this guard is meant to prevent already
 *    exist on the floor; trapping them behind a disabled input would mean
 *    a supervisor could see the bad value in Trace and never clear it.
 */

/** Everything the decision needs to know about one reject cell. */
export interface RejectSlotFacts {
  /** Wall-clock label of the half-hour ("15:00–15:30"), for the message. */
  clock: string;
  /** This order has a Machine Status letter on this half-hour. */
  hasOwnStatus: boolean;
  /** Job number of the order that owns this half-hour, when it is not
   *  this one. Co-running orders share the timeline and are not
   *  occupiers — the caller resolves that before it gets here. */
  occupiedBy: string | null;
  /** The half-hour has finished. False for the one running now and for
   *  anything still to come; true for every slot of an ended shift. */
  isPast: boolean;
  /** Reject count already recorded in this cell. Non-zero keeps the cell
   *  editable so a wrong entry can be corrected or cleared. */
  existing: number;
}

export interface RejectSlotVerdict {
  blocked: boolean;
  /** Why, phrased for the operator — used as both tooltip and toast. */
  reason: string;
}

const OPEN: RejectSlotVerdict = { blocked: false, reason: '' };

export function rejectSlotBlock(f: RejectSlotFacts): RejectSlotVerdict {
  // Existing data always stays correctable — see the note above.
  if (f.existing > 0) return OPEN;
  if (f.occupiedBy) {
    return {
      blocked: true,
      reason: `${f.clock} belongs to ${f.occupiedBy} — switch to that order to log its rejects`,
    };
  }
  if (f.isPast && !f.hasOwnStatus) {
    return {
      blocked: true,
      reason: `Nothing was logged at ${f.clock} — set the Machine Status first, or put the reject on the half-hour it happened in`,
    };
  }
  return OPEN;
}
