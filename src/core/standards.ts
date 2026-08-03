import type { ProductionRecord } from '../types';
import { countSetupEvents } from './metrics';
import { SLOTS_PER_SHIFT, SLOT_MINUTES, shiftBounds } from './shifts';
import { hoursUnavailableFor, shiftTargetFor } from './targets';

/**
 * Changeover standards + planning-driven expected output (floor-stated):
 *
 * - A die change is allowed 4 hours — 8 consecutive D slots.
 * - A colour change or an insert change is allowed 30 min — 1 slot.
 * - What a shift SHOULD produce follows from planning: the job's cycle
 *   time (JobOper_ProdStandard, hours per piece — the "Standard hour")
 *   over the hours the job was scheduled to run in that shift
 *   (JobHead_StartDate + StartHour caps the start), minus the STANDARD
 *   changeover allowance for each changeover that occurred — standard,
 *   not actual, so a die change that dragged past 4h shows up as missed
 *   output instead of silently lowering the bar.
 *
 * KPIs colour actual vs expected red / amber / blue with these numbers.
 */
export const DIE_CHANGE_STD_HRS = 4;
export const COLOR_CHANGE_STD_HRS = 0.5;
export const INSERT_CHANGE_STD_HRS = 0.5;

const SLOT_HOURS = SLOT_MINUTES / 60;
const SHIFT_HOURS = SLOTS_PER_SHIFT * SLOT_HOURS; // 8

export interface SetupStd {
  dieStdHrs: number;
  colorStdHrs: number;
  insertStdHrs: number;
}

/** Standard changeover allowance for a slice: each D/C/I *changeover*
 *  (one per order, as counted by countSetupEvents) earns its standard
 *  duration. Per order, not per run of slots — a die change the sheet
 *  recorded in two pieces is one changeover with one 4 h allowance, not
 *  two with eight. */
export function setupStandardHours(counts: {
  dieChanges: number;
  colorChanges: number;
  insertChanges: number;
}): SetupStd {
  return {
    dieStdHrs: counts.dieChanges * DIE_CHANGE_STD_HRS,
    colorStdHrs: counts.colorChanges * COLOR_CHANGE_STD_HRS,
    insertStdHrs: counts.insertChanges * INSERT_CHANGE_STD_HRS,
  };
}

/** Judge actual changeover hours against the standard allowance:
 *  blue = met (within standard), amber = one slot (0.5 h) over, red =
 *  worse. '' when the slice had no changeover at all (nothing to judge)
 *  or the standard wasn't computed for it (null). */
export function setupJudgement(
  actualHrs: number,
  stdHrs: number | null,
): 'blue' | 'amber' | 'red' | '' {
  if (stdHrs == null) return '';
  if (actualHrs <= 0 && stdHrs <= 0) return '';
  const over = +(actualHrs - stdHrs).toFixed(2);
  if (over <= 0) return 'blue';
  if (over <= 0.5) return 'amber';
  return 'red';
}

/** The planning fields the schedule simulation consumes — a structural
 *  subset of PlanningOrder so tests don't have to build full orders.
 *  Field semantics follow the Epicor CSV: plannedStart =
 *  JobHead_StartDate + StartHour; remainingLaborHrs =
 *  Calculated_RemaingLaborHrs; remainingQty = Calculated_RemainingQty;
 *  hrsPerPiece = JobOper_ProdStandard. */
export interface PlannedOrderLike {
  jobNumber: string;
  plannedStart: string;
  remainingLaborHrs: number;
  remainingQty: number;
  hrsPerPiece: number;
}

export interface ScheduleExpectation {
  /** Expected good pieces; null when no planned order overlaps the
   *  shift window (order rolled off Epicor — caller falls back to the
   *  records-based model). */
  pieces: number | null;
  /** Jobs the simulation walked, for the tooltip. */
  jobsUsed: string[];
}

/**
 * Expected output for a shift straight from the PLANNING QUEUE — the
 * floor-stated recurrence: run the order that's due at shift start; if
 * its remaining labor hours (Calculated_RemaingLaborHrs) end inside the
 * shift it contributes its remaining pieces (Calculated_RemainingQty),
 * the standard changeover is paid if one occurred, and the NEXT planned
 * order fills what's left of the 8 hours at ITS JobOper_ProdStandard:
 *
 *   expected = qtyRemaining(prev)
 *            + (8h − laborHrs(prev) − std C/O) / ProdStandard(next)
 *
 * - Orders are walked in JobHead_StartDate + StartHour sequence; an
 *   order can't start before its planned start (a late planned start
 *   leaves the gap unexpected) nor before the machine frees up.
 * - Each order is capped at its remaining quantity — the old model's
 *   biggest lie: a job with 300 pieces left was "expected" to fill the
 *   whole shift at rate, which is where sub-50% plan attainment came
 *   from on shifts that simply FINISHED their order.
 * - stdSetupHrs (observed changeover occurrences × standard — die 4h,
 *   colour/insert 30 min) and actual smoko are removed from the
 *   productive window before simulating.
 * - Remaining qty / labor hours are as of the last Epicor sync, so the
 *   simulation is exact for the current day and approximate for older
 *   shifts in the window; buckets whose orders have left planning fall
 *   back to the records-based model (pieces: null).
 */
export function expectedShiftOutputFromPlanning(
  shiftId: string,
  queue: PlannedOrderLike[],
  stdSetupHrs: number,
  smokoHrs: number,
): ScheduleExpectation {
  const b = shiftBounds(shiftId);
  if (!b) return { pieces: null, jobsUsed: [] };
  const windowEnd =
    b.end.getTime() - Math.max(0, stdSetupHrs + smokoHrs) * 3_600_000;

  const sorted = queue
    .map((o) => ({ o, start: new Date(o.plannedStart).getTime() }))
    .filter(({ o, start }) => isFinite(start) && start < b.end.getTime() && o.hrsPerPiece > 0)
    .sort((a, z) => a.start - z.start);

  let cursor = b.start.getTime();
  let expected = 0;
  const jobsUsed: string[] = [];
  for (const { o, start } of sorted) {
    const begin = Math.max(cursor, start);
    if (begin >= windowEnd) break;
    const needHrs =
      o.remainingLaborHrs > 0
        ? o.remainingLaborHrs
        : o.remainingQty > 0
          ? o.remainingQty * o.hrsPerPiece
          : 0;
    if (needHrs <= 0) continue;
    const availHrs = (windowEnd - begin) / 3_600_000;
    const usedHrs = Math.min(needHrs, availHrs);
    // Completing inside the shift contributes the order's remaining
    // pieces exactly; a partial run contributes rate × hours, still
    // capped by what's left of the order.
    const pieces =
      usedHrs >= needHrs
        ? Math.max(0, o.remainingQty)
        : Math.min(Math.max(0, o.remainingQty), Math.floor(usedHrs / o.hrsPerPiece));
    if (pieces > 0 || usedHrs > 0) jobsUsed.push(o.jobNumber);
    expected += pieces;
    cursor = begin + usedHrs * 3_600_000;
    if (cursor >= windowEnd) break;
  }
  return { pieces: jobsUsed.length ? expected : null, jobsUsed };
}

/**
 * Expected output for ONE (machine, calendar date, shift) bucket as the
 * SUM OF THE SHIFT TARGETS of the orders recorded on it — the very
 * number the operator side panel showed and lockShift stamped into the
 * ShiftTarget column (core/targets.ts):
 *
 *   target(job) = min(JobLeft at shift start,
 *                     (8h − hours held by the other orders
 *                         − the job's changeover D/C/I) ÷ ProdStandard)
 *
 * Recomputed here from the denormalised per-row facts (JobLeft +
 * CycleTime stamped at sign-off, `ctByJob` planning fallback) rather
 * than trusting the stored ShiftTarget column, so rows signed before
 * the multi-order fix judge by the corrected formula too.
 *
 * Returns null — caller falls back to the planned-queue / footprint
 * models — when the bucket has no jobs, any job's JobLeft or cycle time
 * is unknown (a partially-computable Σ would understate the bar and
 * flatter vs Plan), or the Σ is 0 (nothing was demanded: only
 * die-change pseudo-orders, which carry JobLeft 0, ran).
 */
export function expectedShiftOutputFromTargets(
  records: ProductionRecord[],
  ctByJob: Map<string, number>,
): number | null {
  const jobs = new Set<string>();
  for (const r of records) if (r.jobNumber) jobs.add(r.jobNumber);
  if (jobs.size === 0) return null;
  let sum = 0;
  for (const job of jobs) {
    const canon = records.find((r) => r.jobNumber === job && r.slotIndex === 0);
    const jobLeft = canon?.jobLeft;
    if (jobLeft == null) return null;
    if (jobLeft <= 0) continue; // nothing demanded (die-change pseudo-order)
    const ct =
      canon?.cycleTime && canon.cycleTime > 0
        ? canon.cycleTime
        : (ctByJob.get(job) ?? 0);
    const target = shiftTargetFor({ qtyPerHr: ct }, jobLeft, hoursUnavailableFor(records, job));
    if (target == null) return null;
    sum += target;
  }
  return sum > 0 ? sum : null;
}

export interface ExpectedOutput {
  /** Expected good pieces; null when no job in the bucket has a cycle
   *  time (nothing to judge against). */
  pieces: number | null;
  /** Ingredients, for the explain-yourself tooltip. */
  shiftHrs: number;
  stdSetupHrs: number;
  smokoHrs: number;
  lateStartHrs: number;
  expRunHrs: number;
}

/**
 * Expected good pieces for ONE (machine, calendar date, shift) bucket.
 *
 *   expected = expRunHrs × weighted piece rate
 *   expRunHrs = 8h − standard changeover allowance − actual smoko
 *               − late planned start
 *
 * - Standard (not actual) changeover time is deducted — see module doc.
 * - Smoko (M) is deducted at actual duration: a legitimate scheduled
 *   break shouldn't make 100% unreachable, and there is no site standard
 *   for it in the data.
 * - Late start: when EVERY job in the bucket was planned (JobHead_
 *   StartDate + StartHour) to start after the shift began, the gap from
 *   shift start to the earliest planned start wasn't this shift's to
 *   use. Any job planned at/before shift start (or with no planned
 *   start on record) zeroes the deduction.
 * - Multi-job shifts weight each job's piece rate (1/ct) by its slot
 *   footprint; a job with no cycle time contributes footprint but no
 *   expected pieces, diluting the expectation honestly rather than
 *   pretending the unknown half of the shift didn't exist.
 */
export function expectedShiftOutput(
  shiftId: string,
  records: ProductionRecord[],
  ctByJob: Map<string, number>,
  plannedStartByJob: Map<string, string>,
): ExpectedOutput {
  const counts = countSetupEvents(records);
  const std = setupStandardHours(counts);
  const stdSetupHrs = std.dieStdHrs + std.colorStdHrs + std.insertStdHrs;

  let smokoSlots = 0;
  const fpSlots = new Map<string, number>();
  const jobs = new Set<string>();
  for (const r of records) {
    if (r.jobNumber) jobs.add(r.jobNumber);
    if (!r.statusCode) continue;
    if (r.statusCode === 'M') smokoSlots++;
    fpSlots.set(r.jobNumber, (fpSlots.get(r.jobNumber) ?? 0) + 1);
  }
  const smokoHrs = smokoSlots * SLOT_HOURS;

  let lateStartHrs = 0;
  const b = shiftBounds(shiftId);
  if (b) {
    let earliest: number | null = null;
    let expectedFromStart = jobs.size === 0;
    for (const job of jobs) {
      const ps = plannedStartByJob.get(job);
      const t = ps ? new Date(ps).getTime() : NaN;
      if (!isFinite(t) || t <= b.start.getTime()) {
        expectedFromStart = true;
        break;
      }
      if (t >= b.end.getTime()) continue; // planned for a later shift — ran early
      earliest = earliest == null ? t : Math.min(earliest, t);
    }
    if (!expectedFromStart && earliest != null) {
      lateStartHrs = (earliest - b.start.getTime()) / 3_600_000;
    }
  }

  const expRunHrs = Math.max(0, SHIFT_HOURS - stdSetupHrs - smokoHrs - lateStartHrs);

  let fpTotal = 0;
  for (const v of fpSlots.values()) fpTotal += v;
  let weightedRate = 0; // Σ fp_j / ct_j over jobs WITH a cycle time
  let flatRate = 0; // Σ 1 / ct_j — fallback when nothing has a footprint
  let ctJobs = 0;
  for (const job of jobs) {
    const ct = ctByJob.get(job);
    if (!ct || ct <= 0) continue;
    ctJobs++;
    flatRate += 1 / ct;
    weightedRate += (fpSlots.get(job) ?? 0) / ct;
  }

  let pieces: number | null;
  if (ctJobs === 0) pieces = null;
  else if (fpTotal > 0) pieces = Math.floor((expRunHrs * weightedRate) / fpTotal);
  else pieces = Math.floor((expRunHrs * flatRate) / ctJobs);

  return {
    pieces,
    shiftHrs: SHIFT_HOURS,
    stdSetupHrs: +stdSetupHrs.toFixed(1),
    smokoHrs: +smokoHrs.toFixed(1),
    lateStartHrs: +lateStartHrs.toFixed(2),
    expRunHrs: +expRunHrs.toFixed(2),
  };
}
