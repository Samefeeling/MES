import { useMemo, useRef } from 'react';
import type { LineGroup } from '@/engine/assembly/board';
import { retainLineRows, type OrderSort } from './boardView';

/**
 * The rows in the order they are already drawn in.
 *
 * Editing a start, changing a crew or a background refresh all rebuild the
 * board, and rows sorted by start would jump out from under the pointer as
 * they did. So each line keeps the sequence it is showing, new orders join at
 * the end in date order, and only picking a heading re-sorts.
 *
 * The order is remembered in a ref rather than in state: this used to set
 * state during render, which React allows but pays for with a second render
 * pass on every rebuild of the board.
 */
export function useStableBoardOrder(
  groups: LineGroup[],
  sort: OrderSort,
): LineGroup[] {
  const drawn = useRef<{ sort: OrderSort; ids: Map<string, string[]> } | null>(
    null,
  );

  return useMemo(() => {
    // A new sort is an instruction to re-order; anything else keeps the
    // sequence on screen.
    const keep = drawn.current?.sort === sort ? drawn.current.ids : undefined;
    const next = groups.map((group) => ({
      ...group,
      rows: group.line.schedulable
        ? retainLineRows(group.rows, sort, keep?.get(group.line.key))
        : group.rows,
    }));
    drawn.current = {
      sort,
      ids: new Map(
        next.map((group) => [
          group.line.key,
          group.rows.map((row) => String(row.job.id)),
        ]),
      ),
    };
    return next;
  }, [groups, sort]);
}
