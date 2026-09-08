/**
 * Schedule colour: how the expected completion date compares with the date the
 * order is due.
 *
 *   green   finishes on or before the due date
 *   red     finishes after it
 *   grey    no expected date, or no due date to compare one against
 *
 * The due date's own day counts as on time: an order finishing at any point
 * during it has made it. That takes care, because an Expect Date is an
 * *exclusive* end — work filling Friday ends at Saturday midnight — so the
 * comparison is against the close of the due day rather than its start.
 * Comparing the two instants directly would call every order that finishes on
 * its due date a day late.
 */

import { MS_PER_DAY } from '@/lib/time';

export type ScheduleColor = 'green' | 'red' | 'grey';

export interface ScheduleStatus {
  color: ScheduleColor;
  /**
   * Days early (negative) or late (positive) against the close of the due
   * date. Zero is finishing exactly as the due date ends.
   */
  dueSlackDays: number | null;
  reason: string;
}

const dayDiff = (a: Date, b: Date): number =>
  (a.getTime() - b.getTime()) / MS_PER_DAY;

export function scheduleStatus(
  expect: Date | null,
  due: Date | null,
): ScheduleStatus {
  if (!expect || !due) {
    return {
      color: 'grey',
      dueSlackDays: null,
      reason: expect ? 'No due date on file' : 'Not schedulable',
    };
  }

  // When the due date stops being today: work that ends at this moment or
  // before it has been finished within the day the customer asked for.
  const closes = nextMidnight(due);
  const dueSlackDays = dayDiff(expect, closes);

  return expect > closes
    ? {
        color: 'red',
        dueSlackDays,
        reason: 'Will miss the customer due date',
      }
    : {
        color: 'green',
        dueSlackDays,
        reason: 'On track for the due date',
      };
}

/** Add whole and fractional days to a date. */
export const addDays = (d: Date, days: number): Date =>
  new Date(d.getTime() + days * MS_PER_DAY);

/** Move whole local calendar days without drifting across DST boundaries. */
export function addCalendarDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** Midnight at the start of the given day. */
export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Whole days between two dates, ignoring time of day. */
export const wholeDaysBetween = (a: Date, b: Date): number =>
  Math.round(dayDiff(startOfDay(a), startOfDay(b)));

// ---------------------------------------------------------------------------
// The shift calendar
//
// Resero runs one white shift, Monday to Friday. Saturday and Sunday are shut,
// so an order does not progress across them: three days of work started on a
// Thursday finishes on the Monday, not on the Saturday. A weekend is only
// worked when the supervisor has approved overtime on that particular order,
// which the board asks for the moment a bar is dropped on one.
// ---------------------------------------------------------------------------

/** Saturday or Sunday — the factory is closed. */
export const isWeekend = (d: Date): boolean =>
  d.getDay() === 0 || d.getDay() === 6;

/**
 * Midnight of the next day, robust across daylight-saving shifts.
 *
 * Every step from one day to the next goes through here rather than through
 * `addDays(d, 1)`. A day the clock gave 23 or 25 hours to is still one day on
 * the calendar, and adding a flat 24 hours to it lands an hour off midnight —
 * which every following day then inherits, so a schedule crossing the first
 * Sunday in April came out an hour, and eventually a whole column, adrift.
 */
export const nextMidnight = (d: Date): Date => {
  const out = startOfDay(d);
  // Advance the local calendar date: a DST day can contain 23 or 25 hours.
  out.setDate(out.getDate() + 1);
  return out;
};

/** Midnight of the previous day. The mirror of `nextMidnight`. */
export const prevMidnight = (d: Date): Date => {
  const out = startOfDay(d);
  out.setDate(out.getDate() - 1);
  return out;
};

/**
 * How much of its own day is still ahead of `d`, as a fraction of a day.
 *
 * A day is one unit of work whether the clock gave it 23, 24 or 25 hours: the
 * factory runs one shift either way. Measuring against a nominal day keeps the
 * fraction meaningful without letting the twice-yearly hour leak into it.
 */
export function openFraction(d: Date): number {
  const since = (d.getTime() - startOfDay(d).getTime()) / MS_PER_DAY;
  return Math.min(1, Math.max(0, 1 - since));
}

/**
 * `d` itself when the factory runs that day, otherwise the following Monday.
 * A weekend start is pulled to the start of Monday: nothing was worked on the
 * Saturday, so there is no part-day to carry over.
 */
export function nextWorkingDay(d: Date): Date {
  if (!isWeekend(d)) return d;
  let out = startOfDay(d);
  do {
    out = nextMidnight(out);
  } while (isWeekend(out));
  return out;
}

/**
 * The last day the factory ran before `d` — Friday, when `d` is a Monday.
 *
 * The board opens on this day rather than on today, because the supervisor's
 * first question in the morning is what yesterday's shift actually finished,
 * and on a Monday that shift was Friday's.
 */
export function prevWorkingDay(d: Date): Date {
  let out = startOfDay(d);
  do {
    out = startOfDay(addCalendarDays(out, -1));
  } while (isWeekend(out));
  return out;
}

/**
 * A clock time on `day`, from a fraction of the shift.
 *
 * The inverse of `shiftFraction`: 0 is the moment the crew clocks on, 1 the
 * moment they leave. Nothing this returns can land in the evening, which is
 * the whole point — every date the board works out for itself is a moment
 * somebody is actually on the floor, whatever hour the export happens to
 * carry. The two breaks are spread across the span rather than cut out of it,
 * the same simplification the "now" line makes.
 */
export function shiftMoment(
  day: Date,
  fraction: number,
  startHour: number,
  endHour: number,
): Date {
  const at = Math.min(1, Math.max(0, fraction));
  const hour = startHour + at * (endHour - startHour);
  const out = startOfDay(day);
  out.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return out;
}

/**
 * Where `now` falls in the working day, as a fraction of the shift.
 *
 * Zero before the crew clocks on, one after they leave; the board draws its
 * "now" line at that fraction across today's column. Outside the shift the
 * line pins to the edge of the column rather than wandering into the night,
 * which would read as progress nobody is making.
 */
export function shiftFraction(
  now: Date,
  startHour: number,
  endHour: number,
): number {
  const hours = now.getHours() + now.getMinutes() / 60;
  if (hours <= startHour) return 0;
  if (hours >= endHour) return 1;
  return (hours - startHour) / (endHour - startHour);
}

/** Stops the walk below on a duration that could never be real. */
const MAX_SPAN_DAYS = 2000;

/** A stretch of open days, and how much of the order's work falls in it. */
export interface WorkingSpan {
  from: Date;
  to: Date;
  /** Days of work already done when this stretch begins. */
  workedBefore: number;
  /** Days of work this stretch carries. */
  worked: number;
}

/**
 * Break `from`–`to` into the stretches the factory is actually open.
 *
 * A bar is dated in calendar time but measured in worked days, and the two
 * disagree across a weekend: three days of work from a Thursday ends on the
 * Tuesday. Drawing one block of three columns would stop short of the order's
 * own Expect Date; drawing five would claim the crew worked the weekend. So
 * the bar is drawn as one block per stretch, with the closed days showing
 * through between them — which is what actually happens.
 *
 * An order approved for overtime runs straight through, so its whole span is
 * one stretch.
 */
export function workingSpans(
  from: Date,
  to: Date,
  overtime = false,
): WorkingSpan[] {
  if (to <= from) return [];
  if (overtime) {
    const worked = (to.getTime() - from.getTime()) / MS_PER_DAY;
    return [{ from: new Date(from), to: new Date(to), workedBefore: 0, worked }];
  }

  const out: WorkingSpan[] = [];
  let cursor = new Date(from);
  let done = 0;
  let open: Date | null = null;

  for (let guard = 0; guard < MAX_SPAN_DAYS && cursor < to; guard++) {
    const tomorrow = nextMidnight(cursor);
    const end = tomorrow < to ? tomorrow : to;
    if (isWeekend(cursor)) {
      if (open) {
        const worked = (cursor.getTime() - open.getTime()) / MS_PER_DAY;
        out.push({ from: open, to: new Date(cursor), workedBefore: done, worked });
        done += worked;
        open = null;
      }
    } else if (!open) {
      open = new Date(cursor);
    }
    cursor = end;
  }
  if (open && cursor > open) {
    out.push({
      from: open,
      to: new Date(cursor),
      workedBefore: done,
      worked: (cursor.getTime() - open.getTime()) / MS_PER_DAY,
    });
  }
  return out;
}

/**
 * `from` plus `days` of work, stepping over the days the factory is closed.
 *
 * Fractional days are honoured against the part of the day still ahead, so
 * half a day's work starting at noon on Friday finishes on Monday morning
 * rather than on the Saturday.
 */
export function addWorkingDays(from: Date, days: number): Date {
  if (days <= 0) return new Date(from);
  let cursor = new Date(from);
  let left = days;

  for (let guard = 0; guard < MAX_SPAN_DAYS; guard++) {
    if (isWeekend(cursor)) {
      cursor = nextMidnight(cursor);
      continue;
    }
    const open = openFraction(cursor);
    // Strictly inside the day: the answer is a moment within this shift.
    if (left < open) return addDays(cursor, left);
    left -= open;
    // Work that runs to the end of the day finishes at the next midnight
    // itself, not twenty-four hours after the cursor — the two differ on the
    // day the clocks change, and every later day would carry the difference.
    cursor = nextMidnight(cursor);
    if (left <= 0) return cursor;
  }
  return cursor;
}

