import type { PlanningOrder } from '../types';
import { SLOTS_PER_SHIFT, shiftBounds, slotTimeRange } from './shifts';

// §5.2 Order Bar Width — every bar spans the full 16 slots; slots outside the
// order's ERP-planned region are dimmed (still clickable). These helpers
// compute the in-plan region for rendering.

export interface PlannedRegion {
  /** First slot index (inclusive) inside the planned window, or -1. */
  fromSlot: number;
  /** Last slot index (inclusive) inside the planned window, or -1. */
  toSlot: number;
}

export function plannedRegion(order: PlanningOrder, shiftId: string): PlannedRegion {
  const b = shiftBounds(shiftId);
  if (!b) return { fromSlot: -1, toSlot: -1 };
  const ps = new Date(order.plannedStart).getTime();
  const pe = new Date(order.plannedEnd).getTime();
  let from = -1;
  let to = -1;
  for (let i = 0; i < SLOTS_PER_SHIFT; i++) {
    const r = slotTimeRange(shiftId, i);
    if (!r) continue;
    const sStart = r.start.getTime();
    const sEnd = r.end.getTime();
    // slot overlaps the planned window
    if (sEnd > ps && sStart < pe) {
      if (from === -1) from = i;
      to = i;
    }
  }
  return { fromSlot: from, toSlot: to };
}

export function isSlotInPlan(
  order: PlanningOrder,
  shiftId: string,
  slotIndex: number,
): boolean {
  const { fromSlot, toSlot } = plannedRegion(order, shiftId);
  if (fromSlot === -1) return false;
  return slotIndex >= fromSlot && slotIndex <= toSlot;
}

const DC_MIN_HOURS = 0.5; // §5.3 — DC orders have a fixed minimum 0.5h duration

/**
 * Insert Auto-DC pseudo-orders between consecutive same-machine orders whose
 * PartNumber differs (§5.3). Input order is preserved by PlannedStart.
 */
export function generateDieChanges(orders: PlanningOrder[]): PlanningOrder[] {
  const byMachine = new Map<string, PlanningOrder[]>();
  for (const o of orders) {
    if (o.isDieChange) continue;
    if (!byMachine.has(o.machineCode)) byMachine.set(o.machineCode, []);
    byMachine.get(o.machineCode)!.push(o);
  }
  const result: PlanningOrder[] = [...orders];
  let syntheticId = -1;
  for (const list of byMachine.values()) {
    list.sort(
      (a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime(),
    );
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      if (prev.partNumber === next.partNumber) continue;
      result.push({
        id: syntheticId--,
        jobNumber: `DC_${prev.jobNumber}_${next.jobNumber}`,
        machineCode: next.machineCode,
        originalMachine: next.machineCode,
        partNumber: '',
        partDescription: `Die change ${prev.partNumber} → ${next.partNumber}`,
        plannedStart: prev.plannedEnd,
        plannedEnd: new Date(
          new Date(prev.plannedEnd).getTime() + DC_MIN_HOURS * 3600_000,
        ).toISOString(),
        jobRequired: 0,
        qtyPerHr: 0,
        duration: DC_MIN_HOURS,
        released: next.released,
        isDieChange: true,
        manuallyAdded: false,
        source: 'Auto-DC',
      });
    }
  }
  return result;
}

export function manualDieChangeJobNumber(now: Date = new Date()): string {
  return `DC_manual_${now.getTime()}`;
}
