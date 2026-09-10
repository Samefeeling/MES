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

import { useDroppable } from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssemblyGanttView,
  LineGroup,
  OrderRow,
} from '@/engine/assembly/board';
import {
  ORDER_TYPE_SHORT,
  PRODUCTIVE_HOURS_PER_PERSON,
  SHIFT_END_HOUR,
  SHIFT_START_HOUR,
  WORK_KIND_SHORT,
  type LineKey,
} from '@/domain/assembly';
import { addCalendarDays, isWeekend, shiftFraction } from '@/engine/assembly/dates';
import { remainingHours } from '@/engine/assembly/duration';
import {
  boardDayLoads,
  rosterLoad,
  type WorkerLoad,
} from '@/engine/assembly/workload';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useDataStore } from '@/store/dataStore';
import {
  COLUMN_LIMITS,
  DATE_COLS,
  useUiStore,
  type ClickPoint,
  type ColumnKey,
  type ColumnWidths,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';
import { OrderBar } from './OrderBar';
import { TeamChips } from './TeamChips';
import { WorkerLoadChip } from './WorkerLoadChip';
import { DependencyArrows } from './DependencyArrows';
import { dependencyFocus } from './dependencyRouter';
import {
  teamSummary,
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
        <span className="order-id" title={String(row.job.id)}>{String(row.job.id)}</span>
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
      {visibleDates.expect && <div className={`acell date expect frozen ${row.status.color}`} style={expectStyle}>
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
  const { setNodeRef, isOver } = useDroppable({
    id: String(group.line.id),
    data: {
      type: 'line',
      lineId: String(group.line.id),
      lineKey: group.line.key,
    },
    disabled: !group.line.schedulable,
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
        <button
          type="button"
          className="agroup-label"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <span className="agroup-chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="agroup-name">{group.line.name}</span>
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
        </button>

        {/* Outside the label — a button cannot hold another button, and this
            one does something the label does not: it takes the line off the
            board altogether. */}
        <button
          type="button"
          className="agroup-hide"
          onClick={onHide}
          title={`Hide the ${group.line.name} line — bring it back from the header`}
          aria-label={`Hide the ${group.line.name} line`}
        >
          ×
        </button>

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
  const showWeekends = useUiStore((s) => s.showWeekends);
  const sort = useUiStore((s) => s.orderSort);
  const changeSort = useUiStore((s) => s.changeOrderSort);
  const marked = useUiStore((s) => s.marked);
  const toggleMark = useUiStore((s) => s.toggleMark);
  const workerLineOverrides = usePlanStore((s) => s.workerLines);
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
    if (!orderDay) return null;
    const selected = withPredecessors(
      allRows,
      (row: OrderRow) =>
        row.line.schedulable && isRunningOnDay(row, fromDayKey(orderDay)),
    );
    // Daily Assembly filtering excludes PMD, including PMD predecessors.
    for (const row of allRows) if (!row.line.schedulable) selected.delete(String(row.job.id));
    return selected;
  }, [allRows, orderDay]);
  const visibleGroups = useMemo(
    () =>
      orderedGroups.filter(group =>
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
    [orderedGroups, visibleIds, hiddenLines, orderDay],
  );
  const visibleRows = useMemo(
    () => visibleGroups.flatMap((group) => group.rows),
    [visibleGroups],
  );
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
      : (todayIndex + shiftFraction(now, SHIFT_START_HOUR, SHIFT_END_HOUR)) *
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

      <DependencyArrows
        root={root}
        rows={visibleRows}
        focusJobId={dependencyFocusId}
        labelWidth={labelWidth}
      />

      <div className="assy-sticky">
        <div className="assy-head">
          <div className="acell order">
            Order
            {/* Grab the edge to give the description more room. */}
            <ColumnGrip column="order" label="Order" />
          </div>
          <div className="acell qty frozen" style={{ left: headLefts.qty }}>
            Order Qty
            <ColumnGrip column="qty" label="Order Qty" />
          </div>
          <div
            className="acell hours frozen"
            style={{ left: headLefts.hours }}
          >
            Required Hours
            <ColumnGrip column="hours" label="Required Hours" />
          </div>
          {dateHead('start', 'Start Date', true)}
          {dateHead('due', 'Due Date', true)}
          {dateHead('expect', 'Expect Date', false)}
          <div
            className="acell team team-head frozen"
            style={{ left: headLefts.team }}
          >
            <span>Team</span>
            <span
              className={`team-free ${team.free.length === 0 ? 'none' : ''}`}
              title="Allocated today / staff on site; includes orders outside the current view"
              aria-live="polite"
            >
              {team.label}
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
                  <span className="daycol-date">
                    {formatShortDay(d)}
                    {load.isToday && <b className="today-tag">today</b>}
                    {load.past && <b className="past-tag">done</b>}
                  </span>
                  <span className={`day-bar ${band} ${load.actual ? 'actual' : ''}`}>
                    <i style={{ height: `${Math.min(100, pct)}%` }} />
                  </span>
                  <span className={`day-load ${band}`}>{pct}%</span>
                  <button
                    className="day-order-filter"
                    aria-label={`Filter orders running on ${toDayKey(d)}`}
                    aria-pressed={orderDay === toDayKey(d)}
                    onClick={() => setOrderDay(
                      orderDay === toDayKey(d) ? null : toDayKey(d),
                    )}
                  >
                    {running} {running === 1 ? 'order' : 'orders'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {visibleGroups.map((group) => (
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
          filtered={orderDay !== null}
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
