import { formatDay } from '@/lib/time';
/**
 * A person's name in the board header, with their week of work behind it.
 *
 * The supervisor's question at the top of the board is "who has room?", which
 * the crew chips on the rows cannot answer — those show one order at a time.
 * Five squares beside the name answer it at a glance, one per working day in
 * the same green/orange/red bands as the day columns; clicking opens the full
 * view, the same hours totalled per day across every order the person is on.
 */

import { useDraggable } from '@dnd-kit/core';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '@/store/uiStore';
import type { LineKey, Worker } from '@/domain/assembly';
import {
  dayBand,
  loadPreview,
  type WorkerLoad,
} from '@/engine/assembly/workload';


const hrs = (n: number): string => `${n.toFixed(1)} h`;

export function WorkerLoadChip({
  worker,
  load,
  line,
  dragDisabled,
}: {
  worker: Worker;
  /** This person's week, computed once for the whole roster by the board. */
  load: WorkerLoad;
  line: LineKey;
  dragDisabled: boolean;
}) {
  // One person's week at a time, and in the store rather than here: Escape
  // has to know this is open to decide whether it is the thing to close.
  const openWorkerId = useUiStore((s) => s.workerLoadId);
  const setWorkerLoad = useUiStore((s) => s.setWorkerLoad);
  const open = openWorkerId === String(worker.id);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const wrap = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `worker:${String(worker.id)}`,
    disabled: dragDisabled,
    data: { type: 'worker', workerId: String(worker.id), line },
  });

  const workingDays = load.days.filter((day) => day.working).slice(0, 5);
  const totalHours = workingDays.reduce((sum, day) => sum + day.hours, 0);
  const capacityHours = workingDays.reduce(
    (sum, day) => sum + day.capacity,
    0,
  );
  const orderCount = new Set(
    workingDays.flatMap((day) => day.entries.map((entry) => String(entry.jobId))),
  ).size;
  const overloadedDays = workingDays.filter((day) => day.over).length;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = anchor.current;
      const panel = popup.current;
      if (!button || !panel) return;
      const gap = 8;
      const margin = 12;
      const target = button.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      let left = target.left;
      if (left + box.width > window.innerWidth - margin) {
        left = target.right - box.width;
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
      let top = target.bottom + gap;
      if (top + box.height > window.innerHeight - margin) {
        top = target.top - box.height - gap;
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
      setPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, worker.id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      // The button lives inside the wrapper too, so clicking it again toggles
      // rather than closing and immediately reopening.
      const target = e.target as Node;
      if (
        !wrap.current?.contains(target) &&
        !popup.current?.contains(target)
      ) setWorkerLoad(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setWorkerLoad]);

  const pct = capacityHours
    ? Math.round((totalHours / capacityHours) * 100)
    : 0;
  const preview = loadPreview(load);

  /** What one square means, spelled out for the hover. */
  const dayTitle = (day: (typeof preview)[number]): string => {
    const when = formatDay(day.date);
    if (day.capacity <= 0) {
      return day.hours > 0
        ? `${when} — ${hrs(day.hours)} booked on a day off`
        : `${when} — planned leave`;
    }
    if (day.hours <= 0) return `${when} — free`;
    // Spell out what the colour means: full is not the same as over, and the
    // board books a whole shift to anyone it puts on an order.
    const state =
      day.dot === 'red'
        ? 'more than a full shift'
        : day.dot === 'orange'
          ? 'full'
          : 'room for more';
    return (
      `${when} — ${hrs(day.hours)} of ${hrs(day.capacity)} ` +
      `(${Math.round(day.pct)}%, ${state})`
    );
  };

  return (
    <span className="worker-load-anchor" ref={wrap}>
      <button
        ref={(node) => {
          anchor.current = node;
          setNodeRef(node);
        }}
        type="button"
        className={`worker-name ${open ? 'open' : ''} ${isDragging ? 'dragging' : ''} ${dragDisabled ? 'drag-locked' : ''}`}
        aria-expanded={open}
        aria-label={`${worker.name} — ${pct}% booked over ${preview.length} working days`}
        title={
          dragDisabled
            ? `${worker.name} — load details; unlock Supervisor and finish started work before moving lines`
            : `${worker.name} — click for load, drag to another production line`
        }
        onClick={() => setWorkerLoad(open ? null : String(worker.id))}
        {...listeners}
        {...attributes}
      >
        {worker.name}
        {/* One square per working day. Decorative for a screen reader — the
            button's label already carries the number. */}
        <span className="wl-dots" aria-hidden="true">
          {preview.map((day) => (
            <i key={day.key} className={`wl-dot ${day.dot}`} title={dayTitle(day)} />
          ))}
        </span>
      </button>

      {open && createPortal(
        <div
          ref={popup}
          className="worker-load"
          role="dialog"
          aria-label={`${worker.name} work load`}
          style={position}
        >
          <header className="wl-head">
            <strong>{worker.name}</strong>
            <span className="wl-sub">
              {[
                worker.position,
                `line ${line}`,
                worker.supervisor && `reports to ${worker.supervisor}`,
              ]
                .filter(Boolean)
                .join(' — ')}
            </span>
            <button
              type="button"
              className="wl-close"
              aria-label="Close"
              onClick={() => setWorkerLoad(null)}
            >
              ×
            </button>
          </header>

          <div className="wl-summary">
            <span>
              <b>{hrs(totalHours)}</b> booked
            </span>
            <span>of {hrs(capacityHours)}</span>
            <span className={`wl-pct ${pct > 100 ? 'over' : ''}`}>{pct}%</span>
            <span>
              {orderCount} order{orderCount === 1 ? '' : 's'}
            </span>
          </div>

          <ol className="wl-days">
            {workingDays.map((day) => {
              const over = day.over;
              // Same bands as the squares, so the two views of one week can
              // never read differently.
              const band = dayBand(day);
              const fill = day.capacity
                ? Math.min(100, (day.hours / day.capacity) * 100)
                : day.hours > 0
                  ? 100
                  : 0;
              return (
                <li
                  key={day.key}
                  className={`${day.onLeave ? 'leave' : ''} ${
                    // A closed day recedes — unless work landed on it, which
                    // is the one weekend case worth looking at.
                    day.working ? '' : day.hours > 0 ? 'overtime' : 'closed'
                  }`}
                >
                  <span className="wl-day">{formatDay(day.date)}</span>
                  <span className="wl-meter">
                    <i className={band} style={{ width: `${fill}%` }} />
                  </span>
                  <span className={`wl-hours ${over ? 'over' : ''}`}>
                    {day.hours > 0 ? hrs(day.hours) : '—'}
                  </span>
                  <span className="wl-orders">
                    {day.entries.length > 0
                      ? // The order number first: it is what the supervisor
                        // says out loud and what they look up. Two orders for
                        // the same part are told apart by nothing else.
                        day.entries
                          .map(
                            (e) =>
                              `${String(e.jobId)} · ${e.line} · ${e.description}`,
                          )
                          .join('  |  ')
                      : day.onLeave
                        ? 'planned leave'
                        : day.working
                          ? 'free'
                          : 'factory closed'}
                  </span>
                </li>
              );
            })}
          </ol>

          {overloadedDays > 0 && (
            <p className="wl-warn">
              Booked past a full shift on {overloadedDays} day
              {overloadedDays === 1 ? '' : 's'} — they are on more than one
              order at once or on leave.
            </p>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
