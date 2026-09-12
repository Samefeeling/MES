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
import { useEffect, useMemo, useRef, useState } from 'react';
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
  SHIFT_END_HOUR,
  SHIFT_START_HOUR,
  WORK_KIND_SHORT,
  type LineKey,
  type VirtualLineKey,
} from '@/domain/assembly';
import { addCalendarDays, isWeekend } from '@/engine/assembly/dates';
import { shiftColumnFraction } from '@/engine/assembly/shift';
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
  DATE_COLS,
  DATE_COL_LABEL,
  DUE_SOON_DAYS,
  useUiStore,
  type ClickPoint,
  type ColumnKey,
  type ColumnWidths,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';
import { DragTimeGuide } from './DragTimeGuide';
import { OrderBar } from './OrderBar';
import { DRAG_TYPE_LINE, lineDragId } from './lineDrag';
import { TeamChips } from './TeamChips';
import { WorkerLoadChip } from './WorkerLoadChip';
import { DependencyArrows } from './DependencyArrows';
import { dependencyFocus } from './dependencyRouter';
import {
  teamSummary,
  isDueSoon,
  isRunningOnDay,
  runningOrdersByDay,
  lineOfWorkerToday,
  withPredecessors,
  type OrderSortKey,
} from './boardView';
import { useStableBoardOrder } from './useStableBoardOrder';
import { earliestStart, markedSet, type MarkedMove } from './groupMove';
import { fromDayKey, toDayKey } from '@/lib/time';

/** How often the "now" line catches up with the clock. */
const CLOCK_TICK_MS = 5 * 60 * 1000;

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

/** A clock hour as text — 15.5 reads as 15:30. */
const hourLabel = (h: number): string =>
  TIME_FMT.format(
    new Date(2000, 0, 1, Math.floor(h), Math.round((h % 1) * 60)),
  );

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
function OrderGrip({ id, movable }: { id: string; movable: boolean }) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: !movable || !unlocked,
    data: { type: 'job', jobId: id },
  });
  const draggable = movable && unlocked;
  return (
    <span
      ref={setNodeRef}
      className={`order-id ${draggable ? 'movable' : ''} ${isDragging ? 'dragging' : ''}`}
      title={
        movable
          ? unlocked
            ? `${id} — drag onto another line to move it there`
            : `${id} — sign in as ${gate} to move it to another line`
          : id
      }
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
    >
      {id}
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
  dayWidth,
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
  dayWidth: number;
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
  const isNew = useDataStore((state) =>
    state.newOrderIds.includes(String(row.job.id)),
  );
  const isContext = !row.line.schedulable;
  const lefts = frozenLefts(visibleDates, colWidths);
  const at = (key: DateCol): React.CSSProperties | undefined =>
    lefts.date[key] === undefined ? undefined : { left: lefts.date[key] };
  const startStyle = at('start');
  const dueStyle = at('due');
  const expectStyle = at('expect');
  const startAt = row.job.startDate;
  const mustStart = row.mustStartBy;
  const orderQty = row.job.remainingQty + row.job.completedQty;
  return (
    <div
      className={`arow ${selected ? 'selected' : ''} ${isContext ? 'context' : ''} ${row.completedToday ? 'completed-today' : ''} ${isNew ? 'new-order' : ''}`}
    >
      <div className="acell order">
        {/* A manual support order belongs to Factory General and the plan
            refuses to file it anywhere else, so it carries no grip. */}
        <OrderGrip id={String(row.job.id)} movable={!isContext && !row.job.manual} />
        {isNew && <span className="new-order-tag">NEW</span>}
        {/* On UPL the badge names the bench: Epicor calls both the softies and
            the upholstering "upholstery", and which of the three steps this is
            is the thing worth reading. */}
        {(row.kind !== 'general' || row.job.orderType) && (
          <span className={`order-type ${row.kind}`}>
            {row.job.manual ? 'SUPPORT' : row.kind === 'general'
              ? ORDER_TYPE_SHORT[row.job.orderType!]
              : WORK_KIND_SHORT[row.kind]}
          </span>
        )}
        <span className="order-desc">{row.job.description}</span>
      </div>
      {/* Ordered quantity, with what is still to make under it. */}
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
      <div
        className="acell hours frozen"
        style={{ left: lefts.hours }}
        title="Remaining standard labour hours used by the schedule"
      >
        {remainingHours(row.job).toFixed(1)} h
      </div>
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
      {visibleDates.due && <div className="acell date due frozen" style={dueStyle}>{fmt(row.job.dueDate)}</div>}
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
      <div className="acell track" style={{ width: gridWidth }}>
        <OrderBar
          row={row}
          horizonStart={board.horizonStart}
          dayWidth={dayWidth}
          gridWidth={gridWidth}
          showWeekends={showWeekends}
          readOnly={isContext}
          selected={selected}
          dependencyRelated={dependencyRelated}
          marked={marked}
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
  dayWidth,
  colWidths,
  visibleDates,
  showWeekends,
  collapsed,
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
  dayWidth: number;
  colWidths: ColumnWidths;
  visibleDates: DateCols;
  showWeekends: boolean;
  collapsed: boolean;
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
  const arrange = useDraggable({
    id: lineDragId(group.line.key),
    disabled: !unlocked,
    data: {
      type: DRAG_TYPE_LINE,
      lineKey: group.line.key,
      lineName: group.line.name,
    },
  });
  const load = group.load;
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
      className={`agroup ${isOver ? 'drop-active' : ''}`}
    >
      {/* A row, not one big button: the load chips inside it open their own
          popup, and a button cannot hold another button. The inner block is
          what sticks to the left edge, so the line's totals and its people
          stay readable however far right the grid is scrolled — the row
          itself has to span the whole grid to carry the background. */}
      <div className="agroup-head">
       <div className="agroup-head-in">
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
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
        <div
          ref={arrange.setNodeRef}
          className={`agroup-label ${unlocked ? 'arrangeable' : ''} ${arrange.isDragging ? 'arranging' : ''}`}
          title={
            unlocked
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
            if (!onto || !unlocked) return;
            e.preventDefault();
            onArrange(onto);
          }}
          {...(unlocked ? arrange.listeners : {})}
          {...(unlocked ? arrange.attributes : {})}
        >
          <span className="agroup-name">{group.line.name}</span>
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
              group.rows.length === total
                ? `${total} orders on this line`
                : `${group.rows.length} of ${total} orders shown — the rest are outside the date window`
            }
          >
            {group.rows.length === total
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
          {group.line.schedulable && (
            <span className="agroup-crew">
              {load.crew === 0
                ? 'nobody allocated'
                : `${load.crew} on line · ${load.daysOfWork!.toFixed(1)} d at ${load.capacityPerDay.toFixed(1)} h/day`}
            </span>
          )}
          {load.needsCrew > 0 && (
            <span className="agroup-gap">{load.needsCrew} need crew</span>
          )}
        </div>

        {/* Outside the label — it does something the label does not: it takes
            the line off the board altogether. */}
        <button
          type="button"
          className="agroup-hide"
          onClick={onHide}
          title={`Hide the ${group.line.name} line — bring it back from the header`}
          aria-label={`Hide the ${group.line.name} line`}
        >
          ×
        </button>
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

        {crew.length > 0 && (
          <span
            className="agroup-roster"
            title={`Operators currently assigned to ${group.line.name}`}
          >
            {crew.map((worker) => {
              const week = rosterLoads.get(String(worker.id));
              return week ? (
                <WorkerLoadChip
                  key={String(worker.id)}
                  worker={worker}
                  load={week}
                  line={group.line.key}
                  dragDisabled={
                    !unlocked
                  }
                />
              ) : null;
            })}
          </span>
        )}
       </div>
      </div>

      {!collapsed && (group.rows.length === 0 ? (
        <div className="arow empty">
          <div className="acell order">
            {group.line.schedulable
              ? filtered
                ? 'No orders match the date filter'
                : 'Drop an order here'
              : 'No orders on this line'}
          </div>
        </div>
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
            dayWidth={dayWidth}
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

export function AssemblyGantt({ board }: { board: AssemblyGanttView }) {
  const root = useRef<HTMLDivElement>(null);
  const select = useUiStore((s) => s.select);
  const selectedJobId = useUiStore((s) => s.selectedJobId);
  const dayWidth = useUiStore((s) => s.dayWidth);
  const colWidths = useUiStore((s) => s.colWidths);
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);

  // The clock behind the "now" line. Five minutes is as fine as the line is
  // worth reading, and it keeps the board from re-rendering every second.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const days = useMemo(() => {
    const calendar = Array.from({ length: board.horizonDays }, (_, i) =>
      addCalendarDays(board.horizonStart, i),
    );
    return showWeekends ? calendar : calendar.filter((day) => !isWeekend(day));
  }, [board.horizonDays, board.horizonStart, showWeekends]);
  const gridWidth = days.length * dayWidth;
  const headLefts = frozenLefts(visibleDates, colWidths);
  const labelWidth = headLefts.total;
  const allRows = useMemo(
    () => board.groups.flatMap((group) => group.rows),
    [board],
  );
  const orderedGroups = useStableBoardOrder(board.groups, sort);
  /**
   * The ids a date filter leaves on screen, or null when there is no filter.
   *
   * Worked out across the whole board rather than line by line, because what
   * an order waits for is usually on another line — the press work on PMD,
   * most often — and a chain cut at the line boundary is what made the arrows
   * come and go as bars were dragged.
   */
  const visibleIds = useMemo(() => {
    // Two narrowings, and an order has to satisfy both. Each keeps whatever
    // the orders it shows are waiting for, all the way up the chain: a chain
    // shown with its middle missing says less than no chain at all.
    const chosen: ((row: OrderRow) => boolean)[] = [];
    if (orderDay) {
      chosen.push((row) => row.line.schedulable && isRunningOnDay(row, fromDayKey(orderDay)));
    }
    if (dueSoon) {
      chosen.push((row) => row.line.schedulable && isDueSoon(row, board.today, DUE_SOON_DAYS));
    }
    if (chosen.length === 0) return null;
    const selected = withPredecessors(allRows, (row) => chosen.every((f) => f(row)));
    // Daily Assembly filtering excludes PMD, including PMD predecessors.
    if (orderDay) {
      for (const row of allRows) if (!row.line.schedulable) selected.delete(String(row.job.id));
    }
    return selected;
  }, [allRows, board.today, orderDay, dueSoon]);
  const visibleGroups = useMemo(
    () =>
      // Arranged before it is narrowed: the sequence is the whole board's, so
      // folding a line away must not change where the rest of them sit.
      arrangeLines(
        orderedGroups.map((group) => ({ ...group, key: group.line.key })),
        lineOrder,
      ).filter(group =>
        !hiddenLines.includes(group.line.key) &&
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
    [orderedGroups, visibleIds, hiddenLines, orderDay, lineOrder],
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
    visibleGroups.every((group) => collapsed[group.line.key]);
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
    const byId = new Map(allRows.map((row) => [String(row.job.id), row]));
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
    () => rosterLoad(board.workers, allRows, board.today),
    [board, allRows],
  );
  // Who is on site today with nothing allocated — the people still to reach
  // for, read while deciding who goes on the order in front of you.
  const team = useMemo(
    () => teamSummary(board.workers, allRows, board.today),
    [board.workers, allRows, board.today],
  );
  const runningByDay = useMemo(
    () => runningOrdersByDay(allRows, days),
    [allRows, days],
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
      board.horizonDays,
      board.today,
    );
    return showWeekends ? calendar : calendar.filter((load) => load.working);
  }, [allRows, board, showWeekends]);

  // Where the shift has got to, as a fraction of today's column.
  const todayIndex = dayLoads.findIndex((load) => load.isToday);
  const nowOffset =
    todayIndex < 0
      ? null
      : (todayIndex + shiftColumnFraction(now)) *
        dayWidth;

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
      style={
        {
          minWidth: labelWidth + gridWidth,
          '--order-w': `${colWidths.order}px`,
          '--qty-w': `${colWidths.qty}px`,
          '--hours-w': `${colWidths.hours}px`,
          '--start-w': `${colWidths.start}px`,
          '--due-w': `${colWidths.due}px`,
          '--expect-w': `${colWidths.expect}px`,
          '--team-w': `${colWidths.team}px`,
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
            style={{ left: i * dayWidth, width: dayWidth }}
          />
        ))}
      </div>

      {/* Where the shift has got to. Its own layer, above the bars: the point
          is to see which of them today should have reached by now. */}
      {nowOffset !== null && (
        <div
          className="now-line"
          style={{ left: labelWidth + nowOffset }}
          title={
            `Now — ${TIME_FMT.format(now)} · the shift runs ` +
            `${hourLabel(SHIFT_START_HOUR)}–${hourLabel(SHIFT_END_HOUR)}`
          }
        />
      )}

      <DragTimeGuide horizonStart={board.horizonStart} labelWidth={labelWidth} />
      <DependencyArrows
        root={root}
        rows={visibleRows}
        focusJobId={dependencyFocusId}
        labelWidth={labelWidth}
      />

      <div className="assy-sticky">
        <div className="assy-head">
          <div className="acell order">
            <span className="head-name">Order</span>
            {/* One press for the whole board. Each line has its own triangle on
                its own row, which is the right size of control for one line and
                eight presses for the question a supervisor actually asks —
                "show me the lines, not the orders" — on the way to finding
                which line a job is on. */}
            <button
              type="button"
              className="fold-all"
              onClick={() =>
                setCollapsed(
                  allFolded
                    ? {}
                    : Object.fromEntries(
                        visibleGroups.map((group) => [group.line.key, true]),
                      ),
                )
              }
              aria-expanded={!allFolded}
              aria-label={allFolded ? 'Show every line’s orders' : 'Fold every line’s orders away'}
              title={allFolded ? 'Show every line’s orders' : 'Fold every line’s orders away'}
            >
              <span aria-hidden="true">{allFolded ? '▶' : '▼'}</span>
            </button>
            {/* Grab the edge to give the description more room. */}
            <ColumnGrip column="order" label="Order" />
          </div>
          <div className="acell qty frozen" style={{ left: headLefts.qty }}>
            Qty
            <ColumnGrip column="qty" label="Qty" />
          </div>
          <div
            className="acell hours frozen"
            style={{ left: headLefts.hours }}
          >
            Hours
            <ColumnGrip column="hours" label="Hours" />
          </div>
          {dateHead('start', DATE_COL_LABEL.start, true)}
          {dateHead('due', DATE_COL_LABEL.due, true)}
          {dateHead('expect', DATE_COL_LABEL.expect, false)}
          {/* How many of the roster are allocated today is a figure about the
              whole board and stands with the other three in the header. Who is
              *not* allocated belongs here: it is the list you read while
              deciding who to put on the order you are looking at, and it is
              names rather than a number for the same reason. */}
          <div
            className="acell team team-head frozen"
            style={{ left: headLefts.team }}
          >
            <span>Team</span>
            <span
              className={`team-free ${team.free.length === 0 ? 'none' : ''}`}
              title={
                team.free.length === 0
                  ? 'Everybody on site today is on an order'
                  : `Not allocated today: ${team.free.map((w) => w.name).join(', ')}`
              }
              aria-live="polite"
            >
              {team.free.length === 0
                ? 'all allocated'
                : team.free.map((worker) => (
                    <span className="team-free-name" key={String(worker.id)}>
                      {worker.name}
                    </span>
                  ))}
            </span>
            <ColumnGrip column="team" label="Team" />
          </div>
          {/* Load histogram: one column per day, coloured by band. */}
          <div className="acell track" style={{ width: gridWidth }}>
            {days.map((d, i) => {
              const load = dayLoads[i];
              const running = runningByDay.get(toDayKey(d)) ?? 0;
              const pct = Math.round(load.pct);
              // A closed day still shows what landed on it — that is the case
              // for overtime — but muted, so it never reads as normal capacity.
              const band = load.working ? load.band : 'closed';
              return (
                <div
                  key={i}
                  className={`daycol ${load.working ? '' : 'weekend'} ${load.isToday ? 'today' : ''} ${load.past ? 'past' : ''}`}
                  style={{ left: i * dayWidth, width: dayWidth }}
                  title={
                    (load.actual
                      ? `Booked as output: ${load.hours.toFixed(1)} h of ${load.capacity.toFixed(1)} h `
                      : `${load.hours.toFixed(1)} h booked of ${load.capacity.toFixed(1)} h `) +
                    `(${load.available} people) — ${pct}%` +
                    (load.working ? '' : ' · factory closed, needs overtime')
                  }
                >
                  {/* The load stands the height of the cell on the left and the
                      date takes the rest, rather than the two stacking with the
                      count under them: four things in a column is four lines
                      tall, and this heading has to sit level with the seven
                      column titles beside it. */}
                  <span className={`day-bar ${band} ${load.actual ? 'actual' : ''}`}>
                    <i style={{ height: `${Math.min(100, pct)}%` }} />
                    <b className={`day-load ${band}`}>{pct}%</b>
                  </span>
                  <span className="daycol-main">
                    <span className="daycol-date">{formatShortDay(d)}</span>
                    {/* The count and whichever tag the day carries share the
                        second line. On the date's own line the tag left a
                        column too narrow to print a date in. */}
                    <span className="daycol-sub">
                      <button
                        className="day-order-filter"
                        aria-label={`Filter orders running on ${toDayKey(d)}`}
                        aria-pressed={orderDay === toDayKey(d)}
                        title={`${running} ${running === 1 ? 'order' : 'orders'} running — select to show only those`}
                        onClick={() => setOrderDay(
                          orderDay === toDayKey(d) ? null : toDayKey(d),
                        )}
                      >
                        {running}
                      </button>
                      {load.isToday && <b className="today-tag">today</b>}
                      {load.past && <b className="past-tag">done</b>}
                    </span>
                  </span>
                </div>
              );
            })}
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
          dayWidth={dayWidth}
          colWidths={colWidths}
          visibleDates={visibleDates}
          showWeekends={showWeekends}
          collapsed={Boolean(collapsed[group.line.key])}
          onToggle={() => setCollapsed((current) => ({ ...current, [group.line.key]: !current[group.line.key] }))}
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
    </div>
  );
}
