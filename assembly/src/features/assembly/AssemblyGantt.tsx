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
  DATE_COLS,
  MAX_ORDER_WIDTH,
  MIN_ORDER_WIDTH,
  useUiStore,
  type ClickPoint,
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
  isInNextWorkingDays,
  isRunningOnDay,
  runningOrdersByDay,
  lineOfWorkerToday,
  withPredecessors,
  type OrderSortKey,
} from './boardView';
import { useStableBoardOrder } from './useStableBoardOrder';
import { markedSet, type MarkedMove } from './groupMove';
import { fromDayKey, toDayKey } from '@/lib/time';

// Must match the widths in index.css (--qty-w, --date-w x4, --team-w),
// otherwise the header's day columns drift out of line with the row tracks.
// The Order column is the exception: it is dragged, so it comes from the store
// and is pushed back into CSS as --order-w.
const QTY_W = 58;
const HOURS_W = 82;
const DATE_W = 62;
const TEAM_W = 172;

/** How often the "now" line catches up with the clock. */
const CLOCK_TICK_MS = 5 * 60 * 1000;

const TIME_FMT = new Intl.DateTimeFormat('en-AU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const fmt = (d: Date | null): string => (d ? formatShortDay(d) : '—');

/**
 * Where each frozen column starts, left to right.
 *
 * The header and the rows both need these, and each used to walk the visible
 * date columns with its own running total — two counters that had to be kept
 * in step by hand, and drift in either one slides the dates out from under
 * their headings.
 */
function frozenLefts(
  visible: DateCols,
  orderWidth: number,
): { date: Partial<Record<DateCol, number>>; team: number } {
  const date: Partial<Record<DateCol, number>> = {};
  let left = orderWidth + QTY_W + HOURS_W;
  for (const key of DATE_COLS) {
    if (!visible[key]) continue;
    date[key] = left;
    left += DATE_W;
  }
  return { date, team: left };
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
  orderWidth,
  visibleDates,
  showWeekends,
  workerLines,
  dependencyRelated,
  marked,
  moveWith,
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
  orderWidth: number;
  visibleDates: DateCols;
  showWeekends: boolean;
  workerLines: ReadonlyMap<string, LineKey>;
  dependencyRelated: boolean;
  marked: boolean;
  moveWith: MarkedMove[];
  onMark: (id: string) => void;
  onDependencyHover: (id: string | null) => void;
}) {
  const isNew = useDataStore((state) =>
    state.newOrderIds.includes(String(row.job.id)),
  );
  const isContext = !row.line.schedulable;
  const lefts = frozenLefts(visibleDates, orderWidth);
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
        <span className="order-id">{String(row.job.id)}</span>
        {isNew && <span className="new-order-tag">NEW</span>}
        {/* On UPL the badge names the bench: Epicor calls both the softies and
            the upholstering "upholstery", and which of the three steps this is
            is the thing worth reading. */}
        {(row.kind !== 'general' || row.job.orderType) && (
          <span className={`order-type ${row.kind}`}>
            {row.kind === 'general'
              ? ORDER_TYPE_SHORT[row.job.orderType!]
              : WORK_KIND_SHORT[row.kind]}
          </span>
        )}
        <span className="order-desc">{row.job.description}</span>
      </div>
      {/* Ordered quantity, with what is still to make under it. */}
      <div
        className="acell qty frozen"
        style={{ left: orderWidth }}
        title={`${orderQty} ordered · ${row.job.remainingQty} still to make`}
      >
        <span>{orderQty}</span>
        {row.job.completedQty > 0 && (
          <span className="qty-left">{row.job.remainingQty} left</span>
        )}
      </div>
      <div
        className="acell hours frozen"
        style={{ left: orderWidth + QTY_W }}
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
      {visibleDates.due && <div className="acell date frozen" style={dueStyle}>{fmt(row.job.dueDate)}</div>}
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
            disabled={row.completedToday || Boolean(row.actualStart)}
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
  startedWorkerIds,
  selectedJobId,
  onSelect,
  dayWidth,
  orderWidth,
  visibleDates,
  showWeekends,
  collapsed,
  onToggle,
  filtered,
  unlocked,
  relatedJobIds,
  markedIds,
  moveWith,
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
  startedWorkerIds: ReadonlySet<string>;
  selectedJobId: string | null;
  onSelect: (id: string, at?: ClickPoint) => void;
  dayWidth: number;
  orderWidth: number;
  visibleDates: DateCols;
  showWeekends: boolean;
  collapsed: boolean;
  onToggle: () => void;
  filtered: boolean;
  unlocked: boolean;
  relatedJobIds: ReadonlySet<string>;
  markedIds: ReadonlySet<string>;
  moveWith: MarkedMove[];
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
                    !unlocked || startedWorkerIds.has(String(worker.id))
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
            orderWidth={orderWidth}
            visibleDates={visibleDates}
            showWeekends={showWeekends}
            workerLines={todayLine}
            dependencyRelated={relatedJobIds.has(String(row.job.id))}
            marked={markedIds.has(String(row.job.id))}
            moveWith={moveWith}
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
  const orderWidth = useUiStore((s) => s.orderWidth);
  const setOrderWidth = useUiStore((s) => s.setOrderWidth);
  const visibleDates = useUiStore((s) => s.dateCols);
  const toggleDate = useUiStore((s) => s.toggleDateCol);
  const orderWindow = useUiStore((s) => s.orderWindow);
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
  const dateCount = Object.values(visibleDates).filter(Boolean).length;
  const labelWidth =
    orderWidth + QTY_W + HOURS_W + DATE_W * dateCount + TEAM_W;
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
    const chosen =
      orderWindow === 'next-five'
        ? (row: OrderRow) => isInNextWorkingDays(row, board.today)
        : orderWindow === 'day' && orderDay
          ? (row: OrderRow) => row.line.schedulable && isRunningOnDay(row, fromDayKey(orderDay))
          : null;
    if (!chosen) return null;
    const selected = withPredecessors(allRows, chosen);
    // Daily Assembly filtering excludes PMD, including PMD predecessors.
    if (orderWindow === 'day') {
      for (const row of allRows) if (!row.line.schedulable) selected.delete(String(row.job.id));
    }
    return selected;
  }, [allRows, board.today, orderWindow, orderDay]);
  const visibleGroups = useMemo(
    () =>
      orderedGroups.filter(group => orderWindow !== 'day' || group.line.schedulable).map((group) => ({
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
    [orderedGroups, visibleIds, orderWindow],
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
  /**
   * Whose work has already started, so their name cannot be moved to another
   * line. Worked out once for the board rather than by each name in each
   * line's header rescanning every row on it.
   */
  const startedWorkerIds = useMemo(() => {
    const started = new Set<string>();
    for (const row of allRows) {
      if (!row.actualStart) continue;
      for (const worker of row.workers) started.add(String(worker.id));
    }
    return started;
  }, [allRows]);
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
  const headLefts = frozenLefts(visibleDates, orderWidth);

  /** Drag the Order column's right-hand edge. */
  const startColumnResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = e.clientX;
    const base = orderWidth;
    const move = (ev: PointerEvent) => setOrderWidth(base + ev.clientX - from);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('col-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    document.body.classList.add('col-resizing');
  };

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
      <div className="acell date date-head frozen" style={{ left: headLefts.date[key] }}>
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
      </div>
    );

  return (
    <div
      ref={root}
      className="assy"
      style={
        {
          minWidth: labelWidth + gridWidth,
          '--order-w': `${orderWidth}px`,
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
            <span
              className="col-resize"
              role="separator"
              tabIndex={0}
              aria-label="Resize the Order column"
              aria-valuenow={orderWidth}
              aria-valuemin={MIN_ORDER_WIDTH}
              aria-valuemax={MAX_ORDER_WIDTH}
              title="Drag to resize"
              onPointerDown={startColumnResize}
              onKeyDown={(e) => {
                const step =
                  e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
                if (!step) return;
                e.preventDefault();
                setOrderWidth(orderWidth + step);
              }}
            />
          </div>
          <div className="acell qty frozen" style={{ left: orderWidth }}>Order Qty</div>
          <div
            className="acell hours frozen"
            style={{ left: orderWidth + QTY_W }}
          >
            Required Hours
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
                    aria-pressed={orderWindow === 'day' && orderDay === toDayKey(d)}
                    onClick={() => setOrderDay(
                      orderWindow === 'day' && orderDay === toDayKey(d) ? null : toDayKey(d),
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
          startedWorkerIds={startedWorkerIds}
          selectedJobId={selectedJobId}
          onSelect={select}
          dayWidth={dayWidth}
          orderWidth={orderWidth}
          visibleDates={visibleDates}
          showWeekends={showWeekends}
          collapsed={Boolean(collapsed[group.line.key])}
          onToggle={() => setCollapsed((current) => ({ ...current, [group.line.key]: !current[group.line.key] }))}
          filtered={orderWindow !== 'all'}
          unlocked={unlocked}
          relatedJobIds={relatedJobIds}
          markedIds={markedIds}
          moveWith={moveWith}
          onMark={toggleMark}
          onDependencyHover={setHoveredJobId}
        />
      ))}
    </div>
  );
}
