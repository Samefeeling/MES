/**
 * One order's bar on the day grid. Draggable left/right to move its start day;
 * coloured by how the Expect Date compares with the Due Date.
 *
 * The bar spans start to Expect Date and is drawn as one block per stretch of
 * open days. Weekend gaps appear only while weekend columns are enabled; with
 * them hidden, Friday and Monday meet on the compact working-day axis.
 *
 * ## Short orders
 *
 * A couple of hours of work is a few pixels wide, and a label crammed into
 * those pixels came out as a single clipped character — which named nothing
 * and read as a graphical glitch. So the label lives *outside* a bar too
 * narrow to hold it, in the empty grid to its right, and a bar under half a
 * day says how long it is in hours as well: the block itself is down to its
 * minimum width by then and no longer means anything to the eye.
 */

import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { OrderRow } from '@/engine/assembly/board';
import { addDays, workingSpans } from '@/engine/assembly/dates';
import { completedFraction, remainingHours } from '@/engine/assembly/duration';
import { MS_PER_DAY } from '@/lib/time';
import { barTag, timelineDayOffset } from './boardView';
import type { MarkedMove } from './groupMove';

export const DRAG_TYPE_BAR = 'order-bar';

/** Narrowest a block may be drawn and still be seen. */
const MIN_PIECE_PX = 10;

export function OrderBar({
  row,
  horizonStart,
  dayWidth,
  gridWidth,
  showWeekends,
  readOnly = false,
  selected,
  dependencyRelated,
  marked = false,
  moveWith,
  onSelect,
  onMark,
  onDependencyHover,
}: {
  row: OrderRow;
  horizonStart: Date;
  dayWidth: number;
  /** Full width of the day grid, so a tag near the end flips to the left. */
  gridWidth: number;
  showWeekends: boolean;
  /** PMD rows mirror the moulding plan — shown, never scheduled here. */
  readOnly?: boolean;
  selected: boolean;
  dependencyRelated: boolean;
  /** Ticked with Ctrl held, to be moved with the rest of the marked set. */
  marked?: boolean;
  /**
   * Every marked order and the day its bar is drawn on, so a drag can move the
   * whole set by the same number of columns. Only the bar being dragged reads
   * it, but it has to travel in the drag payload, which is set up here.
   */
  moveWith?: MarkedMove[];
  onSelect: (jobId: string, at?: { x: number; y: number }) => void;
  onMark: (jobId: string) => void;
  onDependencyHover: (jobId: string | null) => void;
}) {
  const id = String(row.job.id);
  const dragLocked = readOnly || Boolean(row.actualStart) || row.completedToday;
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `bar:${id}`,
      disabled: dragLocked,
      // The drop handler moves the bar from where it is drawn, which is not
      // necessarily where the planner last pinned it: the line's capacity, a
      // predecessor or a weekend may have pushed it out. Sending the rendered
      // start makes the drag land exactly where the pointer let go.
      data: {
        type: DRAG_TYPE_BAR,
        jobId: id,
        startISO: row.start ? row.start.toISOString() : null,
        // The zoom is live, so the pixels-to-days conversion has to travel with
        // the drag rather than assume the default column width.
        dayWidth,
        showWeekends,
        // Only meaningful when this bar is one of the marked ones; the drop
        // handler checks that before moving anything but this order.
        moveWith,
      },
    });

  if (!row.start || row.days === null) {
    /*
     * Three reasons an order has no bar, and the planner does something
     * different about each: put people on it, place the order it is waiting
     * for, or widen a crew window that runs out before the work does. It used
     * to say "no crew" to all three, which sent them looking for the one
     * problem that was not there.
     */
    const held = row.waitingOn ? String(row.waitingOn.onJobId) : null;
    const unstaffed = row.workers.length === 0;
    return (
      <button
        type="button"
        className="bar-missing"
        title={
          held
            ? `Waiting on ${held}, which has no finish date of its own — it is ` +
              'either unstaffed or on no line yet'
            : unstaffed
              ? 'No crew allocated — cannot schedule'
              : 'The crew allocated to this order leaves before the work is done'
        }
        onClick={(event) => {
          event.stopPropagation();
          onSelect(id, { x: event.clientX, y: event.clientY });
        }}
        onMouseEnter={() => onDependencyHover(id)}
        onMouseLeave={() => onDependencyHover(null)}
      >
        {held ? `waits on ${held}` : unstaffed ? 'no crew' : 'not covered'}
      </button>
    );
  }

  const axisOffset = (date: Date) =>
    timelineDayOffset(date, horizonStart, showWeekends);
  const offsetDays = axisOffset(row.start);
  const left = offsetDays * dayWidth;
  const end = row.expectDate ?? row.planThrough ?? row.start;
  // When weekends are hidden, their zero-width dates are removed from the
  // coordinate system rather than leaving blank columns behind.
  const span = Math.max(0, axisOffset(end) - offsetDays);
  const width = Math.max(span * dayWidth, MIN_PIECE_PX * 2);

  // Two kinds of order run straight through: one the supervisor has approved
  // for the weekend, and a moulding row — the presses keep their own calendar,
  // and this lane mirrors their plan rather than restating it in our hours.
  const continuous = row.overtime || readOnly;
  const plannedSpans = row.crewDays.map((day) => ({
    from: addDays(day.date, day.from),
    to: addDays(day.date, day.from + day.used),
  }));
  const merged = plannedSpans.reduce<{ from: Date; to: Date }[]>(
    (out, next) => {
      const previous = out.at(-1);
      if (previous && previous.to.getTime() === next.from.getTime()) {
        previous.to = next.to;
      } else {
        out.push({ ...next });
      }
      return out;
    },
    [],
  );
  let workedBefore = 0;
  const spans =
    !readOnly
      ? merged.map((piece) => {
          const worked =
            (piece.to.getTime() - piece.from.getTime()) / MS_PER_DAY;
          const result = { ...piece, worked, workedBefore };
          workedBefore += worked;
          return result;
        })
      : workingSpans(row.start, end, continuous);
  const worked = spans.reduce((s, p) => s + p.worked, 0);
  const completion = completedFraction(row.job);
  // Days of work already booked, in the same units as `WorkingSpan.worked`.
  const doneDays = completion * worked;

  const pieces = (
    spans.length > 0
      ? spans.map((piece) => ({
          key: piece.from.getTime(),
          left: (axisOffset(piece.from) - offsetDays) * dayWidth,
          width: Math.max(
            (axisOffset(piece.to) - axisOffset(piece.from)) * dayWidth,
            0,
          ),
          // How much of this stretch is already finished.
          done:
            piece.worked > 0
              ? Math.min(
                  1,
                  Math.max(0, (doneDays - piece.workedBefore) / piece.worked),
                )
              : 0,
        }))
      : // A closed order has no span left to draw, but still needs a handle.
        [{ key: 0, left: 0, width, done: 1 }]
  )
    .filter((piece) => piece.width > 0)
    .map((piece) => ({
      ...piece,
      width: Math.max(piece.width, MIN_PIECE_PX),
    }));

  /*
   * Every stretch of this bar can come out zero-width, and the whole bar used
   * to vanish when it did — `return null`, no block and no row content.
   *
   * It happens whenever all of an order's work falls on days the axis is not
   * drawing: the compact working-week axis gives Saturday and Sunday no width,
   * and a press job runs on a Sunday often enough, because the moulding lane
   * keeps moulding's own calendar rather than our shifts. An order approved for
   * weekend overtime and nothing else goes the same way.
   *
   * A missing bar is worse than a small one. It leaves a row with nothing in
   * it, and — because a dependency arrow is drawn between two bars — it takes
   * the line to whatever was waiting on that order with it, so the successor
   * reads as though nothing were holding it up. So the order keeps a marker on
   * the seam the hidden days collapse to, and the tooltip says why it is one.
   */
  const offAxis = pieces.length === 0;
  const drawn = offAxis
    ? [{ key: 0, left: 0, width, done: completion }]
    : pieces;

  // A couple of hours of work is a few pixels of bar; where the label cannot
  // fit inside it, the tag goes in the empty grid beside the block.
  const tag = barTag({
    jobId: id,
    hours: remainingHours(row.job),
    spanDays: span,
    width,
    left,
    gridWidth,
    overtime: row.overtime,
  });

  return (
    <div
      ref={setNodeRef}
      data-job-id={id}
      className={`bar ${row.status.color} ${selected ? 'selected' : ''} ${
        isDragging ? 'dragging' : ''
      } ${dependencyRelated ? 'dependency-related' : ''} ${
        readOnly ? 'readonly' : ''
      } ${row.overtime ? 'overtime' : ''} ${
        drawn.length > 1 ? 'split' : ''
      } ${offAxis ? 'off-axis' : ''} ${tag.stub ? 'stub' : ''} ${
        tag.outside ? 'tagged' : ''
      } ${tag.flip ? 'tag-left' : ''} ${marked ? 'marked' : ''}`}
      style={{
        left,
        width,
        transform: CSS.Translate.toString(transform),
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Ctrl (or Cmd on a Mac) ticks the bar into the set being moved
        // together, and deliberately does not open the detail: marking a run
        // of orders and reading one of them are different jobs.
        if (e.ctrlKey || e.metaKey) {
          onMark(id);
          return;
        }
        onSelect(id, { x: e.clientX, y: e.clientY });
      }}
      onMouseEnter={() => onDependencyHover(id)}
      onMouseLeave={() => onDependencyHover(null)}
      title={
        `${row.job.id} · ${row.days.toFixed(1)} d worked with ${row.workers.length}` +
        (readOnly ? '' : ` · position ${row.slot + 1} of ${row.line.parallelOrders}`) +
        (drawn.length > 1 ? ' · pauses over the weekend' : '') +
        (offAxis
          ? ' · runs entirely on days this axis is hiding — show Weekends to see it'
          : '') +
        (row.overtime ? ' · weekend overtime approved' : '') +
        ` · ${Math.round(completion * 100)}% complete` +
        ` · ${row.status.reason}`
      }
      {...(dragLocked ? {} : listeners)}
      {...(dragLocked ? {} : attributes)}
    >
      {drawn.map((piece) => (
        <div
          key={piece.key}
          className="bar-piece"
          style={{ left: piece.left, width: piece.width }}
        >
          {piece.done > 0 && (
            <div
              className="bar-progress"
              style={{ width: `${piece.done * 100}%` }}
            />
          )}
        </div>
      ))}
      {/* One tag, so that outside the bar the three parts stay together. */}
      <span className="bar-tag" data-job-label={id}>
        <span className="bar-label">{tag.text}</span>
        {row.overtime && (
          <span className="bar-ot" title="Weekend overtime approved">
            OT
          </span>
        )}
      </span>
    </div>
  );
}
