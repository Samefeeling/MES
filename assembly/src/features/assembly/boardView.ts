/** Pure view-only transforms for the assembly board. */

import type { OrderRow } from '@/engine/assembly/board';
import {
  addCalendarDays,
  isWeekend,
  startOfDay,
  wholeDaysBetween,
} from '@/engine/assembly/dates';
import type { LineKey, Worker } from '@/domain/assembly';
import { MS_PER_DAY, toDayKey } from '@/lib/time';

export type OrderSortKey = 'start' | 'due';
export type SortDirection = 'asc' | 'desc';

export interface OrderSort {
  key: OrderSortKey;
  direction: SortDirection;
}

const sortDate = (row: OrderRow, key: OrderSortKey): Date | null => {
  // Crew changes move the planned bar. A confirmed production start wins;
  // the latest permissible start (mustStartBy) is a deadline, not this order.
  if (key === 'start') return row.actualStart
    ? new Date(row.actualStart.startedAt)
    : row.start ?? row.plannedStart ?? row.job.startDate;
  return row.job.dueDate;
};

/** Stable, line-local date sort. Missing source dates always stay at the end. */
export function sortLineRows(
  rows: OrderRow[],
  sort: OrderSort | null,
): OrderRow[] {
  if (!sort || rows.every(row => !row.line.schedulable)) return rows;
  return rows
    .map((row, index) => ({ row, index, date: sortDate(row, sort.key) }))
    .sort((a, b) => {
      if (!a.date && !b.date) return a.index - b.index;
      if (!a.date) return 1;
      if (!b.date) return -1;
      const delta = a.date.getTime() - b.date.getTime();
      return (sort.direction === 'asc' ? delta : -delta) || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** Keep existing row positions during edits; append new orders in date order. */
export function retainLineRows(
  rows: OrderRow[],
  sort: OrderSort,
  previousIds?: readonly string[],
): OrderRow[] {
  if (!previousIds) return sortLineRows(rows, sort);
  const remaining = new Map(rows.map((row) => [String(row.job.id), row]));
  const retained: OrderRow[] = [];
  for (const id of previousIds) {
    const row = remaining.get(id);
    if (row) retained.push(row);
    remaining.delete(id);
  }
  return [...retained, ...sortLineRows([...remaining.values()], sort)];
}

/**
 * An order with work on this local calendar day, counted once regardless of
 * crew size. Exact crew days exclude idle gaps and unapproved weekends;
 * booked output also keeps finished work discoverable. PMD uses its source
 * bar because its crew is managed outside this board.
 */
export function isRunningOnDay(row: OrderRow, day: Date): boolean {
  const key = toDayKey(day);
  if (row.booked.some((entry) => entry.day === key && entry.qty > 0)) return true;
  if (row.line.schedulable) {
    return row.crewDays.some((entry) => entry.day === key && entry.hours > 0);
  }
  if (row.completedToday || !row.start || !row.expectDate) return false;
  if (row.line.schedulable && isWeekend(day) && !row.overtime) return false;
  return row.start < addCalendarDays(startOfDay(day), 1) &&
    row.expectDate > startOfDay(day);
}

export function countRunningOrders(rows: OrderRow[], day: Date): number {
  return new Set(rows.filter((row) => row.line.schedulable && isRunningOnDay(row, day))
    .map((row) => String(row.job.id))).size;
}

/**
 * How many orders run on each day of `days`, in one pass over the rows.
 *
 * The header asks this once per column, and asking it column by column walked
 * every row on the board for every column on screen. An order names the days
 * it runs — its own plan, and whatever the shift booked against it — so
 * counting outwards from the rows is the cheap direction. PMD is context
 * only and is excluded from the Assembly day counts.
 */
export function runningOrdersByDay(
  rows: OrderRow[],
  days: Date[],
): Map<string, number> {
  const onDay = new Map<string, Set<string>>();
  const mark = (day: string, jobId: string): void => {
    const already = onDay.get(day);
    if (already) already.add(jobId);
    else onDay.set(day, new Set([jobId]));
  };

  for (const row of rows) {
    if (!row.line.schedulable) continue;
    const jobId = String(row.job.id);
    for (const entry of row.booked) {
      if (entry.qty > 0) mark(entry.day, jobId);
    }
    if (row.line.schedulable) {
      for (const entry of row.crewDays) {
        if (entry.hours > 0) mark(entry.day, jobId);
      }
    }
  }

  return new Map(
    days.map((day) => {
      const key = toDayKey(day);
      return [key, onDay.get(key)?.size ?? 0];
    }),
  );
}

/** Today through the end of the fifth working day, including today if open. */
export function nextWorkingDaysWindow(
  today: Date,
  count = 5,
): { from: Date; toExclusive: Date } {
  const todayStart = startOfDay(today);
  const from = todayStart;
  let cursor = todayStart;
  let found = 0;
  while (found < Math.max(1, count)) {
    if (!isWeekend(cursor)) found++;
    if (found < Math.max(1, count)) cursor = addCalendarDays(cursor, 1);
  }
  return { from, toExclusive: addCalendarDays(cursor, 1) };
}

/**
 * Horizontal day position on the timeline. When weekends are hidden their
 * width is zero, so Friday and Monday meet without leaving empty columns.
 */
export function timelineDayOffset(
  date: Date,
  horizonStart: Date,
  showWeekends: boolean,
): number {
  const origin = startOfDay(horizonStart);
  const target = startOfDay(date);
  const fraction = (date.getTime() - target.getTime()) / MS_PER_DAY;
  if (showWeekends) return wholeDaysBetween(target, origin) + fraction;

  let offset = 0;
  if (target >= origin) {
    for (
      let cursor = origin;
      cursor < target;
      cursor = startOfDay(addCalendarDays(cursor, 1))
    ) {
      if (!isWeekend(cursor)) offset++;
    }
  } else {
    for (
      let cursor = target;
      cursor < origin;
      cursor = startOfDay(addCalendarDays(cursor, 1))
    ) {
      if (!isWeekend(cursor)) offset--;
    }
  }
  return offset + (isWeekend(target) ? 0 : fraction);
}

/** Move a dragged bar by what the user sees as timeline columns. */
export function shiftTimelineDays(
  from: Date,
  days: number,
  showWeekends: boolean,
): Date {
  if (showWeekends || days === 0) return startOfDay(addCalendarDays(from, days));
  const direction = days < 0 ? -1 : 1;
  let cursor = startOfDay(from);
  for (let left = Math.abs(days); left > 0; ) {
    cursor = startOfDay(addCalendarDays(cursor, direction));
    if (!isWeekend(cursor)) left--;
  }
  return cursor;
}

/**
 * Which rows a narrowed board draws: the ones the filter picked, and whatever
 * they are waiting for.
 *
 * A date filter asks about one order's own bar, and the press job that order
 * cannot start without has a bar of its own — on moulding's dates, which are
 * frequently behind us, because the shell was meant to be made last week. So
 * narrowing the board dropped the predecessor and kept the successor, and the
 * arrow between them, which is drawn only where both bars are on screen, went
 * with it. The chain then read as though nothing was holding the order up.
 *
 * Followed all the way up rather than one link: a chain shown with its middle
 * missing says less than no chain at all.
 */
export function withPredecessors(
  rows: OrderRow[],
  chosen: (row: OrderRow) => boolean,
): Set<string> {
  const byId = new Map(rows.map((row) => [String(row.job.id), row]));
  const keep = new Set<string>();
  const queue: string[] = [];
  for (const row of rows) {
    if (!chosen(row)) continue;
    const id = String(row.job.id);
    keep.add(id);
    queue.push(id);
  }
  // `keep` doubles as the visited set, so a circular material link — which the
  // dependency builder warns about rather than removing — cannot spin here.
  while (queue.length > 0) {
    const row = byId.get(queue.pop()!);
    if (!row) continue;
    for (const dependency of row.predecessors) {
      const id = String(dependency.onJobId);
      if (keep.has(id) || !byId.has(id)) continue;
      keep.add(id);
      queue.push(id);
    }
  }
  return keep;
}

/** An order remains visible when any part of its planned bar touches the window. */
export function isInNextWorkingDays(
  row: OrderRow,
  today: Date,
  count = 5,
): boolean {
  const window = nextWorkingDaysWindow(today, count);
  const from = row.start ?? row.plannedStart ?? row.job.startDate;
  if (!from) return false;
  const to = row.expectDate ?? row.planThrough ?? from;
  return from < window.toExclusive &&
    (to > window.from || (to.getTime() === from.getTime() && from >= window.from));
}

/** Today's available roster and unique allocations, across the whole board. */
export function teamSummary(workers: Worker[], rows: OrderRow[], today: Date) {
  const key = toDayKey(today);
  const attendance = workers.filter(
    (worker) => worker.onShift && !worker.plannedLeave?.includes(key),
  );
  const active = activeWorkerIdsOnDay(rows, today);
  const free = attendance.filter((worker) => !active.has(String(worker.id)));
  const allocated = attendance.length - free.length;
  const label = attendance.length === 0
    ? '0/0 No staff on site'
    : `${allocated}/${attendance.length} ${free.length === 0
      ? 'All allocated'
      : `Free ${free.length}: ${free.map((worker) => worker.name).join(', ')}`}`;
  return { allocated, total: attendance.length, free, label };
}

/** Workers actually allocated on one day; future allocations do not count. */
export function activeWorkerIdsOnDay(
  rows: OrderRow[],
  day: Date,
): Set<string> {
  const key = toDayKey(day);
  const active = new Set<string>();
  for (const row of rows) {
    if (!row.line.schedulable || row.completedToday) continue;
    row.crewDays
      .find((crewDay) => crewDay.day === key)
      ?.workerIds.forEach((workerId) => active.add(workerId));
  }
  return active;
}

/**
 * Width of one character of a bar label, measured in Chromium at the 11px
 * 650-weight the bar uses. It only ever answers "does this fit?", so erring a
 * shade wide is right: a borderline label goes outside rather than being cut.
 */
const LABEL_CHAR_PX = 6.9;
/** The bar's own padding, and room for the overtime marker. */
const LABEL_PADDING_PX = 14;
const OT_MARKER_PX = 22;
/**
 * Under half a day the block has bottomed out at its minimum width, so its
 * length tells you nothing and the tag carries the hours instead.
 */
const STUB_DAYS = 0.5;

export interface BarTag {
  /** What the tag reads — the job number, plus hours on a very short bar. */
  text: string;
  /** Too narrow to hold the tag, so it sits in the grid beside the block. */
  outside: boolean;
  /** No room to the right, so it sits to the left instead. */
  flip: boolean;
  /** A few hours of work: a marker rather than a length. */
  stub: boolean;
}

/**
 * Where an order's label goes.
 *
 * A couple of hours of work is a few pixels of bar, and a label crammed into
 * those pixels came out as one clipped character — naming nothing and reading
 * as a graphical glitch. So a label that will not fit goes in the empty grid
 * beside the block, where there is room for all of it.
 */
export function barTag(bar: {
  jobId: string;
  /** Standard hours still to run, shown when the bar is too short to read. */
  hours: number;
  /** Length of the bar in day columns. */
  spanDays: number;
  /** Drawn width and offset of the bar, and the width of the whole grid. */
  width: number;
  left: number;
  gridWidth: number;
  overtime: boolean;
}): BarTag {
  const stub = bar.spanDays < STUB_DAYS;
  const text =
    stub && bar.hours > 0
      ? `${bar.jobId} · ${bar.hours.toFixed(1)} h`
      : bar.jobId;
  const needed =
    text.length * LABEL_CHAR_PX +
    LABEL_PADDING_PX +
    (bar.overtime ? OT_MARKER_PX : 0);
  const outside = bar.width < needed;
  return {
    text,
    outside,
    stub,
    flip: outside && bar.left + bar.width + needed > bar.gridWidth,
  };
}

/**
 * Which line each person is on today.
 *
 * An explicit supervisor drag always wins. Before the first drag, today's
 * scheduled work chooses the line; with nothing today, the first legacy Skill
 * is used once as the initial placement.
 *
 * Their week of squares still counts every order they are on, whichever line
 * it belongs to: the question those answer is "how much room has this person
 * got", not "what is this line doing".
 */
export function lineOfWorkerToday(
  workers: Worker[],
  rows: OrderRow[],
  today: Date,
  overrides: Readonly<Record<string, LineKey>> = {},
): Map<string, LineKey> {
  const key = toDayKey(today);
  const at = new Map<string, LineKey>();
  for (const row of rows) {
    if (!row.line.schedulable || row.completedToday) continue;
    const onDay =
      row.crewDays.find((day) => day.day === key)?.workerIds ?? [];
    // First order of the day wins. There should only be one — the schedule
    // will not put anyone on two at once unless a supervisor said so.
    for (const id of onDay) {
      if (!overrides[id] && !at.has(id)) at.set(id, row.line.key);
    }
  }
  for (const worker of workers) {
    const id = String(worker.id);
    if (overrides[id]) {
      at.set(id, overrides[id]);
      continue;
    }
    if (!at.has(id)) at.set(id, worker.skills[0] ?? 'FACTORY_GENERAL');
  }
  return at;
}
