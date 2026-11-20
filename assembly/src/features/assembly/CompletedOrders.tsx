/**
 * "Who finished it?" — Epicor's finished orders of the last working day,
 * grouped by line in the board's own order, each offered with that line's
 * group on the board that day less anyone on leave, for the supervisor to
 * review and confirm — a line at a time, or all at once.
 *
 * It opens by itself once a session, the first time a signed-in supervisor
 * has orders in the window nobody has confirmed, and from the header chip at
 * any time. Typing or scanning an order number and pressing Enter confirms
 * that order with the names shown — the quick path for the common case where
 * the board already had the right crew on it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { shortDay } from '@/engine/assembly/completedJobs';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { unconfirmedCount, useCompletionStore, type CompletionItem } from '@/store/completionStore';
import { Button } from '@/ui';
import { usePlanStore } from '@/store/planStore';
import { confirmCompletion, groupByLine, loadCompletions } from './completions';

const windowText = (w: { from: string; to: string } | null): string =>
  !w ? '' : w.from === w.to ? shortDay(w.from) : `${shortDay(w.from)} – ${shortDay(w.to)}`;

const norm = (s: string): string => s.trim().toUpperCase();

/** Keep the dialog's data current with the board's own reads. */
export function useCompletions(board: AssemblyGanttView | null, readStamp: number | null): void {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const status = useCompletionStore((s) => s.status);
  const items = useCompletionStore((s) => s.items);
  const window = useCompletionStore((s) => s.window);
  const autoOpenedFor = useCompletionStore((s) => s.autoOpenedFor);
  const boardRef = useRef(board);
  boardRef.current = board;
  // Read again when the board fills in: the first board is drawn before the
  // saved plan is in, with no crew and, on the demo, no orders yet.
  const orders = board?.rowsByJob.size ?? -1;

  useEffect(() => {
    if (orders >= 0 && readStamp !== null && boardRef.current) void loadCompletions(boardRef.current);
  }, [orders, readStamp]);

  useEffect(() => {
    if (status !== 'ready' || !unlocked || !window) return;
    const key = `${window.from}|${window.to}`;
    if (autoOpenedFor === key || unconfirmedCount(items) === 0) return;
    useCompletionStore.setState({ open: true, autoOpenedFor: key });
  }, [status, unlocked, window, items, autoOpenedFor]);
}

/** The header chip: how many are waiting, and the way back into the dialog. */
export function CompletedOrdersChip() {
  const status = useCompletionStore((s) => s.status);
  const items = useCompletionStore((s) => s.items);
  const setOpen = useCompletionStore((s) => s.setOpen);
  if (status === 'idle' || status === 'off') return null;
  const waiting = unconfirmedCount(items);
  return (
    <button
      type="button"
      className={`completed-chip${waiting ? ' waiting' : ''}${status === 'failed' ? ' failed' : ''}`}
      onClick={() => setOpen(true)}
      title="Orders Epicor shows finished on the last working day, and who finished them"
    >
      ✓ Completed{status === 'failed' ? ' · not read' : waiting ? ` · ${waiting} to confirm` : items.length ? ` · ${items.length}` : ''}
    </button>
  );
}

function PeoplePicker({ item, board, locked }: { item: CompletionItem; board: AssemblyGanttView; locked: boolean }) {
  const setPeople = useCompletionStore((s) => s.setPeople);
  const chosen = new Set(item.people.map((p) => p.id || p.name));
  const roster = useMemo(
    () =>
      board.workers
        .map((w) => ({ id: String(w.id), name: w.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [board.workers],
  );
  const key = item.completion.key;
  return (
    <div className="completed-people">
      {item.people.map((p) => (
        <span key={p.id || p.name} className="completed-person">
          {p.name}
          {!locked && (
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => setPeople(key, item.people.filter((q) => q !== p))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!locked && (
        <select
          aria-label={`Add who finished ${item.completion.jobNum}`}
          value=""
          onChange={(e) => {
            const p = roster.find((r) => r.id === e.target.value);
            if (p) setPeople(key, [...item.people, p]);
          }}
        >
          <option value="">+ Add</option>
          {roster
            .filter((r) => !chosen.has(r.id) && !chosen.has(r.name))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      )}
      {item.people.length === 0 && locked && <span className="completed-none">—</span>}
      {!item.confirmed && (item.onLeave.length > 0 || item.offeredFrom !== 'line') && (
        <div className="completed-hint">
          {item.offeredFrom === 'order' && 'The board’s crew on this order (nobody grouped on this line). '}
          {item.offeredFrom === 'planning' && 'From ASSY_Planning (nobody grouped on this line). '}
          {item.offeredFrom === 'none' && 'Nobody grouped on this line — add who finished it. '}
          {item.onLeave.length > 0 && `On leave: ${item.onLeave.map((p) => p.name).join(', ')}`}
        </div>
      )}
    </div>
  );
}

/** Confirm every order with names in a list, unless it is already confirmed. */
const confirmEach = (items: readonly CompletionItem[]): void => {
  for (const item of items) {
    if (!item.confirmed && item.people.length > 0) void confirmCompletion(item.completion.key);
  }
};

export function CompletedOrdersDialog({ board }: { board: AssemblyGanttView | null }) {
  const open = useCompletionStore((s) => s.open);
  const setOpen = useCompletionStore((s) => s.setOpen);
  const s = useCompletionStore();
  const unlocked = useSupervisorStore((st) => st.unlocked);
  const gated = useSupervisorStore((st) => st.required) && !unlocked;
  const gate = signInAt(useSupervisorStore((st) => st.hosted));
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const lineOrder = usePlanStore((st) => st.lineOrder);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setNote(null);
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  if (!open || !board) return null;

  const q = norm(query);
  const shown = q ? s.items.filter((i) => norm(i.completion.jobNum).includes(q)) : s.items;
  const waiting = unconfirmedCount(s.items);

  const quickConfirm = () => {
    const exact = s.items.filter((i) => norm(i.completion.jobNum) === q);
    const hit = exact.length ? exact : shown;
    if (!q || hit.length === 0) {
      setNote(q ? `${query.trim()} is not among the finished orders.` : null);
      return;
    }
    if (hit.length > 1) {
      setNote(`${hit.length} orders match — type the whole number.`);
      return;
    }
    const item = hit[0];
    if (gated) return setNote(`Sign in as ${gate} to confirm.`);
    if (item.confirmed) return setNote(`${item.completion.jobNum} is already confirmed.`);
    if (item.people.length === 0) return setNote(`Add who finished ${item.completion.jobNum}, then confirm it.`);
    setNote(`${item.completion.jobNum} confirmed: ${item.people.map((p) => p.name).join(', ')}.`);
    setQuery('');
    void confirmCompletion(item.completion.key);
  };

  const confirmAll = () => confirmEach(s.items);
  const groups = groupByLine(board, shown, lineOrder);

  return (
    <div className="ot-backdrop" role="dialog" aria-modal="true" aria-labelledby="completed-title" onClick={() => setOpen(false)}>
      <div className="completed-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="completed-head">
          <h2 id="completed-title">
            Completed orders <span className="completed-window">{windowText(s.window)}</span>
          </h2>
          <button type="button" className="completed-close" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <p className="ot-note">
          Finished in Epicor (CompletedJobs.csv), PMD excepted, grouped by line. Each order offers its line’s group on
          the board that day, less anyone on leave — check the names and confirm a line at a time. The names go to {s.local ? 'this demo only' : 'ASSY_CompletedJobs'}, which KPIs · Assembly reads.
        </p>
        {gated && <p className="ot-gate">Sign in as {gate} to confirm.</p>}
        {s.error && <p className="completed-error" role="alert">{s.error}</p>}
        {s.warnings.length > 0 && <p className="ot-note">{s.warnings.join(' · ')}</p>}

        <div className="completed-search">
          <input
            ref={search}
            type="search"
            placeholder="Order number — Enter confirms it"
            aria-label="Order number"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNote(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                quickConfirm();
              }
            }}
          />
          {note && <span className="completed-note" role="status">{note}</span>}
        </div>

        <div className="completed-table-wrap">
          <table className="completed-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Finished</th>
                <th>Part</th>
                <th>Line</th>
                <th className="num">Qty</th>
                <th className="num" title="Standard hours of the quantity, as Epicor values it">Std h</th>
                <th>Finished by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.status === 'loading' && s.items.length === 0 && (
                <tr><td colSpan={8} className="completed-empty">Reading CompletedJobs.csv…</td></tr>
              )}
              {s.status !== 'loading' && shown.length === 0 && (
                <tr><td colSpan={8} className="completed-empty">{q ? 'No finished order with that number.' : 'Epicor shows no Assembly order finished in this window.'}</td></tr>
              )}
              {groups.map((group) => {
                const ready = group.items.filter((i) => !i.confirmed && i.people.length > 0);
                const open = group.items.filter((i) => !i.confirmed).length;
                return [
                  <tr key={`line:${group.line}`} className="completed-line">
                    <th colSpan={7}>
                      {group.line}
                      <span className="completed-line-count">
                        {group.items.length} {group.items.length === 1 ? 'order' : 'orders'}
                        {open ? ` · ${open} to confirm` : ' · all confirmed'}
                      </span>
                    </th>
                    <th className="completed-act">
                      {ready.length > 0 && (
                        <Button disabled={gated} onClick={() => confirmEach(ready)} title={`Confirm ${group.line}'s orders with the names shown`}>
                          Confirm line ({ready.length})
                        </Button>
                      )}
                    </th>
                  </tr>,
                  ...group.items.map((item) => {
                const c = item.completion;
                return (
                  <tr key={c.key} className={item.confirmed ? 'done' : ''}>
                    <td className="completed-job">{c.jobNum}</td>
                    <td>{shortDay(c.day)} {c.lastAt.slice(11, 16)}</td>
                    <td className="completed-part" title={c.description}>
                      <b>{c.partNum}</b> {c.description}
                    </td>
                    <td>{item.line}</td>
                    <td className="num">{c.qty.toLocaleString('en-AU')}</td>
                    <td className="num">{c.hours.toFixed(2)}</td>
                    <td>
                      <PeoplePicker item={item} board={board} locked={item.confirmed || gated} />
                    </td>
                    <td className="completed-act">
                      {item.confirmed ? (
                        <span className="completed-ok" title={item.confirmedBy ? `Confirmed by ${item.confirmedBy}` : 'Confirmed'}>
                          ✓ {item.confirmedBy || 'Confirmed'}
                          {!gated && (
                            <button
                              type="button"
                              className="completed-change"
                              onClick={() =>
                                useCompletionStore.setState((st) => ({
                                  items: st.items.map((i) => (i.completion.key === c.key ? { ...i, confirmed: false } : i)),
                                }))
                              }
                            >
                              Change
                            </button>
                          )}
                        </span>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={gated || item.saving || item.people.length === 0}
                          onClick={() => void confirmCompletion(c.key)}
                        >
                          {item.saving ? 'Saving…' : 'Confirm'}
                        </Button>
                      )}
                      {item.error && <div className="completed-error">{item.error}</div>}
                    </td>
                  </tr>
                );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>

        <div className="ot-actions">
          <Button
            variant="primary"
            disabled={gated || !s.items.some((i) => !i.confirmed && i.people.length > 0)}
            onClick={confirmAll}
          >
            Confirm all with names ({s.items.filter((i) => !i.confirmed && i.people.length > 0).length})
          </Button>
          <Button onClick={() => setOpen(false)}>{waiting ? 'Later' : 'Close'}</Button>
        </div>
      </div>
    </div>
  );
}
