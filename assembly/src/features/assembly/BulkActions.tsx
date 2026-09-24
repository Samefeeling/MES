/**
 * Right-click on an order: Start production or Job completed, for it or for
 * every order Ctrl has marked.
 *
 * Two steps, never one. The menu picks the action; a confirmation then lists
 * each order and what will happen to it — or why it is left out — before
 * anything is written. Starting and closing are the two bookings on this
 * board that release crew and stamp the clock, and a batch of them is not
 * something to do on a stray click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderRow } from '@/engine/assembly/board';
import { jobNumOf } from '@/domain/routing';
import { toDayKey } from '@/lib/time';
import { usePlanStore } from '@/store/planStore';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { useUiStore } from '@/store/uiStore';
import {
  planComplete,
  planStart,
  startRecord,
  type BulkAction,
} from './bulkPlan';

const TITLE: Record<BulkAction, string> = {
  start: 'Start production',
  complete: 'Job completed',
};

const label = (row: OrderRow): string =>
  row.job.operation
    ? `${jobNumOf(String(row.job.id))} #${row.job.operation.seq}`
    : jobNumOf(String(row.job.id));

/** Closes on a press outside it, or Esc. */
function useDismiss(box: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      // Marked as handled, so the board's own Escape (which would let go of
      // the marked orders too) leaves this press alone.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    // Next tick: the press that opened it is still travelling.
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', down);
      document.addEventListener('keydown', key);
    });
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [box, onClose]);
}

export function BulkActions({
  ids,
  at,
  rows,
  onClose,
}: {
  /** Row ids the menu acts on. */
  ids: string[];
  at: { x: number; y: number };
  rows: readonly OrderRow[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onClose);
  const [action, setAction] = useState<BulkAction | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const production = usePlanStore((s) => s.production);
  const startOrder = usePlanStore((s) => s.startOrder);
  const saveProductionEntry = usePlanStore((s) => s.saveProductionEntry);
  const clearMarks = useUiStore((s) => s.clearMarks);
  const marked = useUiStore((s) => s.marked);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));

  const chosen = useMemo(() => {
    const byId = new Map(rows.map((r) => [String(r.job.id), r]));
    return ids.map((id) => byId.get(id)).filter((r): r is OrderRow => Boolean(r));
  }, [ids, rows]);
  const today = toDayKey(new Date());
  const start = useMemo(() => planStart(chosen, production), [chosen, production]);
  const complete = useMemo(
    () => planComplete(chosen, production, today, new Date().toISOString()),
    [chosen, production, today],
  );

  const reason = overrideReason.trim();
  const overriding = unlocked && reason !== '' ? start.override : [];
  const count =
    action === 'start'
      ? start.ready.length + overriding.length
      : action === 'complete'
        ? complete.ready.length
        : 0;

  const run = () => {
    if (action === 'start') {
      const startedAt = new Date().toISOString();
      for (const row of start.ready) startOrder(row.job.id, startRecord(row, today, startedAt, null));
      for (const { row } of overriding) {
        startOrder(row.job.id, startRecord(row, today, startedAt, reason));
      }
      setDone(`Production started on ${count} ${count === 1 ? 'order' : 'orders'}.`);
    } else if (action === 'complete') {
      // Stamped now, not when the menu opened.
      const savedAt = new Date().toISOString();
      for (const { row, entry } of complete.ready) {
        saveProductionEntry(
          row.job.id,
          { ...entry, savedAt, completedAt: savedAt },
          {
            remainingQty: row.sourceRemainingQty ?? row.job.remainingQty,
            completedQty: row.sourceCompletedQty ?? row.job.completedQty,
          },
        );
      }
      setDone(`${count} ${count === 1 ? 'order' : 'orders'} completed. Crew released.`);
    }
    if (ids.some((id) => marked.includes(id))) clearMarks();
  };

  const width = action ? 400 : 230;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - (action ? 320 : 130)));
  const heading =
    chosen.length === 1 ? `Order ${label(chosen[0])}` : `${chosen.length} orders`;

  return (
    <div
      ref={box}
      className={`bulk-menu${action ? ' confirm' : ''}`}
      role={action ? 'dialog' : 'menu'}
      aria-label={action ? TITLE[action] : heading}
      style={{ left, top, width, maxHeight: `calc(100vh - ${top + 12}px)` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!action ? (
        <>
          <header>{heading}</header>
          <button
            type="button"
            role="menuitem"
            onClick={() => setAction('start')}
            disabled={chosen.length === 0}
          >
            Start production
            <span>{start.ready.length + start.override.length}/{chosen.length}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => setAction('complete')}
            disabled={chosen.length === 0}
          >
            Job completed
            <span>{complete.ready.length}/{chosen.length}</span>
          </button>
          {chosen.length === 1 && (
            <p className="bulk-hint">Ctrl + click orders to act on several at once.</p>
          )}
        </>
      ) : done ? (
        <>
          <header>{TITLE[action]}</header>
          <p className="bulk-done" role="status">{done}</p>
          <footer>
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </footer>
        </>
      ) : (
        <>
          <header>
            {TITLE[action]} · {heading}
          </header>
          <ul className="bulk-list">
            {action === 'start' &&
              start.ready.map((row) => (
                <li key={String(row.job.id)} className="ok">
                  <b>{label(row)}</b>
                  <span>starts now with {startRecord(row, today, '', null).operatorNames.join(', ')}</span>
                </li>
              ))}
            {action === 'start' &&
              start.override.map(({ row, reasons }) => (
                <li
                  key={String(row.job.id)}
                  className={overriding.length > 0 ? 'ok override' : 'held'}
                >
                  <b>{label(row)}</b>
                  <span>
                    {reasons.join(' · ')}
                    {overriding.length > 0
                      ? ' — started on override'
                      : unlocked
                        ? ' — enter an override reason to start it'
                        : ` — sign in as ${gate} to override`}
                  </span>
                </li>
              ))}
            {action === 'complete' &&
              complete.ready.map(({ row, entry, rebooks }) => (
                <li key={String(row.job.id)} className="ok">
                  <b>{label(row)}</b>
                  <span>
                    {entry.complete} complete today
                    {rebooks && ' · replaces today’s entry, keeping its other figures'}
                  </span>
                </li>
              ))}
            {(action === 'start' ? start.skipped : complete.skipped).map(({ row, reason: why }) => (
              <li key={String(row.job.id)} className="skip">
                <b>{label(row)}</b>
                <span>left out — {why}</span>
              </li>
            ))}
          </ul>
          {action === 'start' && start.override.length > 0 && unlocked && (
            <textarea
              className="production-input"
              value={overrideReason}
              placeholder="Supervisor override reason — applies to every order held by the start gate"
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          )}
          {action === 'complete' && complete.ready.length > 0 && (
            <p className="bulk-hint">
              Each order is closed with everything still owed booked as complete today, and its
              crew released — the same as ticking Job completed on it.
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" disabled={count === 0} onClick={run}>
              {TITLE[action]} ({count})
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
