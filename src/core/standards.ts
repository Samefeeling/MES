import type { ProductionRecord } from '../types';
import { countSetupEvents } from './metrics';
import { SLOTS_PER_SHIFT, SLOT_MINUTES, shiftBounds } from './shifts';

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

/** Standard changeover allowance for a slice: each D/C/I *occurrence*
 *  (maximal run of consecutive slots, as counted by countSetupEvents)
 *  earns its standard duration. */
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
