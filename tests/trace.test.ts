import { describe, it, expect } from 'vitest';
import { goodForRecords, syntheticOrderFromRecord } from '../src/ui/trace';
import { jobLeftPiecesFor, shiftTargetFor } from '../src/ui/operator';
import { order, rec } from './helpers';

// Job Left / Shift Target are pure formulas owned by the operator module
// — the Trace page reuses them so management sees the same numbers as
// the operator. These tests fence the formula behaviour at that seam.

describe('jobLeftPiecesFor (shared with operator side panel)', () => {
  it('Job Left = ORDER TOTAL − cumulative Good across every shift', () => {
    // The base is orderQty (JobHead_ProdQty), NOT jobRequired (Epicor's
    // Calculated_RemainingQty): Epicor decrements the latter as
    // production is reported back to it, so subtracting PMD's Good from
    // it again double-counted every reported piece — SFM507147 showed
    // Job Left 0 while 656 genuinely remained.
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 30)).toBe(170); // 200 − 30
  });

  it('falls back to the remaining qty when no total was exported', () => {
    const o = order({ jobNumber: 'J1', orderQty: 0, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 30)).toBe(66); // 96 − 30
  });

  it('never goes negative', () => {
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 250)).toBe(0);
  });

  it('returns null for die-change pseudo-orders', () => {
    const dc = order({ jobNumber: 'DC', isDieChange: true });
    expect(jobLeftPiecesFor(dc, 0)).toBeNull();
  });
});

describe('shiftTargetFor (shared with operator side panel)', () => {
  it('caps at a full 8 h run when the job will not finish', () => {
    // cycle time 0.05 h/piece → a full shift is floor(8 / 0.05) = 160.
    // Job Left 1000 × 0.05 = 50 h ≥ 8 h, so the cap wins.
    const o = order({ jobNumber: 'J1', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 1000)).toBe(160);
  });

  it('= Job Left when the job finishes inside the shift', () => {
    // 40 × 0.05 = 2 h < 8 h, so the target is just the remainder.
    const o = order({ jobNumber: 'J1', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 40)).toBe(40);
  });

  it('returns null when no cycle time is on the planning row', () => {
    const o = order({ jobNumber: 'J1', qtyPerHr: 0 });
    expect(shiftTargetFor(o, 100)).toBeNull();
  });
});

describe('goodForRecords (job-wide Good across shifts)', () => {
  it('sums gross − reject per (machine, shift) tuple', () => {
    const recs = [
      // Day shift: gross 100, 4 rejects → 96 good.
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 100 }),
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'R', rejects: '{"D01":4}' }),
      // Afternoon shift on the same machine: gross 50, no rejects → 50.
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        shiftId: '2026-05-15-Afternoon',
        countStart: 100,
        countEnd: 150,
      }),
    ];
    expect(goodForRecords(recs)).toBe(146); // 96 + 50
  });
});

describe('syntheticOrderFromRecord (past-shift order rebuilt from PMD_Production)', () => {
  it('rebuilds Order Qty + Job Left basis from the denormalised JobRequired total', () => {
    // PMD_Production.JobRequired denormalises the ORDER TOTAL, so a Job
    // Number search for a job Epicor has dropped from Planning.csv still
    // resolves Order Qty / Job Left straight from the List.
    const canon = rec({
      jobNumber: 'SFM507067',
      slotIndex: 0,
      statusCode: 'R',
      partNumber: 'V11690',
      partDescription: 'Ned Stool',
      jobRequired: 96,
      countStart: 0,
      countEnd: 83,
    });
    const o = syntheticOrderFromRecord(canon, 'SFM507067')!;
    expect(o.orderQty).toBe(96);
    expect(o.jobRequired).toBe(96);
    expect(o.partNumber).toBe('V11690');
    // Job Left flows through the SAME formula the operator sheet uses.
    expect(jobLeftPiecesFor(o, 30)).toBe(66); // 96 − 30
    // No cycle time is recorded on PMD_Production, so Shift Target is "—"
    // (null) — identical to how the operator sheet renders a dropped order.
    expect(shiftTargetFor(o, jobLeftPiecesFor(o, 30)!)).toBeNull();
  });

  it('returns null when there is no recorded order total to rebuild from', () => {
    const canon = rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' });
    expect(syntheticOrderFromRecord(canon, 'J1')).toBeNull();
    expect(syntheticOrderFromRecord(undefined, 'J1')).toBeNull();
  });
});
