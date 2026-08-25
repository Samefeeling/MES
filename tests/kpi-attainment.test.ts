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
