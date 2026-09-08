/**
 * Day-scale crew capacity for one order.
 *
 * Assembly reports once per shift, so a date-bounded assignment is the
 * smallest honest planning unit. Each open day consumes up to
 * `PRODUCTIVE_HOURS_PER_PERSON` standard hours per active person — 7.5, and
 * named rather than repeated here so the two cannot drift. A person can help
 * an earlier order for a few days and leave automatically when their next
 * assignment begins.
 */

import {
  MAX_WORKERS_PER_ORDER,
  PRODUCTIVE_HOURS_PER_PERSON,
  type CrewAssignment,
} from '@/domain/assembly';
import { addDays, isWeekend, nextMidnight, startOfDay } from './dates';
import { toDayKey } from '@/lib/time';
import { MS_PER_DAY } from '@/lib/time';

export interface CrewDayPlan {
  day: string;
  date: Date;
  /**
   * How much of the day's shift was already gone when this order picked it up,
   * as a fraction — 0 on every day but the first, and on that one whatever the
   * order it is following left behind. This is what lets a chain of steps meet
   * exactly instead of spending a day at each link: cutting finishes 46% of
   * the way through Wednesday, upholstery has the other 54% of it.
   */
  from: number;
  /** Fraction of a full shift this order takes out of the day. */
  used: number;
  workerIds: string[];
  /** Total standard hours removed from the order on this day. */
  hours: number;
  /** Equal share charged to each active worker. */
  perWorkerHours: number;
}

export interface VariableCrewPlan {
  start: Date | null;
  expectDate: Date | null;
  /** End of the capacity that is actually covered, even if work remains. */
  coveredUntil: Date | null;
  /** Worked-day equivalents, including a fractional final day. */
  days: number | null;
  crewDays: CrewDayPlan[];
  /** Work still uncovered after the bounded planning horizon. */
  uncoveredHours: number;
}

const MAX_PLAN_DAYS = 730;
const EPSILON = 1e-8;

export function assignmentActiveOnDay(
  assignment: CrewAssignment,
  day: string,
  orderStartDay: string,
): boolean {
  const from = assignment.fromDay ?? orderStartDay;
  return from <= day &&
    (assignment.toDayExclusive === null || day < assignment.toDayExclusive);
}

export function crewIdsOnDay(
  assignments: CrewAssignment[],
  day: string,
  orderStartDay: string,
): string[] {
  const ids = assignments
    .filter((assignment) =>
      assignmentActiveOnDay(assignment, day, orderStartDay),
    )
    .map((assignment) => assignment.workerId);
  return [...new Set(ids)].slice(0, MAX_WORKERS_PER_ORDER);
}

/** The moment one of these day plans hands the day on. */
export const endOfCrewDay = (day: CrewDayPlan): Date =>
  addDays(day.date, day.from + day.used);

export function planVariableCrew(
  from: Date,
  requiredHours: number,
  assignments: CrewAssignment[],
  overtime: boolean,
): VariableCrewPlan {
  const orderStart = startOfDay(from);
  const orderStartDay = toDayKey(orderStart);
  // What is left of the opening day. An order picking up where another left
  // off starts part-way through a shift and gets only the rest of it, which is
  // what makes a hand-over exact rather than a day of waiting.
  const opening = Math.min(
    1,
    Math.max(0, (from.getTime() - orderStart.getTime()) / MS_PER_DAY),
  );
  let remaining = Math.max(0, requiredHours);
  let cursor = orderStart;
  let first: Date | null = null;
  let workedDays = 0;
  const crewDays: CrewDayPlan[] = [];

  if (remaining <= EPSILON) {
    return {
      start: from,
      expectDate: from,
      coveredUntil: from,
      days: 0,
      crewDays,
      uncoveredHours: 0,
    };
  }

  for (let i = 0; i < MAX_PLAN_DAYS && remaining > EPSILON; i++) {
    if (!overtime && isWeekend(cursor)) {
      cursor = nextMidnight(cursor);
      continue;
    }
    const day = toDayKey(cursor);
    const workerIds = crewIdsOnDay(assignments, day, orderStartDay);
    if (workerIds.length === 0) {
      cursor = nextMidnight(cursor);
      continue;
    }

    // Only the order's own opening day is short; a weekend or an unstaffed day
    // in between is skipped whole, and the next one starts fresh.
    const gone = day === orderStartDay ? opening : 0;
    const shift = workerIds.length * PRODUCTIVE_HOURS_PER_PERSON;
    const capacity = shift * (1 - gone);
    if (capacity <= EPSILON) {
      cursor = nextMidnight(cursor);
      continue;
    }

    first ??= addDays(cursor, gone);
    const hours = Math.min(remaining, capacity);
    const used = hours / shift;
    crewDays.push({
      day,
      date: cursor,
      from: gone,
      used,
      workerIds,
      hours,
      perWorkerHours: hours / workerIds.length,
    });
    workedDays += used;
    remaining -= hours;

    if (remaining <= EPSILON) {
      const end = addDays(cursor, gone + used);
      return {
        start: first,
        expectDate: end,
        coveredUntil: end,
        days: workedDays,
        crewDays,
        uncoveredHours: 0,
      };
    }
    cursor = nextMidnight(cursor);
  }

  return {
    start: first,
    expectDate: null,
    coveredUntil:
      crewDays.length > 0 ? endOfCrewDay(crewDays.at(-1)!) : null,
    days: first ? workedDays : null,
    crewDays,
    uncoveredHours: remaining,
  };
}
