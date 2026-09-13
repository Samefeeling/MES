import { describe, expect, it } from 'vitest';
import {
  kpiComparisonLabel,
  kpiComparisonMode,
  scheduleAdherenceForShift,
  targetAttainmentForRecords,
} from '../src/core/kpi-attainment';
import { order, rec } from './helpers';

describe('KPI comparison modes', () => {
  it('uses schedule only for Last 24h and target for wider/custom ranges', () => {
    expect(kpiComparisonMode('last3')).toBe('schedule');
    expect(kpiComparisonLabel(kpiComparisonMode('last3'))).toBe('Schedule Adherence');
    for (const period of ['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'custom']) {
      expect(kpiComparisonMode(period)).toBe('target');
      expect(kpiComparisonLabel(kpiComparisonMode(period))).toBe('Vs Target');
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
