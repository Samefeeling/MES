/**
 * How long an assembly order takes, given how many people are on it.
 *
 * Work is measured in standard hours. Adding a person divides the remaining
 * work, which is what lets the supervisor shorten a bar by allocating more
 * of the crew — capped at four people per order.
 */

import {
  MAX_WORKERS_PER_ORDER,
  PRODUCTIVE_HOURS_PER_PERSON,
} from '@/domain/assembly';
import type { Job } from '@/domain/types';
import { isWeekend, prevWorkingDay, startOfDay } from './dates';
import { shiftStartAt } from './shift';

/** Fraction of the order already finished, clamped to [0, 1]. */
export function completedFraction(job: Job): number {
  const total = job.remainingQty + job.completedQty;
  if (total <= 0) return job.completedQty > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, job.completedQty / total));
}

/** Standard hours still to be worked on the order. */
export function remainingHours(job: Job): number {
  return Math.max(0, job.laborHrs) * (1 - completedFraction(job));
}

/**
 * Standard hours one finished unit is worth.
 *
 * The order's whole quantity carries its whole labour content, so this turns a
 * shift's output count back into hours — which is how the board can put what
 * was actually made yesterday on the same scale as what is planned for today.
 */
export function hoursPerUnit(job: Job): number {
  const total = job.remainingQty + job.completedQty;
  return total > 0 ? Math.max(0, job.laborHrs) / total : 0;
}

/** Units still to make. */
export function remainingQty(job: Job): number {
  return Math.max(0, job.remainingQty);
}

/** People-hours the crew delivers in one day. */
export const crewHoursPerDay = (workerCount: number): number =>
  Math.max(0, Math.min(workerCount, MAX_WORKERS_PER_ORDER)) *
  PRODUCTIVE_HOURS_PER_PERSON;

/**
 * Calendar days the order needs with this crew.
 * `null` when nobody is allocated — the order cannot be scheduled at all.
 */
export function durationDays(job: Job, workerCount: number): number | null {
  const perDay = crewHoursPerDay(workerCount);
  if (perDay <= 0) return null;
  const hours = remainingHours(job);
  if (hours <= 0) return 0;
  return hours / perDay;
}

/**
 * Units the crew is expected to finish in one day — the target the supervisor
 * measures the end-of-shift count against.
 */
export function dailyTargetQty(job: Job, workerCount: number): number {
  const days = durationDays(job, workerCount);
  if (days === null || days <= 0) return 0;
  return remainingQty(job) / days;
}

/** Smallest crew that finishes the order within `days`, capped at the max. */
export function crewNeededFor(job: Job, days: number): number | null {
  if (days <= 0) return null;
  const hours = remainingHours(job);
  if (hours <= 0) return 0;
  const needed = Math.ceil(hours / (days * PRODUCTIVE_HOURS_PER_PERSON));
  return needed > MAX_WORKERS_PER_ORDER ? null : needed;
}

/**
 * The last moment work can begin and still be finished by `due`.
 *
 * This is the board's own Start Date, and it replaces the one in the export
 * rather than trusting it. Epicor back-schedules on its own calendar and hands
 * back hours like 18:23 and 23:40 — times when the assembly floor is empty and
 * nothing can start. Here the sum is the factory's: the work is
 * `Calculated_RemainingLaborHrs`, a day is worth `PRODUCTIVE_HOURS_PER_PERSON`
 * per person — 7.5, being 07:00 to 15:30 less morning tea and lunch — and the
 * count runs back over open days only.
 *
 * The answer is a moment inside a shift, not a midnight: an order needing half
 * a day must be on the bench by the middle of the last day, and saying so is
 * the difference between a date that can be acted on and one that cannot. The
 * export's own value stays visible beside it as a cross-check — a gap means
 * the crew size or the hours differ from whatever Epicor assumed.
 *
 * `null` when nobody is on the order, because then there is no rate.
 */
export function latestStart(
  job: Job,
  workerCount: number,
  due: Date,
): Date | null {
  const days = durationDays(job, workerCount);
  if (days === null) return null;

  // The work has to be finished by the close of the due date, so the last
  // shift it can run on is that day itself — or, when the order is due on a
  // weekend, the working day before it. This used to count back from the day
  // before in every case, which was right while an Expect Date landing on the
  // due date counted as late.
  let day = isWeekend(due) ? prevWorkingDay(due) : startOfDay(due);

  // Whole days come off first; the remainder is the tail of the starting day,
  // which is what puts a clock time on the answer.
  let left = days;
  while (left > 1) {
    left -= 1;
    day = prevWorkingDay(day);
  }
  // On the clock, stepping over the breaks — and on the *start* side of the
  // fraction, because this is the last moment the order can be picked up.
  return shiftStartAt(day, 1 - left);
}
