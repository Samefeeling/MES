/**
 * The days the factory is shut on a weekday: New South Wales public holidays,
 * worked out for any year, and the Rostered Days Off the supervisor enters.
 *
 * The holidays are the ones the Public Holidays Act 2010 (NSW) gives every
 * worker in the state, with its additional days:
 *
 *   New Year's Day      1 January; on a weekend, the Monday after as well
 *   Australia Day       26 January; on a weekend, the Monday after instead
 *   Good Friday, Easter Saturday, Easter Sunday, Easter Monday
 *   Anzac Day           25 April; no day in lieu when it is on a weekend
 *   King's Birthday     second Monday in June
 *   Labour Day          first Monday in October
 *   Christmas Day       25 December; on a weekend, the next free weekday as well
 *   Boxing Day          26 December; on a weekend, the next free weekday as well
 *
 * Bank Holiday (first Monday in August) is left out: it is a holiday for banks
 * and some financial institutions, not for a factory. A one-off holiday the
 * state proclaims — a day of mourning — is not in any rule, so it is entered
 * as a closed day by hand, the same way an RDO is.
 *
 * Pure. No React, no store.
 */

import { toDayKey } from '@/lib/time';

export type ClosureKind = 'holiday' | 'rdo';

export interface Closure {
  /** `YYYY-MM-DD`. */
  day: string;
  name: string;
  kind: ClosureKind;
}

/** A Rostered Day Off, as the plan stores it. */
export interface RdoDay {
  day: string;
  /** What the supervisor called it; "RDO" when they did not. */
  name?: string;
}

const date = (year: number, month: number, day: number): Date => new Date(year, month - 1, day);

/** Easter Sunday in the Gregorian calendar (the anonymous algorithm, as Meeus gives it). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return date(year, month, day);
}

const plusDays = (d: Date, days: number): Date => date(d.getFullYear(), d.getMonth() + 1, d.getDate() + days);

/** The `n`th Monday of a month (1-based). */
const nthMonday = (year: number, month: number, n: number): Date => {
  const first = date(year, month, 1);
  const offset = (8 - first.getDay()) % 7; // days to the first Monday
  return date(year, month, 1 + offset + 7 * (n - 1));
};

const weekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

/** The Monday after a weekend day. */
const mondayAfter = (d: Date): Date => plusDays(d, d.getDay() === 6 ? 2 : 1);

/** Every NSW public holiday in `year`, in date order. */
export function nswPublicHolidays(year: number): Closure[] {
  const out: Closure[] = [];
  // Two holidays can share a day — Easter Sunday is Anzac Day in 2038 — and
  // then it is one closed day with both names.
  const add = (d: Date, name: string) => {
    const day = toDayKey(d);
    const same = out.find((h) => h.day === day);
    if (same) same.name = `${same.name} / ${name}`;
    else out.push({ day, name, kind: 'holiday' });
  };

  const newYear = date(year, 1, 1);
  add(newYear, "New Year's Day");
  if (weekend(newYear)) add(mondayAfter(newYear), "New Year's Day (additional day)");

  const australia = date(year, 1, 26);
  add(weekend(australia) ? mondayAfter(australia) : australia, 'Australia Day');

  const easter = easterSunday(year);
  add(plusDays(easter, -2), 'Good Friday');
  add(plusDays(easter, -1), 'Easter Saturday');
  add(easter, 'Easter Sunday');
  add(plusDays(easter, 1), 'Easter Monday');

  add(date(year, 4, 25), 'Anzac Day');
  add(nthMonday(year, 6, 2), "King's Birthday");
  add(nthMonday(year, 10, 1), 'Labour Day');

  // Christmas and Boxing Day, each with a weekday in lieu when it falls on a
  // weekend — the first weekday the other has not already taken.
  const christmas = date(year, 12, 25);
  const boxing = date(year, 12, 26);
  add(christmas, 'Christmas Day');
  add(boxing, 'Boxing Day');
  let free = date(year, 12, 27);
  const nextFree = () => {
    while (weekend(free)) free = plusDays(free, 1);
    const d = free;
    free = plusDays(free, 1);
    return d;
  };
  if (weekend(christmas)) add(nextFree(), 'Christmas Day (additional day)');
  if (weekend(boxing)) add(nextFree(), 'Boxing Day (additional day)');

  return out.sort((a, b) => a.day.localeCompare(b.day));
}

const cache = new Map<number, Map<string, Closure>>();

/** NSW's public holiday on `key`, if it is one. Worked out once a year. */
export function nswHolidayOn(key: string): Closure | null {
  const year = Number(key.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  let days = cache.get(year);
  if (!days) {
    days = new Map(nswPublicHolidays(year).map((h) => [h.day, h]));
    cache.set(year, days);
  }
  return days.get(key) ?? null;
}

/** An entered day, cleaned: a real date, trimmed name. Null when it is not a date. */
export function cleanRdo(entry: RdoDay): RdoDay | null {
  const day = String(entry.day ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const back = date(y, m, d);
  if (back.getFullYear() !== y || back.getMonth() !== m - 1 || back.getDate() !== d) return null;
  const name = entry.name?.trim().slice(0, 40);
  return name ? { day, name } : { day };
}
