/**
 * Timeline controls, in the middle of the title bar.
 *
 * They sit in the header rather than on the board because they change how the
 * board is *looked at*, not what it says: the zoom, the hidden date columns.
 * The one figure that travels with them is the work the board is carrying,
 * which is the number a supervisor quotes when asked how the week looks.
 */

import type { AssemblyGanttView } from '@/engine/assembly/board';
import { DATE_COLS, DATE_COL_LABEL, useUiStore } from '@/store/uiStore';
import { countRunningOrders } from './boardView';
import { fromDayKey } from '@/lib/time';

/** How much one press of − or + moves the day column, in pixels. */
const ZOOM_STEP = 16;

export function BoardTools({ board }: { board: AssemblyGanttView | null }) {
  const dayWidth = useUiStore((s) => s.dayWidth);
  const setDayWidth = useUiStore((s) => s.setDayWidth);
  const dateCols = useUiStore((s) => s.dateCols);
  const toggleDateCol = useUiStore((s) => s.toggleDateCol);
  const orderWindow = useUiStore((s) => s.orderWindow);
  const setOrderWindow = useUiStore((s) => s.setOrderWindow);
  const orderDay = useUiStore((s) => s.orderDay);
  const showWeekends = useUiStore((s) => s.showWeekends);
  const toggleWeekends = useUiStore((s) => s.toggleWeekends);

  if (!board) return null;
  const hidden = DATE_COLS.filter((key) => !dateCols[key]);
  const running = orderWindow === 'day' && orderDay
    ? countRunningOrders(
        board.groups.flatMap((group) => group.rows),
        fromDayKey(orderDay),
      )
    : null;

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
      {/* Which orders are on screen, and the way back to all of them. The
          board is filtered from three places — here, the day chip under each
          column, and nothing else — so this is where a filter has to be
          visible, whichever of them turned it on. */}
      <span className="order-window" aria-label="Order date window">
        <button
          className={orderWindow === 'all' ? 'active' : ''}
          onClick={() => setOrderWindow('all')}
          title="Every order on the board"
        >
          All orders
        </button>
        <button
          className={orderWindow === 'next-five' ? 'active' : ''}
          onClick={() => setOrderWindow('next-five')}
          title="Orders running today or during the next five working days"
        >
          5 working days
        </button>
      </span>
      {orderWindow === 'day' && orderDay && (
        <span className="board-load" role="status">
          {running} {running === 1 ? 'order' : 'orders'} running
        </span>
      )}
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
      <MarkedSet />
    </div>
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

