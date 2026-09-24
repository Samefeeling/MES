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
    return { qty, availableDate: releases[0].availableDate, coversShort: true, releases };
  }
  let running = 0;
  for (const r of releases) {
    running += r.qty;
    if (running >= shortQty) {
      return { qty, availableDate: r.availableDate, coversShort: true, releases };
    }
  }
  return {
    qty,
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
  /** `requiredQty − onHand`; always above zero. */
  shortQty: number;
  /** What is on order for it, when `PODetail.csv` has any. */
  incoming: IncomingSupply | null;
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
 * Every line of a pick list the shelf is short of, worst first.
 *
 * The part is looked up by the spelling the material export uses, which is the
 * lookup the panel makes — a part the on-hand export spells differently is
 * unknown to both, and unknown is not a shortage.
 */
export function pickShortages(
  picks: readonly JobMaterialLink[] | undefined,
  inventoryByPart: ReadonlyMap<PartId, InventoryItem>,
  poByPart: ReadonlyMap<PartId, readonly PoLine[]> = new Map(),
): PickShortage[] {
  const short: PickShortage[] = [];
  for (const pick of picks ?? []) {
    const stock = inventoryByPart.get(pick.childPart);
    const required = pick.requiredQty;
    const onHand = stock?.onHand;
    const shortQty = pickShortfall(required, onHand);
    // Both figures are known whenever there is a shortage at all — the rule
    // above answers 0 when either of them is missing.
    if (shortQty <= 0 || required === null || onHand === undefined) continue;
    short.push({
      part: pick.childPart,
      description: stock?.description || pick.childDescription || '',
      requiredQty: required,
      onHand,
      shortQty,
      incoming: incomingSupply(poByPart.get(pick.childPart), shortQty),
    });
  }
  return short.sort((a, b) => b.shortQty - a.shortQty);
}
