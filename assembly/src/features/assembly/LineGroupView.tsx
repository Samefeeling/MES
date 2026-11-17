/**
 * One line of the assembly board: its header, its load strip, and the rows
 * of the orders on it — benches under their line.
 */
import { formatShortDay } from '@/lib/time';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import type { AssemblyGanttView, LineGroup, OrderRow } from '@/engine/assembly/board';
import { isPressLine, rootLineKey, type LineKey } from '@/domain/assembly';
import type { CapacityDay, LineCapacity } from './crewCapacity';
import type { WorkerLoad } from '@/engine/assembly/workload';
import { shiftText } from '@/engine/assembly/pressPlan';
import { usePlanStore } from '@/store/planStore';
import type { ClickPoint, ColumnWidths, DateCols } from '@/store/uiStore';
import type { DayAxis } from './dayAxis';
import { DRAG_TYPE_LINE, lineDragId } from './lineDrag';
import { WorkerLoadChip } from './WorkerLoadChip';
import { lineDayLoads } from './boardView';
import type { MarkedMove } from './groupMove';
import { mergeEntries, type WeekSpan } from './weekFold';
import { OrderRowView } from './OrderRowView';
import { pctText, LineLoadStrip, type DayDetailContent } from './LineLoadStrip';
import { PressLoadStrip } from './PressLoadStrip';
import { pressDayLoads } from './pressLoad';

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
export function LineGroupView({
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
  loadPicks,
  onPickLoad,
  onLevel,
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
  /** Load-block days picked with Ctrl, as `line|day`. */
  loadPicks: ReadonlySet<string>;
  /** Ctrl + click on a block: pick it, or let it go. */
  onPickLoad: (keys: string[]) => void;
  /** Right-click on a block: level what is picked (or, if it is not, this one). */
  onLevel: (keys: string[], at: { x: number; y: number }) => void;
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
  /*
   * PMD and its presses fold to the same strip, read against the hours the
   * presses can run rather than a crew (see `pressLoad`). Their hours stay
   * out of the board's own figures: the day headings, Hours on board and the
   * crews read only the lines this board schedules.
   */
  const pressLoads = useMemo(
    () =>
      collapsed && (group.line.key === 'PMD' || isPressLine(String(group.line.key)))
        ? pressDayLoads(lineRows, dates, board.today)
        : null,
    [collapsed, group.line.key, lineRows, dates, board.today],
  );
  const hasStrip = Boolean(dayLoads || pressLoads);
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
  // A press's changeovers are drawn on its orders' bars, not counted as orders.
  const changeovers = lineRows.filter((r) => r.changeAfter).length;
  const shownOrders = group.rows.length;
  const totalOrders = total;
  /** A press's shifts, from the orders on it — one pattern, or each that differs. */
  const pressShifts = useMemo(() => {
    if (!isPressLine(String(group.line.key))) return null;
    const seen = [...new Set(group.rows.map((r) => r.job.press?.shifts).filter((s): s is string => Boolean(s)))];
    return seen.length === 0 ? null : seen.map(shiftText).join(' / ');
  }, [group.line.key, group.rows]);

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
      <div className={`agroup-head${hasStrip ? ' has-load' : ''}`}>
       {/* With a day strip, the sticky block also covers the frozen columns, so the day
           strip scrolls under them the way the bars do. */}
       <div
         className="agroup-head-in"
         style={hasStrip ? { minWidth: labelWidth } : undefined}
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
              thirds of itself is the thing a planner has to be able to see.
              A press's changeovers are on its bars, not orders, and are not counted. */}
          <span
            className="agroup-count"
            title={
              // A lane holds none of its own once its work is on its benches,
              // so it counts theirs: a header reading "0 orders, 0 h" over
              // three rows of work is the one thing it must not say.
              (group.benchOrders !== undefined
                ? `${group.benchOrders} orders across this line's benches`
                : shownOrders === totalOrders
                  ? `${totalOrders} orders on this line`
                  : `${shownOrders} of ${totalOrders} orders shown — the rest are outside the date window`) +
              (changeovers > 0 ? ` · ${changeovers} changeover${changeovers === 1 ? '' : 's'} between them` : '')
            }
          >
            {group.benchOrders !== undefined
              ? group.benchOrders
              : shownOrders === totalOrders
                ? totalOrders
                : `${shownOrders} of ${totalOrders}`}
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
          {pressShifts && (
            <span className="chip press-shifts" title="No of shift on Planning.csv, for the orders on this press">
              {pressShifts}
            </span>
          )}
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
       {pressLoads && (
         <PressLoadStrip
           days={pressLoads}
           spans={spans}
           axis={axis}
           left={labelWidth}
           width={gridWidth}
           line={group.line.name}
           onOpen={(from, to, at) => {
             const picked = pressLoads.slice(from, to);
             const hours = picked.reduce((n, d) => n + d.hours, 0);
             const change = picked.reduce((n, d) => n + d.changeHours, 0);
             const cap = picked.reduce((n, d) => n + d.capacity, 0);
             const entries = mergeEntries(picked.map((d) => d.entries));
             const byPress = new Map<string, typeof entries>();
             for (const e of entries) byPress.set(e.line, [...(byPress.get(e.line) ?? []), e]);
             onOpenDay(
               {
                 title:
                   `${group.line.name} · ${formatShortDay(picked[0].date)}` +
                   (to - from > 1 ? `–${formatShortDay(picked[picked.length - 1].date)}` : ''),
                 summary:
                   `${hours.toFixed(1)} h of orders` +
                   (change > 0 ? ` + ${change.toFixed(1)} h changeover` : '') +
                   (cap > 0 ? ` · ${pctText(((hours + change) / cap) * 100)} of ${cap.toFixed(0)} h press time` : ''),
                 groups: [...byPress].map(([name, list]) => ({ name, entries: list })),
               },
               at,
             );
           }}
         />
       )}
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
           lineKey={group.line.key}
           picks={loadPicks}
           onPick={onPickLoad}
           onLevel={onLevel}
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
export function benchPositions(board: AssemblyGanttView, group: LineGroup): number {
  if (group.benchOrders === undefined) return group.line.parallelOrders;
  return board.groups
    .filter((g) => g.line.parent === group.line.key)
    .reduce((sum, g) => sum + g.line.parallelOrders, 0) || group.line.parallelOrders;
}
