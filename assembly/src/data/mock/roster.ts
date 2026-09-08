/**
 * The demo roster — the fifteen people in `seed.json`.
 *
 * It stands in for the `ASSY_Operator` SharePoint list wherever that list
 * cannot be read: without a roster no order can be crewed, and without a crew
 * no order has a bar, so a board with real orders and no people is a blank
 * schedule. Borrowed people are worth less than real ones but a great deal
 * more than none, and the board says which it is showing.
 */

import { WorkerId } from '@/domain/ids';
import type { LineKey, Worker, WorkKind } from '@/domain/assembly';
import seed from './seed.json';

export function demoWorkers(): Worker[] {
  return (seed.workers ?? []).map((w) => {
    // The bench within a line, where the seed names one: UPL is cutting,
    // softies and upholstering, and those are not the same people.
    const trades = ((w as { trades?: string[] }).trades ?? []) as WorkKind[];
    return {
      id: WorkerId(w.id),
      name: w.name,
      skills: (w.skills ?? []) as LineKey[],
      ...(trades.length > 0 ? { trades } : {}),
      onShift: Boolean(w.onShift),
      synthetic: true,
    };
  });
}
