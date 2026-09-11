import { useState } from 'react';
import { useDndMonitor, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { formatDay } from '@/lib/time';
import { DRAG_TYPE_BAR } from './OrderBar';
import { barDragLanding, type BarDragData } from './barDrag';
import { timelineDayOffset } from './boardView';
const TIME = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

export function DragTimeGuide({ horizonStart, labelWidth }: { horizonStart: Date; labelWidth: number }) {
  const [guide, setGuide] = useState<{ at: Date; left: number } | null>(null);
  const update = (event: DragMoveEvent | DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type !== DRAG_TYPE_BAR || !data.startISO) return;
    const at = barDragLanding(data as BarDragData, 'delta' in event ? event.delta.x : 0);
    setGuide({ at, left: labelWidth + timelineDayOffset(at, horizonStart, data.showWeekends === true) * Number(data.dayWidth) });
  };
  useDndMonitor({ onDragStart: update, onDragMove: update, onDragEnd: () => setGuide(null), onDragCancel: () => setGuide(null) });
  return guide ? <div className="drag-time-guide" style={{ left: guide.left }} aria-hidden="true"><span>{formatDay(guide.at)} {TIME.format(guide.at)}</span></div> : null;
}
