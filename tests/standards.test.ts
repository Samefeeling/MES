import { describe, it, expect } from 'vitest';
import {
  DIE_CHANGE_STD_HRS,
  COLOR_CHANGE_STD_HRS,
  INSERT_CHANGE_STD_HRS,
  expectedShiftOutput,
  expectedShiftOutputFromPlanning,
  setupJudgement,
  setupStandardHours,
  type PlannedOrderLike,
} from '../src/core/standards';
import type { ProductionRecord } from '../src/types';

const SID = '2026-05-17-Day'; // 07:00 → 15:00

function slot(
  slotIndex: number,
  statusCode: ProductionRecord['statusCode'],
  jobNumber = 'J1',
): ProductionRecord {
  return {
    id: 0,
    machineCode: '850T',
    shiftId: SID,
    jobNumber,
    partNumber: '',
    slotIndex,
    statusCode,
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
    purgeKg: null,
    operator: '',
    supervisor: '',
    bdIssue: '',
    mangoTicket: '',
    handoverNote: '',
    qcBy: '',
    locked: true,
    lockedBy: '',
    lockedAt: '',
    createdAt: '',
    updatedAt: '',
  };
}

/** n R-slots for a job starting at a slot index. */
function running(job: string, from: number, n: number): ProductionRecord[] {
  return Array.from({ length: n }, (_, i) => slot(from + i, 'R', job));
}

describe('setupStandardHours (die 4h, colour/insert 30min per occurrence)', () => {
  it('multiplies occurrence counts by the standards', () => {
    expect(setupStandardHours({ dieChanges: 2, colorChanges: 1, insertChanges: 3 })).toEqual({
      dieStdHrs: 2 * DIE_CHANGE_STD_HRS,
      colorStdHrs: 1 * COLOR_CHANGE_STD_HRS,
      insertStdHrs: 3 * INSERT_CHANGE_STD_HRS,
    });
  });
});

describe('setupJudgement (红黄蓝 vs the standard allowance)', () => {
  it('blue at/under standard, amber one block over, red beyond', () => {
    expect(setupJudgement(4, 4)).toBe('blue'); // exactly 8 D blocks
    expect(setupJudgement(3.5, 4)).toBe('blue'); // faster than standard
    expect(setupJudgement(4.5, 4)).toBe('amber'); // 1 extra block
    expect(setupJudgement(5, 4)).toBe('red'); // 2+ extra blocks
    expect(setupJudgement(1, 0.5)).toBe('amber');
    expect(setupJudgement(1.5, 0.5)).toBe('red');
  });

  it("'' when nothing to judge (no changeover, or standards not computed)", () => {
    expect(setupJudgement(0, 0)).toBe('');
    expect(setupJudgement(3, null)).toBe('');
  });
});

describe('expectedShiftOutput (planning StartDate+StartHour × Standard hour)', () => {
  const ct = new Map([['J1', 0.01]]); // 0.01 h/pc → 100 pcs/h

  it('full shift, no setup: 8h / ct', () => {
    const e = expectedShiftOutput(SID, running('J1', 0, 16), ct, new Map());
    expect(e.pieces).toBe(800);
    expect(e.expRunHrs).toBe(8);
  });

  it('deducts the STANDARD 4h for a die change even when it dragged to 5h', () => {
    // 10 D slots (5h actual) + 6 R — the allowance stays 4h, so the
    // expectation only drops by 4h: a slow die change shows as missed
    // output rather than lowering the bar.
    const recs = [
      ...Array.from({ length: 10 }, (_, i) => slot(i, 'D')),
      ...running('J1', 10, 6),
    ];
    const e = expectedShiftOutput(SID, recs, ct, new Map());
    expect(e.stdSetupHrs).toBe(4);
    expect(e.pieces).toBe(400); // (8 − 4) / 0.01
  });

  it('one order’s die change earns ONE allowance even when logged in two pieces', () => {
    // The floor rule: a changeover belongs to the order it sets the press
    // up for. Granting 2 × 4 h here would let an 8-hour die change pass as
    // within standard, and would wipe out the shift's expected output.
    const recs = [
      ...Array.from({ length: 4 }, (_, i) => slot(i, 'D')),
      ...running('J1', 4, 4),
      ...Array.from({ length: 4 }, (_, i) => slot(8 + i, 'D')),
      ...running('J1', 12, 4),
    ];
    const e = expectedShiftOutput(SID, recs, ct, new Map());
    expect(e.stdSetupHrs).toBe(4);
    expect(e.pieces).toBe(400); // (8 − 4) / 0.01
  });

  it('two orders’ die changes earn two allowances', () => {
    const recs = [
      ...Array.from({ length: 4 }, (_, i) => slot(i, 'D', 'J1')),
      ...running('J1', 4, 4),
      ...Array.from({ length: 4 }, (_, i) => slot(8 + i, 'D', 'J2')),
      ...running('J2', 12, 4),
    ];
    const e = expectedShiftOutput(SID, recs, ct, new Map());
    expect(e.stdSetupHrs).toBe(8);
    expect(e.pieces).toBe(0); // 8 − 8 = nothing left to expect
  });

  it('colour change deducts 30min per occurrence', () => {
    const recs = [slot(0, 'C'), ...running('J1', 1, 15)];
    const e = expectedShiftOutput(SID, recs, ct, new Map());
    expect(e.stdSetupHrs).toBe(0.5);
    expect(e.pieces).toBe(750);
  });

  it('smoko (M) is deducted at actual duration', () => {
    const recs = [...running('J1', 0, 8), slot(8, 'M'), ...running('J1', 9, 7)];
    const e = expectedShiftOutput(SID, recs, ct, new Map());
    expect(e.smokoHrs).toBe(0.5);
    expect(e.pieces).toBe(750);
  });

  it('planned start mid-shift trims the expectation window', () => {
    // Planned 11:00 on a 07:00–15:00 Day shift → only 4h expected.
    const ps = new Map([['J1', '2026-05-17T11:00:00']]);
    const e = expectedShiftOutput(SID, running('J1', 8, 8), ct, ps);
    expect(e.lateStartHrs).toBe(4);
    expect(e.pieces).toBe(400);
  });

  it('planned before shift start expects the full shift', () => {
    const ps = new Map([['J1', '2026-05-16T23:00:00']]);
    const e = expectedShiftOutput(SID, running('J1', 0, 16), ct, ps);
    expect(e.lateStartHrs).toBe(0);
    expect(e.pieces).toBe(800);
  });

  it('null when no job has a cycle time', () => {
    const e = expectedShiftOutput(SID, running('J1', 0, 16), new Map(), new Map());
    expect(e.pieces).toBeNull();
  });

  it('multi-job shift weights each rate by its slot footprint', () => {
    // J1 (0.01 h/pc) ran 8 slots, J2 (0.02 h/pc) ran 8 slots.
    // expected = 8h × (8/0.01 + 8/0.02) / 16 = 8 × 75 = 600
    const cts = new Map([
      ['J1', 0.01],
      ['J2', 0.02],
    ]);
    const recs = [...running('J1', 0, 8), ...running('J2', 8, 8)];
    const e = expectedShiftOutput(SID, recs, cts, new Map());
    expect(e.pieces).toBe(600);
  });

  it('a job with no cycle time dilutes the expectation instead of vanishing', () => {
    // Half the shift ran a no-ct job — only J1's half is expected.
    const recs = [...running('J1', 0, 8), ...running('JX', 8, 8)];
    const e = expectedShiftOutput(SID, recs, new Map([['J1', 0.01]]), new Map());
    expect(e.pieces).toBe(400); // 8h × (8/0.01)/16
  });
});

describe('expectedShiftOutputFromPlanning (planned queue simulation)', () => {
  // Day shift 2026-05-17 runs 07:00 → 15:00.
  const order = (over: Partial<PlannedOrderLike>): PlannedOrderLike => ({
    jobNumber: 'J1',
    plannedStart: '2026-05-17T07:00:00',
    remainingLaborHrs: 40,
    remainingQty: 100000,
    hrsPerPiece: 0.01,
    ...over,
  });

  it('one long order fills the shift at its ProdStandard', () => {
    const e = expectedShiftOutputFromPlanning(SID, [order({})], 0, 0);
    expect(e.pieces).toBe(800); // 8h / 0.01
    expect(e.jobsUsed).toEqual(['J1']);
  });

  it('the user recurrence: prev order finishes → remaining qty + rest of 8h on the next order', () => {
    // J1 needs 3 labor hours / 300 pcs left; J2 queued behind at 0.02 h/pc.
    // expected = 300 + (8 − 3) / 0.02 = 300 + 250
    const q = [
      order({ jobNumber: 'J1', remainingLaborHrs: 3, remainingQty: 300 }),
      order({ jobNumber: 'J2', plannedStart: '2026-05-17T10:00:00', hrsPerPiece: 0.02 }),
    ];
    const e = expectedShiftOutputFromPlanning(SID, q, 0, 0);
    expect(e.pieces).toBe(300 + 250);
    expect(e.jobsUsed).toEqual(['J1', 'J2']);
  });

  it('a die change between the orders costs its 4h STANDARD', () => {
    // expected = 300 + (8 − 3 − 4h C/O) / 0.02 = 300 + 50
    const q = [
      order({ jobNumber: 'J1', remainingLaborHrs: 3, remainingQty: 300 }),
      order({ jobNumber: 'J2', plannedStart: '2026-05-17T10:00:00', hrsPerPiece: 0.02 }),
    ];
    const e = expectedShiftOutputFromPlanning(SID, q, 4, 0);
    expect(e.pieces).toBe(350);
  });

  it('caps a partial run at the order remaining quantity', () => {
    // Inconsistent Epicor data: 12 labor hours left but only 100 pcs.
    const e = expectedShiftOutputFromPlanning(
      SID,
      [order({ remainingLaborHrs: 12, remainingQty: 100 })],
      0,
      0,
    );
    expect(e.pieces).toBe(100);
  });

  it('a late planned start leaves the gap unexpected', () => {
    const e = expectedShiftOutputFromPlanning(
      SID,
      [order({ plannedStart: '2026-05-17T11:00:00' })],
      0,
      0,
    );
    expect(e.pieces).toBe(400); // only 4 of the 8 hours were scheduled
  });

  it('an order already running from yesterday fills from shift start', () => {
    const e = expectedShiftOutputFromPlanning(
      SID,
      [order({ plannedStart: '2026-05-16T19:00:00' })],
      0,
      0,
    );
    expect(e.pieces).toBe(800);
  });

  it('falls back to remainingQty × ProdStandard when labor hours are blank', () => {
    // 200 pcs × 0.01 = 2h of work, done inside the shift → 200 expected.
    const e = expectedShiftOutputFromPlanning(
      SID,
      [order({ remainingLaborHrs: 0, remainingQty: 200 })],
      0,
      0,
    );
    expect(e.pieces).toBe(200);
  });

  it('null when nothing in planning overlaps the shift (rolled-off history)', () => {
    const e = expectedShiftOutputFromPlanning(
      SID,
      [order({ plannedStart: '2026-05-20T07:00:00' })],
      0,
      0,
    );
    expect(e.pieces).toBeNull();
    expect(e.jobsUsed).toEqual([]);
  });
});
