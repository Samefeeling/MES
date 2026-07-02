import type { PlanningOrder } from '../types';

// Auto die-change generation between consecutive same-machine orders
// with different part numbers (§5.3). Used by the memory DAL's seed so
// the demo data carries realistic DC pseudo-orders; the live planning
// pipeline (Epicor BAQ → Planning.csv → loadPlanningCsv) provides its
// own die-change rows.

const DC_MIN_HOURS = 0.5; // §5.3 — DC orders have a fixed minimum 0.5h duration

/**
 * Chronological order for the operator Job# dropdown: earliest planned start
 * (JobHead_StartDate + StartHour, already merged into plannedStart by the
 * planning-CSV parser) first. Orders with no / unparseable start sort last,
 * with the job number as a stable tie-break.
 */
export function compareOrdersByStart(a: PlanningOrder, b: PlanningOrder): number {
  const ta = Date.parse(a.plannedStart);
  const tb = Date.parse(b.plannedStart);
  const va = isNaN(ta) ? Infinity : ta;
  const vb = isNaN(tb) ? Infinity : tb;
  if (va !== vb) return va - vb;
  return a.jobNumber.localeCompare(b.jobNumber);
}

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
        orderQty: 0,
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
