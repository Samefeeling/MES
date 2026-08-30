import type { PlanningOrder, ProductionRecord } from '../types';
import { aggregate } from './metrics';
import { expectedScheduledPiecesForOrder, plannedOrdersForShift } from './schedule';

export interface KpiAttainment {
  /** Good pieces allowed into the comparison numerator. */
  actual: number;
  /** Scheduled/target pieces in the comparison denominator. */
  expected: number;
  pct: number | null;
  /** Tuples with a usable comparison value. */
  covered: number;
  /** Tuples that should have had a comparison value. */
  total: number;
}

export type KpiComparisonMode = 'schedule' | 'target';

export function kpiComparisonMode(period: string): KpiComparisonMode {
  return period === 'last3' ? 'schedule' : 'target';
}

export function kpiComparisonLabel(mode: KpiComparisonMode): 'Schedule Adherence' | 'Vs Target' {
  return mode === 'schedule' ? 'Schedule Adherence' : 'Vs Target';
}

function result(actual: number, expected: number, covered: number, total: number): KpiAttainment {
  return {
    actual,
    expected,
    pct: expected > 0 ? Math.round((actual / expected) * 100) : null,
    covered,
    total,
  };
}

/**
 * True schedule adherence for one machine-shift.
 *
 * Each scheduled order is judged independently and capped at 100%, so
 * over-producing Job A cannot compensate for missing Job B. Unscheduled
 * output never enters the numerator.
 */
export function scheduleAdherenceForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
): KpiAttainment {
  const expectedByJob = new Map<string, number>();
  for (const order of plannedOrdersForShift(orders, machineCode, shiftId)) {
    const exact = expectedScheduledPiecesForOrder(shiftId, order, machineCode, asOf);
    if (exact == null) continue;
    const pieces = Math.floor(exact);
    if (pieces <= 0) continue;
    const job = order.jobNumber.trim().toUpperCase();
    if (!job) continue;
    expectedByJob.set(job, (expectedByJob.get(job) ?? 0) + pieces);
  }

  let actual = 0;
  let expected = 0;
  let covered = 0;
  for (const [job, planned] of expectedByJob) {
    const matching = records.filter(
      (record) =>
        record.shiftId === shiftId && record.jobNumber.trim().toUpperCase() === job,
    );
    const good = aggregate([...matching]).output;
    actual += Math.min(good, planned);
    expected += planned;
    if (matching.length) covered++;
  }
  return result(actual, expected, covered, expectedByJob.size);
}

/**
 * Target attainment for historical/custom KPI windows.
 *
 * ShiftTarget is a tuple-level snapshot but may be present on more than
 * one slot in legacy data. Group by Machine + Shift + Job, prefer slot 0,
 * and count both the target and Good exactly once. Tuples without a valid
 * positive target are excluded from both numerator and denominator.
 */
export function targetAttainmentForRecords(
  records: ReadonlyArray<ProductionRecord>,
): KpiAttainment {
  const groups = new Map<string, ProductionRecord[]>();
  for (const record of records) {
    const machine = record.machineCode.trim().toUpperCase();
    const job = record.jobNumber.trim().toUpperCase();
    if (!machine || !record.shiftId || !job) continue;
    const key = `${machine}|${record.shiftId}|${job}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  let actual = 0;
  let expected = 0;
  let covered = 0;
  for (const group of groups.values()) {
    const canonical = group.find((record) => record.slotIndex === 0);
    const targetRecord =
      canonical && Number.isFinite(canonical.shiftTarget) && (canonical.shiftTarget ?? 0) > 0
        ? canonical
        : group.find(
            (record) =>
              Number.isFinite(record.shiftTarget) && (record.shiftTarget ?? 0) > 0,
          );
    if (!targetRecord) continue;
    const target = targetRecord.shiftTarget!;
    actual += aggregate(group).output;
    expected += target;
    covered++;
  }
  return result(actual, expected, covered, groups.size);
}

export function combineAttainment(values: ReadonlyArray<KpiAttainment>): KpiAttainment {
  return result(
    values.reduce((sum, value) => sum + value.actual, 0),
    values.reduce((sum, value) => sum + value.expected, 0),
    values.reduce((sum, value) => sum + value.covered, 0),
    values.reduce((sum, value) => sum + value.total, 0),
  );
}
