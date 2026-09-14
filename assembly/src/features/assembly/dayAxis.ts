/**
 * Where each day sits along the timeline, in pixels.
 *
 * The grid used to be one number — every column was `dayWidth` wide, so a
 * position was `day * dayWidth` and a drag was `dx / dayWidth`. Columns are now
 * dragged one at a time, so neither of those holds: the week is a run of
 * widths, and the only honest way to read a pixel off it is to walk it.
 *
 * Everything that draws on the grid asks this: the stripes behind the rows, the
 * day headings, every bar and its pieces, the now line, and the drop that turns
 * a pointer's travel back into days. A day index here is *fractional* — 3.25 is
 * a quarter of the way through the fourth column — because a bar starts at an
 * hour of a shift, not at the open of one.
 *
 * Outside the horizon it keeps going at the end column's width rather than
 * stopping: a bar dragged off the right edge has to land somewhere, and a wall
 * there would pile every such drag onto the last day.
 */

/** The bare numbers, small enough to travel in a drag payload. */
export interface DayAxisData {
  /** Width of each visible day column, left to right. */
  widths: readonly number[];
  /** Width to use when there are no columns at all. */
  fallback: number;
}

export interface DayAxis extends DayAxisData {
  /** Left edge of each column, plus the right edge of the last: n + 1 long. */
  readonly offsets: readonly number[];
  /** Width of the whole grid. */
  readonly total: number;
  /** Pixels from the left edge of the grid, at a fractional day index. */
  x(day: number): number;
  /** The fractional day index at a pixel offset — the inverse of `x`. */
  day(x: number): number;
}

export function dayAxis({ widths, fallback }: DayAxisData): DayAxis {
  const offsets: number[] = [0];
  for (const width of widths) offsets.push(offsets[offsets.length - 1] + width);
  const n = widths.length;
  const total = offsets[n];
  // An empty board still has to answer both questions, and one column's width
  // is the only scale it has left.
  const first = n > 0 ? widths[0] : fallback;
  const last = n > 0 ? widths[n - 1] : fallback;

  return {
    widths,
    fallback,
    offsets,
    total,
    x(day) {
      if (!Number.isFinite(day)) return 0;
      if (day < 0) return day * first;
      if (day >= n) return total + (day - n) * last;
      const i = Math.floor(day);
      return offsets[i] + (day - i) * widths[i];
    },
    day(x) {
      if (!Number.isFinite(x)) return 0;
      if (x < 0) return x / first;
      if (x >= total) return n + (x - total) / last;
      // The run is short — a horizon is weeks, not years — and it is walked
      // once per drag frame, so a scan is cheaper than the search that would
      // have to be kept honest alongside it.
      let i = 0;
      while (i < n - 1 && offsets[i + 1] <= x) i += 1;
      return i + (x - offsets[i]) / widths[i];
    },
  };
}

/**
 * How far a drag moved, in days.
 *
 * `dx` is pixels the pointer travelled, which is only a number of days once you
 * know *where it started*: the same 80 px is half a column on a day dragged
 * wide and two columns on a narrow one. So the bar's own day goes in, and the
 * days between where it was and where it now is come back.
 */
export function dragColumns(axis: DayAxis, fromDay: number, dx: number): number {
  if (!Number.isFinite(dx) || dx === 0) return 0;
  return axis.day(axis.x(fromDay) + dx) - fromDay;
}
