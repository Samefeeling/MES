import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  kpiComparisonLabel,
  kpiComparisonMode,
  savedPlanMissing,
  savedScheduleTuples,
  scheduleAdherenceForShift,
  scheduleSnapshotForShift,
  snapshotToSave,
  targetAttainmentForRecords,
} from '../src/core/kpi-attainment';
import { order, rec } from './helpers';

describe('KPI comparison modes', () => {
  it('plans live for Last 24h and from the saved plans for wider/custom ranges', () => {
    expect(kpiComparisonMode('last3')).toBe('schedule');
    expect(kpiComparisonLabel(kpiComparisonMode('last3'))).toBe('Schedule Adherence');
    for (const period of ['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'custom']) {
      expect(kpiComparisonMode(period)).toBe('saved');
      expect(kpiComparisonLabel(kpiComparisonMode(period))).toBe('Schedule Adherence');
    }
  });

  it('caps each scheduled job so one over-produced order cannot hide another miss', () => {
    const shiftId = '2026-05-15-Day';
    const orders = [
      order({ jobNumber: 'A', machineCode: '125T', qtyPerHr: 1 / 25 }),
      order({ jobNumber: 'B', machineCode: '125T', qtyPerHr: 1 / 25 }),
    ];
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 200 }),
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 50 }),
    ];

    const got = scheduleAdherenceForShift(
      records,
      orders,
      '125T',
      shiftId,
      new Date('2026-05-16T00:00:00'),
    );

    expect(got).toEqual({ actual: 150, expected: 200, pct: 75, covered: 2, total: 2 });
  });

  it('judges the shift on its planned RUNTIME, not on its length', () => {
    /*
     * One order planned across the whole Day shift at 25/h. Eight hours would
     * be 200 pieces — but the shift spent its first four changing the die, and
     * the bar has to be the four hours it had left: Shift Planned Runtime ×
     * JobOper_ProdStandard.
     *
     * The allowance is the STANDARD 4 h for one die change, not the time the
     * changeover actually took, so a die change that dragged on still shows up
     * as missed output rather than quietly lowering the bar.
     */
    const shiftId = '2026-05-15-Day';
    const plan = order({
      jobNumber: 'A',
      machineCode: '125T',
      plannedStart: '2026-05-15T07:00:00',
      plannedEnd: '2026-05-15T15:00:00',
      qtyPerHr: 1 / 25,
    });
    const now = new Date('2026-05-16T00:00:00');

    const ranThrough = Array.from({ length: 16 }, (_, slotIndex) =>
      rec({
        jobNumber: 'A', slotIndex, statusCode: 'R',
        ...(slotIndex === 0 ? { countStart: 0, countEnd: 90 } : {}),
      }),
    );
    expect(scheduleAdherenceForShift(ranThrough, [plan], '125T', shiftId, now)).toEqual({
      actual: 90, expected: 200, pct: 45, covered: 1, total: 1,
    });

    // The same 90 pieces, made in the four hours a die change left.
    const changedOver = Array.from({ length: 16 }, (_, slotIndex) =>
      rec({
        jobNumber: 'A', slotIndex,
        statusCode: slotIndex < 8 ? 'D' : 'R',
        ...(slotIndex === 0 ? { countStart: 0, countEnd: 90 } : {}),
      }),
    );
    expect(scheduleAdherenceForShift(changedOver, [plan], '125T', shiftId, now)).toEqual({
      actual: 90, expected: 100, pct: 90, covered: 1, total: 1,
    });
  });

  it('shares one press between the plan’s overlapping windows', () => {
    // Both orders are planned across the whole shift, which Epicor allows and
    // the Gantt draws in two lanes. The press is still one press: the bar is
    // eight hours of output between them, not eight hours each.
    const shiftId = '2026-05-15-Day';
    const spanning = (jobNumber: string) =>
      order({
        jobNumber, machineCode: '125T', qtyPerHr: 1 / 25,
        plannedStart: '2026-05-15T07:00:00',
        plannedEnd: '2026-05-15T15:00:00',
      });
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 100 }),
      rec({ jobNumber: 'B', slotIndex: 8, statusCode: 'R', countStart: 0, countEnd: 60 }),
    ];
    const got = scheduleAdherenceForShift(
      records,
      [spanning('A'), spanning('B')],
      '125T',
      shiftId,
      new Date('2026-05-16T00:00:00'),
    );
    expect(got.expected).toBe(200); // 8 h × 25, not 16 h × 25
    expect(got.actual).toBe(160);
    expect(got.pct).toBe(80);
  });

  it('never deducts more hours than the press spent not running', () => {
    // Co-running orders mirror the same die change onto both their rows, which
    // counts as two changeovers and eight hours of allowance on an eight-hour
    // shift. The press was running for six of them, so at most two were lost.
    const shiftId = '2026-05-15-Day';
    const plan = (jobNumber: string) =>
      order({
        jobNumber, machineCode: '125T', qtyPerHr: 1 / 25,
        plannedStart: '2026-05-15T07:00:00',
        plannedEnd: '2026-05-15T15:00:00',
      });
    const records = [
      ...Array.from({ length: 16 }, (_, slotIndex) =>
        rec({
          jobNumber: 'A', slotIndex, statusCode: slotIndex < 4 ? 'D' : 'R',
          ...(slotIndex === 0 ? { countStart: 0, countEnd: 100 } : {}),
        }),
      ),
      ...Array.from({ length: 16 }, (_, slotIndex) =>
        rec({
          jobNumber: 'B', slotIndex, statusCode: slotIndex < 4 ? 'D' : 'R',
          ...(slotIndex === 0 ? { countStart: 0, countEnd: 100 } : {}),
        }),
      ),
    ];
    const got = scheduleAdherenceForShift(
      records,
      [plan('A'), plan('B')],
      '125T',
      shiftId,
      new Date('2026-05-16T00:00:00'),
    );
    // 8 h elapsed − 2 h not running = 6 h of runtime at 25/h, over two orders.
    expect(got.expected).toBe(150);
  });

  it('honours the exclusive Planning HS to Hstamp mapping', () => {
    const plan = order({ jobNumber: 'HOT', machineCode: 'HS', qtyPerHr: 1 / 25 });
    const now = new Date('2026-05-16T00:00:00');
    expect(scheduleAdherenceForShift([], [plan], 'Hstamp', '2026-05-15-Day', now).expected).toBe(100);
    expect(scheduleAdherenceForShift([], [plan], 'HS', '2026-05-15-Day', now).expected).toBe(0);
  });

  it('counts ShiftTarget once per machine-shift-job tuple', () => {
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 80, shiftTarget: 100 }),
      rec({ jobNumber: 'A', slotIndex: 1, statusCode: 'R', shiftTarget: 100 }),
    ];
    expect(targetAttainmentForRecords(records)).toEqual({
      actual: 80,
      expected: 100,
      pct: 80,
      covered: 1,
      total: 1,
    });
  });

  it('excludes missing targets from both sides and reports coverage', () => {
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 80, shiftTarget: 100 }),
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 500 }),
    ];
    expect(targetAttainmentForRecords(records)).toEqual({
      actual: 80,
      expected: 100,
      pct: 80,
      covered: 1,
      total: 2,
    });
  });
});


describe('ShiftTarget as the KPI plan', () => {
  it('caps each saved job target for adherence without requiring a current planning row', () => {
    const records = [
      rec({ machineCode: '1600T', jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 200, shiftTarget: 100 }),
      rec({ machineCode: '1600T', jobNumber: 'B', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 50, shiftTarget: 100 }),
    ];
    expect(targetAttainmentForRecords(records, true)).toEqual({ actual: 150, expected: 200, pct: 75, covered: 2, total: 2 });
    expect(targetAttainmentForRecords(records).pct).toBe(125);
  });
  it('adds each machine and shift snapshot once, including a planned zero-output shift', () => {
    const records = [
      rec({ machineCode: '1300T', jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 134, shiftTarget: 256 }),
      rec({ machineCode: '1300T', jobNumber: 'A', slotIndex: 1, statusCode: 'R', shiftTarget: 256 }),
      rec({ machineCode: '1300T', jobNumber: 'A', shiftId: '2026-05-15-Afternoon', slotIndex: 0, statusCode: '', shiftTarget: 256 }),
      rec({ machineCode: '1300T', jobNumber: 'A', shiftId: '2026-05-15-Night', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 119, shiftTarget: 259 }),
      rec({ machineCode: '1600T', jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 100, shiftTarget: 100 }),
    ];
    expect(targetAttainmentForRecords(records, true)).toEqual({ actual: 353, expected: 871, pct: 41, covered: 4, total: 4 });
  });
  it('does not turn an explicit zero target into a stale positive target from another slot', () => {
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'D', shiftTarget: 0 }),
      rec({ jobNumber: 'A', slotIndex: 1, statusCode: 'D', shiftTarget: 100 }),
      rec({ jobNumber: 'DC_1', slotIndex: 0, statusCode: 'D' }),
    ];
    expect(targetAttainmentForRecords(records, true)).toEqual({ actual: 0, expected: 0, pct: null, covered: 1, total: 1 });
  });
});

describe('the schedule snapshot sign-off saves', () => {
  // 07:00–11:00 at 25 an hour: 100 planned in the Day shift.
  const plan = [order({ jobNumber: 'A', machineCode: '125T', qtyPerHr: 1 / 25 })];
  const made = (good: number) => [rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: good })];

  it('judges the whole shift, even when it is signed before the end', () => {
    const snap = scheduleSnapshotForShift(made(50), plan, '125T', '2026-05-15-Day', new Date('2026-05-15T08:00:00'));
    expect(snap).toEqual({ pct: 50, plan: 100, fromPlanning: true, complete: true });
  });

  it('saves a plan of 0 and no % when nothing was planned on the press', () => {
    // The order is planned, on another press: output here is unscheduled.
    const elsewhere = [order({ jobNumber: 'A', machineCode: '1600T', qtyPerHr: 1 / 25 })];
    const snap = scheduleSnapshotForShift(made(50), elsewhere, '125T', '2026-05-15-Day', new Date('2026-05-16T00:00:00'));
    expect(snapshotToSave(snap, null)).toEqual({ pct: null, plan: 0 });
  });

  it('saves nothing while a planned order has no rate', () => {
    const noRate = [order({ jobNumber: 'A', machineCode: '125T', qtyPerHr: 0 })];
    const snap = scheduleSnapshotForShift(made(50), noRate, '125T', '2026-05-15-Day', new Date('2026-05-16T00:00:00'));
    expect(snap?.complete).toBe(false);
    expect(snapshotToSave(snap, null)).toBeNull();
  });

  it('keeps the plan saved first once Planning.csv has dropped the shift', () => {
    const snap = scheduleSnapshotForShift(made(50), [], '125T', '2026-05-15-Day', new Date('2026-05-22T00:00:00'));
    expect(snapshotToSave(snap, { pct: 50, plan: 100 })).toEqual({ pct: 50, plan: 100 });
  });
});

describe('Schedule Adherence over a wider period, from the saved plans', () => {
  const shift = (
    shiftId: string,
    saved: { pct?: number; plan?: number; at?: string },
    good = 0,
    job = 'A',
    extra: Partial<Parameters<typeof rec>[0]> = {},
  ) =>
    rec({
      jobNumber: job,
      shiftId,
      slotIndex: 0,
      statusCode: 'R',
      countStart: 0,
      countEnd: good,
      locked: true,
      lockedAt: saved.at ?? '',
      scheduleAttain: saved.pct,
      schedulePlan: saved.plan,
      ...extra,
    });

  it('weights each shift by its plan: 95% of 20 and 60% of 5,000 are 60%, not 77.5%', () => {
    const lines = savedScheduleTuples([
      shift('2026-05-11-Day', { pct: 95, plan: 20 }, 19),
      shift('2026-05-12-Day', { pct: 60, plan: 5000 }, 3000),
    ]);
    expect(attainmentOfTuples(lines)).toEqual({ actual: 3019, expected: 5020, pct: 60, covered: 2, total: 2 });
    expect(lines.every((l) => l.source === 'saved' && l.jobNumber === '' && l.leadJob === 'A')).toBe(true);
  });

  it('reads one snapshot per machine-shift: the last one signed', () => {
    const lines = savedScheduleTuples([
      shift('2026-05-11-Day', { pct: 40, plan: 100, at: '2026-05-11T15:10:00Z' }, 40, 'A'),
      shift('2026-05-11-Day', { pct: 70, plan: 100, at: '2026-05-11T15:40:00Z' }, 30, 'B'),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ planned: 100, credited: 70, good: 70, leadJob: 'A' });
  });

  it('falls back to ShiftTarget, capped per order, for a shift signed before the plan was saved', () => {
    const lines = savedScheduleTuples([
      shift('2026-05-11-Day', {}, 120, 'A', { shiftTarget: 100 }),
      shift('2026-05-12-Day', { pct: 50, plan: 100 }, 50),
    ]);
    expect(lines.map((l) => l.source).sort()).toEqual(['saved', 'shiftTarget']);
    expect(attainmentOfTuples(lines).pct).toBe(75); // (100 + 50) ÷ 200
  });

  it('leaves output out of a shift that had nothing planned', () => {
    const [line] = savedScheduleTuples([shift('2026-05-11-Day', { plan: 0 }, 80)]);
    expect(line).toMatchObject({ source: 'unscheduled', good: 80 });
    expect(attainmentOfTuples([line]).total).toBe(0);
  });

  it('averages the shifts when some saved a % and no plan', () => {
    const recs = [
      shift('2026-05-11-Day', { pct: 95 }, 19),
      shift('2026-05-12-Day', { pct: 60, plan: 5000 }, 3000),
    ];
    expect(savedPlanMissing(recs)).toBe(true);
    const lines = savedScheduleTuples(recs, true);
    expect(attainmentOfTuples(lines).pct).toBe(78); // (95 + 60) ÷ 2 = 77.5
  });
});
