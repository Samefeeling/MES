import type { PlanningOrder, ProductionRecord } from '../types';
import { aggregate, countSetupEvents } from './metrics';
import { crewedWindowHoursBefore, plannedOrdersForShift, plannedRuntimeForShift } from './schedule';
import { SLOT_MINUTES, shiftBounds } from './shifts';
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


// Legacy VSPLAN sign-off snapshot. The KPI page plans through scheduleTuplesForShift.
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
 * One Machine + Shift + Job line of a KPI comparison. Every figure the page
 * shows for a plan — the "/plan" beside Output and the percentage — is a sum
 * of these, so a machine, a shift, an order and a category can never be
 * judged by different rules.
 *
 *   - `schedule`     planned in Planning.csv for this press and shift.
 *   - `shiftTarget`  run, but its order has left Planning.csv (Epicor drops a
 *                    finished job), so the ShiftTarget saved when it ran is
 *                    the only record of what it was asked for.
 *   - `unscheduled`  run, while Planning.csv has the order somewhere else —
 *                    another press or another shift. Not part of the plan,
 *                    so it is neither credited nor asked for.
 *   - `pending`      planned, but the shift has not been signed off yet. Kept
 *                    out of both sides until it is, so a shift still waiting
 *                    for its supervisor is not scored as a shift that never ran.
 */
export type AttainmentSource = 'schedule' | 'shiftTarget' | 'unscheduled' | 'pending';

export interface AttainmentTuple {
  machineCode: string;
  shiftId: string;
  jobNumber: string;
  /** Pieces asked for. null = this line should carry a plan and none is known
   *  (no ShiftTarget saved, no rate in Planning.csv). */
  planned: number | null;
  /** Good made (signed-off records only — the caller's filter). */
  good: number;
  /** Good allowed into the numerator: capped at the plan when adherence is
   *  capped, 0 when there is no plan to credit it against. */
  credited: number;
  source: AttainmentSource;
}

/** The comparison over a set of lines. Unscheduled and pending lines are
 *  outside it on both sides; a line with no known plan counts against
 *  coverage, not against the percentage. */
export function attainmentOfTuples(tuples: ReadonlyArray<AttainmentTuple>): KpiAttainment {
  let actual = 0;
  let expected = 0;
  let covered = 0;
  let total = 0;
  for (const tuple of tuples) {
    if (tuple.source === 'unscheduled' || tuple.source === 'pending') continue;
    total++;
    if (tuple.planned == null) continue;
    covered++;
    actual += tuple.credited;
    expected += tuple.planned;
  }
  return result(actual, expected, covered, total);
}

const jobKey = (job: string): string => job.trim().toUpperCase();

/**
 * ShiftTarget lines: one per Machine + Shift + Job in the records.
 *
 * ShiftTarget is a tuple-level snapshot but may be present on more than
 * one slot in legacy data. Group by Machine + Shift + Job, prefer slot 0,
 * and count both the target and Good exactly once. A line without a valid
 * target carries planned: null and is reported through coverage. Zero is
 * an explicit target, not a missing value. `capPerJob` caps each line at its
 * target; without it over-production is kept.
 */
export function targetTuplesForRecords(
  records: ReadonlyArray<ProductionRecord>,
  capPerJob = false,
): AttainmentTuple[] {
  const groups = new Map<string, ProductionRecord[]>();
  for (const record of records) {
    const machine = record.machineCode.trim().toUpperCase();
    const job = jobKey(record.jobNumber);
    if (!machine || !record.shiftId || !job || job.startsWith('DC_')) continue;
    const key = `${machine}|${record.shiftId}|${job}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const out: AttainmentTuple[] = [];
  for (const group of groups.values()) {
    const canonical = group.find((record) => record.slotIndex === 0);
    const targetRecord =
      canonical && Number.isFinite(canonical.shiftTarget) && (canonical.shiftTarget ?? -1) >= 0
        ? canonical
        : group.find(
            (record) =>
              Number.isFinite(record.shiftTarget) && (record.shiftTarget ?? -1) >= 0,
          );
    const good = aggregate(group).output;
    const target = targetRecord ? targetRecord.shiftTarget! : null;
    out.push({
      machineCode: group[0].machineCode.trim(),
      shiftId: group[0].shiftId,
      jobNumber: group[0].jobNumber.trim(),
      planned: target,
      good,
      credited: target == null ? 0 : capPerJob ? Math.min(good, target) : good,
      source: 'shiftTarget',
    });
  }
  return out;
}

/** Vs Target over a set of records: Σ Good ÷ Σ ShiftTarget, capped per line
 *  when `capPerJob`. */
export function targetAttainmentForRecords(
  records: ReadonlyArray<ProductionRecord>,
  capPerJob = false,
): KpiAttainment {
  return attainmentOfTuples(targetTuplesForRecords(records, capPerJob));
}

/**
 * Schedule Adherence lines for one machine-shift, planned from Planning.csv.
 *
 * The plan is what Planning.csv put on this press in this shift — whether or
 * not anybody came to run it. That is the whole point: a press planned for
 * the afternoon that stood idle for want of a crew has no production records
 * and so no ShiftTarget, and a plan read off the records left it out of the
 * denominator altogether. The floor read 96% on a day an entire press's
 * schedule was missed.
 *
 *   planned  = the order's share of the shift's planned runtime ×
 *              JobOper_ProdStandard (`plannedRuntimeForShift`), only in the
 *              shifts its "no of shift" says the press is crewed for, and never
 *              more than is left of the order's quantity after the shifts
 *              before this one were asked for theirs — Epicor's Start–Due
 *              window carries the setup time as well, so hours × rate alone
 *              asks for more pieces than the order holds.
 *   credited = min(Good, planned) per order, so over-producing one order
 *              cannot hide missing another.
 *
 * Output of an order Planning.csv still holds but not here is `unscheduled`;
 * output of an order it no longer holds at all falls back to that line's saved
 * ShiftTarget (see AttainmentSource). `pending` answers every planned line as
 * pending — the caller knows the shift has unsigned records and no signed ones.
 *
 * Records are this machine's signed-off records; lines for other shifts are
 * ignored.
 */
export function scheduleTuplesForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
  pending = false,
): AttainmentTuple[] {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) return [];
  const onShift = records.filter((record) => record.shiftId === shiftId);
  const planned = plannedRuntimeForShift(
    shiftId,
    orders,
    machineCode,
    asOf,
    unavailableHoursForShift(onShift),
  );

  const plan = new Map<string, { jobNumber: string; pieces: number | null }>();
  for (const run of planned.runs) {
    const key = jobKey(run.order.jobNumber);
    if (!key) continue;
    // What is left of the order once the shifts before this one have had
    // their share at the same rate: an order is never asked for more pieces
    // than it holds, however its window is spread across shifts.
    const quantity = run.order.orderQty > 0
      ? run.order.orderQty
      : run.order.jobRequired > 0 ? run.order.jobRequired : Infinity;
    const askedBefore = Math.floor(crewedWindowHoursBefore(run.order, bounds.start) / run.order.qtyPerHr);
    const pieces = Math.min(run.pieces, Math.max(0, quantity - askedBefore));
    const prior = plan.get(key);
    plan.set(key, {
      jobNumber: prior?.jobNumber ?? run.order.jobNumber.trim(),
      pieces: (prior?.pieces ?? 0) + pieces,
    });
  }
  // Planned here with no rate: still planned, but nobody can say for how
  // many pieces — a gap in coverage, not a zero.
  for (const order of plannedOrdersForShift(orders, machineCode, shiftId)) {
    const key = jobKey(order.jobNumber);
    if (key && !(order.qtyPerHr > 0) && !plan.has(key)) {
      plan.set(key, { jobNumber: order.jobNumber.trim(), pieces: null });
    }
  }

  const machine = machineCode.trim();
  if (pending) {
    return [...plan.values()].map(({ jobNumber, pieces }) => ({
      machineCode: machine, shiftId, jobNumber, planned: pieces, good: 0, credited: 0, source: 'pending',
    }));
  }

  const ran = new Map<string, ProductionRecord[]>();
  for (const record of onShift) {
    const key = jobKey(record.jobNumber);
    if (!key || key.startsWith('DC_')) continue;
    const group = ran.get(key) ?? [];
    group.push(record);
    ran.set(key, group);
  }
  const known = new Set(orders.filter((order) => !order.isDieChange).map((order) => jobKey(order.jobNumber)));

  const out: AttainmentTuple[] = [];
  for (const [key, { jobNumber, pieces }] of plan) {
    const good = aggregate(ran.get(key) ?? []).output;
    // A planned line nobody got to is a planned line with nothing made — the
    // miss this comparison exists to show. Only a line that asked for nothing
    // and made nothing says nothing, and is left out.
    if (pieces === 0 && good === 0) continue;
    out.push({
      machineCode: machine,
      shiftId,
      jobNumber,
      planned: pieces,
      good,
      credited: pieces == null ? 0 : Math.min(good, pieces),
      source: 'schedule',
    });
  }
  for (const [key, group] of ran) {
    if (plan.has(key)) continue;
    if (known.has(key)) {
      out.push({
        machineCode: machine,
        shiftId,
        jobNumber: group[0].jobNumber.trim(),
        planned: 0,
        good: aggregate(group).output,
        credited: 0,
        source: 'unscheduled',
      });
    } else {
      out.push(...targetTuplesForRecords(group, true));
    }
  }
  return out;
}

export function combineAttainment(values: ReadonlyArray<KpiAttainment>): KpiAttainment {
  return result(
    values.reduce((sum, value) => sum + value.actual, 0),
    values.reduce((sum, value) => sum + value.expected, 0),
    values.reduce((sum, value) => sum + value.covered, 0),
    values.reduce((sum, value) => sum + value.total, 0),
  );
}
