import { formatDay, formatShortDay, formatTime } from '@/lib/time';
/**
 * The assembly main board.
 *
 * Left: one row per order with its dates and crew. Right: the day grid with
 * the draggable bar. Row groups are the lines — PMD first, shown for context
 * only, then the three schedulable assembly lines.
 *
 * The board opens on the previous working day, so the shift that has just
 * finished is still there to be compared against the plan; a line down today's
 * column says where the shift has got to.
 */

import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssemblyGanttView,
  LineGroup,
  OrderRow,
} from '@/engine/assembly/board';
import {
  ORDER_TYPE_SHORT,
  PRODUCTIVE_HOURS_PER_PERSON,
  arrangeLines,
  isVirtualLine,
  STEP_NAME,
  WORK_KIND_SHORT,
  rootLineKey,
  type LineKey,
  type VirtualLineKey,
} from '@/domain/assembly';
import { capacityDays, type CapacityDay, type LineCapacity } from './crewCapacity';
import { loadBand } from '@/engine/assembly/workload';
import { addCalendarDays, isWeekend } from '@/engine/assembly/dates';
import { remainingHours } from '@/engine/assembly/duration';
import {
  boardDayLoads,
  rosterLoad,
  type WorkerLoad,
} from '@/engine/assembly/workload';
import { usePlanStore } from '@/store/planStore';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { useDataStore } from '@/store/dataStore';
import {
  COLUMN_LIMITS,
  DAY_COLUMN_LIMITS,
  DATE_COLS,
  DATE_COL_LABEL,
  DUE_SOON_DAYS,
  useUiStore,
  type ClickPoint,
  type ColumnKey,
  type ColumnWidths,
  type ColVis,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';
import { dayAxis, type DayAxis } from './dayAxis';
import { DragTimeGuide } from './DragTimeGuide';
import { OrderBar } from './OrderBar';
import { DRAG_TYPE_LINE, lineDragId } from './lineDrag';
import { TeamChips } from './TeamChips';
import { CrewName, CrewRoll } from './CrewRolls';
import { WorkerLoadChip } from './WorkerLoadChip';
import { DependencyArrows } from './DependencyArrows';
import { dependencyFocus } from './dependencyRouter';
import {
  teamSummary,
  onLeaveWorkerOrders,
  strandedOrders,
  lineOfWorkerToday,
  filteredOrderIds,
  lineDayLoads,
  timelineDays,
  type DayOrderEntry,
  type LineDayLoad,
  type OrderSortKey,
} from './boardView';
import { useStableBoardOrder } from './useStableBoardOrder';
import { earliestStart, markedSet, type MarkedMove } from './groupMove';
import { toDayKey } from '@/lib/time';
import { rowIndex } from './rowIndex';
import { BulkActions } from './BulkActions';
import { overdueDays } from './overdue';
import {
  TIMELINE_MIN_WEEKS,
  foldedWidths,
  mergeEntries,
  weekLoad,
  weekSpans,
  type WeekSpan,
} from './weekFold';
import { bulkTargets } from './bulkPlan';
import { jobNumOf } from '@/domain/routing';

/** The integers from `from` up to, not including, `to`. */
const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

const TIME_FMT = new Intl.DateTimeFormat('en-AU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const fmt = (d: Date | null): string => (d ? formatShortDay(d) : '—');

/**
 * Where each frozen column starts, left to right, and how wide the frozen
 * block ends up.
 *
 * The header and the rows both need these, and each used to walk the visible
 * date columns with its own running total — two counters that had to be kept
 * in step by hand, and drift in either one slides the dates out from under
 * their headings. Now that every column is dragged, the same is true of the
 * total: the grid starts where the frozen block ends.
 */
/**
 * The widths the board actually lays out with: a hidden Qty / Hours / Team
 * column counts as zero, so every position downstream of it — and the CSS
 * width vars — collapse over it and the grid slides left to reclaim the room.
 */
function shownWidths(w: ColumnWidths, cols: ColVis): ColumnWidths {
  return {
    ...w,
    qty: cols.qty ? w.qty : 0,
    hours: cols.hours ? w.hours : 0,
    team: cols.team ? w.team : 0,
  };
}

function frozenLefts(
  visible: DateCols,
  w: ColumnWidths,
): {
  qty: number;
  hours: number;
  date: Partial<Record<DateCol, number>>;
  team: number;
  total: number;
} {
  const date: Partial<Record<DateCol, number>> = {};
  let left = w.order + w.qty + w.hours;
  for (const key of DATE_COLS) {
    if (!visible[key]) continue;
    date[key] = left;
    left += w[key];
  }
  return {
    qty: w.order,
    hours: w.order + w.qty,
    date,
    team: left,
    total: left + w.team,
  };
}

/**
 * The grip on a column's right-hand edge.
 *
 * It reads its own width from the store rather than being handed one: the
 * header draws seven of these, and threading a width and a setter through the
 * board for each of them would put seven props on every row that never uses
 * them.
 */
function ColumnGrip({ column, label }: { column: ColumnKey; label: string }) {
  const width = useUiStore((s) => s.colWidths[column]);
  const setColumnWidth = useUiStore((s) => s.setColumnWidth);
  const limits = COLUMN_LIMITS[column];

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = e.clientX;
    const base = width;
    const move = (ev: PointerEvent) =>
      setColumnWidth(column, base + ev.clientX - from);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('col-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    document.body.classList.add('col-resizing');
  };

  return (
    <span
      className="col-resize"
      role="separator"
      tabIndex={0}
      aria-label={`Resize the ${label} column`}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      title="Drag to resize"
      onPointerDown={startResize}
      onKeyDown={(e) => {
        const step =
          e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (!step) return;
        e.preventDefault();
        setColumnWidth(column, width + step);
      }}
    />
  );
}

/**
 * The same grip, on a day column.
 *
 * A day is not a frozen column — there is no `colWidths` slot for it and there
 * never can be, because which days are on the board changes every morning — so
 * it is dragged by its own day key and falls back to the zoom until somebody
 * touches it. Double-click puts it back under the zoom, which is the only way
 * out of a column dragged somewhere silly that does not cost the whole board
 * its layout.
 */
function DayGrip({ day, width }: { day: string; width: number }) {
  const setDayColumnWidth = useUiStore((s) => s.setDayColumnWidth);
  const clearDay = useUiStore((s) => s.clearDayColumnWidth);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = e.clientX;
    const base = width;
    const move = (ev: PointerEvent) =>
      setDayColumnWidth(day, base + ev.clientX - from);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('col-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    document.body.classList.add('col-resizing');
  };

  return (
    <span
      className="col-resize day-resize"
      role="separator"
      tabIndex={0}
      aria-label={`Resize the ${day} column`}
      aria-valuenow={width}
      aria-valuemin={DAY_COLUMN_LIMITS.min}
      aria-valuemax={DAY_COLUMN_LIMITS.max}
      title="Drag to resize this day · double-click for the zoom's width"
      onPointerDown={startResize}
      onDoubleClick={(e) => { e.stopPropagation(); clearDay(day); }}
      onKeyDown={(e) => {
        const step =
          e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (!step) return;
        e.preventDefault();
        setDayColumnWidth(day, width + step);
      }}
    />
  );
}

/**
 * The time of day a start falls at. Midnight means there is no hour to show —
 * the export carried none, or the work happens to begin as the shift opens.
 */
const startTime = (d: Date | null): string | null =>
  d && (d.getHours() !== 0 || d.getMinutes() !== 0) ? TIME_FMT.format(d) : null;

/**
 * The order number, and the grip that moves the order to another line.
 *
 * Filing an order somewhere else used to mean dragging its *bar*, which is a
 * different question with a different answer: a bar carries a day as well as a
 * line, so a sideways drag onto another line also pinned whatever start day the
 * pointer happened to be over — and on a board scrolled six weeks out the bar
 * is not on screen at all while its number is. Dragged by the number, an order
 * changes line and nothing else: it keeps falling in behind its crew and its
 * predecessor, exactly as it did on the line it left.
 *
 * Same id and same drag type as an unplaced card, so the two are one gesture:
 * an order is on a line or in the pool, never both, so the ids cannot collide.
 */
function OrderGrip({
  id,
  movable,
  label,
}: {
  id: string;
  movable: boolean;
  /** What the floor reads. The drag still carries the full row id (`id`),
   *  but a routed order shows only its order number — the `#seq` on the end
   *  is the board's row key, and its bench and step are already spelled out
   *  beside it, so the plant never needs to see it. Defaults to `id`. */
  label?: string;
}) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: !movable || !unlocked,
    data: { type: 'job', jobId: id },
  });
  const draggable = movable && unlocked;
  const shown = label ?? id;
  return (
    <span
      ref={setNodeRef}
      className={`order-id ${draggable ? 'movable' : ''} ${isDragging ? 'dragging' : ''}`}
      title={
        movable
          ? unlocked
            ? `${shown} — drag onto another line to move it there`
            : `${shown} — sign in as ${gate} to move it to another line`
          : shown
      }
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
    >
      {shown}
    </span>
  );
}

function OrderRowView({
  row,
  board,
  allRows,
  gridWidth,
  selected,
  onSelect,
  axis,
  colWidths,
  visibleDates,
  showWeekends,
  workerLines,
  dependencyRelated,
  marked,
  moveWith,
  floorISO,
  onMark,
  onDependencyHover,
}: {
  row: OrderRow;
  board: AssemblyGanttView;
  /** Every row on the board, for the crew picker's double-booking check. */
  allRows: OrderRow[];
  gridWidth: number;
  selected: boolean;
  onSelect: (id: string, at?: ClickPoint) => void;
  /** Where each day sits along the grid, and how wide it is. */
  axis: DayAxis;
  colWidths: ColumnWidths;
  visibleDates: DateCols;
  showWeekends: boolean;
  workerLines: ReadonlyMap<string, LineKey>;
  dependencyRelated: boolean;
  marked: boolean;
  moveWith: MarkedMove[];
  /** Earliest day this order may begin, whatever the drag asks for. */
  floorISO: string | null;
  onMark: (id: string) => void;
  onDependencyHover: (id: string | null) => void;
}) {
  const cols = useUiStore((state) => state.cols);
  const isNew = useDataStore((state) =>
    // Flagged by order number: a routed order arriving today is new once,
    // whichever of its operations is being worked.
    state.newOrderIds.includes(jobNumOf(String(row.job.id))),
  );
  const isContext = !row.line.schedulable;
  const lefts = frozenLefts(visibleDates, shownWidths(colWidths, cols));
  const at = (key: DateCol): React.CSSProperties | undefined =>
    lefts.date[key] === undefined ? undefined : { left: lefts.date[key] };
  const startStyle = at('start');
  const dueStyle = at('due');
  const expectStyle = at('expect');
  const startAt = row.job.startDate;
  const mustStart = row.mustStartBy;
  const orderQty = row.job.remainingQty + row.job.completedQty;
  // Past its Due Date and not finished — see `overdue`.
  const over = isContext ? null : overdueDays(row, board.today);
  return (
    <div
      data-row-id={String(row.job.id)}
      className={`arow ${row.line.parent ? 'bench' : ''} ${selected ? 'selected' : ''} ${isContext ? 'context' : ''} ${row.completedToday ? 'completed-today' : ''} ${isNew ? 'new-order' : ''} ${over ? 'overdue' : ''}`}
    >
      <div className="acell order">
        {/* A manual support order belongs to Factory General and the plan
            refuses to file it anywhere else, so it carries no grip. */}
        <OrderGrip
          id={String(row.job.id)}
          movable={!isContext && !row.job.manual}
          label={jobNumOf(String(row.job.id))}
        />
        {/*
          * Running on the floor, beside the order number rather than on the
          * bar. The triangle that used to mark it sat at the bar's left edge,
          * which is where a dependency arrow lands: an order waiting for its
          * covers and an order being built read as the same mark. A word does
          * not, and the frozen column carries it whatever the timeline is
          * scrolled to.
          *
          * Not the progress fill either: that says how much is finished, and
          * an order started an hour ago with nothing booked yet has none of
          * it — which is exactly the pair this has to tell apart.
          */}
        {row.actualStart && (
          <span
            className="order-tag run"
            title={
              `Started on the floor ${formatDay(new Date(row.actualStart.startedAt))} ` +
              formatTime(new Date(row.actualStart.startedAt)) +
              (row.actualStart.overrideReason
                ? ` · Override: ${row.actualStart.overrideReason}`
                : '')
            }
          >
            RUN
          </span>
        )}
        {over && (
          <span
            className="order-tag overdue"
            title={
              `Due ${formatDay(row.job.dueDate!)} and not finished — ${over} day${over === 1 ? '' : 's'} overdue.\n` +
              (row.expectDate
                ? `Now expected ${formatDay(row.expectDate)}: bookings made against the Due Date need moving to it.`
                : 'No finish date — some of it has nobody on it. Bookings made against the Due Date need moving.')
            }
          >
            OVERDUE {over}d
          </span>
        )}
        {isNew && <span className="order-tag new">NEW</span>}
        {/* The trade badge — but not on a routed order. There the bench it
            sits under (Foaming / Sewing / Stapling) and the "1/3 Foaming"
            step beside it already say both which trade and which step, so
            SOFTIE / UPH here only repeats the lane. Kept on every other
            line, where it is the one thing that names the work. */}
        {!row.job.operation && (row.kind !== 'general' || row.job.orderType) && (
          <span className={`order-type ${row.kind}`}>
            {row.job.manual ? 'SUPPORT' : row.kind === 'general'
              ? ORDER_TYPE_SHORT[row.job.orderType!]
              : WORK_KIND_SHORT[row.kind]}
          </span>
        )}
        {/* Where the order is on its route. One order, one number; this is
            the bench working it now, and how far through the three it is. */}
        {row.job.operation && (
          <span
            className="order-op"
            title={`Operation ${row.job.operation.seq} of ${String(row.job.operation.jobNum)} — ${
              row.job.operation.last
                ? 'the last, so the units are received here'
                : `${row.job.operation.tailHours.toFixed(1)} h still to come after it`
            }`}
          >
            {row.job.operation.index}/{row.job.operation.of}{' '}
            {STEP_NAME[row.job.operation.step]}
          </span>
        )}
        <span className="order-desc">{row.job.description}</span>
      </div>
      {/* Ordered quantity, with what is still to make under it. */}
      {cols.qty && (
        <div
          className="acell qty frozen"
          style={{ left: lefts.qty }}
          title={row.job.manual ? 'Support work is measured in labour hours' : `${orderQty} ordered · ${row.job.remainingQty} still to make`}
        >
          <span>{row.job.manual ? '—' : orderQty}</span>
          {!row.job.manual && row.job.completedQty > 0 && (
            <span className="qty-left">{row.job.remainingQty} left</span>
          )}
        </div>
      )}
      {cols.hours && (
        <div
          className="acell hours frozen"
          style={{ left: lefts.hours }}
          title="Remaining standard labour hours used by the schedule"
        >
          {remainingHours(row.job).toFixed(1)} h
        </div>
      )}
      {/* Worked out here, not taken from the export. Epicor back-schedules on
          its own calendar and returns hours like 18:23, when the floor is
          empty; this counts the same work back over 07:00–15:30 shifts at 7.5
          productive hours a head, so the answer is always a moment somebody
          could actually pick the order up. The export's own value stays in the
          tooltip as the cross-check. */}
      {visibleDates.start && (
        <div
          className="acell date frozen start"
          style={startStyle}
          title={
            (mustStart
              ? `Must start by ${formatDay(mustStart) + ' ' + formatTime(mustStart)} — ` +
                `${remainingHours(row.job).toFixed(1)} h counted back from the ` +
                `due date at ${PRODUCTIVE_HOURS_PER_PERSON} h a day for ` +
                `${Math.max(1, row.workers.length)} ` +
                `${row.workers.length === 1 ? 'person' : 'people'}`
              : 'No due date to count back from') +
            (startAt
              ? `\nEpicor scheduled ${formatDay(startAt) + ' ' + formatTime(startAt)}`
              : '\nNo scheduled start in the export')
          }
        >
          <span>{fmt(mustStart)}</span>
          {startTime(mustStart) && (
            <span className="date-hour">{startTime(mustStart)}</span>
          )}
        </div>
      )}
      {visibleDates.due && (
        <div
          className={`acell date due frozen${over ? ' overdue' : ''}`}
          style={dueStyle}
          title={over ? `${over} day${over === 1 ? '' : 's'} overdue` : undefined}
        >
          {fmt(row.job.dueDate)}
        </div>
      )}
      {/* A blank Expect Date is not a fault, it is a shortfall — say which,
          and how big, where the dash is. */}
      {visibleDates.expect && <div
        className={`acell date expect frozen ${row.status.color}`}
        style={expectStyle}
        title={
          row.expectDate
            ? row.status.reason
            : (row.uncoveredHours ?? 0) > 0
              ? `${row.uncoveredHours!.toFixed(1)} h of this order has nobody free to do it, so it has no finish date` +
                ((row.crewWithoutRoom?.length ?? 0) > 0
                  ? ` — ${row.crewWithoutRoom!.map((w) => w.name).join(', ')} are booked elsewhere every day of it`
                  : '')
              : row.status.reason
        }
      >
        {fmt(row.expectDate)}
      </div>}
      {cols.team && (
        <div className="acell team frozen" style={{ left: lefts.team }}>
          {isContext ? (
            <span className="chip empty">moulding</span>
          ) : (
            <TeamChips
              row={row}
              roster={board.workers}
              rows={allRows}
              workerLines={workerLines}
              disabled={row.completedToday}
            />
          )}
        </div>
      )}
      <div className="acell track" style={{ width: gridWidth }}>
        <OrderBar
          row={row}
          horizonStart={board.horizonStart}
          axis={axis}
          gridWidth={gridWidth}
          showWeekends={showWeekends}
          readOnly={isContext}
          selected={selected}
          dependencyRelated={dependencyRelated}
          marked={marked}
          overdue={over !== null}
          moveWith={moveWith}
          floorISO={floorISO}
          onSelect={onSelect}
          onMark={onMark}
          onDependencyHover={onDependencyHover}
        />
      </div>
    </div>
  );
}

/**
 * A line and its orders. Schedulable lines are drop targets, so an order can be
 * dragged here from the pool, from another line, or by its own bar.
 *
 * The summary row carries the line's own people — whoever is standing here
 * today, in the order the board reaches for them, each with their week of
 * load. One roster across the top of the board could not say which of those
 * names mattered to the line you were reading; here it is the same row.
 *
 * Each operator appears once, on the line the supervisor currently owns in
 * the draggable roster. See `lineOfWorkerToday`.
 */
function LineGroupView({
  group,
  total,
  board,
  allRows,
  gridWidth,
  rosterLoads,
  todayLine,
  selectedJobId,
  onSelect,
  axis,
  colWidths,
  visibleDates,
  showWeekends,
  collapsed,
  lineRows,
  dates,
  capacity,
  spans,
  labelWidth,
  onOpenDay,
  onToggle,
  onHide,
  onClose,
  neighbours,
  onArrange,
  filtered,
  unlocked,
  relatedJobIds,
  markedIds,
  moveWith,
  rowFloors,
  onMark,
  onDependencyHover,
}: {
  group: LineGroup;
  /** Orders on the line, before any date window narrowed what is drawn. */
  total: number;
  board: AssemblyGanttView;
  allRows: OrderRow[];
  gridWidth: number;
  /** Every person's week, worked out once for the whole board. */
  rosterLoads: Map<string, WorkerLoad>;
  /** Which line each person is standing at today — one each. */
  todayLine: Map<string, LineKey>;
  /** People whose work has started, and so cannot be moved to another line. */
  selectedJobId: string | null;
  onSelect: (id: string, at?: ClickPoint) => void;
  /** Where each day sits along the grid, and how wide it is. */
  axis: DayAxis;
  colWidths: ColumnWidths;
  visibleDates: DateCols;
  showWeekends: boolean;
  collapsed: boolean;
  /**
   * Every order the line holds, its benches' included, before any filter —
   * what its folded row adds up day by day.
   */
  lineRows: OrderRow[];
  /** The day columns, left to right, as the axis lays them out. */
  dates: Date[];
  /** Each day column against the crews — what the banner reads too. */
  capacity: CapacityDay[];
  /** The weeks along the axis, and which are folded. */
  spans: WeekSpan[];
  /** Open the list of orders behind one day of this line. */
  onOpenDay: (detail: DayDetailContent, at: { x: number; y: number }) => void;
  /** Where the day columns begin, past the frozen columns. */
  labelWidth: number;
  onToggle: () => void;
  /** Fold the whole line away; it comes back from the header. */
  onHide: () => void;
  /** Close a line the supervisor opened. Absent on the eight built-in ones. */
  onClose?: () => void;
  /** The lines drawn either side of this one, for arranging by keyboard. */
  neighbours: { before: LineKey | null; after: LineKey | null };
  /** Put this line where `onto` currently is. */
  onArrange: (onto: LineKey) => void;
  filtered: boolean;
  unlocked: boolean;
  relatedJobIds: ReadonlySet<string>;
  markedIds: ReadonlySet<string>;
  moveWith: MarkedMove[];
  /** Job id → earliest day it may begin, for the whole board. */
  rowFloors: ReadonlyMap<string, string>;
  onMark: (id: string) => void;
  onDependencyHover: (id: string | null) => void;
}) {
  const { active } = useDndContext();
  const arranging = active?.data.current?.type === DRAG_TYPE_LINE;
  const { setNodeRef, isOver } = useDroppable({
    id: String(group.line.id),
    data: {
      type: 'line',
      lineId: String(group.line.id),
      lineKey: group.line.key,
    },
    // PMD takes no orders and no people, but it is still somewhere another
    // line can be dropped: arranging the board is not filing work on it.
    disabled: !group.line.schedulable && !arranging,
  });
  /*
   * The row is also the grip that arranges the lines. It is the row and not a
   * separate handle because the row is what the pointer is already on — and it
   * is why the fold is now its own triangle: holding the name used to mean
   * "collapse this", and one gesture cannot mean two things.
   */
  /*
   * A bench is not a line anybody arranges: it is one of the three its lane is
   * made of, and it moves when the lane does. Everything else on the row — the
   * fold, the people, the orders — works exactly as it does on a lane.
   */
  const arrangeable = unlocked && !group.line.parent;
  /*
   * What this floor calls the line.
   *
   * The plant named the eight and the process named the six benches under two
   * of them, and neither is necessarily what the shift says out loud. Renaming
   * is a double-click on the name — the same gesture that renames a file — and
   * it is the supervisor's, because the name travels with the plan and every
   * screen on the floor reads it.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const commitName = (value: string) => {
    usePlanStore.getState().renameLine(group.line.key, value);
    setRenaming(null);
  };
  const arrange = useDraggable({
    id: lineDragId(group.line.key),
    disabled: !arrangeable,
    data: {
      type: DRAG_TYPE_LINE,
      lineKey: group.line.key,
      lineName: group.line.name,
    },
  });
  const load = group.load;
  /*
   * Folded, the line's row is all that is left of it, so it carries the line's
   * week: hours planned on each day, and the work still waiting for a crew that
   * has to land on those days to make its Due Date. Open, the bars under it
   * say the same and the row stays clear. PMD is the moulding plan mirrored
   * for context — nobody on this board crews it — so it has none.
   */
  const dayLoads = useMemo(
    () =>
      collapsed && group.line.schedulable
        ? lineDayLoads(
            lineRows,
            benchPositions(board, group),
            dates,
            board.today,
          )
        : null,
    [collapsed, group, lineRows, dates, board],
  );
  const crew = useMemo(
    () =>
      board.workers
        .filter(
          (worker) =>
            worker.onShift &&
            todayLine.get(String(worker.id)) === group.line.key,
        ),
    [board.workers, group.line.key, todayLine],
  );

  return (
    <section
      ref={setNodeRef}
      className={`agroup ${group.line.parent ? 'bench' : ''} ${isOver ? 'drop-active' : ''}`}
    >
      {/* A row, not one big button: the load chips inside it open their own
          popup, and a button cannot hold another button. The inner block is
          what sticks to the left edge, so the line's totals and its people
          stay readable however far right the grid is scrolled — the row
          itself has to span the whole grid to carry the background. */}
      <div className={`agroup-head${dayLoads ? ' has-load' : ''}`}>
       {/* With a day strip, the sticky block also covers the frozen columns, so the day
           strip scrolls under them the way the bars do. */}
       <div
         className="agroup-head-in"
         style={dayLoads ? { minWidth: labelWidth } : undefined}
       >
        <div className="agroup-meta">
        {/* Its own control, in the Order column where the row starts. Folding
            used to be what clicking the line's name did, and the name is now
            the grip that arranges the lines — a press that might mean either
            is a press nobody makes twice. */}
        <button
          type="button"
          className="agroup-fold"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? `Show the ${group.line.name} orders`
              : `Fold the ${group.line.name} orders away`
          }
          title={
            collapsed
              ? `Show the ${group.line.name} orders`
              : `Fold the ${group.line.name} orders away`
          }
        >
          <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        </button>
        <div
          ref={arrange.setNodeRef}
          className={`agroup-label ${arrangeable ? 'arrangeable' : ''} ${arrange.isDragging ? 'arranging' : ''}`}
          title={
            arrangeable
              ? `${group.line.name} — drag onto another line to put it there` +
                '\nAlt + ↑ / ↓ moves it one place'
              : group.line.name
          }
          onKeyDown={(e) => {
            // The same move without a pointer. Alt rather than a bare arrow:
            // the row is in the tab order for reading, and a board that
            // re-arranged itself on ↓ would do it to somebody scrolling.
            if (!e.altKey) return;
            const onto =
              e.key === 'ArrowUp'
                ? neighbours.before
                : e.key === 'ArrowDown'
                  ? neighbours.after
                  : null;
            if (!onto || !arrangeable) return;
            e.preventDefault();
            onArrange(onto);
          }}
          {...(arrangeable ? arrange.listeners : {})}
          {...(arrangeable ? arrange.attributes : {})}
        >
          {renaming === null ? (
            <span
              className={`agroup-name ${unlocked ? 'renameable' : ''}`}
              onDoubleClick={
                unlocked ? () => setRenaming(group.line.name) : undefined
              }
              title={unlocked ? 'Double-click to rename this line' : undefined}
            >
              {group.line.name}
            </span>
          ) : (
            <input
              className="agroup-rename"
              value={renaming}
              autoFocus
              maxLength={32}
              aria-label={`Rename ${group.line.name}`}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => commitName(renaming)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Enter takes it, Escape leaves the name as it was, and an
                // empty name puts the built-in one back rather than leaving a
                // line with no name at all.
                if (e.key === 'Enter') commitName(renaming);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          )}
          {/* Spelled out where the floor's shorthand is not obvious — this
              board is read across a workshop by people who did not choose
              the abbreviation. */}
          {group.line.fullName && (
            <span className="agroup-note">{group.line.fullName}</span>
          )}
          {!group.line.schedulable && (
            <span className="agroup-note">plan only</span>
          )}
          {/* "9 of 11" whenever the two differ: a line quietly showing two
              thirds of itself is the thing a planner has to be able to see. */}
          <span
            className="agroup-count"
            title={
              // A lane holds none of its own once its work is on its benches,
              // so it counts theirs: a header reading "0 orders, 0 h" over
              // three rows of work is the one thing it must not say.
              group.benchOrders !== undefined
                ? `${group.benchOrders} orders across this line's benches`
                : group.rows.length === total
                  ? `${total} orders on this line`
                  : `${group.rows.length} of ${total} orders shown — the rest are outside the date window`
            }
          >
            {group.benchOrders !== undefined
              ? group.benchOrders
              : group.rows.length === total
                ? total
                : `${group.rows.length} of ${total}`}
          </span>

          {/* The line's own work load: remaining standard hours, and how long
              the crew on it needs to clear them. */}
          <span
            className="agroup-load"
            title="Work load — standard hours still to run on this line"
          >
            {load.hours.toFixed(1)} h
          </span>

        </div>

        {/* The line's roster, right-aligned into the Order column so it ends at
            the Qty column rather than spilling over the schedule — the board's
            right-hand side is where the work is read, and a week of load chips
            drawn across the first days of it hid exactly that. Always rendered,
            empty or not: it is also the spacer that holds the × out in the Qty
            column on a line nobody is on yet. */}
        <span
          className="agroup-roster"
          title={
            crew.length > 0
              ? `On ${group.line.name}: ${crew.map((w) => w.name).join(', ')}` +
                '\nScrolls sideways when there are more than fit'
              : undefined
          }
        >
          {crew.map((worker) => {
            const week = rosterLoads.get(String(worker.id));
            return week ? (
              <WorkerLoadChip
                key={String(worker.id)}
                worker={worker}
                load={week}
                line={group.line.key}
                dragDisabled={!unlocked}
              />
            ) : null;
          })}
        </span>

        {/* Closing a line the supervisor opened is a different act from
            folding it away, and it is theirs alone: the orders on it go back
            to the unplaced pool for somebody to file again. */}
        {onClose && (
          <button
            type="button"
            className="agroup-close"
            onClick={() => {
              if (
                group.rows.length === 0 ||
                window.confirm(
                  `Close ${group.line.name}? Its ${group.rows.length} order` +
                    `${group.rows.length === 1 ? '' : 's'} go back to the unplaced pool.`,
                )
              ) onClose();
            }}
            title={`Close the ${group.line.name} line`}
          >
            Close line
          </button>
        )}
        {/* Outside the label — it does something the label does not: it takes
            the line off the board altogether. Last in the block, and as wide
            as the Qty column, so it stands under that heading on every line. */}
        <button
          type="button"
          className="agroup-hide"
          onClick={onHide}
          title={`Hide the ${group.line.name} line — bring it back from the header`}
          aria-label={`Hide the ${group.line.name} line`}
        >
          ×
        </button>

        </div>
       </div>
       {dayLoads && (
         <LineLoadStrip
           days={dayLoads}
           capacity={capacity.map((day) => day.lines.get(rootLineKey(group.line.key))?.capacity)}
           spans={spans}
           onOpen={(from, to, at) => {
             const picked = dayLoads.slice(from, to);
             const crews = capacity
               .slice(from, to)
               .map((c) => c.lines.get(rootLineKey(group.line.key))?.capacity)
               .filter((c): c is LineCapacity => Boolean(c) && c!.pct !== null);
             const hours = picked.reduce((n, d) => n + d.hours, 0);
             const waiting = picked.reduce((n, d) => n + d.unstaffedHours, 0);
             const cap = crews.reduce((n, c) => n + c.capacity, 0);
             const demand = crews.reduce((n, c) => n + c.demand, 0);
             const first = picked[0].date;
             const last = picked[picked.length - 1].date;
             const past = picked.every((d) => d.past);
             onOpenDay(
               {
                 title:
                   `${group.line.name} · ${formatShortDay(first)}` +
                   (to - from > 1 ? `–${formatShortDay(last)}` : ''),
                 summary:
                   `${hours.toFixed(1)} h ${past ? 'booked' : 'with people on it'}` +
                   (waiting > 0 ? ` + ${waiting.toFixed(1)} h with nobody on it yet` : '') +
                   (crews.length > 0
                     ? ` · ${crews[0].pools.join(' + ')} ${demand.toFixed(1)} of ${cap.toFixed(1)} h (${pctText(cap > 0 ? (demand / cap) * 100 : Infinity)})`
                     : ''),
                 groups: [{ name: group.line.name, entries: mergeEntries(picked.map((d) => d.entries)) }],
               },
               at,
             );
           }}
           axis={axis}
           left={labelWidth}
           width={gridWidth}
           line={group.line.name}
         />
       )}
      </div>

      {!collapsed && (group.rows.length === 0 ? (
        // A lane whose work lives on its benches (benchOrders is set) holds
        // none of its own — every order is added straight to a bench now, so
        // a "Drop an order here" row on the lane would invite a drop the plan
        // has nowhere to put. Its benches carry their own empty prompt.
        group.benchOrders !== undefined ? null : (
          <div className={`arow empty ${group.line.parent ? 'bench' : ''}`}>
            <div className="acell order">
              {group.line.schedulable
                ? filtered
                  ? 'No orders match the date filter'
                  : 'Drop an order here'
                : 'No orders on this line'}
            </div>
          </div>
        )
      ) : (
        group.rows.map((row) => (
          <OrderRowView
            key={String(row.job.id)}
            row={row}
            board={board}
            allRows={allRows}
            gridWidth={gridWidth}
            selected={selectedJobId === String(row.job.id)}
            onSelect={onSelect}
            axis={axis}
            colWidths={colWidths}
            visibleDates={visibleDates}
            showWeekends={showWeekends}
            workerLines={todayLine}
            dependencyRelated={relatedJobIds.has(String(row.job.id))}
            marked={markedIds.has(String(row.job.id))}
            moveWith={moveWith}
            floorISO={rowFloors.get(String(row.job.id)) ?? null}
            onMark={onMark}
            onDependencyHover={onDependencyHover}
          />
        ))
      ))}
    </section>
  );
}

/** Build positions across a line, or across the benches a lane is made of. */
function benchPositions(board: AssemblyGanttView, group: LineGroup): number {
  if (group.benchOrders === undefined) return group.line.parallelOrders;
  return board.groups
    .filter((g) => g.line.parent === group.line.key)
    .reduce((sum, g) => sum + g.line.parallelOrders, 0) || group.line.parallelOrders;
}

/** Every order a line holds, reaching into its benches for a lane made of them. */
function rowsOfLine(board: AssemblyGanttView, key: LineKey): OrderRow[] {
  return board.groups
    .filter((g) => g.line.key === key || g.line.parent === key)
    .flatMap((g) => g.rows);
}

const hoursText = (hours: number) =>
  `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} h`;

/** A load as a percentage, or what stands in for one with nothing to divide by. */
const pctText = (pct: number) => (Number.isFinite(pct) ? `${Math.round(pct)}%` : 'no crew');

/**
 * A folded line's days, one column each: as tall as the line's hours are
 * against what the crews it draws on can work that day, coloured by that
 * share. The figures in it are the hours with people on them, and — in blue —
 * the hours of orders nobody is on yet that have to be worked that day to make
 * their Due Date. A folded week is one column for the week.
 */
function LineLoadStrip({
  days,
  capacity,
  spans,
  onOpen,
  axis,
  left,
  width,
  line,
}: {
  days: LineDayLoad[];
  capacity: (LineCapacity | undefined)[];
  spans: readonly WeekSpan[];
  /** Days `from` up to `to` were pressed — one day, or a folded week: list their orders. */
  onOpen: (from: number, to: number, at: { x: number; y: number }) => void;
  axis: DayAxis;
  left: number;
  width: number;
  line: string;
}) {
  const cell = (
    key: string,
    from: number,
    to: number,
    heading: string,
    detail: string[],
  ) => {
    const picked = days.slice(from, to);
    const hours = picked.reduce((n, d) => n + d.hours, 0);
    const waiting = picked.reduce((n, d) => n + d.unstaffedHours, 0);
    if (hours <= 0 && waiting <= 0) return null;
    const crews = capacity.slice(from, to).filter((c): c is LineCapacity => Boolean(c) && c!.pct !== null);
    const cap = crews.reduce((n, c) => n + c.capacity, 0);
    const pool = crews.reduce((n, c) => n + c.demand, 0);
    const share = cap > 0 ? ((hours + waiting) / cap) * 100 : Infinity;
    const x = axis.offsets[from];
    return (
      <button
        type="button"
        key={key}
        className={`aline-day${to - from > 1 ? ' week' : ''}${crews.length === 0 ? ' idle' : ''}`}
        style={{ left: x, width: axis.offsets[to] - x }}
        title={[
          `${line} · ${heading}: ${hours.toFixed(1)} h with people on it`,
          ...detail,
          ...(waiting > 0 ? [`${waiting.toFixed(1)} h (blue) of orders waiting for a crew, to be worked by their Due Date`] : []),
          crews.length > 0
            ? `${pctText(share)} of the ${cap.toFixed(1)} h ${crews[0].pools.join(' + ')} can work` +
              ` · the crew as a whole is at ${pctText((pool / cap) * 100)}`
            : 'No crew group lists this line — set one under Crew capacity',
          'Click for the orders',
        ].join('\n')}
        onClick={(e) => onOpen(from, to, { x: e.clientX, y: e.clientY })}
      >
        <LoadColumn
          crewed={hours}
          waiting={waiting}
          capacity={cap}
          band={crews.length > 0 ? loadBand(share) : 'idle'}
        />
        <span className="aline-figures">
          {hours > 0 && <b>{hoursText(hours)}</b>}
          {waiting > 0 && <span className="aline-wait">{hoursText(waiting)}</span>}
        </span>
      </button>
    );
  };
  return (
    <div className="aline-load" style={{ left, width }}>
      {spans.map((span) =>
        span.folded
          ? cell(
              `week-${span.key}`,
              span.from,
              span.to,
              `${span.label} (${formatShortDay(span.first)}–${formatShortDay(span.last)})`,
              [],
            )
          : range(span.from, span.to).map((i) => {
              const day = days[i];
              return cell(
                day.key,
                i,
                i + 1,
                formatShortDay(day.date),
                day.orders.length
                  ? [
                      `${day.people} ${day.people === 1 ? 'person' : 'people'}, ` +
                        `${day.orders.length} of ${day.positions} positions (${day.orders.join(', ')})`,
                    ]
                  : [],
              );
            }),
      )}
    </div>
  );
}

/** What a pressed day lists: a heading, its figures, and the orders by line. */
interface DayDetailContent {
  title: string;
  summary: string;
  groups: { name: string; entries: DayOrderEntry[] }[];
  /** Set for one whole day on every line: the board can be narrowed to it. */
  day?: string;
}

/**
 * A load as a column: as tall as the hours asked are against the hours the
 * crews can work. Solid in the day's band for work with people on it, blue on
 * top for orders nobody is on yet. Past capacity the column is scaled to fit
 * and a tick marks where capacity sits, so what is over reads above it.
 */
function LoadColumn({
  crewed,
  waiting,
  capacity,
  band,
  label,
}: {
  crewed: number;
  waiting: number;
  capacity: number;
  band: string;
  label?: string;
}) {
  const asked = crewed + waiting;
  const scale = Math.max(asked, capacity) || 1;
  const pct = (h: number) => `${Math.min(100, (h / scale) * 100)}%`;
  return (
    <span className={`load-col ${band}`}>
      <i className="lc-crewed" style={{ height: pct(crewed) }} />
      <i className="lc-waiting" style={{ bottom: pct(crewed), height: pct(waiting) }} />
      {asked > capacity && capacity > 0 && <i className="lc-cap" style={{ bottom: pct(capacity) }} />}
      {label && <b className="lc-label">{label}</b>}
    </span>
  );
}

const KIND_LABEL: Record<DayOrderEntry['kind'], string> = {
  crewed: 'crew',
  booked: 'booked',
  waiting: 'no crew yet',
};

/**
 * The orders behind one day's load, beside where it was pressed. Pressing an
 * order selects it on the board; pressing anywhere else, or Esc, closes it.
 */
function DayDetail({
  detail,
  at,
  onPick,
  onClose,
  filteredDay,
  onFilter,
}: {
  detail: DayDetailContent;
  at: { x: number; y: number };
  onPick: (jobId: string) => void;
  onClose: () => void;
  /** The day the board is narrowed to, if any. */
  filteredDay?: string | null;
  /** Narrow the board to the orders running on a day, or (null) stop. */
  onFilter?: (day: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [onClose]);
  const width = 380;
  const left = Math.max(8, Math.min(at.x - 20, window.innerWidth - width - 8));
  const top = Math.min(at.y + 12, window.innerHeight - 160);
  const shown = detail.groups.filter((g) => g.entries.length > 0);
  return (
    <div
      ref={box}
      className="day-detail"
      role="dialog"
      aria-label={detail.title}
      style={{ left, top, width, maxHeight: `calc(100vh - ${top + 12}px)` }}
    >
      <header>
        <strong>{detail.title}</strong>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <p className="day-detail-sum">{detail.summary}</p>
      {detail.day && onFilter && (
        <button
          type="button"
          className="day-detail-filter"
          onClick={() => onFilter(filteredDay === detail.day ? null : detail.day!)}
        >
          {filteredDay === detail.day ? 'Show every order again' : 'Show only the orders running this day'}
        </button>
      )}
      {shown.length === 0 && <p className="day-detail-sum">Nothing planned.</p>}
      {shown.map((group) => (
        <section key={group.name}>
          {detail.groups.length > 1 && (
            <h4>
              {group.name}
              <span>{group.entries.reduce((n, e) => n + e.hours, 0).toFixed(1)} h</span>
            </h4>
          )}
          <ul>
            {group.entries.map((e, i) => (
              <li key={`${e.jobId}-${e.kind}-${i}`}>
                <button
                  type="button"
                  className={`day-entry ${e.kind}`}
                  onClick={() => onPick(e.jobId)}
                  title={`${e.description}\nOn ${e.line}` + (e.due ? ` · due ${formatShortDay(e.due)}` : '')}
                >
                  <b>{e.order}</b>
                  <span className="day-entry-kind">
                    {KIND_LABEL[e.kind]}
                    {e.kind === 'crewed' && e.people > 0 ? ` · ${e.people}p` : ''}
                    {e.kind === 'waiting' && e.due ? ` · due ${formatShortDay(e.due)}` : ''}
                  </span>
                  <span className="day-entry-h">{e.hours.toFixed(1)} h</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function AssemblyGantt({
  board,
  unreleasedHidden = 0,
}: {
  board: AssemblyGanttView;
  /** Orders Released Only is keeping off this board, for the switch's title. */
  unreleasedHidden?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const releasedOnly = useUiStore((s) => s.releasedOnly);
  const setReleasedOnly = useUiStore((s) => s.setReleasedOnly);
  const select = useUiStore((s) => s.select);
  const selectedJobId = useUiStore((s) => s.selectedJobId);
  const dayWidth = useUiStore((s) => s.dayWidth);
  const dayWidths = useUiStore((s) => s.dayWidths);
  const colWidths = useUiStore((s) => s.colWidths);
  const cols = useUiStore((s) => s.cols);
  const toggleCol = useUiStore((s) => s.toggleCol);
  const visibleDates = useUiStore((s) => s.dateCols);
  const toggleDate = useUiStore((s) => s.toggleDateCol);
  const hiddenLines = useUiStore((s) => s.hiddenLines);
  const toggleLine = useUiStore((s) => s.toggleLine);
  const orderDay = useUiStore((s) => s.orderDay);
  const setOrderDay = useUiStore((s) => s.setOrderDay);
  const dueSoon = useUiStore((s) => s.dueSoon);
  const showWeekends = useUiStore((s) => s.showWeekends);
  const sort = useUiStore((s) => s.orderSort);
  const changeSort = useUiStore((s) => s.changeOrderSort);
  const marked = useUiStore((s) => s.marked);
  const toggleMark = useUiStore((s) => s.toggleMark);
  const workerLineOverrides = usePlanStore((s) => s.workerLines);
  const removeVirtualLine = usePlanStore((s) => s.removeVirtualLine);
  const lineOrder = usePlanStore((s) => s.lineOrder);
  const moveLine = usePlanStore((s) => s.moveLine);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  // The board opens on its lines, one row each, and a line is opened to see
  // its orders. Only what has been pressed is held here. A line nobody has
  // pressed is folded — unless a filter is on: that asks for orders, and a
  // board of folded lines would answer with none of them.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const filtering = orderDay !== null || dueSoon;
  const isFolded = (key: string): boolean => !(opened[key] ?? filtering);
  const [dayDetail, setDayDetail] = useState<{
    detail: DayDetailContent;
    at: { x: number; y: number };
  } | null>(null);
  const openDay = useCallback(
    (detail: DayDetailContent, at: { x: number; y: number }) => setDayDetail({ detail, at }),
    [],
  );
  const closeDay = useCallback(() => setDayDetail(null), []);
  /** The right-click menu: which orders it acts on, and where it was opened. */
  const [bulk, setBulk] = useState<{ ids: string[]; at: { x: number; y: number } } | null>(null);
  const closeBulk = useCallback(() => setBulk(null), []);
  const weekView = useUiStore((s) => s.weekView);
  const weekFold = useUiStore((s) => s.weekFold);
  const setWeekFold = useUiStore((s) => s.setWeekFold);
  // Not stopped at the engine's fortnight: at least the weeks asked for, and
  // out to every planned bar and every waiting order's Due Date.
  const spanDays = useMemo(
    () => {
      // Out to the end of the last week, so the last folded week is a whole
      // week's load against a whole week's capacity.
      const days = timelineDays(board, TIMELINE_MIN_WEEKS);
      const last = addCalendarDays(board.horizonStart, days - 1);
      return days + (6 - ((last.getDay() + 6) % 7));
    },
    [board],
  );
  const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);

  const days = useMemo(() => {
    const calendar = Array.from({ length: spanDays }, (_, i) =>
      addCalendarDays(board.horizonStart, i),
    );
    return showWeekends ? calendar : calendar.filter((day) => !isWeekend(day));
  }, [spanDays, board.horizonStart, showWeekends]);
  /*
   * The week's widths, and everything read off them.
   *
   * A day the reader has dragged keeps the width they gave it; every other one
   * answers to the zoom. The axis is what turns that run of widths into the
   * positions the stripes, the headings, the bars and the drop all work in —
   * see `dayAxis`.
   */
  // The weeks along the axis — each one column when zoomed out to weeks.
  const spans = useMemo(
    () => weekSpans(days, weekView, weekFold),
    [days, weekView, weekFold],
  );
  const axis = useMemo(
    () =>
      dayAxis({
        widths: foldedWidths(spans, (i) => dayWidths[toDayKey(days[i])] ?? dayWidth),
        fallback: dayWidth,
      }),
    [spans, days, dayWidths, dayWidth],
  );
  const gridWidth = axis.total;
  // A hidden Qty / Hours / Team column is laid out as zero width, so the grid
  // reclaims its room; the same widths drive the CSS vars below and every row.
  const laidOut = shownWidths(colWidths, cols);
  const headLefts = frozenLefts(visibleDates, laidOut);
  const labelWidth = headLefts.total;
  const allRows = useMemo(
    () => board.groups.flatMap((group) => group.rows),
    [board],
  );
  const orderedGroups = useStableBoardOrder(board.groups, sort);
  const crewPools = usePlanStore((s) => s.crewPools);
  /*
   * Every day column against the crews: what the banner shows, and what each
   * line's row is tinted by. Over every row, not the filtered ones —
   * how full a day is does not change because the view was narrowed.
   */
  const capacity = useMemo(() => {
    const positions = new Map(board.groups.map((g) => [g.line.key, benchPositions(board, g)]));
    return capacityDays(
      board.groups.flatMap((g) => g.rows),
      crewPools,
      (lane) => positions.get(lane) ?? 0,
      days,
      board.today,
    );
  }, [board, crewPools, days]);
  const rowsByLine = useMemo(
    () => new Map(board.groups.map((g) => [g.line.key, rowsOfLine(board, g.line.key)])),
    [board],
  );
  /**
   * The ids a date filter leaves on screen, or null when there is no filter.
   *
   * Worked out across the whole board rather than line by line, because what
   * an order waits for is usually on another line — the press work on PMD,
   * most often — and a chain cut at the line boundary is what made the arrows
   * come and go as bars were dragged.
   */
  const visibleIds = useMemo(
    () =>
      filteredOrderIds(allRows, {
        orderDay,
        dueSoon,
        dueSoonDays: DUE_SOON_DAYS,
        today: board.today,
      }),
    [allRows, board.today, orderDay, dueSoon],
  );
  const visibleGroups = useMemo(
    () =>
      // Arranged before it is narrowed: the sequence is the whole board's, so
      // folding a line away must not change where the rest of them sit.
      arrangeLines(
        orderedGroups.map((group) => ({ ...group, key: group.line.key })),
        lineOrder,
      ).filter(group =>
        !hiddenLines.includes(group.line.key) &&
        // A lane taken off the board takes its benches with it: three orphan
        // benches indented under nothing is not a board anybody can read.
        !(group.line.parent && hiddenLines.includes(group.line.parent)) &&
        // Folding a lane folds its benches away too. A lane made of benches
        // holds no rows of its own, so folding it had nothing to hide and the
        // triangle did nothing — the benches are separate groups. Fold them
        // with their parent so the ▶/▼ on Smart Soft Seating or UPHOLSTRY
        // opens and shuts the whole section.
        !(group.line.parent && isFolded(group.line.parent)) &&
        (!orderDay || group.line.schedulable),
      ).map((group) => ({
        ...group,
        rows: visibleIds
          ? group.rows.filter((row) => visibleIds.has(String(row.job.id)))
          : group.rows,
        // How many the line actually holds, which is not what is on screen
        // once a window is on. The header counted the rows it was given, so a
        // filtered line read as a line with fewer orders on it.
        //
        // The line keeps its own load for the same reason. How much work is
        // standing on a line does not change because somebody narrowed the
        // view to one day, and the engine has already worked it out over all
        // of them — this used to throw that away and count the filtered rows.
        total: group.rows.length,
      })),
    [orderedGroups, visibleIds, hiddenLines, orderDay, lineOrder, opened, filtering],
  );
  const visibleRows = useMemo(
    () => visibleGroups.flatMap((group) => group.rows),
    [visibleGroups],
  );
  // Whether the master triangle in the Order block is offering to open the
  // board or to fold it. An empty board offers to fold, which does nothing and
  // says nothing false.
  const allFolded =
    visibleGroups.length > 0 &&
    visibleGroups.every((group) => isFolded(group.line.key));
  const markedIds = useMemo(() => new Set(marked), [marked]);
  /*
   * The marked set and where each of its bars is drawn, so dragging any one of
   * them can move the rest by the same number of columns. The day a bar sits on
   * is not the day it was pinned to — a predecessor or a full line may have
   * pushed it out — so the drawn day is what a relative move has to start from.
   */
  const moveWith = useMemo(
    () =>
      markedSet(
        board.groups.flatMap((group) => group.rows),
        markedIds,
        board.today,
      ),
    [markedIds, board.groups, board.today],
  );
  /**
   * The earliest day each order may begin, whoever drags it. A single bar used
   * to be written wherever the pointer left it and let the schedule argue
   * afterwards, so a drag the schedule was always going to refuse still pinned
   * the order — and a pinned order stops falling in behind its crew and its
   * predecessor. A marked run has asked this question all along; now one bar
   * asks it too, and a drag that cannot move writes nothing.
   */
  const rowFloors = useMemo(() => {
    const byId = rowIndex(allRows);
    return new Map(
      allRows.map((row) => [
        String(row.job.id),
        earliestStart(byId, row, board.today).toISOString(),
      ]),
    );
  }, [allRows, board.today]);

  const dependencyFocusId = selectedJobId ?? hoveredJobId;
  const relatedJobIds = useMemo(() => {
    const edges = visibleRows.flatMap((row) =>
      row.predecessors.map((dependency) => ({
        key: `${String(dependency.onJobId)}->${String(row.job.id)}`,
        sourceId: String(dependency.onJobId),
        targetId: String(row.job.id),
      })),
    );
    return dependencyFocus(edges, dependencyFocusId).nodeIds;
  }, [dependencyFocusId, visibleRows]);
  // Every name in the header carries five load squares, so the whole roster's
  // week is worked out once here rather than once per chip on every render.
  // From today: the week to come is what a supervisor allocates against.
  const rosterLoads = useMemo(
    () =>
      rosterLoad(
        board.workers,
        allRows,
        board.today,
        undefined,
        board.workerOnLeave,
      ),
    [board, allRows],
  );
  // Who is on site with nothing allocated, and who is not in at all — the two
  // halves of the morning question, read while deciding who goes on the order
  // in front of you and who is going to pick up what somebody put down.
  const team = useMemo(
    () => teamSummary(board.workers, allRows, board.today, board.workerOnLeave),
    [board.workers, allRows, board.today, board.workerOnLeave],
  );
  /** What each absent person has left behind today, worst first. */
  const onLeaveOrders = useMemo(
    () => onLeaveWorkerOrders(allRows, board.today),
    [allRows, board.today],
  );
  /** The begun orders that today has nobody at all on — the hand-over queue. */
  const stranded = useMemo(
    () =>
      new Set(
        strandedOrders(allRows, board.today).map((row) => String(row.job.id)),
      ),
    [allRows, board.today],
  );

  // The Free / On Leave rolls. They read the whole roster, not one column, so
  // they live in the Order heading — which has room to spare beside its one
  // short word — rather than over the Team column, which is now hideable and
  // would take the two lists off the board with it. Still drop targets: a name
  // dragged between them marks somebody off or back on.
  const crewRolls = (
    <div className="order-crew team-head">
      <CrewRoll
        roll="free"
        label="Free"
        count={team.free.length}
        empty="all allocated"
        listTitle={
          (team.free.length === 0
            ? 'Everybody on site today is on an order'
            : `Not allocated today: ${team.free.map((w) => w.name).join(', ')}`) +
          (unlocked ? '\nDrag a name into On Leave to mark them off' : '')
        }
      >
        {team.free.map((worker) => (
          <CrewName
            key={String(worker.id)}
            worker={worker}
            roll="free"
            className="team-name"
            draggable={unlocked}
            title={
              `${worker.name} — in today, nothing allocated` +
              (unlocked
                ? '\nDrag onto a line to move them, or into On Leave'
                : '')
            }
          >
            {worker.name}
          </CrewName>
        ))}
      </CrewRoll>
      <CrewRoll
        roll="onLeave"
        label="On Leave"
        count={team.onLeave.length}
        empty="full shift in"
        listTitle={
          (team.onLeave.length === 0
            ? 'Everybody on the roster is in today'
            : `Not in today: ${team.onLeave.map((w) => w.name).join(', ')}`) +
          (unlocked ? '\nDrag a name into Free to put them back in' : '')
        }
      >
        {team.onLeave.map((worker) => {
          const left = onLeaveOrders.get(String(worker.id)) ?? [];
          const held = left.filter((row) => stranded.has(String(row.job.id)));
          // A name with orders behind it is the shortest route to them: press
          // it and the board selects the first one nobody is covering, which
          // is the one to hand over.
          return (
            <CrewName
              key={String(worker.id)}
              worker={worker}
              roll="onLeave"
              className={`team-name on-leave ${held.length > 0 ? 'stranded' : ''}`}
              draggable={unlocked}
              onClick={
                held.length > 0 ? () => select(String(held[0].job.id)) : undefined
              }
              title={
                (left.length === 0
                  ? `${worker.name} is not in today — nothing was on them`
                  : `${worker.name} is not in today\n` +
                    `Was on: ${left.map((row) => jobNumOf(String(row.job.id))).join(', ')}` +
                    (held.length > 0
                      ? `\nNobody else on: ${held
                          .map((row) => jobNumOf(String(row.job.id)))
                          .join(', ')} — needs a hand-over`
                      : '\nCovered by the rest of the crew')) +
                (unlocked ? '\nDrag into Free to put them back in' : '')
              }
            >
              {worker.name}
              {held.length > 0 && (
                <i className="team-name-held" aria-hidden="true">
                  {held.length}
                </i>
              )}
            </CrewName>
          );
        })}
      </CrewRoll>
    </div>
  );
  // One row per person: an explicit drag wins; source data supplies only the
  // initial line for plans that have never placed that person.
  const todayLine = useMemo(
    () =>
      lineOfWorkerToday(
        board.workers,
        allRows,
        board.today,
        workerLineOverrides,
      ),
    [board.workers, allRows, board.today, workerLineOverrides],
  );
  // Hours booked per day against the hours the shift can deliver — the same
  // arithmetic as the per-person and per-line loads, so the three agree. The
  // columns behind today instead carry what was booked as output.
  //
  // Over every row, not the ones the date filter is showing: how full a day
  // is does not change because somebody narrowed the view, and the counts
  // beside it have always been over the whole board.
  const dayLoads = useMemo(() => {
    const calendar = boardDayLoads(
      allRows,
      board.workers,
      board.horizonStart,
      spanDays,
      board.today,
      board.workerOnLeave,
    );
    return showWeekends ? calendar : calendar.filter((load) => load.working);
  }, [allRows, board, showWeekends, spanDays]);

  /** One day's heading: a column as tall as the day is full. */
  const dayHead = (d: Date, i: number, span: WeekSpan) => {
    const load = dayLoads[i];
    const cap = capacity[i];
    const pct = Math.round(cap.pct);
    // A closed day still shows what landed on it — that is the case for
    // overtime — but muted, so it never reads as normal capacity.
    const band = cap.working ? cap.band : 'closed';
    const day = toDayKey(d);
    const title = [
      `${formatShortDay(d)} — asked of the crews`,
      `${cap.crewed.toFixed(1)} h with people on it` +
        (cap.waiting > 0 ? `, ${cap.waiting.toFixed(1)} h of orders with nobody on them yet (blue)` : ''),
      `of ${cap.capacity.toFixed(1)} h the crews can work — ${pct}%` +
        (cap.working ? '' : ' · factory closed, needs overtime'),
      ...cap.pools.map((p) =>
        `  ${p.name} (${p.people}): ${p.demand.toFixed(1)} / ${p.capacity.toFixed(1)} h — ${pctText(p.pct)}`,
      ),
      ...(cap.unpooled > 0
        ? [`  ${cap.unpooled.toFixed(1)} h on lines no crew group lists`]
        : []),
    ].join('\n');
    return (
      <div
        key={day}
        className={`daycol ${load.working ? '' : 'weekend'} ${load.isToday ? 'today' : ''} ${load.past ? 'past' : ''} ${orderDay === day ? 'filtered' : ''}`}
        style={{ left: axis.offsets[i], width: axis.widths[i] }}
        title={`${title}\nClick for the orders`}
        onClick={(e) => {
          // The fold chip folds and the edge resizes the day; the rest of
          // the cell lists what the day is made of.
          if ((e.target as Element).closest('button, .col-resize')) return;
          openDay(
            {
              title: `${formatShortDay(d)} · every line`,
              summary:
                `${cap.crewed.toFixed(1)} h with people on it` +
                (cap.waiting > 0 ? `, ${cap.waiting.toFixed(1)} h with nobody on it yet` : '') +
                ` of ${cap.capacity.toFixed(1)} h — ${pct}%`,
              groups: board.groups
                .filter((g) => cap.lines.has(g.line.key))
                .map((g) => ({ name: g.line.name, entries: cap.lines.get(g.line.key)!.load.entries })),
              day,
            },
            { x: e.clientX, y: e.clientY },
          );
        }}
      >
        <span className="daycol-top">
          {span.from === i && (
            <button
              type="button"
              className="week-fold"
              onClick={() => setWeekFold(span.key, true)}
              aria-label={`Fold week ${span.label}`}
            >
              ◂
            </button>
          )}
          <span className="daycol-date">{formatShortDay(d)}</span>
        </span>
        <LoadColumn crewed={cap.crewed} waiting={cap.waiting} capacity={cap.capacity} band={band} label={`${pct}%`} />
        {/* Every day is dragged by its own edge, the way the seven columns
            to the left of it are. */}
        <DayGrip day={day} width={axis.widths[i]} />
      </div>
    );
  };

  /** A folded week's heading: the week's column, summed from its days. */
  const weekHead = (span: WeekSpan) => {
    const caps = capacity.slice(span.from, span.to);
    const week = weekLoad(caps);
    const pct = Math.round(week.pct);
    const dates = `${formatShortDay(span.first)}–${formatShortDay(span.last)}`;
    const left = axis.offsets[span.from];
    const width = axis.offsets[span.to] - left;
    return (
      <div
        key={`week-${span.key}`}
        className="daycol weekcol"
        style={{ left, width }}
        title={
          `${span.label} · ${dates}\n` +
          `${week.crewed.toFixed(1)} h with people on it` +
          (week.waiting > 0 ? `, ${week.waiting.toFixed(1)} h with nobody on it yet (blue)` : '') +
          ` of ${week.capacity.toFixed(1)} h the crews can work — ${pct}%\nClick for the orders`
        }
        onClick={(e) => {
          if ((e.target as Element).closest('button')) return;
          openDay(
            {
              title: `${span.label} · ${dates} · every line`,
              summary:
                `${week.crewed.toFixed(1)} h with people on it` +
                (week.waiting > 0 ? `, ${week.waiting.toFixed(1)} h with nobody on it yet` : '') +
                ` of ${week.capacity.toFixed(1)} h — ${pct}%`,
              groups: board.groups
                .filter((g) => caps.some((c) => c.lines.has(g.line.key)))
                .map((g) => ({
                  name: g.line.name,
                  entries: mergeEntries(caps.map((c) => c.lines.get(g.line.key)?.load.entries ?? [])),
                })),
            },
            { x: e.clientX, y: e.clientY },
          );
        }}
      >
        <span className="daycol-top">
          <button
            type="button"
            className="week-fold open"
            onClick={() => setWeekFold(span.key, false)}
            aria-label={`Open week ${span.label}`}
          >
            {span.label} ▸
          </button>
        </span>
        <LoadColumn crewed={week.crewed} waiting={week.waiting} capacity={week.capacity} band={week.band} label={`${pct}%`} />
      </div>
    );
  };

  const dateHead = (
    key: DateCol,
    label: string,
    sortable: boolean,
  ) =>
    visibleDates[key] && (
      <div className={`acell date ${key} date-head frozen`} style={{ left: headLefts.date[key] }}>
        {sortable ? (
          <button
            className={`date-sort ${sort?.key === key ? 'active' : ''}`}
            onClick={() => changeSort(key as OrderSortKey)}
            title={`Sort Assembly lines by ${label}; PMD keeps its source order`}
          >
            {label}
            <span aria-hidden="true">
              {sort?.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
            </span>
          </button>
        ) : (
          <span>{label}</span>
        )}
        <button
          className="date-hide"
          onClick={() => toggleDate(key)}
          title={`Hide ${label}`}
        >
          −
        </button>
        <ColumnGrip column={key} label={label} />
      </div>
    );

  return (
    <div
      ref={root}
      className="assy"
      // Right-click on an order: its menu, acting on every Ctrl-marked order
      // when the one pressed is among them.
      onContextMenu={(e) => {
        const id = (e.target as Element).closest?.('[data-row-id]')?.getAttribute('data-row-id');
        if (!id) return;
        e.preventDefault();
        setBulk({ ids: bulkTargets(id, marked), at: { x: e.clientX, y: e.clientY } });
      }}
      style={
        {
          minWidth: labelWidth + gridWidth,
          '--order-w': `${laidOut.order}px`,
          '--qty-w': `${laidOut.qty}px`,
          '--hours-w': `${laidOut.hours}px`,
          '--start-w': `${laidOut.start}px`,
          '--due-w': `${laidOut.due}px`,
          '--expect-w': `${laidOut.expect}px`,
          '--team-w': `${laidOut.team}px`,
        } as React.CSSProperties
      }
    >
      {/*
        Day backgrounds for the whole board, drawn once behind the rows rather
        than per row: today is picked out and days already gone are faded.
        Saturday and Sunday are greyed when their optional columns are visible.
      */}
      <div className="day-stripes" style={{ left: labelWidth, width: gridWidth }}>
        {dayLoads.map((load, i) => (
          <div
            key={load.key}
            className={`stripe ${load.working ? '' : 'closed'} ${load.isToday ? 'today' : ''} ${load.past ? 'past' : ''}`}
            style={{ left: axis.offsets[i], width: axis.widths[i] }}
          />
        ))}
      </div>

      <DragTimeGuide horizonStart={board.horizonStart} labelWidth={labelWidth} />
      <DependencyArrows
        root={root}
        rows={visibleRows}
        focusJobId={dependencyFocusId}
        labelWidth={labelWidth}
      />

      <div className="assy-sticky">
        <div className="assy-head">
          <div className="acell order order-head">
            <div className="order-head-line">
              <span className="head-name">Order</span>
              {/* One press for the whole board. Each line has its own triangle
                  on its own row, which is the right size of control for one
                  line and eight presses for the question a supervisor actually
                  asks — "show me the lines, not the orders" — on the way to
                  finding which line a job is on. */}
              <button
                type="button"
                className="fold-all"
                onClick={() =>
                  // Opening opens the benches under a lane too, which are
                  // not on screen while their lane is folded.
                  setOpened(
                    Object.fromEntries(
                      orderedGroups.map((group) => [group.line.key, allFolded]),
                    ),
                  )
                }
                aria-expanded={!allFolded}
                aria-label={allFolded ? 'Show every line’s orders' : 'Fold every line’s orders away'}
                title={allFolded ? 'Show every line’s orders' : 'Fold every line’s orders away'}
              >
                <span aria-hidden="true">{allFolded ? '▶' : '▼'}</span>
              </button>
              {/* Which orders the board plans with. Not a view filter: the
                  board is planned again from the orders it keeps, so line and
                  day loads are the capacity that work needs. */}
              <div className="release-scope" role="group" aria-label="Orders to plan with">
                <button
                  type="button"
                  className={releasedOnly ? '' : 'on'}
                  aria-pressed={!releasedOnly}
                  onClick={() => setReleasedOnly(false)}
                  title="Plan with every order in the export, released or not — what the lines would carry once the rest is released"
                >
                  All
                </button>
                <button
                  type="button"
                  className={releasedOnly ? 'on' : ''}
                  aria-pressed={releasedOnly}
                  onClick={() => setReleasedOnly(true)}
                  title={
                    'Plan with released orders only (JobHead_JobReleased). An unreleased order stays if it has ' +
                    'begun on the floor or a released order waits for it.' +
                    (releasedOnly && unreleasedHidden > 0
                      ? ` ${unreleasedHidden} unreleased order${unreleasedHidden === 1 ? ' is' : 's are'} off the board.`
                      : '')
                  }
                >
                  Released Only
                </button>
              </div>
            </div>
            {/* The roster's two rolls, moved here off the Team column. */}
            {crewRolls}
            {/* Grab the edge to give the description more room. */}
            <ColumnGrip column="order" label="Order" />
          </div>
          {cols.qty && (
            <div className="acell qty frozen" style={{ left: headLefts.qty }}>
              Qty
              <button
                className="date-hide"
                onClick={() => toggleCol('qty')}
                title="Hide Qty"
              >
                −
              </button>
              <ColumnGrip column="qty" label="Qty" />
            </div>
          )}
          {cols.hours && (
            <div
              className="acell hours frozen"
              style={{ left: headLefts.hours }}
            >
              Hours
              <button
                className="date-hide"
                onClick={() => toggleCol('hours')}
                title="Hide Hours"
              >
                −
              </button>
              <ColumnGrip column="hours" label="Hours" />
            </div>
          )}
          {dateHead('start', DATE_COL_LABEL.start, true)}
          {dateHead('due', DATE_COL_LABEL.due, true)}
          {dateHead('expect', DATE_COL_LABEL.expect, false)}
          {/* The per-order crew chips. The Free / On Leave rolls that used to
              head this column now sit in the Order heading, so this is a plain
              titled column again — and one the reader can hide, since with the
              rolls gone it carries only the names already on each order's bar
              menu. */}
          {cols.team && (
            <div
              className="acell team frozen"
              style={{ left: headLefts.team }}
            >
              <span className="head-name">Team</span>
              <button
                className="date-hide"
                onClick={() => toggleCol('team')}
                title="Hide Team"
              >
                −
              </button>
              <ColumnGrip column="team" label="Team" />
            </div>
          )}
          {/* Load histogram: one column per day, coloured by band. */}
          <div className="acell track" style={{ width: gridWidth }}>
            {spans.flatMap((span) =>
              span.folded
                ? [weekHead(span)]
                : range(span.from, span.to).map((i) => dayHead(days[i], i, span)),
            )}
          </div>
        </div>
      </div>

      {visibleGroups.map((group, i) => (
        <LineGroupView
          key={group.line.key}
          group={group}
          total={group.total}
          board={board}
          allRows={allRows}
          gridWidth={gridWidth}
          rosterLoads={rosterLoads}
          todayLine={todayLine}
          selectedJobId={selectedJobId}
          onSelect={select}
          axis={axis}
          colWidths={colWidths}
          visibleDates={visibleDates}
          showWeekends={showWeekends}
          collapsed={isFolded(group.line.key)}
          lineRows={rowsByLine.get(group.line.key) ?? []}
          dates={days}
          capacity={capacity}
          spans={spans}
          labelWidth={labelWidth}
          onOpenDay={openDay}
          onToggle={() => setOpened((current) => ({ ...current, [group.line.key]: isFolded(group.line.key) }))}
          onHide={() => toggleLine(group.line.key)}
          onClose={
            unlocked && isVirtualLine(group.line.key)
              ? () => removeVirtualLine(group.line.key as VirtualLineKey)
              : undefined
          }
          neighbours={{
            before: visibleGroups[i - 1]?.line.key ?? null,
            after: visibleGroups[i + 1]?.line.key ?? null,
          }}
          onArrange={(onto) => moveLine(group.line.key, onto)}
          filtered={orderDay !== null || dueSoon}
          unlocked={unlocked}
          relatedJobIds={relatedJobIds}
          markedIds={markedIds}
          moveWith={moveWith}
          rowFloors={rowFloors}
          onMark={toggleMark}
          onDependencyHover={setHoveredJobId}
        />
      ))}
      {bulk && (
        <BulkActions ids={bulk.ids} at={bulk.at} rows={allRows} onClose={closeBulk} />
      )}
      {dayDetail && (
        <DayDetail
          detail={dayDetail.detail}
          at={dayDetail.at}
          onClose={closeDay}
          filteredDay={orderDay}
          onFilter={(day) => {
            setOrderDay(day);
            closeDay();
          }}
          onPick={(jobId) => {
            select(jobId);
            closeDay();
          }}
        />
      )}
    </div>
  );
}
