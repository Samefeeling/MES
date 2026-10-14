/**
 * Working-day arithmetic for dispatch: Monday to Friday, less listed holidays.
 * Days are local `YYYY-MM-DD` keys throughout.
 */

import { fromDayKey, toDayKey } from '@/lib/time';
import type { DayKey } from '@/domain/dispatch';

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export const isoWeekday = (day: DayKey): number => {
  const d = fromDayKey(day).getDay();
  return d === 0 ? 7 : d;
};

export const isWorkingDay = (day: DayKey, holidays: ReadonlySet<DayKey>): boolean =>
  isoWeekday(day) <= 5 && !holidays.has(day);

export const addCalendarDays = (day: DayKey, n: number): DayKey => {
  const d = fromDayKey(day);
  d.setDate(d.getDate() + n);
  return toDayKey(d);
};

/** Move `n` working days (negative goes back); 0 returns `day` unchanged. */
export function addWorkingDays(
  day: DayKey,
  n: number,
  holidays: ReadonlySet<DayKey>,
): DayKey {
  let cur = day;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    cur = addCalendarDays(cur, step);
    if (isWorkingDay(cur, holidays)) left--;
  }
  return cur;
}

/** Working days strictly after `from` up to and including `to`; negative if reversed. */
export function workingDaysBetween(
  from: DayKey,
  to: DayKey,
  holidays: ReadonlySet<DayKey>,
): number {
  if (from === to) return 0;
  const sign = from < to ? 1 : -1;
  const [a, b] = sign > 0 ? [from, to] : [to, from];
  let n = 0;
  for (let cur = addCalendarDays(a, 1); cur <= b; cur = addCalendarDays(cur, 1)) {
    if (isWorkingDay(cur, holidays)) n++;
  }
  return n * sign;
}

/**
 * Days a route can dispatch on, from `from` to `to` inclusive: working days,
 * and only the listed weekdays when there are any.
 */
export function dispatchDays(
  from: DayKey,
  to: DayKey,
  weekdays: readonly number[] | null,
  holidays: ReadonlySet<DayKey>,
): DayKey[] {
  const out: DayKey[] = [];
  for (let cur = from; cur <= to; cur = addCalendarDays(cur, 1)) {
    if (!isWorkingDay(cur, holidays)) continue;
    if (weekdays && weekdays.length > 0 && !weekdays.includes(isoWeekday(cur))) continue;
    out.push(cur);
  }
  return out;
}
