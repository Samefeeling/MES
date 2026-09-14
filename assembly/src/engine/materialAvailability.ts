/**
 * Material availability: free inventory + incoming POs → can this job run now,
 * and if not, when?
 *
 * For each component we net the requirement against free-on-hand. Any shortfall
 * is chased against open purchase orders (earliest due first); the cumulative
 * receipt that first clears the shortfall sets the component's coverage date.
 * A job's earliest start is the latest coverage date across its short
 * components.
 */

import type { PartId } from '@/domain/ids';
import type {
  ComponentShortage,
  InventoryItem,
  MaterialStatus,
  PoLine,
} from '@/domain/types';
import type { ComponentRequirement } from './materialExplosion';
import { maxDate } from '@/lib/time';

function coverageDate(
  shortQty: number,
  pos: PoLine[],
): { date: Date | null; poNum: string | null } {
  const dated = pos
    .filter((p) => p.outstandingQty > 0)
    .map((p) => ({ p, when: p.dueDate ?? p.promiseDate }))
    .filter((x): x is { p: PoLine; when: Date } => x.when !== null)
    .sort((a, b) => a.when.getTime() - b.when.getTime());

  let cumulative = 0;
  for (const { p, when } of dated) {
    cumulative += p.outstandingQty;
    if (cumulative >= shortQty) return { date: when, poNum: p.poNum };
  }
  return { date: null, poNum: dated.at(-1)?.p.poNum ?? null };
}

export function materialAvailability(
  requirements: ComponentRequirement[],
  inventoryByPart: Map<PartId, InventoryItem>,
  poByPart: Map<PartId, PoLine[]>,
): MaterialStatus {
  const shortages: ComponentShortage[] = [];
  let earliest: Date | null = null;
  let anyUncovered = false;

  for (const req of requirements) {
    const item = inventoryByPart.get(req.componentPart);
    const freeOnHand = item?.freeOnHand ?? 0;
    const shortQty = req.requiredQty - freeOnHand;
    if (shortQty <= 0) continue;

    const { date, poNum } = coverageDate(
      shortQty,
      poByPart.get(req.componentPart) ?? [],
    );
    if (date) earliest = earliest ? maxDate(earliest, date) : date;
    else anyUncovered = true;

    shortages.push({
      componentPart: req.componentPart,
      description: item?.description ?? '',
      requiredQty: req.requiredQty,
      freeOnHand,
      shortQty,
      coverageDate: date,
      poNum,
    });
  }

  if (shortages.length === 0) {
    return { level: 'ok', earliestStart: null, shortages: [] };
  }
  return {
    // Some shortfall has no PO to cover it → genuinely short (start unknown).
    // Otherwise every shortfall is covered by an incoming receipt.
    level: anyUncovered ? 'short' : 'covered',
    earliestStart: anyUncovered ? null : earliest,
    shortages,
  };
}
