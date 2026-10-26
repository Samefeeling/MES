import type { PlanningOrder } from '../types';
import { SHIFTS, buildShiftId, dateKey, parseShiftId, shiftBounds, slotTimeRange } from './shifts';
import { wholePieces } from './targets';
import { DIE_CHANGE_STD_HRS } from './standards';

/** What the plan needs to know beyond Planning.csv itself. */
export interface ScheduleContext {
  /** The die a part runs on (PMD_ProductDieColor.DieNumber), when known. */
  dieOf?: (partNumber: string) => string | undefined;
  /** The part the press was last running before a moment, from its own
   *  records — what was on it when an order's window opened. */
  partBefore?: (at: number) => string | undefined;
}

/** `ScheduleContext.dieOf` from PMD_ProductDieColor: part (any case) → die. */
export function dieLookup(
  dieColors: ReadonlyArray<{ partNumber: string; dieNumber: string }>,
): (partNumber: string) => string | undefined {
  const byPart = new Map<string, string>();
  for (const c of dieColors) {
    const part = c.partNumber.trim().toUpperCase();
    if (part && c.dieNumber.trim()) byPart.set(part, c.dieNumber.trim());
  }
  return (partNumber) => byPart.get(partNumber.trim().toUpperCase());
}

/** `ScheduleContext.partBefore` over a press's records: the part of the
 *  latest half-hour with a status that began before the moment. */
export function lastPartBefore(
  records: ReadonlyArray<{ shiftId: string; slotIndex: number; statusCode: string; partNumber: string; jobNumber: string }>,
): (at: number) => string | undefined {
  const runs = records
    .filter((r) => r.statusCode && r.partNumber && !r.jobNumber.startsWith('DC_'))
    .map((r) => ({ at: slotTimeRange(r.shiftId, r.slotIndex)?.start.getTime() ?? NaN, part: r.partNumber }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  return (at) => {
    let part: string | undefined;
    for (const r of runs) {
      if (r.at >= at) break;
      part = r.part;
    }
    return part;
  };
}

/**
 * A press's planned orders as they will actually run once its die changes
 * are given their time — each order's Start–Due window moved later where a
 * die change has to come first, its length kept.
 *
 * The rule is the Assembly board's PMD lane (assembly/src/engine/assembly/
 * pressPlan.ts). Two orders on one press need a die change
 * (DIE_CHANGE_STD_HRS) unless PMD_ProductDieColor puts both parts on the same
 * die; a die it does not know is a die change, because assuming the cheap
 * answer is how a plan comes out four hours optimistic. The change runs
 * straight after the order before as it now runs; where the planner left four
 * hours for it nothing moves, and where it left less, this order and every
 * one behind it on the press move later by the difference. Orders Epicor
 * overlaps on one die are a co-run and move together. On the same die it is a
 * colour or insert change, which Epicor already allows inside the window, so
 * nothing is added for it here.
 *
 * The press's first order in Planning.csv has nobody before it in the file —
 * that order is finished and gone, and its die change went with it, so the
 * window reads as running from its first minute when those hours put the die
 * on (320T's 03:05 start on a Night). It is compared with what the press was
 * last running before it, from the press's records; with no record to go on
 * it starts with a die change unless the press is plainly carrying on: the
 * order is already under way (part of it made), or it starts when the export
 * was scheduled from (Epicor puts the next order on a press at "now", the
 * earliest start in the file).
 *
 * The hot-stamp press has no dies: its orders are returned as they are.
 * The map is from each of the press's orders to the order as it will run.
 */
export function pressRunsAfterDieChanges(
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  ctx: ScheduleContext = {},
): Map<PlanningOrder, PlanningOrder> {
  const out = new Map<PlanningOrder, PlanningOrder>();
  const press = normaliseMachineCode(machineCode);
  const die = (part: string): string => (ctx.dieOf?.(part.trim()) ?? '').trim().toUpperCase();
  const sameDie = (a: string, b: string): boolean => {
    if (a.trim().toUpperCase() === b.trim().toUpperCase()) return true;
    const da = die(a);
    return da !== '' && da === die(b);
  };
  let earliest = Infinity;
  const planned: Array<{ order: PlanningOrder; start: number; end: number }> = [];
  for (const o of orders) {
    if (o.isDieChange) continue;
    const start = Date.parse(o.plannedStart);
    if (!Number.isFinite(start)) continue;
    if (start < earliest) earliest = start;
    if (!planningOrderMatchesMachine(o, machineCode)) continue;
    const end = Date.parse(o.plannedEnd);
    if (!Number.isFinite(end) || end <= start) {
      out.set(o, o);
      continue;
    }
    planned.push({ order: o, start, end });
  }
  if (press === 'HS' || press === 'HSTAMP') {
    for (const p of planned) out.set(p.order, p.order);
    return out;
  }
  planned.sort((a, b) => a.start - b.start || a.order.jobNumber.localeCompare(b.order.jobNumber));
  const DIE_CHANGE_MS = DIE_CHANGE_STD_HRS * HOUR_MS;
  const firstNeedsChange = (o: PlanningOrder, start: number): boolean => {
    if (o.orderQty > 0 && o.jobRequired >= 0 && o.jobRequired < o.orderQty) return false;
    const last = ctx.partBefore?.(start)?.trim();
    if (last) return !sameDie(last, o.partNumber);
    return (start - earliest) / HOUR_MS >= 1;
  };
  let last: { order: PlanningOrder; plannedEnd: number; runEnd: number; pushed: number } | null = null;
  for (const p of planned) {
    const length = p.end - p.start;
    let runStart: number;
    if (last && p.start < last.plannedEnd && sameDie(last.order.partNumber, p.order.partNumber)) {
      // A co-run: the same shot, moved as far as the order it runs with.
      runStart = p.start + last.pushed;
    } else {
      let ready = -Infinity;
      if (last) {
        ready = last.runEnd + (sameDie(last.order.partNumber, p.order.partNumber) ? 0 : DIE_CHANGE_MS);
      } else if (firstNeedsChange(p.order, p.start)) {
        ready = p.start + DIE_CHANGE_MS;
      }
      runStart = Math.max(p.start, ready);
    }
    const runEnd = runStart + length;
    const moved =
      runStart === p.start
        ? p.order
        : { ...p.order, plannedStart: new Date(runStart).toISOString(), plannedEnd: new Date(runEnd).toISOString() };
    out.set(p.order, moved);
    if (!last || runEnd >= last.runEnd || !(p.start < last.plannedEnd)) {
      last = { order: p.order, plannedEnd: p.end, runEnd, pushed: runStart - p.start };
    }
  }
  return out;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

/** Saturday or Sunday, by the date a shift is filed under — so Friday's
 * night (Fri 23:00 → Sat 07:00) is a weekday shift and Sunday's night
 * (Sun 23:00 → Mon 07:00) is weekend. */
const isWeekend = (year: number, month: number, day: number): boolean => {
  const dow = new Date(year, month - 1, day).getDay();
  return dow === 0 || dow === 6;
};

/** Whether "no of shift" crews this shift, weekend or not. An order with no
 * pattern is crewed for every shift. */
function patternCrews(order: PlanningOrder, shiftId: string): boolean {
  if (!order.shifts?.length) return true;
  const parsed = parseShiftId(shiftId);
  return !!parsed && order.shifts.includes(parsed.code);
}

/** Hours of [start, end) inside the shifts `crewed` accepts. */
function hoursInShifts(start: number, end: number, crewed: (shiftId: string) => boolean): number {
  if (end <= start) return 0;
  let hours = 0;
  // From the day before: that day's Night runs into the morning.
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  for (; day.getTime() < end; day.setDate(day.getDate() + 1)) {
    for (const shift of SHIFTS) {
      const id = buildShiftId(day, shift.code);
      if (!crewed(id)) continue;
      const bounds = shiftBounds(id)!;
      const from = Math.max(bounds.start.getTime(), start);
      const to = Math.min(bounds.end.getTime(), end);
      if (to > from) hours += (to - from) / HOUR_MS;
    }
  }
  return hours;
}

const weekendMemo = new WeakMap<PlanningOrder, ReadonlySet<string> | null>();

/**
 * What a planner adds to a window by hand — half an hour to an hour for an
 * insert or colour change, or both. A window this much longer than its
 * weekday shifts can hold is that allowance, not weekend work.
 */
export const PLANNER_ALLOWANCE_HOURS = 2;

/**
 * The weekend days an order's own schedule says were worked, by date
 * (YYYY-MM-DD); null when there is nothing to tell it from.
 *
 * Weekends are overtime, a whole day at a time — 24 hours, every shift — and
 * some weekends run one day, some two, some none. Planning.csv does not say
 * which, but Epicor's schedule does: the order's Start→Due window is as long
 * as the work (Calculated_RemainingQty ÷ JobOper_ProdStandard) plus whatever
 * inside it nobody works. Take away the weekday shifts its "no of shift"
 * crews and what is left of the work had to be done on the weekend — near
 * nothing, none of it; near 24 hours, one day; near 48, both.
 *
 * Up to `PLANNER_ALLOWANCE_HOURS` short is the planner's changeover
 * allowance and works no weekend. Past that, days are taken earliest first,
 * and one counts when it is needed for more than half of what it holds, so a
 * window that only clips a weekend day is not read as working it.
 */
export function weekendDaysWorked(order: PlanningOrder): ReadonlySet<string> | null {
  if (weekendMemo.has(order)) return weekendMemo.get(order)!;
  let answer: Set<string> | null = null;
  const window = orderWindow(order);
  if (window && order.qtyPerHr > 0 && order.jobRequired >= 0) {
    answer = new Set();
    const start = window.start.getTime();
    const end = window.end.getTime();
    const workHours = order.jobRequired * order.qtyPerHr; // qtyPerHr is hours/piece
    const weekdayHours = hoursInShifts(start, end, (id) => {
      const p = parseShiftId(id);
      return !!p && !isWeekend(p.year, p.month, p.day) && patternCrews(order, id);
    });
    let short = workHours - weekdayHours;
    if (short <= PLANNER_ALLOWANCE_HOURS) short = 0;
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - 1);
    for (; day.getTime() < end && short > 0; day.setDate(day.getDate() + 1)) {
      if (!isWeekend(day.getFullYear(), day.getMonth() + 1, day.getDate())) continue;
      // A weekend day's shifts run 07:00 to 07:00 the next morning.
      const from = new Date(day);
      from.setHours(SHIFTS[0].startHour, 0, 0, 0);
      const inWindow =
        (Math.min(from.getTime() + DAY_MS, end) - Math.max(from.getTime(), start)) / HOUR_MS;
      if (inWindow <= 0 || short <= inWindow / 2) continue;
      answer.add(dateKey(day));
      short -= inWindow;
    }
  }
  weekendMemo.set(order, answer);
  return answer;
}

/**
 * True when the order is crewed for this shift: on a weekday, unless its
 * Planning.csv "no of shift" leaves the shift out (no pattern crews every
 * shift); on a weekend, when its schedule shows that day was worked
 * (`weekendDaysWorked`) — every shift of it — and by the pattern when there is
 * nothing to tell that from.
 */
export function orderCrewedForShift(order: PlanningOrder, shiftId: string): boolean {
  const parsed = parseShiftId(shiftId);
  if (parsed && isWeekend(parsed.year, parsed.month, parsed.day)) {
    const worked = weekendDaysWorked(order);
    if (worked) return worked.has(shiftId.slice(0, 10));
  }
  return patternCrews(order, shiftId);
}

/** Planning rows assigned to a press whose Start–Due interval overlaps the
 * selected eight-hour shift, in a shift the order is crewed for. Touching an
 * edge is not an overlap. */
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
      if (!orderCrewedForShift(order, shiftId)) return false;
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

/**
 * Hours of an order's Start–Due window before `until`, counting only the
 * shifts it is crewed for (`orderCrewedForShift`). What the plan had already
 * asked the order for before a given shift began.
 */
export function crewedWindowHoursBefore(order: PlanningOrder, until: Date): number {
  const window = orderWindow(order);
  if (!window) return 0;
  return hoursInShifts(
    window.start.getTime(),
    Math.min(window.end.getTime(), until.getTime()),
    (id) => orderCrewedForShift(order, id),
  );
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
  if (!orderCrewedForShift(order, shiftId)) return 0;
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
  /** hours × JobOper_ProdStandard in whole pieces (`wholePieces`). */
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
  ctx: ScheduleContext = {},
): PlannedRuntime {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) return NO_RUNTIME;
  const elapsedEnd = Math.min(bounds.end.getTime(), asOf.getTime());
  const elapsedHours = (elapsedEnd - bounds.start.getTime()) / HOUR_MS;
  const unavailableHours = Math.min(elapsedHours, Math.max(0, unavailableHrs));
  const runtimeHours = Math.max(0, elapsedHours - unavailableHours);

  const demand: Array<{ order: PlanningOrder; hours: number }> = [];
  let demandHours = 0;
  // The press's orders as they run once its die changes have their time.
  const runs = pressRunsAfterDieChanges(orders, machineCode, ctx);
  // An order the plan had in this shift stays the shift's order when its die
  // change has pushed it out: planned for 0, so what it made early is not
  // "unscheduled".
  const keep = new Set(
    plannedOrdersForShift(orders, machineCode, shiftId)
      .filter((o) => overlapHoursInShift(shiftId, o, machineCode, asOf) > 0)
      .map((o) => runs.get(o) ?? o),
  );
  const here = new Set([...plannedOrdersForShift([...runs.values()], machineCode, shiftId), ...keep]);
  const sorted = [...here].sort(
    (a, b) => Date.parse(a.plannedStart) - Date.parse(b.plannedStart) || a.jobNumber.localeCompare(b.jobNumber),
  );
  for (const order of sorted) {
    const hours = overlapHoursInShift(shiftId, order, machineCode, asOf);
    if (hours <= 0 && !keep.has(order)) continue;
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
      return { order, hours: mine, pieces: wholePieces(mine / order.qtyPerHr) };
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
    pieces: wholePieces(exactPieces),
    scheduledHours,
    jobsUsed: Array.from(new Set(planned.runs.map((run) => run.order.jobNumber))),
  };
}
