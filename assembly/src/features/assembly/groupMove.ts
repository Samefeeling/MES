/**
 * Where a Ctrl-marked run of orders lands when one of its bars is dragged.
 *
 * A marked set is one shape, and it stays one shape: every order shifts by the
 * same number of columns as the bar under the pointer, so the run keeps the
 * spacing the planner gave it. What this adds is that the shape then comes to
 * rest on the earliest columns it may legally take. Each order carries the day
 * it may not begin before — today, a predecessor outside the set still running,
 * material that only lands on a later PO — and whichever of them needs the
 * biggest push gets it for all of them.
 *
 * So a run dragged a fortnight into the past butts up against today in the
 * formation it left, rather than piling its leading orders onto today's column
 * while the rest stay where the pointer put them. And a run with one order
 * already hard against its predecessor will not move earlier at all: it cannot,
 * and saying so by not moving is clearer than moving the other two and leaving
 * the set in a shape nobody chose.
 *
 * Orders inside the set need no floor from each other. They all move by the
 * same amount, so how they stand relative to one another is exactly what it was
 * before the drag.
 */

import { isWeekend, nextWorkingDay, startOfDay } from '@/engine/assembly/dates';
import { shiftTimelineDays } from './boardView';

/** One order in the marked set, and what it may not begin before. */
export interface MarkedMove {
  jobId: string;
  /** Where its bar is drawn now — a relative move starts from what is on screen. */
  startISO: string;
  /**
   * The earliest day it may begin, for reasons outside the set. Null when
   * nothing holds it.
   */
  floorISO: string | null;
}

/** The parts of a board row that decide whether, and how far, it may move. */
export interface MovableRow {
  job: { id: string };
  start?: Date | null;
  actualStart?: unknown;
  expectDate?: Date | null;
  material: { earliestStart?: Date | null };
  predecessors: readonly { onJobId: string }[];
}

/**
 * The marked orders a drag should carry, and the earliest day each may take.
 *
 * `rows` is the whole board, not what the window is showing. A filter that
 * hides a marked order does not unmark it, and moving the rest without it
 * would leave the run in exactly the broken shape a marked set exists to
 * prevent — so membership follows the marks, not the viewport.
 *
 * A predecessor inside the set contributes no floor: it is about to move by
 * the same number of columns, so where it finishes relative to this order is
 * what it already was. Predecessors outside the set are looked up across the
 * whole board, since an order can be held by a press job or by one scrolled
 * out of the window.
 */
export function markedSet(
  rows: readonly MovableRow[],
  markedIds: ReadonlySet<string>,
  today: Date,
): MarkedMove[] {
  const everyRow = new Map(rows.map((row) => [String(row.job.id), row] as const));
  const movable = [...everyRow.values()].filter(
    (row) => markedIds.has(String(row.job.id)) && row.start && !row.actualStart,
  );
  const moving = new Set(movable.map((row) => String(row.job.id)));
  return movable.map((row) => {
    const floors: Date[] = [today];
    if (row.material.earliestStart) floors.push(row.material.earliestStart);
    for (const dependency of row.predecessors) {
      const id = String(dependency.onJobId);
      if (moving.has(id)) continue;
      const finish = everyRow.get(id)?.expectDate;
      if (finish) floors.push(finish);
    }
    return {
      jobId: String(row.job.id),
      startISO: row.start!.toISOString(),
      floorISO: floors.reduce((a, b) => (b > a ? b : a)).toISOString(),
    };
  });
}

/** Guards the column walk against a floor years out on a bad export. */
const LIMIT = 400;

/** How many timeline columns it takes to get from `from` up to `to`. */
function columnsBetween(from: Date, to: Date, showWeekends: boolean): number {
  let cursor = startOfDay(from);
  const target = startOfDay(to);
  for (let columns = 0; columns < LIMIT; columns++) {
    if (cursor >= target) return columns;
    cursor = shiftTimelineDays(cursor, 1, showWeekends);
  }
  return LIMIT;
}

/**
 * Weekends are shut unless overtime is approved, and a bulk move is not where
 * that gets decided — so a bar landing on one opens on the Monday. With weekend
 * columns hidden this never fires: the column axis has no weekends on it.
 */
const onShift = (day: Date): Date =>
  isWeekend(day) ? startOfDay(nextWorkingDay(day)) : startOfDay(day);

/**
 * The day each marked order that is actually moving should be pinned to.
 *
 * Orders the move leaves on the day they are already drawn on are left out
 * rather than pinned where they stand. Pinning is not free: an order held to a
 * day begins at the open of that shift instead of the hour its crew or its
 * predecessor freed it, and it stops following that predecessor about. None of
 * that should happen to an order the planner has not moved — and a set that
 * cannot move at all is then a set nothing is written for.
 */
export function planGroupMove(
  orders: readonly MarkedMove[],
  dayShift: number,
  showWeekends: boolean,
): { jobId: string; startISO: string }[] {
  if (orders.length === 0) return [];

  // Where the drag alone would put each of them, before anything says no.
  const asked = orders.map((order) =>
    startOfDay(
      shiftTimelineDays(
        startOfDay(new Date(order.startISO)),
        dayShift,
        showWeekends,
      ),
    ),
  );

  // The furthest any one of them has to be pushed to sit somewhere legal.
  let push = 0;
  orders.forEach((order, index) => {
    if (!order.floorISO) return;
    const floor = startOfDay(new Date(order.floorISO));
    if (floor <= asked[index]) return;
    const need = columnsBetween(asked[index], floor, showWeekends);
    if (need > push) push = need;
  });

  return orders.flatMap((order, index) => {
    const landing = onShift(
      push === 0
        ? asked[index]
        : shiftTimelineDays(asked[index], push, showWeekends),
    );
    const drawn = startOfDay(new Date(order.startISO));
    if (landing.getTime() === drawn.getTime()) return [];
    return [{ jobId: order.jobId, startISO: landing.toISOString() }];
  });
}
