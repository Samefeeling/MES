import { describe, it, expect } from 'vitest';
import { hoursUnavailableFor, shiftTargetFor } from '../src/core/targets';
import { expectedShiftOutputFromTargets } from '../src/core/standards';
import { order, rec } from './helpers';

// The operator-stated Shift Target rule:
//   capacity = (8h − hours consumed by previous order − changeover) ÷ ProdStandard
//   target   = JobLeft < capacity ? JobLeft : capacity

describe('hoursUnavailableFor — press hours not available to a job', () => {
  it('is 0 for an empty shift and for a job with the whole press', () => {
    expect(hoursUnavailableFor([], 'J1')).toBe(0);
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'B' }),
      rec({ jobNumber: 'J1', slotIndex: 2, statusCode: 'M' }),
    ];
    // Own run / breakdown / smoko slots never deduct — losses inside the
    // job's own run must show as a missed target, not a lowered bar.
    expect(hoursUnavailableFor(recs, 'J1')).toBe(0);
  });

  it('counts every slot held by a previous order, whatever its status', () => {
    const recs = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'A', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'A', slotIndex: 2, statusCode: 'B' }),
      rec({ jobNumber: 'A', slotIndex: 3, statusCode: 'M' }),
      rec({ jobNumber: 'B', slotIndex: 4, statusCode: 'R' }),
    ];
    // For B: A held 4 slots = 2 h.
    expect(hoursUnavailableFor(recs, 'B')).toBe(2);
    // For A: B's later slot is press time A did not get either.
    expect(hoursUnavailableFor(recs, 'A')).toBe(0.5);
  });

  it("counts the job's own changeover (D/C/I) but not startup/purge", () => {
    const recs = [
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'B', slotIndex: 1, statusCode: 'D' }),
      rec({ jobNumber: 'B', slotIndex: 2, statusCode: 'C' }),
      rec({ jobNumber: 'B', slotIndex: 3, statusCode: 'I' }),
      rec({ jobNumber: 'B', slotIndex: 4, statusCode: 'S' }),
      rec({ jobNumber: 'B', slotIndex: 5, statusCode: 'P' }),
      rec({ jobNumber: 'B', slotIndex: 6, statusCode: 'R' }),
    ];
    // 2×D + 1×C + 1×I = 4 slots = 2 h; S/P/R don't deduct.
    expect(hoursUnavailableFor(recs, 'B')).toBe(2);
  });

  it('counts a die-change pseudo-order timeline as consumed hours', () => {
    const recs = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'A', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'DC_A_B', slotIndex: 2, statusCode: 'D' }),
      rec({ jobNumber: 'DC_A_B', slotIndex: 3, statusCode: 'D' }),
      rec({ jobNumber: 'B', slotIndex: 4, statusCode: 'R' }),
    ];
    // For B: A's 2 slots + the DC block's 2 slots = 2 h.
    expect(hoursUnavailableFor(recs, 'B')).toBe(2);
  });

  it('exempts co-run mirrors: a slot held by BOTH jobs is simultaneous work', () => {
    const recs = [
      rec({ jobNumber: 'X', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'Y', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'X', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'Y', slotIndex: 1, statusCode: 'R' }),
    ];
    expect(hoursUnavailableFor(recs, 'X')).toBe(0);
    expect(hoursUnavailableFor(recs, 'Y')).toBe(0);
  });

  it('counts a mirrored co-run changeover once (as own changeover)', () => {
    const recs = [
      rec({ jobNumber: 'X', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'Y', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'X', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'Y', slotIndex: 1, statusCode: 'R' }),
    ];
    expect(hoursUnavailableFor(recs, 'X')).toBe(0.5);
    expect(hoursUnavailableFor(recs, 'Y')).toBe(0.5);
  });

  it('ignores blank statuses (canonical slot-0 rows hold nothing)', () => {
    const recs = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R' }),
      // B's canonical row — a counters-only record, not a held slot.
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: '' }),
      rec({ jobNumber: 'B', slotIndex: 1, statusCode: 'R' }),
    ];
    expect(hoursUnavailableFor(recs, 'B')).toBe(0.5); // A's slot 0 only
  });
});

describe('shiftTargetFor with consumed hours', () => {
  it('keeps the original whole-8h rule when nothing was consumed', () => {
    const o = order({ jobNumber: 'J1', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 1000)).toBe(160); // floor(8 / 0.05)
    expect(shiftTargetFor(o, 40)).toBe(40); // finishes inside the shift
    expect(shiftTargetFor(order({ jobNumber: 'J1', qtyPerHr: 0 }), 100)).toBeNull();
  });

  it('Else branch: capacity = (8h − consumed) ÷ ProdStandard', () => {
    // Previous order used 5 h, changeover 1 h → 2 h left at 0.005 h/pc.
    const o = order({ jobNumber: 'B', qtyPerHr: 0.005 });
    expect(shiftTargetFor(o, 1000, 6)).toBe(400); // floor(2 / 0.005)
  });

  it('When branch: JobLeft below the reduced capacity wins', () => {
    const o = order({ jobNumber: 'B', qtyPerHr: 0.005 });
    expect(shiftTargetFor(o, 300, 6)).toBe(300);
  });

  it('clamps: a fully-consumed shift targets 0; negative input is ignored', () => {
    const o = order({ jobNumber: 'B', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 500, 8)).toBe(0);
    expect(shiftTargetFor(o, 500, 12)).toBe(0);
    expect(shiftTargetFor(o, 1000, -3)).toBe(160);
  });
});

describe('expectedShiftOutputFromTargets — KPI Output vs plan / vs Plan', () => {
  // The floor-stated recurrence, straight from the recorded shift:
  //   expected = JobLeft(prev, finishes inside the shift)
  //            + (8h − prev hours − changeover) ÷ ProdStandard(next)
  it('sums per-order Shift Targets across a two-order shift with a die change', () => {
    const recs = [
      // Order A: 2 h of running, finished (Job Left at start = 40).
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', jobLeft: 40, cycleTime: 0.05 }),
      rec({ jobNumber: 'A', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'A', slotIndex: 2, statusCode: 'R' }),
      rec({ jobNumber: 'A', slotIndex: 3, statusCode: 'R' }),
      // Die change logged on its own pseudo-order: 1 h.
      rec({ jobNumber: 'DC_A_B', slotIndex: 0, statusCode: '', jobLeft: 0 }),
      rec({ jobNumber: 'DC_A_B', slotIndex: 4, statusCode: 'D' }),
      rec({ jobNumber: 'DC_A_B', slotIndex: 5, statusCode: 'D' }),
      // Order B: big job, runs out the shift.
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: '', jobLeft: 2000, cycleTime: 0.005 }),
      rec({ jobNumber: 'B', slotIndex: 6, statusCode: 'R' }),
    ];
    // A: later orders held 1.5 h → capacity floor(6.5 / 0.05) = 130;
    //    Job Left 40 < 130 → target 40 (the job finishes).
    // B: (8 − 2 h prev order − 1 h changeover) = 5 h ÷ 0.005 = 1000 < 2000 → 1000.
    expect(expectedShiftOutputFromTargets(recs, new Map())).toBe(1040);
  });

  it('falls back (null) when any demanded order lacks JobLeft or a cycle time', () => {
    const missingJobLeft = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', cycleTime: 0.05 }),
    ];
    expect(expectedShiftOutputFromTargets(missingJobLeft, new Map())).toBeNull();
    const missingCt = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', jobLeft: 500 }),
    ];
    expect(expectedShiftOutputFromTargets(missingCt, new Map())).toBeNull();
  });

  it('uses the planning cycle time when the row was signed without one', () => {
    const recs = [rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', jobLeft: 500 })];
    expect(expectedShiftOutputFromTargets(recs, new Map([['A', 0.05]]))).toBe(160);
  });

  it('returns null when nothing was demanded (die-change-only shift / no rows)', () => {
    expect(expectedShiftOutputFromTargets([], new Map())).toBeNull();
    const dcOnly = [
      rec({ jobNumber: 'DC_A_B', slotIndex: 0, statusCode: 'D', jobLeft: 0 }),
    ];
    expect(expectedShiftOutputFromTargets(dcOnly, new Map())).toBeNull();
  });
});
