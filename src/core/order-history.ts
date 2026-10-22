import type { ProductionRecord } from '../types';
import { sumGoodStartedBefore } from './jobgood';
import { shiftBounds } from './shifts';
import { hoursUnavailableFor, shiftTargetFor } from './targets';

// An order Planning.csv no longer holds.
//
// Epicor drops an order from the planning export once it is complete — and
// an order that has overrun its quantity is complete there while the press
// is still running it. Everything the sheet and the KPI page read off the
// planning row (Part #, Order Qty, the cycle time) then has nowhere to come
// from: the shift is signed with no part, no CycleTime and no ShiftTarget,
// and that one shift takes the press's Efficiency and Schedule Adherence
// down to "—" with it.
//
// The order's own signed history still has all of it: every earlier shift
// of the order stamped PartNumber, JobRequired and CycleTime at sign-off.
// So that is the fallback after planning, here and at sign-off alike.

/** What an order's signed history says about it. Blank / 0 = never recorded. */
export interface OrderFacts {
  partNumber: string;
  partDescription: string;
  /** The order total (Epicor ProdQty), as PMD_Production.JobRequired keeps it. */
  jobRequired: number;
  /** Planned hours per piece, as PMD_Production.CycleTime keeps it. */
  cycleTime: number;
}

const startMs = (shiftId: string): number => shiftBounds(shiftId)?.start.getTime() ?? 0;

/**
 * Each fact from the newest record that carries it — the latest sign-off is
 * the rate the order was last judged by — the canonical slot before the
 * others of the same shift.
 */
export function orderFactsFromHistory(records: readonly ProductionRecord[]): OrderFacts {
  const newest = [...records].sort(
    (a, b) =>
      startMs(b.shiftId) - startMs(a.shiftId) ||
      Number(b.slotIndex === 0) - Number(a.slotIndex === 0),
  );
  const text = (get: (r: ProductionRecord) => string | undefined): string =>
    newest.map(get).find((v) => !!v && v.trim() !== '')?.trim() ?? '';
  const positive = (get: (r: ProductionRecord) => number | null | undefined): number =>
    newest.map(get).find((v): v is number => Number.isFinite(v) && (v as number) > 0) ?? 0;
  return {
    partNumber: text((r) => r.partNumber),
    partDescription: text((r) => r.partDescription),
    jobRequired: positive((r) => r.jobRequired),
    cycleTime: positive((r) => r.cycleTime),
  };
}

const validTarget = (v: number | null | undefined): boolean =>
  v != null && Number.isFinite(v) && v >= 0;

/**
 * Fill what a signed shift of an order was saved without — Part #, Order
 * Qty, CycleTime and ShiftTarget — from the order's own history, so a shift
 * signed after Planning.csv dropped the order still counts on the KPI page.
 *
 * The ShiftTarget is the one sign-off would have written: the pieces still
 * needed when the shift began (Order Qty − Good of the order's earlier
 * signed shifts), capped at what the press could make in the hours left to
 * the order (`hoursUnavailableFor` over the same press-shift). An order
 * already overrun has nothing left to ask for, so its target is 0 — its
 * output is outside the plan, as any overrun is.
 *
 * `records` are the signed records being read (any presses and shifts);
 * `historyByJob` holds, for the orders to repair, every signed record of the
 * order. Records of other orders, and values already present, are returned
 * untouched. New objects for the records it changes; the input is not
 * mutated.
 */
export function repairFromHistory(
  records: readonly ProductionRecord[],
  historyByJob: ReadonlyMap<string, readonly ProductionRecord[]>,
): ProductionRecord[] {
  if (historyByJob.size === 0) return [...records];
  const byShift = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const key = `${r.machineCode}|${r.shiftId}`;
    const held = byShift.get(key);
    if (held) held.push(r);
    else byShift.set(key, [r]);
  }
  const factsOf = new Map<string, OrderFacts>();
  const targetOf = new Map<string, number | null>();
  return records.map((r) => {
    const history = historyByJob.get(r.jobNumber);
    if (!history) return r;
    let facts = factsOf.get(r.jobNumber);
    if (!facts) {
      facts = orderFactsFromHistory(history);
      factsOf.set(r.jobNumber, facts);
    }
    const patch: Partial<ProductionRecord> = {};
    if (!r.partNumber && facts.partNumber) patch.partNumber = facts.partNumber;
    if (!r.partDescription && facts.partDescription) patch.partDescription = facts.partDescription;
    if (!(r.jobRequired && r.jobRequired > 0) && facts.jobRequired > 0) patch.jobRequired = facts.jobRequired;
    if (!(r.cycleTime && r.cycleTime > 0) && facts.cycleTime > 0) patch.cycleTime = facts.cycleTime;
    if (r.slotIndex === 0 && !validTarget(r.shiftTarget)) {
      const tuple = `${r.machineCode}|${r.shiftId}|${r.jobNumber}`;
      if (!targetOf.has(tuple)) {
        const required = r.jobRequired && r.jobRequired > 0 ? r.jobRequired : facts.jobRequired;
        const ct = r.cycleTime && r.cycleTime > 0 ? r.cycleTime : facts.cycleTime;
        let target: number | null = null;
        if (required > 0 && ct > 0) {
          const before = sumGoodStartedBefore([...history], r.machineCode, r.shiftId) ?? 0;
          target = shiftTargetFor(
            { qtyPerHr: ct },
            Math.max(0, required - before),
            hoursUnavailableFor(byShift.get(`${r.machineCode}|${r.shiftId}`) ?? [], r.jobNumber),
          );
        }
        targetOf.set(tuple, target);
      }
      const target = targetOf.get(tuple);
      if (target != null) patch.shiftTarget = target;
    }
    return Object.keys(patch).length ? { ...r, ...patch } : r;
  });
}
