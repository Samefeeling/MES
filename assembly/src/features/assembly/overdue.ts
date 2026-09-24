/**
 * Orders past their Due Date and still not finished.
 *
 * Red on its own says an order *will* be late — a forecast, and one the board
 * may still pull back by moving crew. Overdue is not a forecast: the day it
 * was due has gone and the goods did not come off the line, so whatever
 * logistics booked against that date — a container, a truck — is booked for
 * goods that are not there. That is a call somebody has to make today, and it
 * needs the new date to rebook to, which is the order's Expect Date.
 *
 * Pure. No React, no store.
 */

import type { OrderRow } from '@/engine/assembly/board';
import { startOfDay, wholeDaysBetween } from '@/engine/assembly/dates';
import { jobNumOf } from '@/domain/routing';

/** Calendar days past the Due Date, or null when the order is not overdue. */
export function overdueDays(row: OrderRow, today: Date): number | null {
  const due = row.job.dueDate;
  if (!due || row.completedToday || row.job.remainingQty <= 0) return null;
  const days = wholeDaysBetween(startOfDay(today), startOfDay(due));
  return days > 0 ? days : null;
}

export interface OverdueOrder {
  /** The row to open — the operation being worked, for a routed order. */
  rowId: string;
  orderNum: string;
  partNum: string;
  description: string;
  line: string;
  dueDate: Date;
  daysOver: number;
  qtyLeft: number;
  /**
   * When it is now expected off the line — the date to move bookings to. Null
   * when some of it has nobody on it, so there is no date yet.
   */
  expectDate: Date | null;
}

/**
 * Every overdue order on the assembly lines, one per order number, most
 * overdue first. A routed order is late once, not once per bench, and it is
 * finished when its last operation is — so its Expect Date is the latest of
 * its operations', and unknown if any of them has none.
 */
export function overdueOrders(rows: readonly OrderRow[], today: Date): OverdueOrder[] {
  const byOrder = new Map<string, OrderRow[]>();
  for (const row of rows) {
    if (!row.line.schedulable || overdueDays(row, today) === null) continue;
    const n = jobNumOf(String(row.job.id));
    const held = byOrder.get(n);
    if (held) held.push(row);
    else byOrder.set(n, [row]);
  }
  const out: OverdueOrder[] = [];
  for (const [orderNum, ops] of byOrder) {
    const last = ops.find((r) => r.job.operation?.last) ?? ops[ops.length - 1];
    const first = ops.find((r) => !r.job.operation || r.job.operation.index === 1) ?? ops[0];
    const expectDate = ops.some((r) => !r.expectDate)
      ? null
      : new Date(Math.max(...ops.map((r) => r.expectDate!.getTime())));
    out.push({
      rowId: String(first.job.id),
      orderNum,
      partNum: String(last.job.partNum ?? ''),
      description: last.job.description,
      line: last.line.name,
      dueDate: last.job.dueDate!,
      daysOver: overdueDays(last, today)!,
      qtyLeft: Math.max(...ops.map((r) => r.job.remainingQty)),
      expectDate,
    });
  }
  return out.sort(
    (a, b) => b.daysOver - a.daysOver || a.orderNum.localeCompare(b.orderNum),
  );
}

/**
 * The list as tab-separated text, header first — what pastes straight into a
 * spreadsheet or an email to logistics. Dates are day first, as the plant
 * writes them.
 */
export function overdueTsv(orders: readonly OverdueOrder[]): string {
  const day = (d: Date | null) =>
    d
      ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
      : '';
  const lines = [
    ['Order', 'Part', 'Description', 'Line', 'Qty left', 'Due Date', 'Days overdue', 'Expected finish'],
    ...orders.map((o) => [
      o.orderNum,
      o.partNum,
      o.description.replace(/[\t\r\n]+/g, ' '),
      o.line,
      String(o.qtyLeft),
      day(o.dueDate),
      String(o.daysOver),
      o.expectDate ? day(o.expectDate) : 'no crew — no date',
    ]),
  ];
  return lines.map((l) => l.join('\t')).join('\n');
}
