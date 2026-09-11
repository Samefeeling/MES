/**
 * The working day on the clock: 07:00 to 15:30, less three breaks.
 *
 * Everything else on the board plans in *work*: an order needs 5.5 standard
 * hours, a person contributes 7.5 in a day, so the order takes 0.73 of a
 * shift. That is the right unit to plan in and the wrong one to read off a
 * wall, because 0.73 of a shift is not 0.73 of a day and the floor works to a
 * clock. This module is the only place the two meet.
 *
 * The difference is not small and it is not linear. Spreading 7.5 hours of
 * work evenly from midnight to midnight — which is what a fraction of a
 * calendar day means — put a bar that finishes mid-morning at a quarter past
 * seven, and the board printed that on the Start Date cell as if it were a
 * time somebody could turn up at. Spreading it evenly across 07:00–15:30 is
 * closer and still wrong: an order with two hours of work in it finishes at
 * 09:00, not 09:16, because the crew are on the floor for 8.5 hours and
 * working for 7.5 of them.
 *
 * So work is laid into the shift's stretches in order, and the breaks are
 * stepped over:
 *
 *     07:00 ──────── 09:00  morning tea  09:15 ──────── 12:00
 *     lunch  12:30 ──────── 15:15  afternoon tea  15:30
 *
 * Two hours of work ends at 09:00. Two and a quarter ends at 09:30 — a
 * quarter of an hour of it was spent standing at the urn.
 */

import {
  PRODUCTIVE_HOURS_PER_PERSON,
  SHIFT_END_HOUR,
  SHIFT_START_HOUR,
} from '@/domain/assembly';
import { startOfDay } from './dates';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** Minutes past midnight. */
const at = (hour: number, minute = 0): number => hour * MINUTES_PER_HOUR + minute;

export interface ShiftBreak {
  name: string;
  /** Minutes past midnight. */
  from: number;
  to: number;
}

/**
 * When the crew are not on the job, as the floor runs it.
 *
 * The afternoon one butts against the end of the shift: work stops at 15:15,
 * and the last quarter of an hour is putting the bench away. An order can
 * therefore finish at 15:15 but never at 15:30.
 */
export const BREAKS: readonly ShiftBreak[] = [
  { name: 'Morning tea', from: at(9), to: at(9, 15) },
  { name: 'Lunch', from: at(12), to: at(12, 30) },
  { name: 'Afternoon tea', from: at(15, 15), to: at(15, 30) },
];

/** 07:00 and 15:30, in minutes past midnight. */
export const SHIFT_OPEN_MINUTE = at(SHIFT_START_HOUR);
export const SHIFT_CLOSE_MINUTE = at(SHIFT_END_HOUR);

/** How wide a day column is in clock terms: 8.5 hours on the floor. */
export const SHIFT_SPAN_MINUTES = SHIFT_CLOSE_MINUTE - SHIFT_OPEN_MINUTE;

export interface WorkSegment {
  from: number;
  to: number;
}

/**
 * The stretches the crew are actually on the job, derived from the breaks
 * rather than listed again beside them — one of the two would otherwise be
 * edited alone, and the board would plan to a different day than it drew.
 */
function deriveSegments(): WorkSegment[] {
  const out: WorkSegment[] = [];
  let cursor = SHIFT_OPEN_MINUTE;
  for (const rest of [...BREAKS].sort((a, b) => a.from - b.from)) {
    if (rest.from > cursor) out.push({ from: cursor, to: rest.from });
    cursor = Math.max(cursor, rest.to);
  }
  if (SHIFT_CLOSE_MINUTE > cursor) out.push({ from: cursor, to: SHIFT_CLOSE_MINUTE });
  return out;
}

export const WORK_SEGMENTS: readonly WorkSegment[] = deriveSegments();

/**
 * Minutes of work in one person's day: **450**, which is the 7.5 hours the
 * rest of the board plans with. A test holds the two together — change a
 * break and the arithmetic has to still land on the capacity every duration
 * on this board is divided by.
 */
export const PRODUCTIVE_MINUTES = WORK_SEGMENTS.reduce(
  (sum, segment) => sum + (segment.to - segment.from),
  0,
);

/** What time it is once `worked` minutes of the shift have been done. */
export function clockAtWorkMinutes(worked: number): number {
  let left = Math.min(PRODUCTIVE_MINUTES, Math.max(0, worked));
  for (const segment of WORK_SEGMENTS) {
    const length = segment.to - segment.from;
    // `<=` so finishing a segment exactly reads as the moment they stop, not
    // as the moment they come back: two hours of work ends at 09:00.
    if (left <= length) return segment.from + left;
    left -= length;
  }
  return WORK_SEGMENTS.at(-1)?.to ?? SHIFT_CLOSE_MINUTE;
}

/** How much of the shift has been worked by `clock` minutes past midnight. */
export function workMinutesAtClock(clock: number): number {
  let worked = 0;
  for (const segment of WORK_SEGMENTS) {
    if (clock <= segment.from) break;
    worked += Math.min(clock, segment.to) - segment.from;
  }
  return Math.min(PRODUCTIVE_MINUTES, Math.max(0, worked));
}

/** Minutes past midnight of an instant, in its own local day. */
const minuteOfDay = (instant: Date): number =>
  (instant.getTime() - startOfDay(instant).getTime()) / MS_PER_MINUTE;

/**
 * The moment `fraction` of a day's work is done — the board's day plans carry
 * exactly that fraction, so this is what turns one into a time.
 */
function atMinuteOfDay(day: Date, minutes: number): Date {
  const whole = Math.floor(minutes);
  const out = startOfDay(day);
  /*
   * Set on the wall clock, not by adding milliseconds to midnight: twice a
   * year midnight plus seven hours is six or eight in the morning, and the
   * crew clock on at seven on all of them.
   *
   * Carried to the millisecond rather than rounded to the minute. An order
   * takes 5.7 standard hours, not 5 and 42; rounding here cost a successor up
   * to half a minute against its own predecessor's finish, which is small and
   * is still a successor starting before the thing it waits on. What the floor
   * reads is rounded where it is displayed.
   */
  out.setHours(0, whole, 0, Math.round((minutes - whole) * MS_PER_MINUTE));
  return out;
}

export function shiftClockAt(day: Date, fraction: number): Date {
  return atMinuteOfDay(day, clockAtWorkMinutes(fraction * PRODUCTIVE_MINUTES));
}

/** 07:00 on this day — where work starts when nothing has been done yet. */
export const shiftOpensOn = (day: Date): Date => shiftClockAt(day, 0);

/** 15:15 on this day — the last moment work can be booked to. */
export const shiftWorkEndsOn = (day: Date): Date => shiftClockAt(day, 1);

/**
 * The next moment work can actually happen, at or after `instant`.
 *
 * Inside a break that is the moment they come back; before the shift opens it
 * is 07:00. A component that comes off a press at ten past twelve cannot be
 * picked up at ten past twelve, because everyone is at lunch until half past.
 */
export function nextWorkingMoment(instant: Date): Date {
  const minute = minuteOfDay(instant);
  for (const segment of WORK_SEGMENTS) {
    if (minute <= segment.from) return atMinuteOfDay(instant, segment.from);
    if (minute < segment.to) return instant;
  }
  return shiftWorkEndsOn(instant);
}

/**
 * When work *resumes* at `fraction` of the day, as against `shiftClockAt`,
 * which says when it *reached* it.
 *
 * The two differ by a break, and only exactly on one. Half the shift's work is
 * done at 11:00 and the next order starts at 11:00 — the same moment. But the
 * first two hours are done at 09:00 and the next order starts at 09:15: the
 * fraction is a measure of capacity, and capacity cannot tell the moment they
 * put their tools down from the moment they pick them up again. Ends ask
 * `shiftClockAt`; starts ask this.
 */
export function shiftStartAt(day: Date, fraction: number): Date {
  return nextWorkingMoment(shiftClockAt(day, fraction));
}

/**
 * The inverse: how much of the day's work an instant has behind it, as the
 * fraction the planner uses. A moment inside a break has the work before it
 * and nothing more — the break bought no capacity.
 */
export function workFractionAt(instant: Date): number {
  return workMinutesAtClock(minuteOfDay(instant)) / PRODUCTIVE_MINUTES;
}

/**
 * Where an instant sits across its day's column, 0 at 07:00 and 1 at 15:30.
 *
 * This is the drawing measure, and it is deliberately not `workFractionAt`:
 * the column is the shift as the floor stands in it, breaks included, so an
 * order that stops for lunch keeps the width lunch takes. Before the shift
 * opens and after it closes the answer pins to the edge rather than wandering
 * into the night, which would read as work nobody is doing.
 */
export function shiftColumnFraction(instant: Date): number {
  const offset = (minuteOfDay(instant) - SHIFT_OPEN_MINUTE) / SHIFT_SPAN_MINUTES;
  return Math.min(1, Math.max(0, offset));
}

/** The break covering this instant, for saying why a bar has a notch in it. */
export function breakAt(instant: Date): ShiftBreak | null {
  const minute = minuteOfDay(instant);
  return BREAKS.find((rest) => minute >= rest.from && minute < rest.to) ?? null;
}

/** `PRODUCTIVE_HOURS_PER_PERSON` in the same minutes this module counts. */
export const PRODUCTIVE_HOURS_AS_MINUTES =
  PRODUCTIVE_HOURS_PER_PERSON * MINUTES_PER_HOUR;
