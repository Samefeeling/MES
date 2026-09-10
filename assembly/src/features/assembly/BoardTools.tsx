/**
 * Timeline controls, in the middle of the title bar.
 *
 * They sit in the header rather than on the board because they change how the
 * board is *looked at*, not what it says: the zoom, the hidden date columns.
 * The one figure that travels with them is the work the board is carrying,
 * which is the number a supervisor quotes when asked how the week looks.
 */

import { useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { LINES, virtualLineDef } from '@/domain/assembly';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { DATE_COLS, DATE_COL_LABEL, DUE_SOON_DAYS, useUiStore } from '@/store/uiStore';
import { countRunningOrders, isDueSoon } from './boardView';
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
  const orderDay = useUiStore((s) => s.orderDay);
  const setOrderDay = useUiStore((s) => s.setOrderDay);
  const dueSoon = useUiStore((s) => s.dueSoon);
  const toggleDueSoon = useUiStore((s) => s.toggleDueSoon);
  const showWeekends = useUiStore((s) => s.showWeekends);
  const toggleWeekends = useUiStore((s) => s.toggleWeekends);
  const virtualLines = usePlanStore((s) => s.virtualLines);

  if (!board) return null;
  const hidden = DATE_COLS.filter((key) => !dateCols[key]);
  const allLines = [...LINES, ...virtualLines.map(virtualLineDef)];
  const foldedLines = allLines.filter((line) => hiddenLines.includes(line.key));
  const running = orderDay
    ? countRunningOrders(
        board.groups.flatMap((group) => group.rows),
        fromDayKey(orderDay),
      )
    : null;
  const dueCount = board.groups
    .flatMap((group) => group.rows)
    .filter((row) => row.line.schedulable && isDueSoon(row, board.today, DUE_SOON_DAYS))
    .length;

  return (
    <div className="board-tools">
      <strong>Timeline</strong>
      <button
        onClick={() => setDayWidth(dayWidth - ZOOM_STEP)}
        aria-label="Zoom out"
        title="Narrower days — see further ahead"
      >
        −
      </button>
      <button
        onClick={() => setDayWidth(dayWidth + ZOOM_STEP)}
        aria-label="Zoom in"
        title="Wider days"
      >
        +
      </button>
      <span
        className="board-load"
        title="Standard hours still to run across every scheduled order"
      >
        {board.totals.remainingHours.toFixed(0)} h on the board
      </span>
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
      {/* What has to go out before the board is next looked at. Late orders
          are in it: one due last Tuesday is not less urgent than one due
          tomorrow, and a "due soon" list that drops them is the list you would
          least want to work from. */}
      <button
        className={`due-soon${dueSoon ? ' active' : ''}`}
        onClick={toggleDueSoon}
        aria-pressed={dueSoon}
        title={`Only orders due within ${DUE_SOON_DAYS} working days, and anything already late`}
      >
        ⏱ Due ≤ {DUE_SOON_DAYS}d
        <span className="due-soon-count">{dueCount}</span>
      </button>
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
      <AddLine />
      <MarkedSet />
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

