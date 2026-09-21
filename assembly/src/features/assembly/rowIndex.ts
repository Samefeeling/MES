/**
 * Rows by the two names they answer to.
 *
 * A routed order's row is filed under `ASM8001#20` — order, then operation —
 * because two operations of one order can be worked at once and each needs its
 * own row, its own crew and its own bar. But everything *pointing* at an order
 * names the order: a material link, a dependency, an id the supervisor typed.
 *
 * So a row index answers to both. The order number reaches the row furthest
 * along its route, which is the one that finishes the order and the one whose
 * expected date already carries the rest of the route behind it — exactly what
 * a successor is waiting for.
 */

import { jobNumOf } from '@/domain/routing';

interface Indexable {
  job: { id: unknown; operation?: { seq: number } };
}

export function rowIndex<T extends Indexable>(rows: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(String(row.job.id), row);
  for (const row of rows) {
    const id = String(row.job.id);
    const order = jobNumOf(id);
    if (order === id) continue;
    const held = byId.get(order);
    const seq = row.job.operation?.seq ?? 0;
    if (!held || seq > (held.job.operation?.seq ?? 0)) byId.set(order, row);
  }
  return byId;
}
