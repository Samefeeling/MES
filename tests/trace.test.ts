import { describe, it, expect } from 'vitest';
import { jobMetrics, qcSummary, goodForRecords } from '../src/ui/trace';
import { order, rec } from './helpers';

describe('jobMetrics (Order Qty / Job Left / Shift Target)', () => {
  it('Order Qty = ProdQty, Job Left = remaining − job-wide Good', () => {
    // orderQty 200 total, 96 remaining per Epicor; 30 made so far in-app.
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96, qtyPerHr: 0 });
    const m = jobMetrics(o, 30);
    expect(m.orderQty).toBe(200);
    expect(m.jobLeft).toBe(66); // 96 − 30
    expect(m.shiftTarget).toBeNull(); // no cycle time
  });

  it('Job Left never goes negative', () => {
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96, qtyPerHr: 0 });
    expect(jobMetrics(o, 150).jobLeft).toBe(0);
  });

  it('Shift Target caps at a full 8h run when the job will not finish', () => {
    // cycle time 0.05 h/piece → a full shift is floor(8 / 0.05) = 160.
    // Job Left 1000 × 0.05 = 50 h ≥ 8 h, so target is the full-shift cap.
    const o = order({ jobNumber: 'J1', jobRequired: 1000, qtyPerHr: 0.05 });
    expect(jobMetrics(o, 0).shiftTarget).toBe(160);
  });

  it('Shift Target = Job Left when the job finishes inside the shift', () => {
    // Job Left 40 × 0.05 = 2 h < 8 h, so the target is just the remainder.
    const o = order({ jobNumber: 'J1', jobRequired: 40, qtyPerHr: 0.05 });
    expect(jobMetrics(o, 0).shiftTarget).toBe(40);
  });

  it('returns nulls for die-change pseudo-orders and missing plans', () => {
    const dc = order({ jobNumber: 'DC', isDieChange: true });
    expect(jobMetrics(dc, 0)).toEqual({ orderQty: null, jobLeft: null, shiftTarget: null });
    expect(jobMetrics(undefined, 0)).toEqual({
      orderQty: null,
      jobLeft: null,
      shiftTarget: null,
    });
  });
});

describe('goodForRecords (job-wide Good across shifts)', () => {
  it('sums gross−reject per (machine, shift) tuple', () => {
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

describe('qcSummary (management QC roll-up)', () => {
  it('counts sign-offs and flags supervisor cadence slots (1/7/13)', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', qcBy: 'Tin Maung' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R', qcBy: 'Christopher King' }),
      rec({ jobNumber: 'J1', slotIndex: 7, statusCode: 'R', qcBy: 'Christopher King' }),
      rec({ jobNumber: 'J1', slotIndex: 2, statusCode: 'R' }), // no QC
    ];
    const qc = qcSummary(recs);
    expect(qc.signed).toBe(3);
    expect(qc.supervisorSigned).toBe(2); // slots 1 and 7
    expect(qc.slots.map((s) => s.slot)).toEqual([0, 1, 7]); // sorted
    expect(qc.slots[0].role).toBe('operator');
    expect(qc.slots[1].role).toBe('supervisor');
  });
});
