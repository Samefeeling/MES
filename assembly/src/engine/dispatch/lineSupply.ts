/**
 * When the goods lines nobody builds to order can be ready: stock lines and
 * bought-to-order (BTO) lines, from what is on hand, the open purchase-order
 * releases and the stock jobs on the board.
 *
 * Neither export says which order a quantity is for. `OnHandInventory.csv` is
 * a balance per part and `PODetail.csv` a release per part, with no sales
 * order on either, so supply is shared out by part the way MRP pegs it:
 *
 * 1. What is on hand and not already allocated to a waybill line is free
 *    stock, ready today.
 * 2. Then the open supply, earliest first: each PO release on the later of its
 *    due date and the supplier's promise (`poAvailableDate`), and each stock
 *    job on its Expect Date from the board.
 * 3. The lines short of goods take from it in the order they are due to leave
 *    — Need By, then Ship By, then order number — so the first to go is the
 *    first served, and a line covered by two releases is ready when the
 *    second arrives.
 *
 * It is an estimate, and says what it was made from: which PO, which job, how
 * many from stock. A release meant for another customer's order will be
 * credited to whichever line is due first, which is also what the warehouse
 * does with it when it arrives.
 *
 * Lines built to order (`Job`) are the board's — see `assemblyLink` — and
 * freight and service lines (`Other`) need nothing.
 */

import type { DayKey, WaybillLine } from '@/domain/dispatch';
import { lineKey, orderKey } from '@/domain/orderLink';
import { poAvailableDate, type InventoryItem, type PoLine } from '@/domain/types';
import { isGoodsLine, isLineReady } from '@/data/csv/waybill.parser';
import { toDayKey } from '@/lib/time';

export type SupplySource = 'stock' | 'po' | 'job';

/** One piece of supply credited to a line. */
export interface SupplyPiece {
  source: SupplySource;
  /** PO number or job number; null for stock. */
  ref: string | null;
  qty: number;
  /** When it is in: today for stock; null when the PO or job has no date. */
  date: DayKey | null;
  /** The supplier, or where the job is on the board. */
  note: string | null;
}

export interface LineSupply {
  order: string;
  line: string;
  rel: string;
  part: string;
  fulfillment: string;
  /** Still to find: what is left to ship, less what is already allocated. */
  shortQty: number;
  pieces: SupplyPiece[];
  /** Short quantity nothing open covers. */
  uncoveredQty: number;
  /** The whole short quantity is in: the latest piece. Null when uncovered or undated. */
  readyBy: DayKey | null;
}

/** A stock job — built for no order — as the board plans it. */
export interface StockJob {
  jobId: string;
  partNum: string;
  /** What it still has to make. */
  qty: number;
  expect: Date | null;
  /** Where it is on the board, in words. */
  place: string | null;
}

export interface SupplyInputs {
  /** Every open waybill line — the allocated ones count against stock too. */
  lines: readonly WaybillLine[];
  inventory: readonly Pick<InventoryItem, 'partNum' | 'onHand'>[];
  po: readonly PoLine[];
  stockJobs?: readonly StockJob[];
  today: DayKey;
}

/** One spelling of a part number, so `abc 1` on one export finds `ABC1` on another. */
const partKey = (part: string): string => part.trim().replace(/\s+/g, '').toUpperCase();

interface Lot {
  source: SupplySource;
  ref: string | null;
  left: number;
  date: DayKey | null;
  note: string | null;
}

const byDate = (a: Lot, b: Lot): number =>
  a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1;

/** The line's due day for the queue: Need By, else Ship By, else last. */
const dueOf = (l: WaybillLine): string => l.needBy ?? l.shipBy ?? '9999-12-31';

/**
 * Does this line wait on supply this module answers for? A goods line that is
 * not built to order, not yet fully allocated, with something left to ship.
 */
export const needsSupply = (l: WaybillLine): boolean =>
  isGoodsLine(l) &&
  l.fulfillment.trim().toLowerCase() !== 'job' &&
  l.leftToShip > 0 &&
  !isLineReady(l);

/** Supply for every line short of goods, filed under its order. */
export function pegSupply(input: SupplyInputs): Map<string, LineSupply[]> {
  const { lines, today } = input;
  // Allocated quantities are still on the shelf, counted in on-hand.
  const allocated = new Map<string, number>();
  for (const l of lines) {
    if (l.allocatedQty > 0) allocated.set(partKey(l.part), (allocated.get(partKey(l.part)) ?? 0) + l.allocatedQty);
  }
  const lots = new Map<string, Lot[]>();
  const push = (part: string, lot: Lot) => {
    if (!(lot.left > 0)) return;
    const key = partKey(part);
    const held = lots.get(key);
    if (held) held.push(lot);
    else lots.set(key, [lot]);
  };
  const onHand = new Map<string, number>();
  for (const item of input.inventory) {
    const key = partKey(String(item.partNum));
    onHand.set(key, (onHand.get(key) ?? 0) + item.onHand);
  }
  for (const [key, qty] of onHand) {
    push(key, { source: 'stock', ref: null, left: qty - (allocated.get(key) ?? 0), date: today, note: null });
  }
  for (const po of input.po) {
    const date = poAvailableDate(po);
    push(String(po.partNum), {
      source: 'po',
      ref: po.poNum,
      left: po.outstandingQty,
      // A release already overdue is counted as arriving today, not in the past.
      date: date ? (toDayKey(date) < today ? today : toDayKey(date)) : null,
      note: po.vendor ?? null,
    });
  }
  for (const job of input.stockJobs ?? []) {
    push(job.partNum, {
      source: 'job',
      ref: job.jobId,
      left: job.qty,
      date: job.expect ? toDayKey(job.expect) : null,
      note: job.place,
    });
  }
  // Stock first (it is today), then by date; undated last.
  for (const list of lots.values()) list.sort(byDate);

  const queue = lines
    .filter(needsSupply)
    .slice()
    .sort(
      (a, b) =>
        dueOf(a).localeCompare(dueOf(b)) ||
        orderKey(a.order).localeCompare(orderKey(b.order), undefined, { numeric: true }) ||
        lineKey(a.line).localeCompare(lineKey(b.line), undefined, { numeric: true }) ||
        lineKey(a.rel).localeCompare(lineKey(b.rel), undefined, { numeric: true }),
    );

  const out = new Map<string, LineSupply[]>();
  for (const l of queue) {
    const shortQty = Math.max(0, l.leftToShip - Math.max(0, l.allocatedQty));
    let need = shortQty;
    const pieces: SupplyPiece[] = [];
    for (const lot of lots.get(partKey(l.part)) ?? []) {
      if (need <= 0) break;
      if (lot.left <= 0) continue;
      const take = Math.min(lot.left, need);
      lot.left -= take;
      need -= take;
      pieces.push({ source: lot.source, ref: lot.ref, qty: take, date: lot.date, note: lot.note });
    }
    const uncoveredQty = Math.max(0, need);
    const dates = pieces.map((p) => p.date);
    const readyBy =
      uncoveredQty > 0 || dates.some((d) => d === null)
        ? null
        : dates.length > 0
          ? dates.reduce((a, b) => (a! > b! ? a : b))
          : today;
    const supply: LineSupply = {
      order: orderKey(l.order),
      line: lineKey(l.line),
      rel: lineKey(l.rel),
      part: l.part,
      fulfillment: l.fulfillment,
      shortQty,
      pieces,
      uncoveredQty,
      readyBy,
    };
    const held = out.get(supply.order);
    if (held) held.push(supply);
    else out.set(supply.order, [supply]);
  }
  return out;
}

/**
 * - `ok` — everything short is in before the load leaves;
 * - `same-day` — the last of it is in the day the load leaves: tight;
 * - `late` — some is in after the load has left;
 * - `unknown` — some has no open supply at all, or a PO or job with no date.
 */
export type SupplyVerdict = 'ok' | 'same-day' | 'late' | 'unknown';

export interface SupplyCheck {
  verdict: SupplyVerdict;
  /** When the last of it is in; null when unknown. */
  readyBy: DayKey | null;
  lines: LineSupply[];
}

/**
 * Can the order leave on `day`, as far as its stock and bought-in lines go?
 * Null when none of its lines is short of anything this answers for.
 */
export function checkSupply(lines: readonly LineSupply[] | undefined, day: DayKey): SupplyCheck | null {
  if (!lines || lines.length === 0) return null;
  const list = [...lines];
  if (list.some((l) => l.readyBy === null)) return { verdict: 'unknown', readyBy: null, lines: list };
  const readyBy = list.map((l) => l.readyBy!).sort().at(-1)!;
  return { verdict: readyBy > day ? 'late' : readyBy === day ? 'same-day' : 'ok', readyBy, lines: list };
}
