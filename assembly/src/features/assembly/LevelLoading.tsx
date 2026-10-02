/**
 * Right-click on load blocks picked with Ctrl: level the load.
 *
 * Two steps, never one, like every other multi-order write on this board. The
 * plan is worked out as the panel opens and nothing is written until it is
 * accepted: each order that would move is listed with the day it goes to, each
 * order it will not touch is listed with why, and the overload it leaves is
 * read off a real re-plan of the board rather than off the plan's own sums.
 * A picked day with room is filled with the next orders that can start on
 * it, unless that is turned off here.
 * What it wrote can be taken back from the same panel — and any one order can
 * be handed back to the schedule from its own detail with Release.
 *
 * See `levelLoad` for what it moves, what it leaves and how linked orders go.
 */

import type { JobId } from '@/domain/ids';
import { useMemo, useRef, useState } from 'react';
import type { CrewPool, LineKey } from '@/domain/assembly';
import type { OrderRow } from '@/engine/assembly/board';
import { formatShortDay, fromDayKey } from '@/lib/time';
import { usePlanStore } from '@/store/planStore';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { useUiStore } from '@/store/uiStore';
import { useDismiss } from './BulkActions';
import { overtimeOf, parseLoadPicks, pinsOf, planLevelLoad, type LevelMove } from './levelLoad';

const CEILINGS = [1, 0.9, 0.8] as const;
const hours = (n: number) => `${n.toFixed(1)} h`;
const dayText = (key: string | null) => (key ? formatShortDay(fromDayKey(key)) : '—');

export function LevelLoading({
  keys,
  at,
  rows,
  pools,
  today,
  lineName,
  verify,
  onClose,
}: {
  /** The picked blocks, as `line|day`. */
  keys: string[];
  at: { x: number; y: number };
  rows: readonly OrderRow[];
  pools: readonly CrewPool[];
  today: Date;
  lineName: (line: LineKey) => string;
  /**
   * Overload and room on the picked days if these starts were pinned, read off
   * a fresh schedule of the whole board — or null when it cannot be re-planned.
   */
  verify: (
    pins: Record<string, string>,
    picks: ReadonlyMap<LineKey, ReadonlySet<string>>,
    ceiling: number,
    overtime?: Record<string, boolean>,
  ) => { hours: number; days: number; room: number } | null;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onClose);
  const [ceiling, setCeiling] = useState<number>(1);
  const [fill, setFill] = useState(true);
  const [undo, setUndo] = useState<{
    starts: Record<string, string | null>;
    overtime: Record<string, boolean>;
  } | null>(null);
  const [applied, setApplied] = useState<{ moved: number; filled: number; linked: number } | null>(null);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));
  const clearLoadPicks = useUiStore((s) => s.clearLoadPicks);

  const picks = useMemo(() => parseLoadPicks(keys), [keys]);
  const plan = useMemo(
    () => planLevelLoad({ rows, pools, today, picks, ceiling, fill }),
    [rows, pools, today, picks, ceiling, fill],
  );
  const verified = useMemo(
    () => (plan.moves.length > 0 ? verify(pinsOf(plan), picks, ceiling, overtimeOf(plan)) : null),
    [plan, verify, picks, ceiling],
  );

  const days = useMemo(() => [...new Set(keys.map((k) => k.slice(k.lastIndexOf('|') + 1)))].sort(), [keys]);
  const lines = [...picks.keys()].map(lineName);
  const heading =
    `Level loading · ${lines.length === 1 ? lines[0] : `${lines.length} lines`} · ` +
    (days.length === 1
      ? dayText(days[0])
      : `${dayText(days[0])}–${dayText(days[days.length - 1])}`);

  const afterHours = verified ? verified.hours : plan.after.hours;
  const afterDays = verified ? verified.days : plan.after.days;
  const afterRoom = verified ? verified.room : plan.room.after;
  const over = plan.before.hours > 0.05;
  const room = plan.room.before > 0.05;

  const apply = () => {
    const { orderStarts, orderOvertime, setOrderStarts, setOvertime } = usePlanStore.getState();
    const pins = pinsOf(plan);
    const overtime = overtimeOf(plan);
    setUndo({
      starts: Object.fromEntries(Object.keys(pins).map((id) => [id, orderStarts[id] ?? null])),
      overtime: Object.fromEntries(Object.keys(overtime).map((id) => [id, Boolean(orderOvertime[id])])),
    });
    setOrderStarts(pins);
    // Levelled onto a picked weekend: the overtime is the reason it was picked.
    for (const id of Object.keys(overtime)) setOvertime(id as JobId, true);
    setApplied({
      moved: plan.moves.length,
      filled: plan.moves.filter((m) => m.kind === 'fill').length,
      linked: plan.moves.filter((m) => m.kind === 'linked').length,
    });
    clearLoadPicks();
  };
  const revert = () => {
    if (undo) {
      const { setOrderStarts, setOvertime } = usePlanStore.getState();
      setOrderStarts(undo.starts);
      for (const [id, was] of Object.entries(undo.overtime)) setOvertime(id as JobId, was);
    }
    setUndo(null);
    setApplied(null);
  };

  const width = 440;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 420));

  const moveLine = (m: LevelMove) => (
    <li key={m.jobId} className={m.stillOver ? 'held' : 'ok'}>
      <b title={m.description}>{m.order}</b>
      <span>
        {m.line} · {dayText(m.fromDay)} → {dayText(m.toDay)} · {hours(m.hours)}
        {m.kind === 'fill' && ' · brought forward into room'}
        {m.overtime && ' · weekend overtime'}
        {m.because &&
          ` · ${m.because.effect === 'follows' ? 'follows' : 'brought ahead of'} ${m.because.order}`}
        {m.stillOver && ' · still over capacity there'}
      </span>
    </li>
  );

  return (
    <div
      ref={box}
      className="bulk-menu confirm level-menu"
      role="dialog"
      aria-label="Level loading"
      style={{ left, top, width, maxHeight: `calc(100vh - ${top + 12}px)` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header>{heading}</header>

      {applied !== null ? (
        <>
          <p className="bulk-done" role="status">
            Moved {applied.moved} {applied.moved === 1 ? 'order' : 'orders'}
            {(applied.filled > 0 || applied.linked > 0) &&
              ` (${[
                applied.filled > 0 && `${applied.filled} brought forward`,
                applied.linked > 0 && `${applied.linked} linked`,
              ]
                .filter(Boolean)
                .join(', ')})`}
            . Their starts are fixed on the days above; Release
            in an order’s detail hands it back to the schedule.
          </p>
          <footer>
            <button type="button" onClick={revert} disabled={!undo}>Undo</button>
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </footer>
        </>
      ) : (
        <>
          {plan.noCrew.length > 0 && (
            <p className="bulk-hint level-warn">
              No crew group lists {plan.noCrew.map(lineName).join(', ')} — set one under Crew
              capacity; there is nothing to level it against.
            </p>
          )}
          <p className="bulk-hint">
            {over
              ? `Over capacity on the picked days: ${hours(plan.before.hours)} on ${plan.before.days} ` +
                `${plan.before.days === 1 ? 'day' : 'days'} → ${hours(afterHours)} on ${afterDays} ` +
                `${afterDays === 1 ? 'day' : 'days'} once levelled.`
              : plan.inScope === 0
                ? 'Nothing is planned on the picked days.'
                : `Nothing is over capacity on the picked days (${plan.inScope} ` +
                  `${plan.inScope === 1 ? 'order' : 'orders'} behind them).`}
            {room &&
              ` Room the crews still have on them: ${hours(plan.room.before)}` +
                (plan.moves.length > 0 ? ` → ${hours(afterRoom)}.` : '.')}
            {verified && plan.moves.length > 0 && ' Checked against a re-plan of the board.'}
          </p>
          <label className="level-ceiling">
            Fill a day to
            <select value={ceiling} onChange={(e) => setCeiling(Number(e.target.value))}>
              {CEILINGS.map((c) => (
                <option key={c} value={c}>{Math.round(c * 100)}% of the crew’s day</option>
              ))}
            </select>
          </label>
          <label className="level-ceiling">
            <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} />
            Fill room on the picked days with the next orders that can start there
          </label>

          {plan.moves.length > 0 && (
            <>
              <h4 className="level-h">Will move ({plan.moves.length})</h4>
              <ul className="bulk-list">{plan.moves.map(moveLine)}</ul>
            </>
          )}
          {plan.left.length > 0 && (
            <>
              <h4 className="level-h">Left where they are ({plan.left.length})</h4>
              <ul className="bulk-list">
                {plan.left.map((l) => (
                  <li key={l.jobId} className={l.kind === 'fixed' ? 'skip' : 'held'}>
                    <b>{l.order}</b>
                    <span>{l.line} · {hours(l.hours)} — {l.why}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.moves.length > 0 && (
            <p className="bulk-hint">
              Orders with a crew, routed operations and started orders are never moved, but their
              hours count against the day. Nothing is moved before today, before its material
              lands or before the order it is made from finishes, or past the last day it can
              start and make its Due Date. An order is only brought forward onto a day it
              fits on without tipping it over.
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={plan.moves.length === 0 || !unlocked}
              onClick={apply}
              title={unlocked ? undefined : `Levelling writes to the plan — sign in as ${gate}`}
            >
              Level ({plan.moves.length})
            </button>
          </footer>
          {!unlocked && plan.moves.length > 0 && (
            <p className="bulk-hint">Sign in as {gate} to apply it.</p>
          )}
        </>
      )}
    </div>
  );
}
