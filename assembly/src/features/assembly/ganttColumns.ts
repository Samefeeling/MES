/**
 * The board's frozen columns: which are showing, how wide, and where each
 * starts. The header and every row lay out from the same answer.
 */
import {
  DATE_COLS,
  type ColumnWidths,
  type ColVis,
  type DateCol,
  type DateCols,
} from '@/store/uiStore';

/** The integers from `from` up to, not including, `to`. */
export const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

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
export function shownWidths(w: ColumnWidths, cols: ColVis): ColumnWidths {
  return {
    ...w,
    qty: cols.qty ? w.qty : 0,
    hours: cols.hours ? w.hours : 0,
    team: cols.team ? w.team : 0,
  };
}

export function frozenLefts(
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
