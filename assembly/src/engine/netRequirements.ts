/**
 * Net requirements: demand − free inventory → quantity that must be produced.
 *
 * Aggregates period demand per part and nets it against free-on-hand. A
 * positive result is a real production need; zero or negative means stock
 * covers it.
 */

import type { PartId } from '@/domain/ids';
import type { DemandLine, InventoryItem } from '@/domain/types';

export interface NetRequirement {
  partNum: PartId;
  grossDemand: number;
  freeOnHand: number;
  netQty: number;
}

export function netRequirements(
  demand: DemandLine[],
  inventory: InventoryItem[],
): Map<PartId, NetRequirement> {
  const grossByPart = new Map<PartId, number>();
  for (const d of demand) {
    grossByPart.set(d.partNum, (grossByPart.get(d.partNum) ?? 0) + d.reqQty);
  }

  const freeByPart = new Map<PartId, number>();
  for (const i of inventory) freeByPart.set(i.partNum, i.freeOnHand);

  const out = new Map<PartId, NetRequirement>();
  for (const [partNum, grossDemand] of grossByPart) {
    const freeOnHand = freeByPart.get(partNum) ?? 0;
    out.set(partNum, {
      partNum,
      grossDemand,
      freeOnHand,
      netQty: Math.max(0, grossDemand - freeOnHand),
    });
  }
  return out;
}

/** Net quantity still to produce for a single part (0 when stock covers it). */
export function netQtyForPart(
  part: PartId,
  reqs: Map<PartId, NetRequirement>,
): number {
  return reqs.get(part)?.netQty ?? 0;
}
