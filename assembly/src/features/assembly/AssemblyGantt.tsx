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
import { formatShortDay, toDayKey } from '@/lib/time';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import { arrangeLines, isVirtualLine, type LineKey, type VirtualLineKey } from '@/domain/assembly';
import { capacityDays } from './crewCapacity';
import { boardDayLoads, rosterLoad } from '@/engine/assembly/workload';
import { addCalendarDays, closureOn, isWeekend } from '@/engine/assembly/dates';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import {
  COLUMN_LIMITS,
  DAY_COLUMN_LIMITS,
  DATE_COL_LABEL,
  DUE_SOON_DAYS,
  useUiStore,
  type ColumnKey,
  type ColumnWidths,
  type ColVis,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';
import { dayAxis } from './dayAxis';
import { DragTimeGuide } from './DragTimeGuide';
import { CrewName, CrewRoll } from './CrewRolls';
import { DependencyArrows } from './DependencyArrows';
import { dependencyFocus } from './dependencyRouter';
import {
  teamSummary,
  onLeaveWorkerOrders,
  strandedOrders,
  lineOfWorkerToday,
  filteredOrderIds,
  timelineDays,
  type DayOrderEntry,
  type OrderSortKey,
} from './boardView';
import { useStableBoardOrder } from './useStableBoardOrder';
import { earliestStart, markedSet } from './groupMove';
import { rowIndex } from './rowIndex';
import { OrderFinder, revealRows } from './OrderFinder';
import { findEntries, type FindEntry } from './orderSearch';
import { ShipByContext, useShipByValue } from './shipBy';
import { useIgnoredOrders } from '@/store/ignoredOrders';
import { BulkActions } from './BulkActions';
import { LevelLoading } from './LevelLoading';
import { aheadLoadPicks, loadPickKey, overtimeDays, pickedOverload } from './levelLoad';
import { recomputeAssemblyGantt } from '@/store/assemblySelectors';
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
import { range, shownWidths, frozenLefts } from './ganttColumns';
import { LineGroupView, benchPositions } from './LineGroupView';
import { pctText, type DayDetailContent, LoadColumn } from './LineLoadStrip';

/** Below this width the frozen columns give way to the timeline. */
const FIT_BELOW_PX = 1280;

/** The share of a narrow screen the frozen columns may take. */
const FIT_SHARE = 0.6;

/** How narrow the Order column goes to make room — still the number and the
 *  start of the description. */
const FIT_ORDER_MIN = 160;

/** How narrow Team goes: two people and the + on one line. Any narrower and
 *  the chips stack, and every row stands three chips tall. */
const FIT_TEAM_MIN = 160;

/**
 * The frozen columns as a narrow screen can afford them.
 *
 * At the widths a desktop reader leaves them the frozen block is some 870px,
 * and an iPad held upright is 820: the timeline — what the board is for — was
 * pushed entirely off the screen, with no way to scroll to it because the
 * frozen block scrolls with it. Below FIT_BELOW_PX the block is held to
 * FIT_SHARE of the width as far as it can be: the Order column gives first,
 * down to FIT_ORDER_MIN, then Team down to FIT_TEAM_MIN. The stored widths are not touched, so a
 * wider window, or the iPad turned, gets the reader's own widths back.
 */
export function fitFrozenWidths(
  w: ColumnWidths,
  cols: ColVis,
  visible: DateCols,
  viewport: number,
): ColumnWidths {
  if (viewport >= FIT_BELOW_PX) return w;
  let over = frozenLefts(visible, shownWidths(w, cols)).total - Math.floor(viewport * FIT_SHARE);
  if (over <= 0) return w;
  const out = { ...w };
  const give = (key: 'order' | 'team', floor: number): void => {
    if (over <= 0 || (key === 'team' && !cols.team)) return;
    const room = Math.max(0, out[key] - floor);
    const take = Math.min(room, over);
    out[key] -= take;
    over -= take;
  };
  give('order', Math.max(COLUMN_LIMITS.order.min, Math.min(FIT_ORDER_MIN, w.order)));
  give('team', Math.max(COLUMN_LIMITS.team.min, Math.min(FIT_TEAM_MIN, w.team)));
  return out;
}

/** The frame's width, kept current through a resize or an iPad turning. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The grip on a column's right-hand edge.
 *
 * It reads its own width from the store rather than being handed one: the
 * header draws seven of these, and threading a width and a setter through the
 * board for each of them would put seven props on every row that never uses
 * them.
 */
function ColumnGrip({ column, label, shown }: { column: ColumnKey; label: string; shown?: number }) {
  // Drag from the width on screen: on a narrow screen that can be less than
  // the stored one, and a drag from the stored width would not move at first.
  const stored = useUiStore((s) => s.colWidths[column]);
  const width = shown ?? stored;
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

/** Every order a line holds, reaching into its benches for a lane made of them. */
function rowsOfLine(board: AssemblyGanttView, key: LineKey): OrderRow[] {
  return board.groups
    .filter((g) => g.line.key === key || g.line.parent === key)
    .flatMap((g) => g.rows);
}

const KIND_LABEL: Record<DayOrderEntry['kind'], string> = {
  crewed: 'crew',
  booked: 'booked',
  waiting: 'no crew yet',
  press: 'press',
  change: 'changeover',
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
  planBoard = null,
  unreleasedHidden = 0,
}: {
  board: AssemblyGanttView;
  /** Every order in the export, Released Only or not — for the order finder. */
  planBoard?: AssemblyGanttView | null;
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
  const storedWidths = useUiStore((s) => s.colWidths);
  const cols = useUiStore((s) => s.cols);
  const toggleCol = useUiStore((s) => s.toggleCol);
  const visibleDates = useUiStore((s) => s.dateCols);
  const viewport = useViewportWidth();
  // Each job's order and its Ship By, from the plan of every order.
  const shipBy = useShipByValue(planBoard ?? board);
  const colWidths = useMemo(
    () => fitFrozenWidths(storedWidths, cols, visibleDates, viewport),
    [storedWidths, cols, visibleDates, viewport],
  );
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
  // Level loading: load blocks picked with Ctrl, and the panel a right-click on
  // one opens over them.
  const loadPicks = useUiStore((s) => s.loadPicks);
  const toggleLoadPicks = useUiStore((s) => s.toggleLoadPicks);
  const pickedLoads = useMemo(() => new Set(loadPicks), [loadPicks]);
  const [level, setLevel] = useState<{ keys: string[]; at: { x: number; y: number } } | null>(null);
  const closeLevel = useCallback(() => setLevel(null), []);
  /** Right-click: what is picked if this block is among it, else just this block. */
  const openLevel = useCallback(
    (keys: string[], at: { x: number; y: number }) => {
      if (keys.length === 0) return;
      setLevel({ keys: keys.every((k) => pickedLoads.has(k)) ? loadPicks : keys, at });
    },
    [loadPicks, pickedLoads],
  );
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
  // Level the week, pressed in the toolbar: the next working days of every
  // line, in the same panel a right-click on picked days opens.
  const levelAhead = useUiStore((s) => s.levelAhead);
  useEffect(() => {
    if (!levelAhead) return;
    useUiStore.getState().requestLevelAhead(null);
    const keys = aheadLoadPicks(capacity);
    if (keys.length > 0) setLevel({ keys, at: levelAhead });
  }, [levelAhead, capacity]);
  const rowsByLine = useMemo(
    () => new Map(board.groups.map((g) => [g.line.key, rowsOfLine(board, g.line.key)])),
    [board],
  );
  /**
   * How over capacity the picked days would read if these starts were pinned —
   * off a fresh schedule of the whole board, not the level-loading plan's own
   * sums, so the panel promises only what the board will then draw.
   */
  const verifyLevel = useCallback(
    (
      pins: Record<string, string>,
      picks: ReadonlyMap<LineKey, ReadonlySet<string>>,
      ceiling: number,
      overtime: Record<string, boolean> = {},
    ) => {
      const next = recomputeAssemblyGantt({}, pins, overtime);
      if (!next) return null;
      const positions = new Map(next.groups.map((g) => [g.line.key, benchPositions(next, g)]));
      const after = capacityDays(
        next.groups.flatMap((g) => g.rows),
        crewPools,
        (lane) => positions.get(lane) ?? 0,
        days,
        next.today,
        // A picked weekend is read as the planner reads it: worked overtime.
        overtimeDays(picks, toDayKey(next.today)),
      );
      return pickedOverload(after, picks, crewPools, ceiling);
    },
    [crewPools, days],
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

  /*
   * The order finder in the Order heading. Taking the reader to an order
   * undoes whatever is keeping its row off the screen — its line folded or
   * hidden, a date filter, Released Only — and says which, because each of
   * those was somebody's choice. The rows stay picked out until cleared.
   */
  const findList = useMemo(() => findEntries(board, planBoard), [board, planBoard]);
  const foundOrder = useUiStore((s) => s.foundOrder);
  const findCount = useUiStore((s) => s.findCount);
  /** The find still waiting for its row to be drawn, and when it was asked. */
  const findPending = useRef<{ count: number; at: number } | null>(null);
  const takeToOrder = useCallback(
    (entry: FindEntry): string[] => {
      const ui = useUiStore.getState();
      const notes: string[] = [];
      const lineName = (key: string) =>
        (planBoard ?? board).groups.find((group) => group.line.key === key)?.line.name ?? key;
      if (entry.status === 'unreleased') {
        ui.setReleasedOnly(false);
        notes.push('not released, so the board now plans with All orders');
      }
      if (entry.rowIds.length === 0) {
        // Ignoring an order only takes it out of the strip; asking for it by
        // number is asking to see it.
        const ignored = useIgnoredOrders.getState();
        const back = ignored.ids.filter((id) => jobNumOf(id) === entry.order);
        for (const id of back) ignored.restore(id);
        notes.push(
          back.length
            ? 'on no line yet, and was ignored; it is back in the Unassigned strip'
            : 'on no line yet; it is in the Unassigned strip',
        );
      }
      const hidden = entry.lines.filter((key) => ui.hiddenLines.includes(key));
      for (const key of hidden) ui.toggleLine(key);
      if (hidden.length) notes.push(`${hidden.map(lineName).join(', ')} was hidden and is shown again`);
      // A day filter also takes the plan-only PMD lane off the board.
      const contextRows = new Set(
        board.groups.filter((group) => !group.line.schedulable).flatMap((group) => group.rows.map((row) => String(row.job.id))),
      );
      const filteredOut =
        entry.rowIds.length > 0 &&
        (ui.orderDay !== null || ui.dueSoon) &&
        (entry.status === 'unreleased' ||
          !visibleIds ||
          !entry.rowIds.some((id) => visibleIds.has(id) && !(ui.orderDay !== null && contextRows.has(id))));
      if (filteredOut) {
        ui.setOrderDay(null);
        if (ui.dueSoon) ui.toggleDueSoon();
        notes.push('it was outside the date filter, which is cleared');
      }
      if (entry.lines.length) {
        setOpened((current) => ({ ...current, ...Object.fromEntries(entry.lines.map((key) => [key, true])) }));
      }
      findPending.current = { count: ui.findCount + 1, at: Date.now() };
      ui.findOrder(entry.order);
      return notes;
    },
    [board, planBoard, visibleIds],
  );
  // Once the row is drawn — a line opened, the board re-planned with All —
  // scroll it into the middle of the screen with its bar in view. A find whose
  // row never comes (an order on no line) gives up rather than jumping the
  // board later, when something else happens to draw it.
  useEffect(() => {
    const pending = findPending.current;
    if (!foundOrder || !pending || pending.count !== findCount) return;
    if (Date.now() - pending.at > 3000) {
      findPending.current = null;
      return;
    }
    const host = root.current;
    const pane = host?.parentElement;
    if (!host || !pane) return;
    const rows = [...host.querySelectorAll<HTMLElement>('[data-row-id]')].filter(
      (el) => jobNumOf(el.dataset.rowId ?? '') === foundOrder,
    );
    if (rows.length === 0) return;
    findPending.current = null;
    revealRows(pane, rows, labelWidth, dayWidth * 2);
  }, [foundOrder, findCount, visibleGroups, board, labelWidth, dayWidth]);
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
    return showWeekends ? calendar : calendar.filter((load) => !isWeekend(load.date));
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
    // A weekday the factory is shut: a public holiday or an RDO.
    const closure = closureOn(d);
    // Every line's block for this day, for level loading.
    const pickKeys = [...cap.lines.keys()].map((lane) => loadPickKey(lane, cap.key));
    const isPicked = pickKeys.length > 0 && pickKeys.every((k) => pickedLoads.has(k));
    const title = [
      `${formatShortDay(d)} — asked of the crews`,
      ...(closure
        ? [`${closure.name} — ${closure.kind === 'rdo' ? 'Rostered Day Off' : 'NSW public holiday'}, factory closed`]
        : []),
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
        className={`daycol ${load.working ? '' : 'weekend'} ${closure ? `closure ${closure.kind}` : ''} ${load.isToday ? 'today' : ''} ${load.past ? 'past' : ''} ${orderDay === day ? 'filtered' : ''} ${isPicked ? 'picked' : ''}`}
        style={{ left: axis.offsets[i], width: axis.widths[i] }}
        title={`${title}\nClick for the orders · Ctrl + click to pick every line's load for level loading`}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('button, .col-resize')) return;
          e.preventDefault();
          openLevel(pickKeys, { x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => {
          // The fold chip folds and the edge resizes the day; the rest of
          // the cell lists what the day is made of.
          if ((e.target as Element).closest('button, .col-resize')) return;
          if (e.ctrlKey || e.metaKey) {
            toggleLoadPicks(pickKeys);
            return;
          }
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
        <LoadColumn
          crewed={cap.crewed}
          waiting={cap.waiting}
          capacity={cap.capacity}
          band={band}
          label={
            closure
              ? closure.kind === 'rdo' ? 'RDO' : 'PH'
              : !cap.working && cap.crewed + cap.waiting > 0.05
                // Weekend overtime: no rostered capacity to be a share of,
                // so the hours it carries.
                ? `${Math.round(cap.crewed + cap.waiting)} h`
                : `${pct}%`
          }
        />
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
    const pickKeys = caps.flatMap((c) => [...c.lines.keys()].map((lane) => loadPickKey(lane, c.key)));
    const isPicked = pickKeys.length > 0 && pickKeys.every((k) => pickedLoads.has(k));
    return (
      <div
        key={`week-${span.key}`}
        className={`daycol weekcol${isPicked ? ' picked' : ''}`}
        style={{ left, width }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('button')) return;
          e.preventDefault();
          openLevel(pickKeys, { x: e.clientX, y: e.clientY });
        }}
        title={
          `${span.label} · ${dates}\n` +
          `${week.crewed.toFixed(1)} h with people on it` +
          (week.waiting > 0 ? `, ${week.waiting.toFixed(1)} h with nobody on it yet (blue)` : '') +
          ` of ${week.capacity.toFixed(1)} h the crews can work — ${pct}%\n` +
          caps
            .map((c) => closureOn(c.date))
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .map((c) => `${c.name} (${c.day.slice(8)}/${c.day.slice(5, 7)}) — closed\n`)
            .join('') +
          'Click for the orders'
        }
        onClick={(e) => {
          if ((e.target as Element).closest('button')) return;
          if (e.ctrlKey || e.metaKey) {
            toggleLoadPicks(pickKeys);
            return;
          }
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
        <ColumnGrip column={key} label={label} shown={laidOut[key]} />
      </div>
    );

  return (
    <ShipByContext.Provider value={shipBy}>
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
              <div className="order-head-stack">
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
                <OrderFinder entries={findList} onFind={takeToOrder} />
              </div>
              {/* The roster's two rolls, moved here off the Team column. */}
              {crewRolls}
              {/* Grab the edge to give the description more room. */}
              <ColumnGrip column="order" label="Order" shown={laidOut.order} />
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
                <ColumnGrip column="qty" label="Qty" shown={laidOut.qty} />
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
                <ColumnGrip column="hours" label="Hours" shown={laidOut.hours} />
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
                <ColumnGrip column="team" label="Team" shown={laidOut.team} />
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
            loadPicks={pickedLoads}
            onPickLoad={toggleLoadPicks}
            onLevel={openLevel}
          />
        ))}
        {level && (
          <LevelLoading
            keys={level.keys}
            at={level.at}
            rows={allRows}
            pools={crewPools}
            today={board.today}
            lineName={(line) => board.groups.find((g) => g.line.key === line)?.line.name ?? line}
            verify={verifyLevel}
            onClose={closeLevel}
          />
        )}
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
              // Centred: the list it was picked from is closing, and the order's
              // own row may be folded away or off screen.
              select(jobId, null);
              closeDay();
            }}
          />
        )}
      </div>
    </ShipByContext.Provider>
  );
}
