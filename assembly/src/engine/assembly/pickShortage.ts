/**
 * What the warehouse cannot cover on an order's pick list.
 *
 * `JobMaterialReq.csv` says what each order consumes, `OnHandInventory.csv`
 * what is on the shelf, and netting the two is the only shortage figure this
 * board actually has. The live source carries no `part req` sheet and no
 * purchase orders, so the BOM explosion behind `MaterialStatus` comes back
 * empty and every order reads `ok` on material however bare the racks are.
 *
 * The pick list is also what the supervisor opens to check, so the rule lives
 * here and is read twice: once by the panel, which turns the On-hand cell red,
 * and once by the board, which says "short material" where it would otherwise
 * have said "no crew". One rule, so the label and the panel behind it cannot
 * disagree.
 *
 * Pure. No React, no store.
 */

import type { PartId } from '@/domain/ids';
import {
  poAvailableDate,
  type InventoryItem,
  type JobMaterialLink,
  type PoLine,
} from '@/domain/types';

/** One open PO release for a part. */
export interface IncomingRelease {
  poNum: string | null;
  vendor: string | null;
  qty: number;
  /** The later of its due and promise dates. */
  availableDate: Date | null;
}

/** What is on order for one pick line, from `PODetail.csv`. */
export interface IncomingSupply {
  /** `Calculated_OutstandingQty`, summed over the part's open releases. */
  qty: number;
  /** Of `qty`, what orders ahead of this one have already been given. */
  heldEarlier: number;
  /**
   * When the order can count on the part. On a short line: the release whose
   * arrival, added to everything due before it, first covers the shortfall —
   * or, when all of them together fall short, the last one. On a covered line:
   * the next release to arrive. Null when no release is dated.
   */
  availableDate: Date | null;
  /** Whether everything on order adds up to the shortfall. */
  coversShort: boolean;
  /** Every release, earliest first. */
  releases: IncomingRelease[];
}

/**
 * What is coming for a part against what this order is short of it.
 *
 * Like the on-hand figure, the whole of each release is set against this one
 * order: nothing here shares a delivery out between orders needing the same
 * part.
 */
export function incomingSupply(
  pos: readonly PoLine[] | undefined,
  shortQty: number,
): IncomingSupply | null {
  const releases = (pos ?? [])
    .filter((p) => p.outstandingQty > 0)
    .map((p) => ({
      poNum: p.poNum,
      vendor: p.vendor ?? null,
      qty: p.outstandingQty,
      availableDate: poAvailableDate(p),
    }))
    .sort(
      (a, b) =>
        (a.availableDate?.getTime() ?? Infinity) - (b.availableDate?.getTime() ?? Infinity),
    );
  if (releases.length === 0) return null;
  const qty = releases.reduce((n, r) => n + r.qty, 0);
  if (shortQty <= 0) {
    return { qty, heldEarlier: 0, availableDate: releases[0].availableDate, coversShort: true, releases };
  }
  let running = 0;
  for (const r of releases) {
    running += r.qty;
    if (running >= shortQty) {
      return { qty, heldEarlier: 0, availableDate: r.availableDate, coversShort: true, releases };
    }
  }
  return {
    qty,
    heldEarlier: 0,
    availableDate: releases.findLast((r) => r.availableDate)?.availableDate ?? null,
    coversShort: false,
    releases,
  };
}

/** One pick-list line the shelf cannot cover. */
export interface PickShortage {
  part: PartId;
  /** From the on-hand export, else the material row's own description. */
  description: string;
  /** What the order needs, as the material export states it. */
  requiredQty: number;
  /** `Calculated_OnHand`, summed over the part's bins. */
  onHand: number;
  /** Of `onHand`, what orders ahead of this one have already been given. */
  heldEarlier: number;
  /** What the shelf leaves this order short; always above zero. */
  shortQty: number;
  /** What is on order for it, when `PODetail.csv` has any. */
  incoming: IncomingSupply | null;
  /** Bought in rather than made here — see `isPurchased`. */
  purchased: boolean;
}

/**
 * Whether a part is bought in. `Part_TypeCode` says so when the export has it
 * (P purchased, M manufactured). Without it: a part some order on the board
 * builds is made here, and anything else is bought — in this plant a component
 * is one or the other, and one with a purchase order open is bought whatever
 * else is said about it.
 */
export function isPurchased(
  item: InventoryItem | undefined,
  hasPo: boolean,
  madeHere: boolean,
): boolean {
  if (hasPo) return true;
  const type = item?.typeCode?.trim().toUpperCase();
  if (type === 'P') return true;
  if (type === 'M') return false;
  return !madeHere;
}

/**
 * How many short the pick is — 0 when it is covered, and 0 when nobody can
 * say.
 *
 * Red on the sheet is a claim that this order cannot be picked, so it is only
 * made when both halves of the comparison are known. A component the loaded
 * OnHandInventory.csv has never heard of has no on-hand figure to be below
 * anything, and a line the order export gave no required quantity has nothing
 * to be below: both read as unknown, not as none in stock.
 */
export const pickShortfall = (
  requiredQty: number | null,
  onHand: number | undefined,
): number =>
  requiredQty === null || onHand === undefined
    ? 0
    : Math.max(0, requiredQty - onHand);

/**
 * The shelf and the open purchase orders, handed out one order at a time.
 *
 * Every order used to be measured against the whole of both, so two orders
 * needing the same frame each read as covered by the same delivery. A ledger
 * is taken from in the order the board schedules — the most urgent first —
 * and what one order is given is gone for the next: on-hand stock first, then
 * the PO releases earliest first. An order that cannot be covered in full
 * still takes what there is, because it is the more urgent one.
 */
export interface PickLedger {
  /** Give one order its pick list; returns the lines it is short of, worst first. */
  take(picks: readonly JobMaterialLink[] | undefined): PickShortage[];
}

export function pickLedger(
  inventoryByPart: ReadonlyMap<PartId, InventoryItem>,
  poByPart: ReadonlyMap<PartId, readonly PoLine[]> = new Map(),
  /** Parts some order builds, for telling made from bought — see `isPurchased`. */
  madeParts: ReadonlySet<string> = new Set(),
): PickLedger {
  const shelfTaken = new Map<PartId, number>();
  const onOrder = new Map<PartId, { release: IncomingRelease; left: number }[]>();
  const releasesOf = (part: PartId) => {
    let held = onOrder.get(part);
    if (!held) {
      held = (incomingSupply(poByPart.get(part), 0)?.releases ?? []).map((release) => ({
        release,
        left: release.qty,
      }));
      onOrder.set(part, held);
    }
    return held;
  };

  return {
    take(picks) {
      const short: PickShortage[] = [];
      for (const pick of picks ?? []) {
        const stock = inventoryByPart.get(pick.childPart);
        const required = pick.requiredQty;
        // Unknown is not a shortage: a part the on-hand export has never heard
        // of, or a line with no required quantity — see `pickShortfall`.
        if (required === null || !stock || required <= 0) continue;
        const onHand = stock.onHand;
        const taken = shelfTaken.get(pick.childPart) ?? 0;
        const use = Math.min(Math.max(0, onHand - taken), required);
        shelfTaken.set(pick.childPart, taken + use);
        const shortQty = required - use;
        if (shortQty <= 0) continue;

        const releases = releasesOf(pick.childPart);
        let incoming: IncomingSupply | null = null;
        if (releases.length > 0) {
          const qty = releases.reduce((n, r) => n + r.release.qty, 0);
          const heldEarlier = releases.reduce((n, r) => n + (r.release.qty - r.left), 0);
          let still = shortQty;
          let availableDate: Date | null = null;
          for (const r of releases) {
            if (still <= 0) break;
            if (r.left <= 0) continue;
            const draw = Math.min(r.left, still);
            r.left -= draw;
            still -= draw;
            availableDate = r.release.availableDate;
          }
          incoming = {
            qty,
            heldEarlier,
            availableDate,
            coversShort: still <= 0,
            releases: releases.map((r) => r.release),
          };
        }
        short.push({
          part: pick.childPart,
          description: stock.description || pick.childDescription || '',
          requiredQty: required,
          onHand,
          heldEarlier: Math.max(0, Math.min(onHand, taken)),
          shortQty,
          incoming,
          purchased: isPurchased(stock, releases.length > 0, madeParts.has(String(pick.childPart))),
        });
      }
      // Bought-in parts first: those are the ones a phone call to a supplier
      // can move, and the ones a purchase order date is known for.
      return short.sort(
        (a, b) => Number(b.purchased) - Number(a.purchased) || b.shortQty - a.shortQty,
      );
    },
  };
}

/**
 * Every line of a pick list the shelf is short of, bought-in first, for one order
 * on its own — nothing ahead of it has taken anything.
 *
 * The part is looked up by the spelling the material export uses, which is the
 * lookup the panel makes — a part the on-hand export spells differently is
 * unknown to both, and unknown is not a shortage.
 */
export function pickShortages(
  picks: readonly JobMaterialLink[] | undefined,
  inventoryByPart: ReadonlyMap<PartId, InventoryItem>,
  poByPart: ReadonlyMap<PartId, readonly PoLine[]> = new Map(),
  madeParts: ReadonlySet<string> = new Set(),
): PickShortage[] {
  return pickLedger(inventoryByPart, poByPart, madeParts).take(picks);
}

/**
 * When everything an order is short of that is on order has arrived: the
 * latest date among its short lines that the purchase orders cover. A line
 * nothing covers has no date to wait for and is left out — it is named on the
 * hover instead. Null when no line is covered by a dated PO.
 */
export function materialArrival(short: readonly PickShortage[]): Date | null {
  let latest: Date | null = null;
  for (const s of short) {
    const when = s.incoming?.coversShort ? s.incoming.availableDate : null;
    if (when && (!latest || when > latest)) latest = when;
  }
  return latest;
}
