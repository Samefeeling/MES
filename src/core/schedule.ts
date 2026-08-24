import type { PlanningOrder } from '../types';
import { shiftBounds } from './shifts';

const HOUR_MS = 3_600_000;

/** Machine codes originate in both CSV and SharePoint. Treat whitespace
 * and letter case as presentation details, not scheduling identity. */
export function normaliseMachineCode(value: string): string {
  return value.trim().toUpperCase();
}

/** True when an order belongs to a machine. Supervisor-created manual
 * orders have no assigned machine and may optionally remain selectable on
 * every press; Planning.csv rows never use that wildcard behaviour. */
export function planningOrderMatchesMachine(
  order: PlanningOrder,
  machineCode: string,
  includeUniversalManual = false,
): boolean {
  const orderMachine = normaliseMachineCode(order.machineCode);
  if (!orderMachine) return includeUniversalManual && order.manuallyAdded;
  return orderMachine === normaliseMachineCode(machineCode);
}

function orderWindow(order: PlanningOrder): { start: Date; end: Date } | null {
  const start = new Date(order.plannedStart);
  const end = new Date(order.plannedEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (end <= start) return null;
  return { start, end };
}

/** Planning rows assigned to a press whose Start–Due interval overlaps the
 * selected eight-hour shift. Touching an edge is not an overlap. */
export function plannedOrdersForShift(
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
): PlanningOrder[] {
  const bounds = shiftBounds(shiftId);
  if (!bounds) return [];
  return orders
    .filter((order) => {
      if (order.isDieChange || !planningOrderMatchesMachine(order, machineCode)) return false;
      const window = orderWindow(order);
      return !!window && window.start < bounds.end && window.end > bounds.start;
    })
    .sort((a, b) => {
      const byStart = new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime();
      return byStart || a.jobNumber.localeCompare(b.jobNumber);
    });
}

export interface ScheduleSegment {
  order: PlanningOrder;
  leftPct: number;
  widthPct: number;
  lane: number;
}

/** Convert the overlapping schedule into percentage-positioned bars. Jobs
 * that overlap each other are assigned separate lanes instead of covering
 * one another. */
export function scheduleSegmentsForShift(
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
): { segments: ScheduleSegment[]; laneCount: number } {
  const bounds = shiftBounds(shiftId);
  if (!bounds) return { segments: [], laneCount: 0 };
  const span = bounds.end.getTime() - bounds.start.getTime();
  const laneEnds: number[] = [];
  const segments = plannedOrdersForShift(orders, machineCode, shiftId).map((order) => {
    const window = orderWindow(order)!;
    const start = Math.max(window.start.getTime(), bounds.start.getTime());
    const end = Math.min(window.end.getTime(), bounds.end.getTime());
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    return {
      order,
      leftPct: ((start - bounds.start.getTime()) / span) * 100,
      widthPct: ((end - start) / span) * 100,
      lane,
    };
  });
  return { segments, laneCount: laneEnds.length };
}

export interface ScheduledOutput {
  /** null means there is no elapsed Planning.csv schedule to judge. */
  pieces: number | null;
  scheduledHours: number;
  jobsUsed: string[];
}

/** Expected pieces from Planning.csv alone.
 *
 * JobOper_ProdStandard is normalised by the CSV parser to hours/piece, so
 * each order contributes elapsed scheduled hours / hours-per-piece. A
 * completed shift uses its whole Start–Due overlap; the current shift stops
 * at `asOf`; future time contributes nothing. Status blocks, shift targets,
 * changeovers and smoko are intentionally not inputs to vs Plan. */
export function expectedScheduledOutputForShift(
  shiftId: string,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  asOf: Date = new Date(),
): ScheduledOutput {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) {
    return { pieces: null, scheduledHours: 0, jobsUsed: [] };
  }
  const elapsedEnd = Math.min(bounds.end.getTime(), asOf.getTime());
  let exactPieces = 0;
  let scheduledHours = 0;
  const jobsUsed: string[] = [];
  for (const order of plannedOrdersForShift(orders, machineCode, shiftId)) {
    if (!(order.qtyPerHr > 0)) continue;
    const window = orderWindow(order)!;
    const start = Math.max(bounds.start.getTime(), window.start.getTime());
    const end = Math.min(elapsedEnd, window.end.getTime());
    if (end <= start) continue;
    const hours = (end - start) / HOUR_MS;
    scheduledHours += hours;
    exactPieces += hours / order.qtyPerHr;
    jobsUsed.push(order.jobNumber);
  }
  if (!jobsUsed.length) return { pieces: null, scheduledHours: 0, jobsUsed: [] };
  return {
    pieces: Math.floor(exactPieces),
    scheduledHours,
    jobsUsed: Array.from(new Set(jobsUsed)),
  };
}
