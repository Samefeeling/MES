/**
 * Assembly orders not on a line yet. Drop an order here to take it off the
 * schedule, and drag one out of here onto a line to put it back.
 *
 * When every order is on a line, the target is a hidden overlay near the
 * timeline header. Dragging reveals it without reserving an empty footer
 * or moving the last row away from the pointer.
 *
 * Something ends up here for two reasons, and both need a way out of it. The
 * planner put it here; or the export named a line the board does not know, in
 * which case the order is not merely unplaced but invisible — and anything
 * waiting on its parts is held with no date at all until it is placed.
 */

import { useEffect, useRef } from 'react';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { Job } from '@/domain/types';
import { ORDER_TYPE_SHORT } from '@/domain/assembly';
import { POOL_ID, homeLineOf, usePlanStore } from '@/store/planStore';
import { JobId } from '@/domain/ids';
import { useUiStore } from '@/store/uiStore';
import { useIgnoredOrders } from '@/store/ignoredOrders';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { DRAG_TYPE_BAR } from './OrderBar';
import { jobNumOf } from '@/domain/routing';
import { formatDay } from '@/lib/time';

function PoolCard({
  job,
  home,
  selected,
  onSelect,
}: {
  job: Job;
  /** The line this order belongs on, by name — null when nothing names one. */
  home: string | null;
  selected: boolean;
  onSelect: (id: string, at?: { x: number; y: number }) => void;
}) {
  const id = String(job.id);
  // Asked for in the Order heading's finder: picked out, and brought into view
  // along the strip each time it is asked for.
  const found = useUiStore((s) => s.foundOrder !== null && s.foundOrder === jobNumOf(id));
  const findCount = useUiStore((s) => s.findCount);
  const card = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (found) card.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [found, findCount]);
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
      ref={(node) => {
        setNodeRef(node);
        card.current = node;
      }}
      className={`ord ${selected ? 'selected' : ''} ${found ? 'found' : ''} ${isDragging ? 'dragging' : ''} ${
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
      {/* Why it is here. Everything with a line is filed by itself, so an
          order in this strip is one of exactly two things — and they want
          different answers. */}
      <div
        className={`ord-why ${home ? 'by-hand' : ''}`}
        title={
          home
            ? `Taken off ${home} by hand. It stays here until it is dragged back onto a line.`
            : 'Nothing names a line for this order: not ERP, the routing table, the BOM or an order type.'
        }
      >
        {home ? `Off ${home} by hand` : 'No line known'}
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
  const unlocked = useSupervisorStore((s) => s.unlocked);
  // Line names as the board draws them; a bench under its lane, because
  // "Foaming" alone does not say whose.
  const lineNames = new Map(
    board.groups.map((group) => {
      const lane = group.line.parent
        ? board.groups.find((held) => held.line.key === group.line.parent)?.line.name
        : null;
      return [String(group.line.id), lane ? `${lane} › ${group.line.name}` : group.line.name];
    }),
  );
  const homeOf = (job: Job): { key: string; name: string } | null => {
    const key = homeLineOf(job);
    const name = key ? lineNames.get(key) : undefined;
    return key && name ? { key, name } : null;
  };
  const offByHand = pool.filter((job) => homeOf(job));
  const putBack = () => {
    const { moveJob } = usePlanStore.getState();
    for (const job of offByHand) moveJob(JobId(String(job.id)), homeOf(job)!.key);
  };
  // The empty target is outside layout flow, including during a drag.

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
            {offByHand.length > 0 && (
              <button
                className="pool-put-back"
                disabled={!unlocked}
                onClick={putBack}
                title={
                  `${offByHand.length} of these ${offByHand.length === 1 ? 'has' : 'have'} a line and ` +
                  `${offByHand.length === 1 ? 'was' : 'were'} taken off it by hand. Put ` +
                  `${offByHand.length === 1 ? 'it' : 'them'} back.`
                }
              >
                Put {offByHand.length} back on {offByHand.length === 1 ? 'its line' : 'their lines'}
              </button>
            )}
          </h2>
          {pool.map((job) => (
            <PoolCard
              key={String(job.id)}
              job={job}
              home={homeOf(job)?.name ?? null}
              selected={selectedJobId === String(job.id)}
              onSelect={select}
            />
          ))}
        </div>
      )}
    </div>
  );
}
