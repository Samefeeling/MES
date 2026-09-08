/**
 * @dnd-kit wiring for the board. Jobs are draggable; lanes, the pool, and other
 * job cards are drop targets. Dropping onto a lane/pool appends; dropping onto
 * a card inserts before it (re-ordering). All mutations go through the plan
 * store, which the selectors re-derive into a fresh timeline.
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
import { useUiStore } from '@/store/uiStore';
import { DEFAULT_DAY_WIDTH } from '@/store/uiStore';
import { DRAG_TYPE_BAR } from '@/features/assembly/OrderBar';
import type { LineKey } from '@/domain/assembly';
import {
  isWeekend,
  nextWorkingDay,
  startOfDay,
} from '@/engine/assembly/dates';
import { shiftTimelineDays } from './boardView';
import { planGroupMove, type MarkedMove } from './groupMove';
import { toDayKey } from '@/lib/time';

/** Prefer whatever the pointer is actually inside, then the nearest. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

export function useDragDrop() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    // Bars carry a prefixed id; the overlay only wants plain job cards.
    const type = e.active.data.current?.type;
    setActiveWorkerId(
      type === 'worker' ? String(e.active.data.current?.workerId ?? '') : null,
    );
    setActiveJobId(
      type === DRAG_TYPE_BAR || type === 'worker' ? null : String(e.active.id),
    );
  };
  const onDragCancel = () => {
    setActiveJobId(null);
    setActiveWorkerId(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveJobId(null);
    setActiveWorkerId(null);
    const { over, active, delta } = e;

    if (active.data.current?.type === 'worker') {
      if (over?.data.current?.type !== 'line') return;
      const line = over.data.current.lineKey as LineKey | undefined;
      if (!line) return;
      usePlanStore
        .getState()
        .moveWorkerToLine(String(active.data.current.workerId), line);
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
      const dayShift = Math.round((delta?.x ?? 0) / dayWidth);

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
      if (dayShift === 0) return;

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

      // Move from where the bar is drawn. The pinned day is only a request —
      // the line's capacity, a predecessor or a weekend may have pushed the
      // bar past it, and dragging from the pin would then snap it backwards.
      const drawn = active.data.current.startISO as string | null | undefined;
      const from = drawn
        ? startOfDay(new Date(drawn))
        : orderStarts[key]
          ? startOfDay(new Date(orderStarts[key]))
          : startOfDay(new Date());
      const moved = startOfDay(
        shiftTimelineDays(from, dayShift, showWeekends),
      );

      // The factory is shut at the weekend. Ask before writing work into one;
      // nothing changes until the supervisor answers.
      if (isWeekend(moved)) {
        useUiStore.getState().askOvertime({
          jobId: key,
          isoDay: toDayKey(moved),
          nextWorkingIsoDay: toDayKey(nextWorkingDay(moved)),
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
    activeWorkerId,
    onDragStart,
    onDragEnd,
    onDragCancel,
    collisionDetection,
  };
}
