/**
 * One order's row on the assembly board: its frozen cells on the left, its
 * bar on the day grid on the right.
 */
import { formatDay, formatShortDay, formatTime } from '@/lib/time';
import { useDraggable } from '@dnd-kit/core';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import {
  ORDER_TYPE_SHORT,
  PRODUCTIVE_HOURS_PER_PERSON,
  STEP_NAME,
  WORK_KIND_SHORT,
  type LineKey,
} from '@/domain/assembly';
import { remainingHours } from '@/engine/assembly/duration';
import { shiftText } from '@/engine/assembly/pressPlan';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { useDataStore } from '@/store/dataStore';
import {
  useUiStore,
  type ClickPoint,
  type ColumnWidths,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';
import type { DayAxis } from './dayAxis';
import { OrderBar } from './OrderBar';
import { TeamChips } from './TeamChips';
import type { MarkedMove } from './groupMove';
import { ShipTag } from './shipBy';
import { overdueDays } from './overdue';
import { jobNumOf } from '@/domain/routing';
import { shownWidths, frozenLefts } from './ganttColumns';

const TIME_FMT = new Intl.DateTimeFormat('en-AU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const fmt = (d: Date | null): string => (d ? formatShortDay(d) : '—');

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

export function OrderRowView({
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
  // Picked out by the Order heading's finder: every row of the order asked for.
  const found = useUiStore(
    (state) => state.foundOrder !== null && state.foundOrder === jobNumOf(String(row.job.id)),
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
      className={`arow ${row.line.parent ? 'bench' : ''} ${selected ? 'selected' : ''} ${isContext ? 'context' : ''} ${row.completedToday ? 'completed-today' : ''} ${isNew ? 'new-order' : ''} ${over ? 'overdue' : ''} ${found ? 'found' : ''}`}
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
        {/* The order's planned dispatch day, from the waybill — see shipBy.
            On a press row too: a moulded part sold as it is ships the same way. */}
        <ShipTag jobNum={jobNumOf(String(row.job.id))} />
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
            // A press order's team is the press's crew: the shifts Planning.csv
            // says it is manned for while the order runs.
            row.job.press?.shifts ? (
              <span className="chip press-shifts" title={`No of shift on Planning.csv: ${row.job.press.shifts}`}>
                {shiftText(row.job.press.shifts)}
              </span>
            ) : (
              <span className="chip empty">moulding</span>
            )
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
