import type { PlanningOrder } from '../types';

// Auto die-change generation between consecutive same-machine orders
// with different part numbers (§5.3). Used by the memory DAL's seed so
// the demo data carries realistic DC pseudo-orders; the live planning
// pipeline (Epicor BAQ → Planning.csv → loadPlanningCsv) provides its
// own die-change rows.

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
