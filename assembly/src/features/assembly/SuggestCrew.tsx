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
import {
  countUnstaffed,
  crewSkipReason,
  skippedByRules,
  suggestCrew,
  type CrewSuggestion,
} from '@/engine/assembly/crew';
import type { LineKey } from '@/domain/assembly';
import { jobNumOf } from '@/domain/routing';
import { CrewRulesEditor, describeCrewRules, skipLabel } from './CrewRulesEditor';
import { recomputeAssemblyGantt } from '@/store/assemblySelectors';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { Button } from '@/ui';
import { lineOfWorkerToday } from './boardView';

export function ReviewOrders({
  board,
  open: openPanel,
  onOpen,
}: {
  board: AssemblyGanttView | null;
  /** Which figure on the row is open — the header owns the state so two
   *  panels can never hang off it at once. */
  open?: string | null;
  onOpen?: (name: string | null) => void;
}) {
  const assignCrews = usePlanStore((s) => s.assignCrews);
  const workerLineOverrides = usePlanStore((s) => s.workerLines);
  const rules = usePlanStore((s) => s.crewRules);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const open = openPanel === 'review';
  const [showRules, setShowRules] = useState(false);
  /** What the last press did, said once under the button. */
  const [report, setReport] = useState<Pick<CrewSuggestion, 'staffed' | 'left'> | null>(null);

  const ignoredIds = useIgnoredOrders((s) => s.ids);
  const ignore = useIgnoredOrders((s) => s.ignore);
  const restore = useIgnoredOrders((s) => s.restore);
  const candidates = board ? withoutIgnoredOrders(board, ignoredIds) : null;
  const waiting = candidates ? countUnstaffed(candidates, rules) : 0;
  const skipped = candidates ? skippedByRules(candidates, rules) : null;
  const skippedCount = skipped ? Object.values(skipped).reduce((n, ids) => n + ids.length, 0) : 0;
  // Nothing to say when every order already has its people.
  if (!board) return null;
  const lineName = (key: LineKey) => board.groups.find((g) => g.line.key === key)?.line.name ?? key;
  const ruleLines = board.groups
    .map((g) => g.line)
    .filter((line) => line.schedulable && !line.parent && line.key !== 'FACTORY_GENERAL');
  const pending = board.groups.filter((g) => g.line.schedulable).flatMap((g) => g.rows)
    .filter((r) => r.workers.length === 0 && !r.completedToday && remainingQty(r.job) > 0 && remainingHours(r.job) > 0);
  const jobs = new Map([...board.pool, ...pending.map((r) => r.job)].map((job) => [String(job.id), job]));
  for (const id of ignoredIds) {
    const row = board.rowsByJob.get(id);
    if (row) jobs.set(id, row.job);
  }
  if (waiting === 0 && ignoredIds.length === 0 && skippedCount === 0) return null;

  const crewThem = () => {
    const rows = board.groups.flatMap((group) => group.rows);
    const workerLines = lineOfWorkerToday(
      board.workers,
      rows,
      board.today,
      workerLineOverrides,
    );
    const result = suggestCrew(
      withoutIgnoredOrders(board, ignoredIds),
      (soFar) => withoutIgnoredOrders(recomputeAssemblyGantt(soFar) ?? board, ignoredIds),
      workerLines,
      rules,
    );
    assignCrews(result.allocations);
    setReport({ staffed: result.staffed, left: result.left });
  };
  const reasonOf = (id: string) => {
    const row = board.rowsByJob.get(id);
    const reason = row && row.workers.length === 0 ? crewSkipReason(row, rules, board.today) : null;
    return reason ? skipLabel(reason, rules) : null;
  };
  const ids = [...new Set([...jobs.keys(), ...ignoredIds])];
  // The orders the rules leave alone go last: they are not waiting on anybody.
  const listed = [...ids.filter((id) => !reasonOf(id)), ...ids.filter((id) => reasonOf(id))];

  return (
    <div className="metric-slot review-orders">
      <button
        className={`metric review-open${open ? ' active' : ''}`}
        aria-expanded={open}
        onClick={() => onOpen?.(open ? null : 'review')}
        title={
          `${waiting} order${waiting === 1 ? '' : 's'} with nobody on them that Crew orders will crew` +
          (skippedCount > 0 ? ` · ${skippedCount} left alone by the crew rules` : '') +
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
        <div className="metric-panel review-panel">
          <div className="review-actions">
            {waiting > 0 && (
              <Button
                onClick={crewThem}
                disabled={!unlocked}
                title={
                  unlocked
                    ? `Crew ${waiting} unstaffed orders from their current production-line rosters, ` +
                      'forward from today, by the crew rules: nearest Due Date band first, ' +
                      'and within each the least slack to its Due Date; skills and trades, then nobody ' +
                      'away while it runs, then whoever is free soonest. ' +
                      'A smaller crew if the line has fewer people. Existing crews stay unchanged. ' +
                      'Busy workers queue behind existing work; conflicting suggestions are removed.'
                    : 'Allocating crew needs the supervisor password'
                }
              >
                Crew {waiting} orders
              </Button>
            )}
            <button
              className={`review-rules-toggle${showRules ? ' on' : ''}`}
              aria-expanded={showRules}
              onClick={() => setShowRules(!showRules)}
            >
              Crew rules {showRules ? '▾' : '▸'}
            </button>
          </div>
          {report && (
            <p className="metric-note review-report">
              Crewed {report.staffed} order{report.staffed === 1 ? '' : 's'}.
              {report.left.length > 0 &&
                ` ${report.left.length} still waiting — nobody on the line's roster free with the trade: ` +
                  report.left.slice(0, 6).map((id) => jobNumOf(id)).join(', ') +
                  (report.left.length > 6 ? ` +${report.left.length - 6}` : '') +
                  '.'}{' '}
              Check and Save.
            </p>
          )}
          {!showRules && <p className="metric-note">Rules: {describeCrewRules(rules, lineName)}.</p>}
          {showRules && <CrewRulesEditor lines={ruleLines} />}
          <ul>
            {listed.map((id) => (
              <li key={id} className={reasonOf(id) ? 'is-skipped' : undefined}>
                <span title={jobs.get(id)?.description}>
                  {id}
                  {ignoredIds.includes(id) ? ' · Ignored' : ''}
                  {reasonOf(id) && <i> · {reasonOf(id)}</i>}
                </span>
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
