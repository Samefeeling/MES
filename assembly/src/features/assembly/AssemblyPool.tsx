/**
 * Assembly orders not on a line yet. Drop an order here to take it off the
 * schedule, and drag one out of here onto a line to put it back.
 *
 * When every order is on a line, a reserved bottom strip stays invisible
 * until an order is dragged. Revealing the target does not resize the board
 * or move the last row away from the pointer.
 *
 * Something ends up here for two reasons, and both need a way out of it. The
 * planner put it here; or the export named a line the board does not know, in
 * which case the order is not merely unplaced but invisible — and anything
 * waiting on its parts is held with no date at all until it is placed.
 */

import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { Job } from '@/domain/types';
import { ORDER_TYPE_SHORT } from '@/domain/assembly';
import { POOL_ID } from '@/store/planStore';
import { useUiStore } from '@/store/uiStore';
import { useIgnoredOrders } from '@/store/ignoredOrders';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { DRAG_TYPE_BAR } from './OrderBar';
import { formatDay } from '@/lib/time';

function PoolCard({
  job,
  selected,
  onSelect,
}: {
  job: Job;
  selected: boolean;
  onSelect: (id: string, at?: { x: number; y: number }) => void;
}) {
  const id = String(job.id);
  const ignore = useIgnoredOrders((s) => s.ignore);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));
  // Filing an unplaced order onto a line is the same decision as moving one
  // that is already on a board, and behind the same gate.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: !unlocked,
    data: { type: 'job', jobId: id },
  });
  return (
    <div
      ref={setNodeRef}
      className={`ord ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${
        unlocked ? '' : 'locked'
      }`}
      title={unlocked ? undefined : `Sign in as ${gate} to put this order on a line`}
      onClick={(e) => onSelect(id, { x: e.clientX, y: e.clientY })}
      {...listeners}
      {...attributes}
    >
      <div className="ord-head">
        <span className="ord-job">{id}</span>
        {job.orderType && (
          <span className="ord-type">{ORDER_TYPE_SHORT[job.orderType]}</span>
        )}
      </div>
      <button className="pool-ignore" disabled={!unlocked}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); ignore(id); }}
        title="Ignore this order on this browser; restore it from Review orders">Ignore</button>
      <div className="ord-desc">{job.description || String(job.partNum)}</div>
      <div className="ord-meta">
        <span>{job.remainingQty} pcs</span>
        <span>·</span>
        <span>due {job.dueDate ? formatDay(job.dueDate) : '—'}</span>
      </div>
    </div>
  );
}

export function AssemblyPool({ board }: { board: AssemblyGanttView }) {
  const { active } = useDndContext();
  const orderDragging = active?.data.current?.type === DRAG_TYPE_BAR || active?.data.current?.type === 'job';
  const { setNodeRef, isOver } = useDroppable({
    id: POOL_ID,
    data: { type: 'pool' },
    disabled: !orderDragging,
  });
  const select = useUiStore((s) => s.select);
  const selectedJobId = useUiStore((s) => s.selectedJobId);
  const ignoredIds = useIgnoredOrders((s) => s.ids);
  const pool = board.pool.filter((job) => !ignoredIds.includes(String(job.id)));
  const empty = pool.length === 0;
  // Reserve the empty strip before pointer-down so the last row never jumps.

  return (
    <div
      ref={setNodeRef}
      aria-hidden={empty && !orderDragging}
      className={`pool ${empty ? 'target-only' + (orderDragging ? '' : ' inactive') : ''} ${isOver ? 'drop-active' : ''}`}
    >
      {empty ? (
        <div className="pool-target">Drop here to take the order off its line</div>
      ) : (
        <div className="pool-list">
          <h2>
            {pool.length} order{pool.length === 1 ? '' : 's'} on no
            line — drag one onto a line to schedule it
          </h2>
          {pool.map((job) => (
            <PoolCard
              key={String(job.id)}
              job={job}
              selected={selectedJobId === String(job.id)}
              onSelect={select}
            />
          ))}
        </div>
      )}
    </div>
  );
}
