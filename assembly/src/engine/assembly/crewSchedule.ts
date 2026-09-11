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
import {
  isWeekend,
  nextMidnight,
  openDaysBetween,
  startOfDay,
} from './dates';
import { shiftClockAt, shiftStartAt, workFractionAt } from './shift';
import { toDayKey } from '@/lib/time';

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

/**
 * How much of that day this person has already given to something else, as a
 * fraction of the shift — 0 free all day, 1 gone.
 *
 * The board fills one of these in as it plans, and hands it to the next order
 * so that order can work around what is already booked. Two things it is
 * deliberately not:
 *
 * Not "free from": a person booked next Monday is free this Thursday *and*
 * next Tuesday, and treating that one Monday as the end of their availability
 * cost the order every day after it.
 *
 * Not a yes/no either. A day with two hours on it has five and a half left,
 * and the next order takes them — orders run back to back through a person's
 * shift, the same way a hand-over already worked on an order's opening day.
 * Answering "busy" for that day sent the order to the next one instead and
 * left a hole in the middle of its bar for hours nobody was using.
 */
export type TakenOnDay = (workerId: string, day: string) => number;

const NOTHING_TAKEN: TakenOnDay = () => 0;

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
  taken: TakenOnDay = NOTHING_TAKEN,
): string[] {
  const ids = assignments
    .filter((assignment) =>
      assignmentActiveOnDay(assignment, day, orderStartDay) &&
      // Only a shift with nothing left in it drops the person from the day.
      // A part-used one keeps them, and the plan starts from where their last
      // order left them.
      taken(String(assignment.workerId), day) < 1 - EPSILON,
    )
    .map((assignment) => assignment.workerId);
  return [...new Set(ids)].slice(0, MAX_WORKERS_PER_ORDER);
}

/*
 * The two fractions above, read off the clock — 07:00 to 15:15, stepping over
 * the breaks. Derived rather than stored beside them: they are the same fact
 * in two units, and a copy is a copy to keep in step.
 */

/** The moment the crew pick this order up that day. */
export const startOfCrewDay = (day: CrewDayPlan): Date =>
  shiftStartAt(day.date, day.from);

/** The moment one of these day plans hands the day on. */
export const endOfCrewDay = (day: CrewDayPlan): Date =>
  shiftClockAt(day.date, day.from + day.used);

/**
 * The open days in the middle of a run that the order is not worked, grouped
 * into the stretches they fall in.
 *
 * A day plan is allowed to have holes: capacity is charged a whole day at a
 * time, so a person who is on something else on the Monday gives this order
 * the Friday and the Tuesday and nothing in between. That is an operational
 * fact and the board draws it — but a *weekend* is a different fact, and only
 * these days need a reason attached to them.
 */
export function idleRuns(
  crewDays: readonly CrewDayPlan[],
  overtime = false,
): string[][] {
  const runs: string[][] = [];
  for (let i = 1; i < crewDays.length; i++) {
    const idle = openDaysBetween(crewDays[i - 1].date, crewDays[i].date, overtime);
    if (idle.length > 0) runs.push(idle);
  }
  return runs;
}

export function planVariableCrew(
  from: Date,
  requiredHours: number,
  assignments: CrewAssignment[],
  overtime: boolean,
  taken: TakenOnDay = NOTHING_TAKEN,
): VariableCrewPlan {
  const orderStart = startOfDay(from);
  const orderStartDay = toDayKey(orderStart);
  // What is left of the opening day. An order picking up where another left
  // off starts part-way through a shift and gets only the rest of it, which is
  // what makes a hand-over exact rather than a day of waiting.
  //
  // Read as work done, not as time elapsed: a hand-over at half past twelve
  // has 285 minutes of the shift behind it, not the 52% of a calendar day the
  // clock happens to show.
  const opening = workFractionAt(from);
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
    const workerIds = crewIdsOnDay(assignments, day, orderStartDay, taken);
    if (workerIds.length === 0) {
      cursor = nextMidnight(cursor);
      continue;
    }

    /*
     * Where in the shift this order picks the day up.
     *
     * Two things can have eaten the front of it, and the later of them wins.
     * On the order's own opening day, whatever it was waiting for — its
     * material, the component it follows, the day it was pinned to. On any
     * day, whatever its own crew were already on: orders run back to back
     * through a person's 7.5 hours, so an order that finished at eleven hands
     * the rest of the day to the next one, in the middle of a run exactly as
     * it always did on the first day.
     *
     * The crew is charged as a block, so the day starts when the last of them
     * comes free. A shift with nothing left in it dropped that person from
     * `workerIds` above rather than holding the whole order out of the day.
     */
    const gone = Math.max(
      day === orderStartDay ? opening : 0,
      ...workerIds.map((workerId) => taken(workerId, day)),
    );
    const shift = workerIds.length * PRODUCTIVE_HOURS_PER_PERSON;
    const capacity = shift * (1 - gone);
    if (capacity <= EPSILON) {
      cursor = nextMidnight(cursor);
      continue;
    }

    first ??= shiftStartAt(cursor, gone);
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
      const end = shiftClockAt(cursor, gone + used);
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
