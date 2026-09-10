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
import { addDays, openDaysBetween, workingSpans } from '@/engine/assembly/dates';
import { completedFraction, remainingHours } from '@/engine/assembly/duration';
import { MS_PER_DAY } from '@/lib/time';
import { useSupervisorStore } from '@/store/supervisorStore';
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
  floorISO = null,
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
  /**
   * The earliest day this order may begin, whatever the drag asks for — today,
   * material still on a PO, a component not finished yet. The drop reads it so
   * a drag the schedule was always going to refuse writes nothing at all.
   */
  floorISO?: string | null;
  onSelect: (jobId: string, at?: { x: number; y: number }) => void;
  onMark: (jobId: string) => void;
  onDependencyHover: (jobId: string | null) => void;
}) {
  const id = String(row.job.id);
  /*
   * Moving an order is a change to the shared plan — it pins a start day, it
   * can move the order to another line, and the pinned day goes out to the
   * production list as this order's start. Putting a name on an order has been
   * behind the supervisor gate since the beginning; moving the order itself
   * was not, which had it backwards. See `store/supervisorStore` for what this
   * gate is and is not.
   */
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const dragLocked =
    readOnly || !unlocked || Boolean(row.actualStart) || row.completedToday;
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
        floorISO,
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
          from: piece.from,
          to: piece.to,
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
        [{ key: 0, from: row.start, to: end, left: 0, width, done: 1 }]
  )
    .filter((piece) => piece.width > 0)
    .map((piece) => ({
      ...piece,
      width: Math.max(piece.width, MIN_PIECE_PX),
    }));

  /*
   * The days in the middle of the run that the order is not worked, drawn as
   * part of the bar rather than as the absence of one.
   *
   * Two holes can open between two blocks and they mean opposite things. A
   * weekend is the factory being shut: the closed-day stripe shows through and
   * that is the whole explanation. An *open* day is this order's crew being on
   * another one — and drawn the same way it read as two orders, so the planner
   * dragged the bar back together, which pins it and books that person on both
   * at once. So the pause keeps the bar joined, says how long it is, and the
   * title says which order took the days.
   */
  const links = pieces.slice(1).flatMap((piece, i) => {
    const previous = pieces[i];
    const idle = openDaysBetween(previous.to, piece.from, continuous);
    const left = previous.left + previous.width;
    const linkWidth = piece.left - left;
    return idle.length > 0 && linkWidth > 0
      ? [{ key: `link-${previous.key}`, left, width: linkWidth, idle: idle.length }]
      : [];
  });
  const idleDays = links.reduce((sum, link) => sum + link.idle, 0);
  const pausedFor = [
    ...new Set((row.pauses ?? []).flatMap((pause) => pause.heldBy)),
  ];
  /*
   * The other half of the same story. Dragging a bar over its own pause closes
   * the hole, and it is easy to read that as the board having found room —
   * what it actually did was pin the order, and a pinned order consults no
   * diary. So the bar says whose day it is now spending twice.
   */
  const nameOf = (workerId: string) =>
    row.workers.find((worker) => String(worker.id) === workerId)?.name ??
    workerId;
  const clashes = row.doubleBooked ?? [];
  const clashedWith = [...new Set(clashes.map((clash) => clash.withJob))];
  const clashedNames = [...new Set(clashes.map((clash) => nameOf(clash.workerId)))];

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

  /*
   * The left edge is not the planner's to choose.
   *
   * A component this order is made from has not been finished yet, so the bar
   * is standing against that date and a drag towards it comes straight back —
   * correctly, and, until now, in silence: you could pull the same bar left a
   * dozen times, watch it return each time, and never be told that the thing
   * holding it was the cover being sewn on the next line down. The order knows
   * which one it is waiting for; the bar now says so, and carries a stop
   * against the edge that will not move.
   */
  const heldBy = row.waitingOn ? String(row.waitingOn.onJobId) : null;

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
      } ${idleDays > 0 ? 'paused' : ''} ${
        offAxis ? 'off-axis' : ''
      } ${!unlocked ? 'locked' : ''} ${clashes.length > 0 ? 'clash' : ''} ${
        heldBy ? 'held' : ''
      } ${tag.stub ? 'stub' : ''} ${
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
        (idleDays > 0
          ? ` · put down for ${idleDays} working day${idleDays === 1 ? '' : 's'}` +
            (pausedFor.length > 0
              ? ` — its crew are on ${pausedFor.join(', ')}`
              : ' — nobody on it is free those days')
          : drawn.length > 1
            ? ' · pauses over the weekend'
            : '') +
        (offAxis
          ? ' · runs entirely on days this axis is hiding — show Weekends to see it'
          : '') +
        (row.overtime ? ' · weekend overtime approved' : '') +
        (heldBy
          ? ` · cannot start before ${heldBy} is finished, so it will not drag any earlier`
          : '') +
        (clashes.length > 0
          ? ` · ${clashedNames.join(', ')} ${
              clashedNames.length === 1 ? 'is' : 'are'
            } on ${clashedWith.join(', ')} the same day — only one of the two ` +
            'can have them'
          : '') +
        ` · ${Math.round(completion * 100)}% complete` +
        ` · ${row.status.reason}` +
        (!unlocked && !readOnly
          ? ' · sign in as Supervisor to move it'
          : '')
      }
      {...(dragLocked ? {} : listeners)}
      {...(dragLocked ? {} : attributes)}
    >
      {links.map((link) => (
        <div
          key={link.key}
          className="bar-link"
          style={{ left: link.left, width: link.width }}
          aria-hidden="true"
        />
      ))}
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
