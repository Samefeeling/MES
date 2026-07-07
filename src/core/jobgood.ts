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

/**
 * Earlier-started tuples of this job that produced pieces but have NEVER
 * been signed off — the exact hole in the signed-only Job Left maths:
 * an unsigned Afternoon means the Night operator's Job Left silently
 * overstates what's still needed. The arithmetic stays signed-only on
 * purpose (mixing live tuples in re-opens the SFM507147 phantom-shadow
 * bug); this list exists so the UI can SAY the number is provisional
 * and name the shift that needs signing, instead of being silently
 * wrong. `all` must be the BLENDED read (live + cache + signed).
 * Returns "machine|shiftId" keys, earliest first.
 */
export function unsignedEarlierTuples(
  all: ProductionRecord[],
  currentKey: string,
): string[] {
  const myShiftId = currentKey.slice(currentKey.indexOf('|') + 1);
  const my = shiftBounds(myShiftId)?.start.getTime();
  // Which tuples carry a signed (or reopened-for-correction) row?
  const signed = new Set<string>();
  for (const r of all) {
    if (r.locked || r.reopened) signed.add(`${r.machineCode}|${r.shiftId}`);
  }
  const out: Array<{ key: string; startMs: number }> = [];
  for (const [key, t] of aggregateByTuple(all)) {
    if (key === currentKey || !t.real || signed.has(key)) continue;
    if (goodOf(t) <= 0) continue; // nothing produced — nothing missing
    if (my != null && !isNaN(my) && !isNaN(t.startMs) && t.startMs >= my) continue;
    out.push({ key, startMs: t.startMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs).map((o) => o.key);
}

/**
 * Corrections needed on LATER-started signed tuples' JobLeft after a
 * (typically late) sign-off lands. Floor reality: Night regularly signs
 * off before a forgotten Afternoon; when Afternoon's sign-off finally
 * arrives, Night's already-written JobLeft column still excludes
 * Afternoon's output. JobLeft is defined as "pieces still needed when
 * the shift began" — a fact — so the ledger must converge to
 *   required − Σ good(started earlier)
 * regardless of sign-off ORDER. Returns the tuples whose stored jobLeft
 * (canonical slot-0) disagrees with that, with the corrected value.
 * `all` must be SIGNED rows of the job, including the just-signed tuple.
 */
export function retroJobLeftFixes(
  all: ProductionRecord[],
  signedMachine: string,
  signedShiftId: string,
  required: number,
): Array<{ machineCode: string; shiftId: string; jobLeft: number }> {
  if (!(required > 0)) return [];
  const myStart = shiftBounds(signedShiftId)?.start.getTime();
  if (myStart == null || isNaN(myStart)) return [];
  const out: Array<{ machineCode: string; shiftId: string; jobLeft: number }> = [];
  const seen = new Set<string>();
  for (const r of all) {
    if (r.slotIndex !== 0) continue;
    const key = `${r.machineCode}|${r.shiftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.machineCode === signedMachine && r.shiftId === signedShiftId) continue;
    const start = shiftBounds(r.shiftId)?.start.getTime();
    if (start == null || isNaN(start) || start <= myStart) continue;
    const before = sumGoodStartedBefore(all, r.machineCode, r.shiftId);
    if (before == null) continue;
    const want = Math.max(0, required - before);
    if (r.jobLeft === want) continue;
    out.push({ machineCode: r.machineCode, shiftId: r.shiftId, jobLeft: want });
  }
  return out;
}
