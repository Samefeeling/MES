import type { ProductionRecord } from '../types';
import { cavityGross } from './metrics';
import { shiftBounds } from './shifts';

// Cross-shift Good totals for the Job Left math. Shared by the operator
// page (live "Job left" cell) and the DAL's sign-off (authoritative
// JobLeft column recompute), so both read the same definition of "how
// much of this order is already made".

interface TupleAgg {
  /** slot-0 counters × cavities — gross lives ONLY on the canonical slot. */
  gross: number;
  /** Σ rejects across ALL slots — reject events round-trip onto their own
   *  slot (see expandHeaderToSlots / timelineToSlot); summing slot 0 alone
   *  dropped every reject after the first half hour and handed the next
   *  shift the GROSS count as "good". */
  rejects: number;
  /** Signed-off / reopened, or carries at least one machine-status letter.
   *  A tuple with counters but not a single status letter is a mis-tap or
   *  a stale PMD_LiveStatus shadow, not production — counting one silently
   *  inflates the cross-shift Good and crashes Job Left toward 0
   *  (SFM507147: one phantom shadow added a constant 456 pieces to every
   *  Job Left freeze after it appeared). */
  real: boolean;
  /** Physical start of the tuple's shift (Night dated 2/07 starts 23:00
   *  that evening). NaN when the shiftId doesn't parse. */
  startMs: number;
}

function aggregateByTuple(all: ProductionRecord[]): Map<string, TupleAgg> {
  const tuples = new Map<string, TupleAgg>();
  for (const r of all) {
    const key = `${r.machineCode}|${r.shiftId}`;
    let t = tuples.get(key);
    if (!t) {
      t = {
        gross: 0,
        rejects: 0,
        real: false,
        startMs: shiftBounds(r.shiftId)?.start.getTime() ?? NaN,
      };
      tuples.set(key, t);
    }
    if (r.slotIndex === 0) t.gross = cavityGross(r.countStart, r.countEnd, r.cavities);
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      t.rejects += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      t.rejects += Number(r.rejectCount) || 0;
    }
    if (r.locked || r.reopened || r.statusCode) t.real = true;
  }
  return tuples;
}

/** Net good, clamped so a tuple with more rejects than gross (bad data)
 *  contributes 0 instead of eating another shift's output. */
const goodOf = (t: TupleAgg): number => Math.max(0, t.gross - t.rejects);

/**
 * Σ good across every real (machine, shift) tuple of this job EXCEPT
 * `currentKey`. The currently-viewed tuple is excluded because the
 * operator page adds it back via goodThis — counting it here too
 * double-subtracted it from JobRequired and made Job Left collapse to 0
 * the moment Count End was filled in.
 */
export function sumOtherShiftGood(all: ProductionRecord[], currentKey: string): number {
  let total = 0;
  for (const [key, t] of aggregateByTuple(all)) {
    if (key === currentKey || !t.real) continue;
    total += goodOf(t);
  }
  return total;
}

/**
 * Σ good across real tuples whose shift physically STARTED before the
 * given one. lockShift uses this to recompute "pieces still needed when
 * this shift began" from the production list itself and write THAT into
 * the JobLeft column — instead of trusting the value frozen client-side
 * at job start, which inherits whatever junk the freezing device could
 * see at that moment and can never self-correct. Tuples that start at
 * the same instant (the same shift on another press) are treated as
 * concurrent, not earlier. Returns null when `shiftId` doesn't parse —
 * no ordering is possible, so the caller should fall back.
 */
export function sumGoodStartedBefore(
  all: ProductionRecord[],
  machineCode: string,
  shiftId: string,
): number | null {
  const my = shiftBounds(shiftId)?.start.getTime();
  if (my == null || isNaN(my)) return null;
  const currentKey = `${machineCode}|${shiftId}`;
  let total = 0;
  for (const [key, t] of aggregateByTuple(all)) {
    if (key === currentKey || !t.real) continue;
    if (isNaN(t.startMs) || t.startMs >= my) continue;
    total += goodOf(t);
  }
  return total;
}
