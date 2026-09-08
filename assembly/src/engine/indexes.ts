/**
 * Pre-built look-up indexes over a dataset, so the per-job scheduling pass in
 * `store/selectors` is O(jobs) rather than O(jobs × rows). Pure and rebuilt
 * whenever the source data changes.
 */

import type { PartId } from '@/domain/ids';
import type {
  BomLine,
  InventoryItem,
  PlanningDataset,
  PoLine,
} from '@/domain/types';

export interface DataIndexes {
  inventoryByPart: Map<PartId, InventoryItem>;
  poByPart: Map<PartId, PoLine[]>;
  /** Keyed by job number string. */
  bomByJob: Map<string, BomLine[]>;
  bomByPart: Map<PartId, BomLine[]>;
}

function groupBy<T, K>(items: T[], keyOf: (t: T) => K | null): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function buildIndexes(
  data: Pick<PlanningDataset, 'inventory' | 'po' | 'bom'>,
): DataIndexes {
  const inventoryByPart = new Map<PartId, InventoryItem>();
  for (const i of data.inventory) inventoryByPart.set(i.partNum, i);

  return {
    inventoryByPart,
    poByPart: groupBy(data.po, (p) => p.partNum),
    bomByJob: groupBy(data.bom, (b) => (b.jobNum ? String(b.jobNum) : null)),
    bomByPart: groupBy(data.bom, (b) => b.finishedPart),
  };
}
