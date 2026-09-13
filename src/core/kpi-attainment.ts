import type { PlanningOrder, ProductionRecord } from '../types';
import { aggregate, countSetupEvents } from './metrics';
import { plannedRuntimeForShift } from './schedule';
import { SLOT_MINUTES } from './shifts';
import { setupStandardHours } from './standards';

const SLOT_HOURS = SLOT_MINUTES / 60;

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
 * Hours of one shift the plan was never going to be running in.
 *
 *   - Each changeover the shift recorded earns its STANDARD allowance — a die
 *     change 4 h, a colour or insert change 30 min — not the time it actually
 *     took. Standard, so a die change that dragged to six hours shows up as
 *     missed output instead of quietly lowering the bar it is judged against.
 *   - Smoko is deducted at its actual length. It is a scheduled break, there is
 *     no site standard for it in the data, and a shift cannot be asked to
 *     produce through one.
 *
 * Capped at the hours the press spent NOT running: it cannot have lost more
 * than that, whatever the allowance adds up to. That cap is also what keeps a
 * pair of co-running orders — one die change written on both their rows, which
 * counts as two changeovers — from deducting eight hours from an eight-hour
 * shift.
 *
 * Everything here is counted in DISTINCT SLOTS. Co-running orders (one die
 * making two or three parts at once) mirror the same statuses onto the same
 * half-hours, and a half-hour the press spent changing over is one half-hour
 * however many order rows say so.
 */
function unavailableHoursForShift(records: ReadonlyArray<ProductionRecord>): number {
  const flat = [...records];
  const std = setupStandardHours(countSetupEvents(flat));
  const stdSetupHrs = std.dieStdHrs + std.colorStdHrs + std.insertStdHrs;
  const smoko = new Set<number>();
  const filled = new Set<number>();
  const running = new Set<number>();
  for (const r of flat) {
    if (!r.statusCode) continue;
    filled.add(r.slotIndex);
    if (r.statusCode === 'M') smoko.add(r.slotIndex);
    if (r.statusCode === 'R') running.add(r.slotIndex);
  }
  const notRunning = Math.max(0, filled.size - running.size) * SLOT_HOURS;
  return Math.min(stdSetupHrs + smoko.size * SLOT_HOURS, notRunning);
}

/**
 * True schedule adherence for one machine-shift.
 *
 * The bar is the floor's own formula — **Shift Planned Runtime ×
 * JobOper_ProdStandard** — worked out by `plannedRuntimeForShift` from the
 * hours this shift actually had to run in: elapsed, less the standard
 * changeover allowance and smoko, and shared out between the planned orders so
 * the plan can never ask one press for more hours than the shift holds.
 *
 * It used to be each order's whole Start–Due overlap with the shift at rate,
 * with no deduction at all. On a press carrying three overlapping planned
 * windows and a die change that was a bar two or three times what anybody could
 * have made, and the page read single-digit adherence on shifts that had run
 * their plan.
 *
 * Each scheduled order is still judged independently and capped at 100%, so
 * over-producing Job A cannot compensate for missing Job B. Unscheduled output
 * never enters the numerator.
 */
export function scheduleAdherenceForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
): KpiAttainment {
  const onShift = records.filter((record) => record.shiftId === shiftId);
  const planned = plannedRuntimeForShift(
    shiftId,
    orders,
    machineCode,
    asOf,
    unavailableHoursForShift(onShift),
  );
  const expectedByJob = new Map<string, number>();
  for (const run of planned.runs) {
    if (run.pieces <= 0) continue;
    const job = run.order.jobNumber.trim().toUpperCase();
    if (!job) continue;
    expectedByJob.set(job, (expectedByJob.get(job) ?? 0) + run.pieces);
  }

  let actual = 0;
  let expected = 0;
  let covered = 0;
  for (const [job, want] of expectedByJob) {
    const matching = onShift.filter(
      (record) => record.jobNumber.trim().toUpperCase() === job,
    );
    const good = aggregate([...matching]).output;
    actual += Math.min(good, want);
    expected += want;
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
