/**
 * What the orders on screen are short of, part by part.
 *
 * Each order's short lines are already worked out by the board, with the shelf
 * and the purchase orders handed out most urgent first (`pickLedger`). This
 * only turns them round: from "this order lacks these parts" to "this part is
 * lacking on these orders", which is the list a buyer chases.
 *
 * Routed orders put one row per operation on the board and every one of them
 * carries the same pick list, so an order is counted once, by its number.
 *
 * Pure. No React, no store.
 */

import { jobNumOf } from '@/domain/routing';
import type { OrderRow } from '@/engine/assembly/board';

/** One order short of a part. */
export interface ShortOrder {
  /** The row to open: the first of the order's operations on screen. */
  rowId: string;
  orderNum: string;
  line: string;
  dueDate: Date | null;
  shortQty: number;
  /**
   * When the order's share of what is on order arrives: the date it is covered
   * by, or — when there is not enough — when the last of what there is comes.
   */
  availableDate: Date | null;
  covered: boolean;
  /** Not covered, or covered only after the order's Due Date. */
  late: boolean;
}

export interface PartShortage {
  part: string;
  description: string;
  /** Summed over the orders listed. */
  shortQty: number;
  /** Everything open on PODetail.csv for the part; 0 when nothing is. */
  onOrder: number;
  /** Orders whose shortfall no purchase order covers. */
  uncovered: number;
  /** The latest date a covered order waits for the part. */
  lastArrival: Date | null;
  orders: ShortOrder[];
}

export interface ShortageReport {
  parts: PartShortage[];
  /** Distinct orders short of anything. */
  orders: number;
  /** Of them, those with at least one line nothing is on order for. */
  uncoveredOrders: number;
  /** Of them, those that cannot have everything by their Due Date. */
  lateOrders: number;
}

/**
 * Parts with an order nothing covers come first, then those arriving latest:
 * the ones somebody has to pick up the phone about.
 */
const byConcern = (a: PartShortage, b: PartShortage): number =>
  Number(b.uncovered > 0) - Number(a.uncovered > 0) ||
  (b.lastArrival?.getTime() ?? 0) - (a.lastArrival?.getTime() ?? 0) ||
  b.shortQty - a.shortQty ||
  a.part.localeCompare(b.part);

export function shortageReport(rows: readonly OrderRow[]): ShortageReport {
  const seen = new Set<string>();
  const parts = new Map<string, PartShortage>();
  const uncoveredOrders = new Set<string>();
  const lateOrders = new Set<string>();

  for (const row of rows) {
    const orderNum = jobNumOf(String(row.job.id));
    if (seen.has(orderNum) || !row.shortPicks?.length) continue;
    seen.add(orderNum);
    const due = row.job.dueDate ?? null;
    for (const s of row.shortPicks) {
      const covered = Boolean(s.incoming?.coversShort);
      const availableDate = s.incoming?.availableDate ?? null;
      const late = !covered || Boolean(availableDate && due && availableDate > due);
      if (!covered) uncoveredOrders.add(orderNum);
      if (late) lateOrders.add(orderNum);

      const key = String(s.part);
      let part = parts.get(key);
      if (!part) {
        part = {
          part: key,
          description: s.description,
          shortQty: 0,
          onOrder: s.incoming?.qty ?? 0,
          uncovered: 0,
          lastArrival: null,
          orders: [],
        };
        parts.set(key, part);
      }
      part.shortQty += s.shortQty;
      if (!covered) part.uncovered += 1;
      if (covered && availableDate && (!part.lastArrival || availableDate > part.lastArrival)) {
        part.lastArrival = availableDate;
      }
      part.orders.push({
        rowId: String(row.job.id),
        orderNum,
        line: row.line.name,
        dueDate: due,
        shortQty: s.shortQty,
        availableDate,
        covered,
        late,
      });
    }
  }

  for (const part of parts.values()) {
    part.orders.sort(
      (a, b) =>
        (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity) ||
        a.orderNum.localeCompare(b.orderNum),
    );
  }
  return {
    parts: [...parts.values()].sort(byConcern),
    orders: seen.size,
    uncoveredOrders: uncoveredOrders.size,
    lateOrders: lateOrders.size,
  };
}
