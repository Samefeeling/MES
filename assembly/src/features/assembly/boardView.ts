/** Pure view-only transforms for the assembly board. */

import type { OrderRow } from '@/engine/assembly/board';
import {
  addCalendarDays,
  isWeekend,
  startOfDay,
  wholeDaysBetween,
} from '@/engine/assembly/dates';
import type { LineKey, Worker } from '@/domain/assembly';
import { workersOnLeave, type LeaveDays } from '@/engine/assembly/attendance';
import { toDayKey } from '@/lib/time';
import {
  DRAG_STEP_MINUTES,
  SHIFT_SPAN_MINUTES,
  atColumnMinute,
  columnMinuteOf,
  nextWorkingMoment,
  shiftColumnFraction,
} from '@/engine/assembly/shift';
import { rowIndex } from './rowIndex';
import { jobNumOf } from '@/domain/routing';

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

/**
 * Horizontal day position on the timeline. When weekends are hidden their
 * width is zero, so Friday and Monday meet without leaving empty columns.
 *
 * A day column is the *shift*, 07:00 to 15:30 — not midnight to midnight. An
 * order that starts at seven starts at the left edge of its column and one
 * that finishes at 15:15 all but fills it; before and after, the position pins
 * to the column's edges rather than wandering into a night nobody works. The
 * fraction used to be the calendar one, which drew a bar starting at seven a
 * third of the way into its own day and left the mornings of the board empty.
 */
export function timelineDayOffset(
  date: Date,
  horizonStart: Date,
  showWeekends: boolean,
): number {
  const origin = startOfDay(horizonStart);
  const target = startOfDay(date);
  const fraction = shiftColumnFraction(date);
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

/** The same move, keeping the time of day the bar is drawn at. */
export function shiftTimelineKeepingClock(
  from: Date,
  days: number,
  showWeekends: boolean,
): Date {
  return atColumnMinute(
    shiftTimelineDays(from, days, showWeekends),
    columnMinuteOf(from),
  );
}

/** Enough columns to cross the widest horizon twice; a drag cannot exceed it. */
const MAX_COLUMNS = 800;

/**
 * Where a dragged bar comes to rest.
 *
 * `columns` is what the pointer moved, in day columns, and it is **not** a whole
 * number: two thirds of a column is two thirds of a shift. That is the whole
 * point of this function. A drag used to round to the nearest column, so a bar
 * drawn at a quarter to three — because that is when its crew came off the last
 * order — moved to 07:00 the moment anybody touched it, and could never be put
 * back: every pinned order began at the open of its shift, and dragging it home
 * only ever offered 07:00 on the day it came from.
 *
 * So the move is measured along the column, which is the shift as the floor
 * stands in it, and lands on five minutes. Running off either end of a column
 * carries into the next one the reader can see — with the compact working week
 * that is Monday, not Saturday. A landing inside a break resolves forward to
 * the moment they come back, because nobody picks a job up during lunch.
 */
export function landAfterDrag(
  drawn: Date,
  columns: number,
  showWeekends: boolean,
): Date {
  const step = DRAG_STEP_MINUTES;
  /*
   * Ties break the way the pointer is going, and that is what makes out-and-back
   * exact. Rounding halves the same way both times drifts: a bar moved a quarter
   * of a column and moved back gained five minutes on every trip, so a board
   * worked over for an afternoon walked away from where it started — which is
   * the complaint this whole function exists to answer.
   */
  const snap = (m: number): number =>
    columns < 0
      ? Math.ceil(m / step - 0.5) * step
      : Math.floor(m / step + 0.5) * step;
  let minutes = snap(columnMinuteOf(drawn) + columns * SHIFT_SPAN_MINUTES);
  let day = startOfDay(drawn);
  for (let guard = 0; minutes >= SHIFT_SPAN_MINUTES && guard < MAX_COLUMNS; guard++) {
    day = shiftTimelineDays(day, 1, showWeekends);
    minutes -= SHIFT_SPAN_MINUTES;
  }
  for (let guard = 0; minutes < 0 && guard < MAX_COLUMNS; guard++) {
    day = shiftTimelineDays(day, -1, showWeekends);
    minutes += SHIFT_SPAN_MINUTES;
  }
  return nextWorkingMoment(atColumnMinute(day, minutes));
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
  const byId = rowIndex(rows);
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

/**
 * The last moment of the `count`th working day from today, inclusive.
 *
 * Two working days on a Friday afternoon reaches Monday, not Saturday: the
 * question production asks is "what has to go out before I next see this
 * board", and nothing goes out at the weekend.
 */
export function dueWithin(today: Date, count: number): Date {
  let cursor = startOfDay(today);
  for (let found = isWeekend(cursor) ? 0 : 1; found < Math.max(1, count); ) {
    cursor = addCalendarDays(cursor, 1);
    if (!isWeekend(cursor)) found++;
  }
  // Through the end of that day, so an order due on it is included.
  return addCalendarDays(cursor, 1);
}

/**
 * Orders that have to be finished in the next `count` working days — and
 * everything already past its Due Date, unfinished.
 *
 * An order that was due last Tuesday is not less urgent than one due
 * tomorrow, and a list of "what is due soon" that quietly drops the late ones
 * is the list you would least want to work from.
 */
export function isDueSoon(row: OrderRow, today: Date, count = 2): boolean {
  if (!row.job.dueDate || row.completedToday) return false;
  return row.job.dueDate < dueWithin(today, count);
}

/**
 * Today's roster, split three ways: on an order, on site with nothing on, and
 * not in at all.
 *
 * The third list is the one the board used to have nowhere to put. Somebody
 * marked off simply left the ratio — "11 of 14" quietly became "10 of 13" —
 * and the two orders they were half-way through said nothing about it. Free
 * and On Leave are the two halves of the same morning question, which is why
 * they are worked out together and shown side by side: one is who can pick
 * something up, the other is what has been put down.
 */
export function teamSummary(
  workers: Worker[],
  rows: OrderRow[],
  today: Date,
  leave: LeaveDays = {},
) {
  const out = workersOnLeave(workers, leave, today);
  const outIds = new Set(out.map((worker) => String(worker.id)));
  const attendance = workers.filter(
    (worker) => !outIds.has(String(worker.id)),
  );
  const active = activeWorkerIdsOnDay(rows, today);
  const free = attendance.filter((worker) => !active.has(String(worker.id)));
  const allocated = attendance.length - free.length;
  const label = attendance.length === 0
    ? '0/0 No staff on site'
    : `${allocated}/${attendance.length} ${free.length === 0
      ? 'All allocated'
      : `Free ${free.length}: ${free.map((worker) => worker.name).join(', ')}`}`;
  return {
    allocated,
    total: attendance.length,
    attendance,
    free,
    onLeave: out,
    label,
  };
}

/** Is anyone actually planned to work this order on `day`? */
export function crewedOnDay(row: OrderRow, day: Date): boolean {
  const key = toDayKey(day);
  return row.crewDays.some(
    (crewDay) => crewDay.day === key && crewDay.workerIds.length > 0,
  );
}

/** Has this order been picked up on the floor — started, or booked against? */
export function hasBegun(row: OrderRow): boolean {
  return Boolean(row.actualStart) || row.booked.some((day) => day.qty > 0);
}

/**
 * The orders a Released Only board plans with: every order Epicor has
 * released (JobHead_JobReleased), plus the few an unreleased flag must not
 * take off the board —
 *
 *   - one already begun on the floor: it is at the line whatever the flag
 *     says, and hiding it would hide work in progress and its crew;
 *   - one a kept order waits for, all the way up the chain: a released order
 *     drawn without the work it waits on would plan as if it could start now.
 *
 * A blank flag (`released: null` — the column missing or empty) is not
 * "unreleased" and stays. Returns the job ids to keep, as order numbers, so
 * every operation row of a routed order goes with it.
 */
export function releasedOrderNumbers(rows: readonly OrderRow[]): Set<string> {
  const kept = withPredecessors([...rows], (row) => row.job.released !== false || hasBegun(row));
  return new Set([...kept].map(jobNumOf));
}

/**
 * Orders somebody's absence has left standing: begun on the floor, not
 * finished, and with nobody on them today because the people who were are not
 * in.
 *
 * Not the same list as "needs a crew", and much more urgent than it. An order
 * with nobody on it has not started and is waiting its turn; one of these is
 * half built, holding a build position, and will hold it until somebody is
 * told to pick it up. The board had no way of saying so: the row still showed
 * a full crew, because the crew is still on it — they are simply not here.
 */
export function strandedOrders(rows: OrderRow[], today: Date): OrderRow[] {
  return rows.filter(
    (row) =>
      row.line.schedulable &&
      !row.completedToday &&
      (row.crewOnLeaveToday?.length ?? 0) > 0 &&
      hasBegun(row) &&
      !crewedOnDay(row, today),
  );
}

/** Orders each absent person has left behind today, by worker id. */
export function onLeaveWorkerOrders(
  rows: OrderRow[],
  today: Date,
): Map<string, OrderRow[]> {
  const stranded = new Set(
    strandedOrders(rows, today).map((row) => String(row.job.id)),
  );
  const by = new Map<string, OrderRow[]>();
  for (const row of rows) {
    for (const worker of row.crewOnLeaveToday ?? []) {
      const id = String(worker.id);
      by.set(id, [...(by.get(id) ?? []), row]);
    }
  }
  // Whatever nobody else is covering first: that is what the supervisor has to
  // do something about, and a list is read from the top.
  for (const [id, mine] of by) {
    by.set(
      id,
      [...mine].sort(
        (a, b) =>
          Number(stranded.has(String(b.job.id))) -
          Number(stranded.has(String(a.job.id))),
      ),
    );
  }
  return by;
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

export interface MissingBar {
  /** What the placeholder reads, in the grid, where the bar would have been. */
  label: string;
  /** The whole story on hover — every reason, not only the one named. */
  title: string;
  /** Material is the named reason, so the placeholder is marked as such. */
  material: boolean;
}

/**
 * Why an order has no bar, and what the planner should do about it.
 *
 * Four different jobs: place the order it is waiting for, chase the material,
 * put people on it, or widen a crew window that runs out before the work does.
 * It used to say "no crew" to all of them, which sent the supervisor looking
 * for the one problem that was not there — orders were standing still for want
 * of foam with a label asking for people.
 *
 * Material is named ahead of crew because no crew can build what is not on the
 * shelf: putting three people on it changes nothing until the part arrives. It
 * is named behind a predecessor, though, because "waits on ASM8001" already
 * names the shortage *and* who is clearing it. Whatever the label says, the
 * hover carries every reason that applies, so naming one never hides another.
 */
export function missingBarReason(row: OrderRow): MissingBar {
  const held = row.waitingOn ? jobNumOf(String(row.waitingOn.onJobId)) : null;
  const short = row.shortPicks ?? [];
  const unstaffed = row.workers.length === 0;

  if (held) {
    return {
      label: `waits on ${held}`,
      title:
        `Waiting on ${held}, which has no finish date of its own — it is ` +
        'either unstaffed or on no line yet',
      material: false,
    };
  }

  if (short.length > 0) {
    const worst = short[0];
    const rest = short.length - 1;
    return {
      label: 'short material',
      title:
        `${short.length} line${short.length === 1 ? '' : 's'} of the pick ` +
        'list cannot be covered by what is on hand — ' +
        `${String(worst.part)} short ${worst.shortQty} (needs ` +
        `${worst.requiredQty}, ${worst.onHand} on hand)` +
        (rest > 0 ? ` and ${rest} more` : '') +
        (unstaffed ? '\nNo crew allocated either' : ''),
      material: true,
    };
  }

  return unstaffed
    ? {
        label: 'no crew',
        title: 'No crew allocated — cannot schedule',
        material: false,
      }
    : {
        label: 'not covered',
        title: 'The crew allocated to this order leaves before the work is done',
        material: false,
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
