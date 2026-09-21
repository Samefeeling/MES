/**
 * What is already on the shelf, given out to the orders that need it.
 *
 * The board used to make an order wait for the job building its component
 * whether or not the component was in stock. A chair whose covers were sitting
 * in the racks still queued behind the next cover order, because the material
 * export says "ASM80010 consumes PDSC00747" and something open builds
 * PDSC00747 — and that is the whole of what the dependency graph knew. The
 * warehouse's answer never reached the schedule.
 *
 * So stock is allocated here, before the graph is built. It is an allocation
 * rather than a lookup, and the difference matters: forty covers on the shelf
 * cover one order for forty or two orders for twenty, never two orders for
 * forty. Each order draws from a pool the ones before it have already drawn
 * from, in the order the floor will actually need them — earliest need date
 * first, ties broken on job number so the same export always allocates the
 * same way.
 *
 * What comes out is a fraction per order per component: 1 means the shelf
 * covers the whole requirement and the order is not waiting for anybody, 0
 * means nothing is there. In between it is a real number, because part of a
 * requirement is worth something: an order with three quarters of its covers
 * can start three quarters of its run before it needs the rest.
 *
 * Pure. No React, no store.
 */

import type { PartId } from '@/domain/ids';
import type { InventoryItem, Job, JobMaterialLink } from '@/domain/types';

/** How much of one component one order already has. */
export interface PartCoverage {
  /** What the order needs, as the material export states it. */
  requiredQty: number;
  /** How much of that this allocation gave it from free stock. */
  allocatedQty: number;
  /** `allocatedQty / requiredQty`, clamped to 0…1. */
  fraction: number;
}

/** Consuming job id → component → what stock covers of it. */
export type StockCoverage = ReadonlyMap<string, ReadonlyMap<string, PartCoverage>>;

/** Epicor part numbers are case-insensitive; the source spelling is display. */
export const partKey = (part: PartId | string): string =>
  String(part).trim().toUpperCase();

/**
 * When an order needs its material — its own start if the export dates one,
 * otherwise the date it is due out.
 *
 * An order with neither sorts last. It is not evidence that nothing is needed;
 * it is the absence of evidence, and stock is better given to an order that
 * can say when it wants it than to one that cannot.
 */
export const needAt = (job: Job): number =>
  (job.startDate ?? job.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY;

/**
 * Give out the free stock, order by order.
 *
 * `jobs` should be every open order that might consume something — the board
 * passes both departments, the same list the dependency graph is built over.
 */
export function allocateStock(
  jobs: readonly Job[],
  links: readonly JobMaterialLink[],
  inventoryByPart: ReadonlyMap<PartId, InventoryItem>,
): StockCoverage {
  const byId = new Map(jobs.map((job) => [String(job.id), job]));

  /*
   * What each order needs, summed per component.
   *
   * A row with no quantity on it is left out altogether rather than read as
   * nothing needed: an export without `JobMtl_RequiredQty` cannot be netted
   * against stock, and an order that silently came free because its quantity
   * column was missing is the worst of the three answers available.
   */
  const need = new Map<string, Map<string, number>>();
  for (const link of links) {
    const job = byId.get(String(link.jobNum));
    if (!job || job.remainingQty <= 0) continue;
    const qty = link.requiredQty;
    if (qty === null || !(qty > 0)) continue;
    const key = partKey(link.childPart);
    if (!key) continue;
    const mine = need.get(String(job.id)) ?? new Map<string, number>();
    mine.set(key, (mine.get(key) ?? 0) + qty);
    need.set(String(job.id), mine);
  }

  // Free on hand, keyed the way the material rows spell their parts.
  const pool = new Map<string, number>();
  for (const [part, item] of inventoryByPart) {
    const key = partKey(part);
    pool.set(key, (pool.get(key) ?? 0) + Math.max(0, item.freeOnHand));
  }

  const queue = [...need.keys()]
    .map((id) => byId.get(id))
    .filter((job): job is Job => Boolean(job))
    .sort(
      (a, b) => needAt(a) - needAt(b) || String(a.id).localeCompare(String(b.id)),
    );

  const out = new Map<string, Map<string, PartCoverage>>();
  for (const job of queue) {
    const mine = need.get(String(job.id));
    if (!mine) continue;
    const covered = new Map<string, PartCoverage>();
    for (const [key, requiredQty] of mine) {
      const free = pool.get(key) ?? 0;
      const allocatedQty = Math.min(free, requiredQty);
      pool.set(key, free - allocatedQty);
      covered.set(key, {
        requiredQty,
        allocatedQty,
        fraction: requiredQty > 0 ? allocatedQty / requiredQty : 0,
      });
    }
    out.set(String(job.id), covered);
  }
  return out;
}

/** What stock covers of one component for one order; 0 when nothing is known. */
export function coverageOf(
  coverage: StockCoverage | undefined,
  jobId: string,
  part: PartId | string | null,
): number {
  if (!coverage || !part) return 0;
  const fraction = coverage.get(jobId)?.get(partKey(part))?.fraction ?? 0;
  return Math.min(1, Math.max(0, fraction));
}
