import type { PlanningOrder } from '../types';
import { shiftBounds } from './shifts';

const HOUR_MS = 3_600_000;

/** Machine codes originate in both CSV and SharePoint. Treat whitespace
 * and letter case as presentation details, not scheduling identity.
 *
 * A missing value reads as "no machine", not as a crash: a planning row can
 * reach here with the column blank — a hand-added order, a CSV whose header
 * moved — and this is called from the sign-off path, where throwing would
 * lose the shift somebody just signed. */
export function normaliseMachineCode(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
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
  const selectedMachine = normaliseMachineCode(machineCode);
  // Planning Excel uses "HS" exclusively for the hot-stamping press while
  // the MES machine register / Operator view calls it "Hstamp". Do not let
  // that planning row also land on a literal Machine Code="HS" press.
  if (orderMachine === 'HS') return selectedMachine === 'HSTAMP';
  return orderMachine === selectedMachine;
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

/** How much of the elapsed shift an order's Start–Due window covers, before
 *  the press's one timeline has been shared out between the orders on it.
 *  0 when the order does not belong here, has no rate, or has not started. */
function overlapHoursInShift(
  shiftId: string,
  order: PlanningOrder,
  machineCode: string,
  asOf: Date,
): number {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) return 0;
  if (!planningOrderMatchesMachine(order, machineCode) || order.isDieChange) return 0;
  if (!(order.qtyPerHr > 0)) return 0;
  const window = orderWindow(order);
  if (!window || window.start >= bounds.end || window.end <= bounds.start) return 0;
  const start = Math.max(bounds.start.getTime(), window.start.getTime());
  const end = Math.min(bounds.end.getTime(), window.end.getTime(), asOf.getTime());
  return end > start ? (end - start) / HOUR_MS : 0;
}

/** Exact elapsed planned pieces for one order in one shift, judged on its own
 * Start–Due window. null means its schedule has not started yet, does not
 * overlap, has no valid rate, or is assigned to another machine.
 *
 * This is the raw geometry of one order. It is NOT what a shift is judged
 * against: a press runs one order at a time, so the shift's expectation comes
 * from `plannedRuntimeForShift`, which shares the shift's runtime out between
 * however many planned windows happen to cover it. */
export function expectedScheduledPiecesForOrder(
  shiftId: string,
  order: PlanningOrder,
  machineCode: string,
  asOf: Date = new Date(),
): number | null {
  const hours = overlapHoursInShift(shiftId, order, machineCode, asOf);
  return hours > 0 ? hours / order.qtyPerHr : null;
}

/** One planned order's share of one shift. */
export interface PlannedRun {
  order: PlanningOrder;
  /** Hours of this shift the order was planned to be RUNNING in, after the
   *  press's single timeline has been shared out. */
  hours: number;
  /** hours × JobOper_ProdStandard, floored to whole pieces. */
  pieces: number;
}

export interface PlannedRuntime {
  runs: PlannedRun[];
  /** Shift hours up to `asOf` — the whole shift once it is over. */
  elapsedHours: number;
  /** Hours inside that span the plan could not be run in. */
  unavailableHours: number;
  /** What the press was planned to be running for: elapsed − unavailable. */
  runtimeHours: number;
  /** Σ of the raw Start–Due overlaps, before they were shared out. Larger
   *  than `runtimeHours` exactly when the plan is over-subscribed. */
  demandHours: number;
}

const NO_RUNTIME: PlannedRuntime = {
  runs: [],
  elapsedHours: 0,
  unavailableHours: 0,
  runtimeHours: 0,
  demandHours: 0,
};

/**
 * What the plan asked this press for in this shift, in hours and then in
 * pieces — the floor's own formula:
 *
 *   planned output = Shift Planned Runtime × JobOper_ProdStandard
 *
 * **Runtime, not shift length.** The hours a shift can produce in are the
 * hours it is elapsed, less the ones the plan never had: the standard
 * changeover allowance and smoko, passed in by the caller (which is the side
 * that holds the records). A Day shift carrying a die change is asked for four
 * hours of output, not eight.
 *
 * **One press, one order at a time.** Epicor's Start–Due windows overlap each
 * other freely — `scheduleSegmentsForShift` draws them in lanes for exactly
 * that reason — so summing each order's overlap asked the press for two and
 * three times the hours it has. Where the plan is over-subscribed the runtime
 * is shared out in proportion to what each order asked for, which leaves the
 * SHIFT's total at what one press could actually make while still giving every
 * order in the window a figure to be judged against. Where it is not — the
 * ordinary case of a plan that sequences its orders — every order keeps its own
 * overlap and nothing changes.
 *
 * `qtyPerHr` is the app's internal hours/piece, the reciprocal the CSV parser
 * takes of JobOper_ProdStandard (pieces/hour) at the boundary, so hours ÷
 * qtyPerHr is hours × ProdStandard.
 */
export function plannedRuntimeForShift(
  shiftId: string,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  asOf: Date = new Date(),
  unavailableHrs = 0,
): PlannedRuntime {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) return NO_RUNTIME;
  const elapsedEnd = Math.min(bounds.end.getTime(), asOf.getTime());
  const elapsedHours = (elapsedEnd - bounds.start.getTime()) / HOUR_MS;
  const unavailableHours = Math.min(elapsedHours, Math.max(0, unavailableHrs));
  const runtimeHours = Math.max(0, elapsedHours - unavailableHours);

  const demand: Array<{ order: PlanningOrder; hours: number }> = [];
  let demandHours = 0;
  for (const order of plannedOrdersForShift(orders, machineCode, shiftId)) {
    const hours = overlapHoursInShift(shiftId, order, machineCode, asOf);
    if (hours <= 0) continue;
    demand.push({ order, hours });
    demandHours += hours;
  }
  // Scaled down when the plan wants more press-hours than the shift has;
  // never scaled up — a plan that fills three of the eight hours expects
  // three hours of output, not a shift's worth.
  const share = demandHours > runtimeHours ? runtimeHours / demandHours : 1;

  return {
    runs: demand.map(({ order, hours }) => {
      const mine = hours * share;
      return { order, hours: mine, pieces: Math.floor(mine / order.qtyPerHr) };
    }),
    elapsedHours,
    unavailableHours,
    runtimeHours,
    demandHours,
  };
}

/** Expected pieces from Planning.csv alone, with no deduction for the hours
 * the shift spent changing over — planning geometry on its own. The KPI
 * page's Schedule Adherence goes through `plannedRuntimeForShift` directly so
 * it can pass the shift's changeover and smoko. */
export function expectedScheduledOutputForShift(
  shiftId: string,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  asOf: Date = new Date(),
): ScheduledOutput {
  const planned = plannedRuntimeForShift(shiftId, orders, machineCode, asOf);
  if (!planned.runs.length) return { pieces: null, scheduledHours: 0, jobsUsed: [] };
  let exactPieces = 0;
  let scheduledHours = 0;
  for (const run of planned.runs) {
    exactPieces += run.hours / run.order.qtyPerHr;
    scheduledHours += run.hours;
  }
  return {
    pieces: Math.floor(exactPieces),
    scheduledHours,
    jobsUsed: Array.from(new Set(planned.runs.map((run) => run.order.jobNumber))),
  };
}
