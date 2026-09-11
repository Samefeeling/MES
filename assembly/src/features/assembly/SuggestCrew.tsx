/**
 * "Review orders" — the orders waiting to be looked at, and the two things
 * that can be done about them.
 *
 * Two different queues used to sit side by side in the header. **Crew N
 * orders** counted the orders with nobody on them; **Review orders** was the
 * list of orders somebody had told the board to ignore. They are the same
 * question asked twice — which orders is this board not carrying yet — so they
 * are one chip with one count, and the button is inside it next to the list it
 * acts on.
 *
 * `Planning1.csv` says what to build, never who builds it, so every order
 * arrives with nobody on it and therefore with no bar at all. Crewing fills
 * them from each current production-line roster so the week has a shape to
 * argue with; see `engine/assembly/crew`. It is deliberately one explicit
 * click, gated by the same lock as allocating by hand — nothing is invented
 * behind the supervisor's back — and it never touches an order that is already
 * crewed.
 *
 * The suggestion is worked out on the click, not on every render: it staffs a
 * round, re-derives the whole board, and staffs the next against the dates
 * that came back, which is what keeps it from putting anyone on two orders at
 * once. That costs a few milliseconds a round and is far too much to repeat
 * behind a label.
 */

import { useState } from 'react';
import { useIgnoredOrders, withoutIgnoredOrders } from '@/store/ignoredOrders';
import { remainingHours, remainingQty } from '@/engine/assembly/duration';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { countUnstaffed, suggestCrew } from '@/engine/assembly/crew';
import { recomputeAssemblyGantt } from '@/store/assemblySelectors';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { Button } from '@/ui';
import { lineOfWorkerToday } from './boardView';

export function ReviewOrders({ board }: { board: AssemblyGanttView | null }) {
  const assignCrews = usePlanStore((s) => s.assignCrews);
  const workerLineOverrides = usePlanStore((s) => s.workerLines);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const [open, setOpen] = useState(false);

  const ignoredIds = useIgnoredOrders((s) => s.ids);
  const ignore = useIgnoredOrders((s) => s.ignore);
  const restore = useIgnoredOrders((s) => s.restore);
  const candidates = board ? withoutIgnoredOrders(board, ignoredIds) : null;
  const waiting = candidates ? countUnstaffed(candidates) : 0;
  // Nothing to say when every order already has its people.
  if (!board) return null;
  const pending = board.groups.filter((g) => g.line.schedulable).flatMap((g) => g.rows)
    .filter((r) => r.workers.length === 0 && !r.completedToday && remainingQty(r.job) > 0 && remainingHours(r.job) > 0);
  const jobs = new Map([...board.pool, ...pending.map((r) => r.job)].map((job) => [String(job.id), job]));
  for (const id of ignoredIds) {
    const row = board.rowsByJob.get(id);
    if (row) jobs.set(id, row.job);
  }
  if (waiting === 0 && ignoredIds.length === 0) return null;

  const crewThem = () => {
    const rows = board.groups.flatMap((group) => group.rows);
    const workerLines = lineOfWorkerToday(
      board.workers,
      rows,
      board.today,
      workerLineOverrides,
    );
    const { allocations } = suggestCrew(
      withoutIgnoredOrders(board, ignoredIds),
      (soFar) => withoutIgnoredOrders(recomputeAssemblyGantt(soFar) ?? board, ignoredIds),
      workerLines,
    );
    assignCrews(allocations);
  };

  return (
    <div className="review-orders">
      <button
        className={`metric review-open${open ? ' active' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={
          `${waiting} order${waiting === 1 ? '' : 's'} with nobody on them` +
          (ignoredIds.length > 0
            ? ` · ${ignoredIds.length} set aside`
            : '')
        }
      >
        <span className="metric-label">Review orders</span>
        <b className="metric-value">
          {waiting + ignoredIds.length}
          {open && <i> ×</i>}
        </b>
      </button>
      {open && (
        <div className="review-panel">
          {waiting > 0 && (
            <Button
              onClick={crewThem}
              disabled={!unlocked}
              title={
                unlocked
                  ? `Crew ${waiting} unstaffed orders from their current production-line rosters. ` +
                    'Prefer matching skills and trades, then availability. Remaining work: ' +
                    'up to 7.5 h: 1 person; over 7.5 h: 2; over 50 h: 3. Tables: 3. ' +
                    'Use a smaller crew if the line has fewer people. Existing crews stay unchanged. ' +
                    'Busy workers queue behind existing work; conflicting suggestions are removed.'
                  : 'Allocating crew needs the supervisor password'
              }
            >
              Crew {waiting} orders
            </Button>
          )}
          <ul>
            {[...new Set([...jobs.keys(), ...ignoredIds])].map((id) => (
              <li key={id}>
                <span title={jobs.get(id)?.description}>{id}{ignoredIds.includes(id) ? ' · Ignored' : ''}</span>
                <button disabled={!unlocked} onClick={() => ignoredIds.includes(id) ? restore(id) : ignore(id)}>
                  {ignoredIds.includes(id) ? 'Restore' : 'Ignore'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
