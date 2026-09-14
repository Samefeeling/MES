import { DRAG_STEP_MINUTES, nextWorkingMoment } from '@/engine/assembly/shift';
import { landAfterDrag } from './boardView';
import { planGroupMove, type MarkedMove } from './groupMove';

export interface BarDragData {
  jobId: string;
  startISO: string;
  floorISO?: string | null;
  dayWidth: number;
  showWeekends: boolean;
  moveWith?: MarkedMove[];
}
/** Shared by the drop and its guide, so the displayed moment is the saved one. */
export function barDragLanding(data: BarDragData, dx: number): Date {
  const from = new Date(data.startISO);
  if (!Number.isFinite(dx) || !Number.isFinite(data.dayWidth) || data.dayWidth <= 0 || dx === 0) return from;
  const columns = dx / data.dayWidth;
  const marks = data.moveWith ?? [];
  if (marks.length > 1 && marks.some(mark => mark.jobId === data.jobId)) {
    const moved = planGroupMove(marks, Math.round(columns), data.showWeekends)
      .find(mark => mark.jobId === data.jobId);
    return moved ? new Date(moved.startISO) : from;
  }
  const asked = landAfterDrag(from, columns, data.showWeekends);
  const floor = nextWorkingMoment(data.floorISO ? new Date(data.floorISO) : new Date());
  const moved = asked < floor ? floor : asked;
  return Math.abs(moved.getTime() - from.getTime()) < DRAG_STEP_MINUTES * 60_000 ? from : moved;
}
