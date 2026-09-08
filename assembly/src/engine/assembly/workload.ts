/**
 * Work load — how much standard work is booked against a person or a line.
 *
 * The unit throughout is the remaining standard hours of an order, which comes
 * from `Calculated_RemainingLaborHrs` in `Planning1.csv`. An order's hours are
 * shared equally by its crew and spread over the calendar days its bar covers,
 * so a person's day shows what they are actually expected to work, not merely
 * how many orders carry their name.
 *
 * Pure. No React, no store.
 */

import { PRODUCTIVE_HOURS_PER_PERSON, type Worker } from '@/domain/assembly';
import type { JobId } from '@/domain/ids';
import { remainingHours } from './duration';
import { addCalendarDays, isWeekend, startOfDay } from './dates';
import type { OrderRow } from './board';
import { toDayKey } from '@/lib/time';

/** Days a person's popup covers — "one week". */
export const LOAD_WINDOW_DAYS = 7;

/**
 * Squares drawn beside a name in the board header.
 *
 * Five, because a calendar week holds exactly five working days and the
 * factory is shut for the other two — so the squares and the popup are two
 * views of the same window rather than two different weeks.
 */
export const LOAD_PREVIEW_DAYS = 5;

/**
 * Slack before a day counts as over-booked, in hours. A bar sized to fit its
 * crew exactly lands on 7.25 h through a chain of divisions, so a bare `>`
 * would flag half the board as overtime on floating-point dust. 36 seconds is
 * below anything the shop floor would call over.
 */
const OVER_TOLERANCE_HOURS = 0.01;

/** One order's contribution to one person's day. */
export interface LoadEntry {
  jobId: JobId;
  description: string;
  /** Line the order sits on, for the lane colour. */
  line: string;
  hours: number;
}

export interface DayLoad {
  /** Local `YYYY-MM-DD`, the key used for planned leave. */
  key: string;
  date: Date;
  /** Standard hours booked on this person for the day. */
  hours: number;
  /**
   * Hours they can actually work: a full shift on an open day, none while on
   * leave and none at the weekend. Anything booked against a zero reads as
   * over — which is right, because that is what overtime is.
   */
  capacity: number;
  /** Booked past what they can work — they are on two orders at once. */
  over: boolean;
  /** Off the roster for the day, so `capacity` is zero by design. */
  onLeave: boolean;
  /** A day the factory runs. Saturday and Sunday are closed. */
  working: boolean;
  entries: LoadEntry[];
}

export interface WorkerLoad {
  worker: Worker;
  days: DayLoad[];
  /** Booked hours across the window. */
  totalHours: number;
  /** Hours available across the window, after leave. */
  capacityHours: number;
  /** booked ÷ available; above 1 the person is double-booked. */
  utilisation: number;
  /** Distinct orders they appear on in the window. */
  orderCount: number;
  /** Days in the window booked past a full shift. */
  overloadedDays: number;
}

/** How hard a day is booked, against Resero's thresholds. */
export type LoadBand = 'green' | 'orange' | 'red';

/**
 * Colour band for a day's load: comfortable below 80%, tight to 90%,
 * over-committed beyond. Exhaustive and non-overlapping.
 */
export function loadBand(pct: number): LoadBand {
  if (pct < 80) return 'green';
  if (pct <= 90) return 'orange';
  return 'red';
}

/** One day column's load across the whole board. */
export interface DayBoardLoad {
  key: string;
  date: Date;
  /** The day the board is being planned on. */
  isToday: boolean;
  /** Already behind us — yesterday's shift, kept on screen for comparison. */
  past: boolean;
  /**
   * A day the factory runs. Weekends are closed, so bars step over them and a
   * closed column reads 0% — unless an order has been approved for overtime,
   * which is exactly the case the supervisor needs to see standing out.
   */
  working: boolean;
  /** Standard hours of work landing on the day, summed over every order. */
  hours: number;
  /** Hours the people available that day can deliver. */
  capacity: number;
  /** hours ÷ capacity, as a percentage. Zero when nobody is in. */
  pct: number;
  /** `hours` is output that was booked, not work that is planned. */
  actual: boolean;
  band: LoadBand;
  /** People available, after attendance today and planned leave later. */
  available: number;
}

/**
 * The load histogram along the top of the board.
 *
 * Same hours as the per-person and per-line views, so the three agree: the
 * remaining standard hours of each order, spread over the days its bar covers.
 * Attendance is only known for today — the supervisor confirms it each morning
 * — so later days assume everyone is in bar those on planned leave.
 */
export function boardDayLoads(
  rows: OrderRow[],
  workers: Worker[],
  from: Date,
  dayCount: number,
  /** Which column is today; the board opens a working day earlier. */
  today: Date = from,
): DayBoardLoad[] {
  const start = startOfDay(from);
  const todayKey = toDayKey(startOfDay(today));
  const scheduled = rows.filter((r) => r.line.schedulable);
  const out: DayBoardLoad[] = [];

  for (let i = 0; i < dayCount; i++) {
    const date = addCalendarDays(start, i);
    const key = toDayKey(date);
    const available = workers.filter(
      (w) => (key !== todayKey || w.onShift) && !w.plannedLeave?.includes(key),
    ).length;
    const capacity = available * PRODUCTIVE_HOURS_PER_PERSON;
    const past = key < todayKey;
    // A day already gone shows what the shift booked, not what was planned for
    // it — there is nothing left to plan, and the two are rarely the same.
    const hours = past
      ? scheduled.reduce(
          (s, r) =>
            s + r.booked.reduce((n, b) => (b.day === key ? n + b.hours : n), 0),
          0,
        )
      : scheduled.reduce(
          (s, r) => s + hoursOnDay(r, date),
          0,
        );
    const pct = capacity > 0 ? (hours / capacity) * 100 : 0;

    out.push({
      key,
      date,
      isToday: key === todayKey,
      past,
      actual: past,
      working: !isWeekend(date),
      hours,
      capacity,
      pct,
      band: loadBand(pct),
      available,
    });
  }
  return out;
}

/** Work still to run on a line, and what the crew on it can absorb. */
export interface LineLoad {
  /** Standard hours still to run across the line's orders. */
  hours: number;
  /** Most people planned simultaneously on the line on any covered day. */
  crew: number;
  /** Average daily capacity across the shifts currently covered. */
  capacityPerDay: number;
  /** Calendar days to clear the queue; null when nobody is allocated. */
  daysOfWork: number | null;
  /** Orders sitting on the line with nobody on them. */
  needsCrew: number;
}

/**
 * Hours of `row` that fall on the day starting at `from`, per person.
 *
 * The bar is treated as an even spread of work over the days it is actually
 * worked, so a bar half inside a day contributes half its daily rate. That
 * keeps a short order (0.4 days) inside the one day it runs, instead of
 * charging a whole shift to it.
 *
 * A closed day carries nothing: the bar merely spans it. `row.days` counts the
 * days worked, which is precisely the sum of the open overlaps below, so an
 * order's daily shares always add back up to its remaining hours.
 */
function hoursOnDay(
  row: OrderRow,
  from: Date,
  workerId?: string,
): number {
  const plan = row.crewDays.find((day) => day.day === toDayKey(from));
  if (!plan) return 0;
  if (workerId && !plan.workerIds.includes(workerId)) return 0;
  return workerId ? plan.perWorkerHours : plan.hours;
}

/**
 * One person's load over `dayCount` days from `from`.
 *
 * `rows` should be every scheduled row on the board — an order counts against
 * the person wherever it sits, not only on the line they are looking at.
 */
export function workerLoad(
  worker: Worker,
  rows: OrderRow[],
  from: Date,
  dayCount: number = LOAD_WINDOW_DAYS,
): WorkerLoad {
  const start = startOfDay(from);
  const id = String(worker.id);
  const leave = new Set(worker.plannedLeave ?? []);
  const mine = rows.filter(
    (r) => !r.completedToday && r.workers.some((w) => String(w.id) === id),
  );

  const days: DayLoad[] = [];
  const jobs = new Set<string>();

  for (let i = 0; i < dayCount; i++) {
    const date = addCalendarDays(start, i);
    const key = toDayKey(date);
    const onLeave = leave.has(key);
    const entries: LoadEntry[] = [];

    for (const row of mine) {
      const hours = hoursOnDay(row, date, id);
      if (hours <= 0) continue;
      jobs.add(String(row.job.id));
      entries.push({
        jobId: row.job.id,
        description: row.job.description || String(row.job.id),
        line: row.line.name,
        hours,
      });
    }

    entries.sort((a, b) => b.hours - a.hours);
    const hours = entries.reduce((s, e) => s + e.hours, 0);
    const working = !isWeekend(date);
    const capacity = onLeave || !working ? 0 : PRODUCTIVE_HOURS_PER_PERSON;
    days.push({
      key,
      date,
      hours,
      capacity,
      over: hours > capacity + OVER_TOLERANCE_HOURS,
      onLeave,
      working,
      entries,
    });
  }

  const totalHours = days.reduce((s, d) => s + d.hours, 0);
  const capacityHours = days.reduce((s, d) => s + d.capacity, 0);

  return {
    worker,
    days,
    totalHours,
    capacityHours,
    utilisation: capacityHours > 0 ? totalHours / capacityHours : 0,
    orderCount: jobs.size,
    overloadedDays: days.filter((d) => d.over).length,
  };
}

/**
 * Every person's week in one pass, keyed by worker id.
 *
 * The header draws a load square per person per working day, so the board needs
 * all of them on every render; computing them together keeps that to a single
 * walk of the rows instead of one per name.
 */
export function rosterLoad(
  workers: Worker[],
  rows: OrderRow[],
  from: Date,
  dayCount: number = LOAD_WINDOW_DAYS,
): Map<string, WorkerLoad> {
  return new Map(
    workers.map((w) => [String(w.id), workerLoad(w, rows, from, dayCount)]),
  );
}

/** How a single day reads, as a square or as a meter. */
export type LoadDot = 'leave' | 'idle' | LoadBand;

/** Share of a shift at which a person counts as having no room left. */
const PERSON_FULL_PCT = 80;

/**
 * The colour for one day of one person's week, used by both views of it so
 * they can never tell different stories.
 *
 * A person is banded differently from the department, and deliberately. The
 * board sizes every bar to exactly fill the crew on it, so anyone allocated to
 * an order is booked a full shift by definition — under the department's
 * bands, where 90% is already red, that paints every working person red and
 * says nothing. What a supervisor is actually asking of these squares is "who
 * has room?", so: green has room, orange is full, and red is *over* — two
 * orders at once, or work landing on a day the person cannot work at all.
 */
export function dayBand(day: DayLoad): LoadDot {
  if (day.hours <= 0) return day.onLeave ? 'leave' : 'idle';
  // `over` carries the tolerance, so a bar sized to exactly fill its crew
  // reads full rather than over on floating-point dust.
  if (day.over) return 'red';
  return day.hours >= (day.capacity * PERSON_FULL_PCT) / 100
    ? 'orange'
    : 'green';
}

/** One square: a working day boiled down to a colour. */
export interface LoadPreviewDay {
  key: string;
  date: Date;
  hours: number;
  capacity: number;
  /** booked ÷ available, as a percentage. Zero when they cannot work. */
  pct: number;
  onLeave: boolean;
  dot: LoadDot;
}

/**
 * The squares for one person: the working days of their window, in order.
 *
 * Closed days are left out rather than drawn grey — the supervisor is reading
 * these to find room for an order, and the factory offers none at the weekend.
 * Work booked on a day with no capacity (leave, or an approved weekend) counts
 * as fully over: there is no shift to absorb it.
 */
export function loadPreview(
  load: WorkerLoad,
  count: number = LOAD_PREVIEW_DAYS,
): LoadPreviewDay[] {
  return load.days
    .filter((d) => d.working)
    .slice(0, count)
    .map((d) => ({
      key: d.key,
      date: d.date,
      hours: d.hours,
      capacity: d.capacity,
      pct: d.capacity > 0 ? (d.hours / d.capacity) * 100 : 0,
      onLeave: d.onLeave,
      dot: dayBand(d),
    }));
}

/** Work still queued on a line, and how long its crew needs to clear it. */
export function lineLoad(rows: OrderRow[]): LineLoad {
  const hours = rows.reduce((s, r) => s + remainingHours(r.job), 0);
  const byDay = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const day of row.crewDays) {
      const active = byDay.get(day.day) ?? new Set<string>();
      day.workerIds.forEach((workerId) => active.add(workerId));
      byDay.set(day.day, active);
    }
  }
  // Nobody planned on any day is a line with no crew, not a line whose crew
  // is merely idle: the names on a row that never runs cost the line nothing.
  const dayCrews = [...byDay.values()].map((active) => active.size);
  const crew = dayCrews.length > 0 ? Math.max(...dayCrews) : 0;
  const capacityPerDay =
    dayCrews.length > 0
      ? (dayCrews.reduce((sum, count) => sum + count, 0) / dayCrews.length) *
        PRODUCTIVE_HOURS_PER_PERSON
      : 0;

  return {
    hours,
    crew,
    capacityPerDay,
    daysOfWork: capacityPerDay > 0 ? hours / capacityPerDay : null,
    needsCrew: rows.filter(
      (r) =>
        r.line.schedulable &&
        (r.uncoveredHours ?? (r.workers.length === 0 ? 1 : 0)) > 0,
    ).length,
  };
}
