/**
 * @dnd-kit wiring for the board. Bars move along the shift clock; lines and
 * the pool accept order moves. Worker and line-header drags have their own
 * targets. All mutations go through the plan store, which the selectors
 * re-derive into a fresh timeline.
 */

import { useState } from 'react';
import {
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { JobId } from '@/domain/ids';
import { POOL_ID, usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useUiStore } from '@/store/uiStore';
import { DEFAULT_DAY_WIDTH } from '@/store/uiStore';
import { DRAG_TYPE_BAR } from '@/features/assembly/OrderBar';
import { DRAG_TYPE_LINE } from '@/features/assembly/lineDrag';
import type { LineKey } from '@/domain/assembly';
import { isWeekend } from '@/engine/assembly/dates';
import { shiftOpensOn } from '@/engine/assembly/shift';
import { shiftTimelineKeepingClock } from './boardView';
import { barDragLanding } from './barDrag';
import { planGroupMove, type MarkedMove } from './groupMove';

/** Prefer whatever the pointer is actually inside, then the nearest. */
const collisionDetection: CollisionDetection = (args) => {
  // A worker must land inside a line, not snap to a distant row or the pool —
  // and a line being arranged can only land on another line.
  const type = args.active.data.current?.type;
  const linesOnly = type === 'worker' || type === DRAG_TYPE_LINE;
  const targets = linesOnly
    ? { ...args, droppableContainers: args.droppableContainers.filter(target => target.data.current?.type === 'line') }
    : args;
  const hits = pointerWithin(targets);
  return hits.length ? hits : linesOnly ? [] : closestCenter(targets);
};

export function useDragDrop() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null);
  const [activeBar, setActiveBar] = useState(false);
  const [activeLineName, setActiveLineName] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    // Bars and line rows carry a prefixed id; the overlay only wants plain job
    // cards, so everything with a type of its own is excluded by name.
    const type = e.active.data.current?.type;
    setActiveBar(type === DRAG_TYPE_BAR);
    setActiveWorkerId(
      type === 'worker' ? String(e.active.data.current?.workerId ?? '') : null,
    );
    setActiveLineName(
      type === DRAG_TYPE_LINE
        ? String(e.active.data.current?.lineName ?? '')
        : null,
    );
    setActiveJobId(
      type === DRAG_TYPE_BAR || type === 'worker' || type === DRAG_TYPE_LINE
        ? null
        : String(e.active.id),
    );
  };
  const onDragCancel = () => {
    setActiveBar(false);
    setActiveJobId(null);
    setActiveWorkerId(null);
    setActiveLineName(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveBar(false);
    setActiveJobId(null);
    setActiveWorkerId(null);
    setActiveLineName(null);
    const { over, active, delta } = e;

    /*
     * Nothing here is a view preference: every branch below writes to the plan
     * every screen on the floor is reading. The draggables are disabled while
     * the board is locked, so this is the backstop rather than the gate — but
     * it is the one place all of them come through, and a drop that wrote a
     * pinned start after the gate was somehow got past is exactly the write
     * that is hardest to notice afterwards.
     */
    if (!useSupervisorStore.getState().unlocked) return;

    if (active.data.current?.type === 'worker') {
      if (over?.data.current?.type !== 'line') return;
      const line = over.data.current.lineKey as LineKey | undefined;
      if (!line) return;
      usePlanStore
        .getState()
        .moveWorkerToLine(String(active.data.current.workerId), line);
      return;
    }

    /*
     * A line dropped on another line takes its place. Nothing about the
     * schedule moves — the orders, their crews and their days are where they
     * were — but the sequence is in the shared plan rather than in this
     * browser, because what order the floor runs its benches in is a fact
     * about the floor and not a preference of whoever is reading.
     */
    if (active.data.current?.type === DRAG_TYPE_LINE) {
      if (over?.data.current?.type !== 'line') return;
      const moved = active.data.current.lineKey as LineKey | undefined;
      const onto = over.data.current.lineKey as LineKey | undefined;
      if (!moved || !onto || moved === onto) return;
      usePlanStore.getState().moveLine(moved, onto);
      return;
    }

    // An assembly bar dragged along its own row moves its start day. Dragged
    // onto another line, it changes line as well — and that is the only thing
    // that moves a row off the one it is on. Rows never re-order themselves
    // because a bar was pushed out; the board is the planner's own layout.
    if (active.data.current?.type === DRAG_TYPE_BAR) {
      const jobId = JobId(String(active.data.current.jobId));
      const dayWidth = Number(active.data.current.dayWidth) || DEFAULT_DAY_WIDTH;
      const showWeekends = active.data.current.showWeekends === true;
      /*
       * How far the pointer went, in columns — and a column is a shift, so two
       * thirds of one is two thirds of a shift rather than a rounding error.
       * This used to be `Math.round`, which is why a bar could not be put back
       * where it came from: every drag landed on a whole day and every pinned
       * order therefore began at 07:00.
       */
      const columns = (delta?.x ?? 0) / dayWidth;
      const dayShift = Math.round(columns);

      const { orderStarts, setOrderStart, setOvertime, containerOf, moveJob } =
        usePlanStore.getState();
      const key = String(jobId);
      if (usePlanStore.getState().orderActualStarts[key]) return;

      // Dropped on the strip at the bottom: off the schedule altogether. The
      // strip says so, and it was the one thing it said that a bar could not
      // actually do. Nothing else is written — an order with no line has no
      // day to be pinned to.
      if (over?.data.current?.type === 'pool') {
        if (containerOf(jobId) !== POOL_ID) moveJob(jobId, POOL_ID);
        return;
      }

      const droppedOn =
        over?.data.current?.type === 'line'
          ? String(over.data.current.lineId)
          : null;
      if (droppedOn && droppedOn !== containerOf(jobId)) {
        moveJob(jobId, droppedOn);
      }
      if (columns === 0) return;

      /*
       * A set marked with Ctrl moves as one.
       *
       * Every marked order shifts by the same number of columns as the bar
       * under the pointer, each from where its own bar is drawn, and the shape
       * then comes to rest on the earliest days it may legally take — see
       * `planGroupMove`. A weekend landing is pulled to the Monday rather than
       * asking: a bulk move is a re-plan of a run of work, not a decision about
       * overtime on one order, and a prompt per order would be unanswerable.
       * Only the dragged bar can change line — dropping a set on a lane and
       * having all of it jump there is not what the pointer said.
       */
      const marks = (active.data.current.moveWith ?? []) as MarkedMove[];
      if (marks.length > 1 && marks.some((m) => m.jobId === key)) {
        for (const landed of planGroupMove(marks, dayShift, showWeekends)) {
          setOvertime(JobId(landed.jobId), false);
          setOrderStart(JobId(landed.jobId), landed.startISO);
        }
        return;
      }

      // Move from where the bar is drawn, to the minute. The pinned start is
      // only a request — the line's capacity, a predecessor or a weekend may
      // have pushed the bar past it, and dragging from the pin would then snap
      // it backwards.
      const drawn = active.data.current.startISO as string | null | undefined;
      const from = drawn
        ? new Date(drawn)
        : orderStarts[key]
          ? new Date(orderStarts[key])
          : shiftOpensOn(new Date());
      const moved = barDragLanding({
        jobId: key, startISO: from.toISOString(), dayWidth, showWeekends,
        floorISO: active.data.current.floorISO as string | null | undefined,
      }, delta?.x ?? 0);

      // It cannot go where it was asked, and it is already as early as it can
      // be: write nothing. Pinning is not free — a pinned order stops falling
      // in behind its crew and its predecessor — and paying that for a drag
      // that moved nothing is how a board ends up pinned order by order
      // without anybody choosing it. The bar's own stop marker says what is
      // holding it. "Nothing" is a landing step rather than an exact match:
      // below five minutes there is no move to write.
      if (moved.getTime() === from.getTime()) return;

      // The factory is shut at the weekend. Ask before writing work into one;
      // nothing changes until the supervisor answers.
      if (isWeekend(moved)) {
        useUiStore.getState().askOvertime({
          jobId: key,
          atISO: moved.toISOString(),
          // The same time of day on the Monday: saying "not the weekend then"
          // should not also move the order to the open of the shift.
          nextWorkingISO: shiftTimelineKeepingClock(
            moved,
            1,
            false,
          ).toISOString(),
        });
        return;
      }

      // Back onto a weekday: whatever overtime was approved is no longer
      // needed, so it lapses rather than quietly following the order around.
      setOvertime(jobId, false);
      setOrderStart(jobId, moved.toISOString());
      return;
    }

    if (!over) return;

    // Dropped on a lane or the pool → append. Ordering within a lane is the
    // planner's own, set by dragging a bar, not by dropping a card on another.
    usePlanStore.getState().moveJob(JobId(String(active.id)), String(over.id));
  };

  return {
    sensors,
    activeJobId,
    activeBar,
    activeWorkerId,
    activeLineName,
    onDragStart,
    onDragEnd,
    onDragCancel,
    collisionDetection,
  };
}
