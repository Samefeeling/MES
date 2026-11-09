// Machine Utilization by month — the supervisor's KPI chart.
//
//   Utilization = Actual running hours ÷ Available working hours
//
// Actual running hours: the half-hours the press was marked R (Running),
// on any day. Available working hours: every weekday of the month the
// FactoryCalendar list does not shut (holidays and RDOs alike), × 24 h.
// Weekend R hours count as running, so a month can pass 100%.
// The month so far, for the month under way.

import { machineKey } from './maint';
import { SLOT_MINUTES } from './shifts';

/** Hours a weekday makes available: three shifts, round the clock. */
export const UTILIZATION_HOURS_PER_WEEKDAY = 24;

/** The presses charted, in the order they are laid out. */
export const UTILIZATION_PRESSES = ['1600T', '1300T', 'Batt1', 'Batt2', '850T', '550T', '320T', '150T', '125T'];

/** A row of the FactoryCalendar list: a day the factory is shut. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** "RDO", or the holiday's name. */
  name: string;
}

/** A shift's status timeline for one order (16 half-hours). */
export interface ShiftTimeline {
  machineCode: string;
  shiftId: string;
  timeline?: string;
}

export interface UtilizationMonth {
  /** `YYYY-MM`. */
  month: string;
  runHours: number;
  availableHours: number;
  /** runHours ÷ availableHours × 100; null with no available hours. */
  pct: number | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

/**
 * The days the FactoryCalendar list shuts — its holidays and its RDOs — with
 * the factory's one rule on top, as the Assembly board keeps it
 * (engine/assembly/factoryCalendar.ts): an Anzac Day on a weekend shuts the
 * Monday after too (the next weekday still open, when that Monday is
 * already shut).
 */
export function factoryClosedDays(rows: ReadonlyArray<CalendarDay>): Set<string> {
  const listed = new Set(rows.map((r) => r.day));
  const out = new Set<string>(listed);
  for (const r of rows) {
    if (!/anzac/i.test(r.name)) continue;
    const [y, m, d] = r.day.split('-').map(Number);
    const day = new Date(y, m - 1, d);
    if (!isWeekend(day)) continue;
    const monday = new Date(day);
    monday.setDate(monday.getDate() + (day.getDay() === 6 ? 2 : 1));
    // The list already names that Monday for Anzac Day: nothing to add.
    if (rows.some((x) => x.day === dayKey(monday) && /anzac/i.test(x.name))) continue;
    while (listed.has(dayKey(monday)) || isWeekend(monday)) monday.setDate(monday.getDate() + 1);
    out.add(dayKey(monday));
  }
  return out;
}

/**
 * Available working hours in `month`: its weekdays the factory is open ×
 * `hoursPerWeekday`, counted up to and including `asOf`'s day (the month so
 * far; a month to come has none).
 */
export function availableHours(
  month: string,
  closed: ReadonlySet<string>,
  asOf: Date,
  hoursPerWeekday = UTILIZATION_HOURS_PER_WEEKDAY,
): number {
  const [y, m] = month.split('-').map(Number);
  const last = dayKey(asOf);
  let days = 0;
  for (const d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    if (key > last) break;
    if (!isWeekend(d) && !closed.has(key)) days++;
  }
  return days * hoursPerWeekday;
}

/**
 * Hours each press was marked R, by month (of the shift's date): machine
 * key (`machineKey`) → month → hours. A half-hour two orders share on one
 * press (a co-run) is one half-hour of the press.
 */
export function runHoursByMonth(timelines: ReadonlyArray<ShiftTimeline>): Map<string, Map<string, number>> {
  const slots = new Map<string, Set<number>>();
  for (const t of timelines) {
    const tl = t.timeline ?? '';
    const key = `${machineKey(t.machineCode)}|${t.shiftId}`;
    for (let i = 0; i < tl.length && i < 16; i++) {
      if (tl[i] !== 'R') continue;
      const held = slots.get(key) ?? new Set<number>();
      held.add(i);
      slots.set(key, held);
    }
  }
  const out = new Map<string, Map<string, number>>();
  for (const [key, held] of slots) {
    const [machine, shiftId] = key.split('|');
    const month = shiftId.slice(0, 7);
    const byMonth = out.get(machine) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + (held.size * SLOT_MINUTES) / 60);
    out.set(machine, byMonth);
  }
  return out;
}

/** The `n` months up to and including `asOf`'s, oldest first. */
export function lastMonths(asOf: Date, n = 12): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}

/** Each press's Utilization in each of `months`. */
export function machineUtilization(
  presses: ReadonlyArray<string>,
  months: ReadonlyArray<string>,
  timelines: ReadonlyArray<ShiftTimeline>,
  calendar: ReadonlyArray<CalendarDay>,
  asOf: Date,
): Array<{ machineCode: string; months: UtilizationMonth[] }> {
  const run = runHoursByMonth(timelines);
  const closed = factoryClosedDays(calendar);
  return presses.map((machineCode) => ({
    machineCode,
    months: months.map((month) => {
      const runHours = run.get(machineKey(machineCode))?.get(month) ?? 0;
      const available = availableHours(month, closed, asOf);
      return {
        month,
        runHours,
        availableHours: available,
        pct: available > 0 ? Math.round((runHours / available) * 1000) / 10 : null,
      };
    }),
  }));
}
