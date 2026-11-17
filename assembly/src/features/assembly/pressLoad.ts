/**
 * The presses' load, day by day: what PMD's folded row and each press's draw.
 *
 * A press is not crewed from this board, so its load is not read against a
 * crew. It is read against the hours the press can run: eight hours a shift,
 * for the shifts its orders are manned for ("No of shift" on Planning.csv —
 * the most any of its orders says, three when none says). PMD's own row adds
 * up its presses: their hours against all their hours that day.
 *
 * Hours are an order's remaining hours, laid over the days its run spans in
 * the press plan in proportion to the time it runs on each — Epicor's start and
 * end are clock times, and a run from Monday 19:00 to Tuesday 03:00 is mostly
 * Monday's. A changeover takes its own hours on the clock, and holds the press
 * as surely as an order does, so it is load too, shown apart.
 *
 * Nothing here is added to the assembly board's figures: the day headings,
 * Hours on board and the crews' capacity read the lines the board schedules,
 * and PMD is not one of them.
 *
 * Pure: no React, no store.
 */

import type { OrderRow } from '@/engine/assembly/board';
import { isPressLine } from '@/domain/assembly';
import { jobNumOf } from '@/domain/routing';
import { addCalendarDays, isClosed, startOfDay } from '@/engine/assembly/dates';
import { remainingHours } from '@/engine/assembly/duration';
import { changeShortLabel, shiftCount, CHANGE_SHORT } from '@/engine/assembly/pressPlan';
import { toDayKey } from '@/lib/time';
import type { DayOrderEntry } from './boardView';

/** One shift on a press. */
export const PRESS_SHIFT_HOURS = 8;

/** A press whose orders say nothing about shifts is taken to run all three. */
export const PRESS_DEFAULT_SHIFTS = 3;

export interface PressDayLoad {
  key: string;
  date: Date;
  /** Behind today: nothing is shown — what ran is the PMD dashboard's record, not this plan's. */
  past: boolean;
  /** Remaining order hours planned on the presses that day. */
  hours: number;
  /** Changeover hours that day. */
  changeHours: number;
  /** What the presses can run that day: shifts × 8 h, press by press. */
  capacity: number;
  /** Presses counted in `capacity`. */
  presses: number;
  /** Orders running that day, by order number. */
  orders: string[];
  /** Every order and changeover behind the day's figures, largest first. */
  entries: DayOrderEntry[];
}

/** The shifts a press is manned for, from its orders: the most any says, three when none says. */
export function pressShifts(rows: readonly OrderRow[]): number {
  const said = rows
    .map((row) => shiftCount(row.job.press?.shifts ?? null))
    .filter((n): n is number => n !== null && n > 0);
  return said.length > 0 ? Math.max(...said) : PRESS_DEFAULT_SHIFTS;
}

const HOUR = 3_600_000;

/** Hours of `[from, to)` that fall on `day` (a local midnight). */
function overlapHours(from: Date, to: Date, day: Date): number {
  const start = Math.max(from.getTime(), day.getTime());
  const end = Math.min(to.getTime(), addCalendarDays(day, 1).getTime());
  return Math.max(0, end - start) / HOUR;
}

/**
 * `rows`: a press's orders, or PMD's — every press's, and the moulding orders
 * PMD carries with no press plan, which add hours and no capacity.
 */
export function pressDayLoads(
  rows: readonly OrderRow[],
  dates: readonly Date[],
  today: Date,
): PressDayLoad[] {
  const todayStart = startOfDay(today);
  const todayKey = toDayKey(todayStart);

  // Each order's remaining hours, spread over what is left of its run.
  const shares = new Map<string, { row: OrderRow; byDay: Map<string, number> }>();
  for (const row of rows) {
    const hours = remainingHours(row.job);
    if (hours <= 0 || !row.start) continue;
    const end = row.expectDate ?? row.planThrough ?? row.start;
    const from = row.start > todayStart ? row.start : todayStart;
    const byDay = new Map<string, number>();
    if (end <= from) {
      // Planned to be done already and not done: it is still to run, today.
      byDay.set(todayKey, hours);
    } else {
      const span = (end.getTime() - from.getTime()) / HOUR;
      for (let day = startOfDay(from); day < end; day = addCalendarDays(day, 1)) {
        const on = overlapHours(from, end, day);
        if (on > 0) byDay.set(toDayKey(day), (hours * on) / span);
      }
    }
    shares.set(String(row.job.id), { row, byDay });
  }

  // The presses, and the shifts each is manned for.
  const byPress = new Map<string, OrderRow[]>();
  for (const row of rows) {
    if (!isPressLine(String(row.line.key))) continue;
    const held = byPress.get(String(row.line.key));
    if (held) held.push(row);
    else byPress.set(String(row.line.key), [row]);
  }
  const shiftsOf = new Map([...byPress].map(([press, held]) => [press, pressShifts(held)]));

  return dates.map((date) => {
    const day = startOfDay(date);
    const key = toDayKey(day);
    const past = key < todayKey;
    const out: PressDayLoad = {
      key,
      date,
      past,
      hours: 0,
      changeHours: 0,
      capacity: 0,
      presses: 0,
      orders: [],
      entries: [],
    };
    if (past) return out;
    const busy = new Set<string>();
    for (const { row, byDay } of shares.values()) {
      const hours = byDay.get(key) ?? 0;
      if (hours <= 0) continue;
      out.hours += hours;
      out.orders.push(jobNumOf(String(row.job.id)));
      busy.add(String(row.line.key));
      out.entries.push(entry(row, hours, 'press', row.job.description ?? ''));
    }
    for (const row of rows) {
      const after = row.changeAfter;
      if (!after) continue;
      const hours = overlapHours(after.start, after.end, day);
      if (hours <= 0) continue;
      out.changeHours += hours;
      busy.add(String(row.line.key));
      out.entries.push(
        entry(row, hours, 'change', `${CHANGE_SHORT[after.change.kind]} ${changeShortLabel(after.change)} — then ${jobNumOf(after.change.toJob)}`),
      );
    }
    // A press the factory calendar shuts that day runs only if its plan says so.
    for (const [press, shifts] of shiftsOf) {
      if (isClosed(day) && !busy.has(press)) continue;
      out.capacity += shifts * PRESS_SHIFT_HOURS;
      out.presses += 1;
    }
    out.entries.sort((a, b) => b.hours - a.hours);
    return out;
  });
}

function entry(row: OrderRow, hours: number, kind: 'press' | 'change', description: string): DayOrderEntry {
  return {
    jobId: String(row.job.id),
    order: jobNumOf(String(row.job.id)),
    description,
    line: row.line.name,
    hours,
    kind,
    people: 0,
    due: row.job.dueDate ?? null,
  };
}
