/**
 * The board's one row of chrome, and the only one it has.
 *
 * It reads left to right as a question and its answer. **Show** is what the
 * board is being asked to draw — which lines, which columns, which days — and
 * the one thing that adds to the board rather than narrowing it. **Timeline**
 * is how far the days are zoomed. Then the figures: what is on the board, what
 * is nearly due, how much of the roster is spoken for, and what is waiting to
 * be looked at.
 *
 * Controls to the left, figures to the right, and nothing in the middle that is
 * both. The board used to open with a band above this one carrying its name,
 * its source and two of these counts — and inside MES that band sat under a top
 * bar already naming it. There is no identity band now; what is left of it is
 * the source and its read time, beside the button that re-reads them.
 */

import { useMemo, useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { LINES, virtualLineDef } from '@/domain/assembly';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { DATE_COLS, DATE_COL_LABEL, DUE_SOON_DAYS, useUiStore } from '@/store/uiStore';
import { countRunningOrders, isDueSoon, teamSummary } from './boardView';
import { ManualOrderButton } from './ManualOrders';
import { ReviewOrders } from './SuggestCrew';
import { formatShortDay, fromDayKey } from '@/lib/time';

/** How much one press of − or + moves the day column, in pixels. */
const ZOOM_STEP = 16;

export function BoardTools({ board }: { board: AssemblyGanttView | null }) {
  const dayWidth = useUiStore((s) => s.dayWidth);
  const setDayWidth = useUiStore((s) => s.setDayWidth);
  const dateCols = useUiStore((s) => s.dateCols);
  const toggleDateCol = useUiStore((s) => s.toggleDateCol);
  const hiddenLines = useUiStore((s) => s.hiddenLines);
  const toggleLine = useUiStore((s) => s.toggleLine);
  const showEverything = useUiStore((s) => s.showEverything);
  const orderDay = useUiStore((s) => s.orderDay);
  const setOrderDay = useUiStore((s) => s.setOrderDay);
  const dueSoon = useUiStore((s) => s.dueSoon);
  const toggleDueSoon = useUiStore((s) => s.toggleDueSoon);
  const showWeekends = useUiStore((s) => s.showWeekends);
  const toggleWeekends = useUiStore((s) => s.toggleWeekends);
  const virtualLines = usePlanStore((s) => s.virtualLines);

  const allRows = useMemo(
    () => board?.groups.flatMap((group) => group.rows) ?? [],
    [board],
  );
  // The same figure the Team column heading used to carry, worked out the same
  // way. It is about the whole roster on the whole board, so it belongs with
  // the other three totals rather than over one column of one table.
  const team = useMemo(
    () => (board ? teamSummary(board.workers, allRows, board.today) : null),
    [board, allRows],
  );

  if (!board || !team) return null;
  const hidden = DATE_COLS.filter((key) => !dateCols[key]);
  const allLines = [...LINES, ...virtualLines.map(virtualLineDef)];
  const foldedLines = allLines.filter((line) => hiddenLines.includes(line.key));
  const running = orderDay
    ? countRunningOrders(
        board.groups.flatMap((group) => group.rows),
        fromDayKey(orderDay),
      )
    : null;
  const dueCount = allRows
    .filter((row) => row.line.schedulable && isDueSoon(row, board.today, DUE_SOON_DAYS))
    .length;
  /*
   * Whether anything is being held back. Weekends are deliberately not in it:
   * the compact working week is how the board draws itself, not something
   * somebody hid, and counting it here would leave "Show all" on screen for the
   * whole life of every board — which is the same as not having it.
   */
  const narrowed =
    hidden.length > 0 || foldedLines.length > 0 || orderDay !== null || dueSoon;

  return (
    <div className="board-tools">
      <div className="tool-group show-group">
        <strong>Show</strong>
        <button
          className="date-restore"
          onClick={toggleWeekends}
          title={
            showWeekends
              ? 'Hide Saturday and Sunday'
              : 'Show Saturday and Sunday'
          }
        >
          {showWeekends ? '− Weekends' : '+ Weekends'}
        </button>
        {/* Only the columns someone has hidden, so the row stays quiet. */}
        {hidden.map((key) => (
          <button
            className="date-restore"
            key={key}
            onClick={() => toggleDateCol(key)}
            title={`Show the ${DATE_COL_LABEL[key]} column again`}
          >
            + {DATE_COL_LABEL[key]}
          </button>
        ))}
        {/* The same, for a folded-away line. TBP and PMD start here, so this
            row is where the board admits it is not showing all eight. */}
        {foldedLines.map((line) => (
          <button
            className="date-restore line-restore"
            key={line.key}
            onClick={() => toggleLine(line.key)}
            title={`Show the ${line.name} line again`}
          >
            + {line.name}
          </button>
        ))}
        {/* One press for all of them, and drawn only while there is something
            to undo. Chip by chip is fine for the one column somebody hid a
            minute ago; it is not how you get back from a board that opened
            folded, had a day picked on it and then Due ≤ 2d. */}
        {narrowed && (
          <button
            className="show-all"
            onClick={showEverything}
            title="Every line, every column and every order back on the board"
          >
            Show all
          </button>
        )}
        <AddLine />
        <MarkedSet />
        {/* The one control on this row that adds to the board instead of
            narrowing it, and the reason it is on this row at all: it is not
            the action this board is opened for, and it used to have the
            far corner that says it is. */}
        <ManualOrderButton board={board} />
      </div>

      <div className="tool-group">
        <strong>Timeline</strong>
        <button
          className="zoom-step"
          onClick={() => setDayWidth(dayWidth - ZOOM_STEP)}
          aria-label="Zoom out"
          title="Narrower days — see further ahead"
        >
          −
        </button>
        <button
          className="zoom-step"
          onClick={() => setDayWidth(dayWidth + ZOOM_STEP)}
          aria-label="Zoom in"
          title="Wider days"
        >
          +
        </button>
      </div>

      {/*
        What the board comes back with. Three figures and one queue, and the
        only pressable thing among them narrows to what it counts.
      */}
      <div className="head-metrics">
        {/* The board shows every order it has unless somebody picked a day from
            the chip under a column, and this is the only place that says so —
            and the way back. It is not a filter someone can leave on by
            accident: with nothing picked, nothing is drawn here. */}
        {orderDay && (
          <button
            className="day-filter-clear"
            onClick={() => setOrderDay(null)}
            title="Back to every order on the board"
          >
            {formatShortDay(fromDayKey(orderDay))} · {running}{' '}
            {running === 1 ? 'order' : 'orders'} ×
          </button>
        )}
        <span
          className="metric board-load"
          title="Standard hours still to run across every scheduled order"
        >
          <span className="metric-label">Hours on board</span>
          <b className="metric-value">{board.totals.remainingHours.toFixed(0)} h</b>
        </span>
        {/* What has to go out before the board is next looked at. Late orders
            are in it: one due last Tuesday is not less urgent than one due
            tomorrow, and a "due soon" list that drops them is the list you would
            least want to work from. */}
        <button
          className={`metric due-soon${dueSoon ? ' active' : ''}`}
          onClick={toggleDueSoon}
          aria-pressed={dueSoon}
          title={`Only orders due within ${DUE_SOON_DAYS} working days, and anything already late`}
        >
          <span className="metric-label">Due within {DUE_SOON_DAYS} days</span>
          <b className="metric-value">{dueCount}</b>
        </button>
        <span
          className={`metric team-free ${team.free.length === 0 ? 'none' : ''}`}
          title={
            'Allocated today / staff on site; includes orders outside the current view' +
            (team.free.length > 0
              ? `\nFree: ${team.free.map((worker) => worker.name).join(', ')}`
              : '')
          }
          aria-live="polite"
        >
          <span className="metric-label">Crew allocated</span>
          <b className="metric-value">
            {team.allocated}
            <i>/{team.total}</i>
          </b>
        </span>
        <ReviewOrders board={board} />
      </div>
    </div>
  );
}

/**
 * Open a line that is not one of the eight.
 *
 * The plant is built as eight lines; what it is *running* this week is a
 * different question — a second table bench for a rush, a bay set up for one
 * big order, a crew split off to clear a backlog. Those had nowhere to go, so
 * the work sat on a line it was not happening on and the people on it read as
 * booked somewhere else.
 *
 * Supervisor only, and it goes into the shared plan rather than this browser:
 * a bench opened this morning is a fact about the week, and every screen
 * reading the board has to see the same one.
 */
function AddLine() {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const addVirtualLine = usePlanStore((s) => s.addVirtualLine);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  if (!unlocked) return null;

  const submit = () => {
    if (!name.trim()) return setOpen(false);
    const key = addVirtualLine(name);
    if (!key) return setError('That name is already a line.');
    setName('');
    setError('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        className="date-restore add-line"
        onClick={() => { setOpen(true); setError(''); }}
        title="Open another production line on this board"
      >
        + Line
      </button>
    );
  }

  return (
    <span className="add-line-entry">
      <input
        autoFocus
        value={name}
        maxLength={32}
        placeholder="Line name"
        aria-label="New line name"
        onChange={(e) => { setName(e.target.value); setError(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setOpen(false); setName(''); setError(''); }
        }}
      />
      <button onClick={submit} title="Open the line">Add</button>
      {error && <em className="add-line-error">{error}</em>}
    </span>
  );
}

/**
 * The orders ticked to move together, and the way out of it.
 *
 * Marking is otherwise invisible from the header — the bars carry an outline,
 * but they may all be scrolled off — and a set left ticked by accident would
 * make the next drag move things the planner had forgotten about.
 */
function MarkedSet() {
  const marked = useUiStore((s) => s.marked);
  const clearMarks = useUiStore((s) => s.clearMarks);
  if (marked.length === 0) return null;
  return (
    <button
      className="marked-set"
      onClick={clearMarks}
      title={
        `Moving together — drag any one of them:\n${marked.join('\n')}` +
        '\n\nClick here, or press Esc, to let go.'
      }
    >
      {marked.length} marked ×
    </button>
  );
}
