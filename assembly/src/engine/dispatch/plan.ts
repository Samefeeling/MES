/**
 * Outbound load planning: which orders leave on which day, in what.
 *
 * The plan is deadline-driven consolidation, the standard practice for a
 * factory shipping to order:
 *
 * 1. **Every order has a dispatch window.** It must leave by its due date —
 *    `Need By`, the latest ship date (or `Ship By`, as the settings say) —
 *    on the last dispatch day of its route on or before it, and may
 *    leave up to `earlyDays` working days sooner. The early limit is the
 *    warehouse limit — an order shipped early has to be finished and staged
 *    early — so it is the one number to tighten in peak season.
 * 2. **A day's loads are opened only by orders that are due that day.**
 *    Orders with time left never cause a truck or container on their own.
 * 3. **Due orders are packed whole.** An order is split only when it is
 *    bigger than the largest vehicle, into full loads plus a remainder.
 * 4. **Spare space is topped up** with orders from the same route whose
 *    window is open — nearest customers first for NSW delivery, the
 *    earliest due date first otherwise. Inside the firm window only orders
 *    whose goods are already ready are pulled forward.
 * 5. **Each load is then right-sized** to the smallest vehicle or container
 *    that holds it. Interstate and export shipments too small for a full
 *    load go as a part load (LTL / LCL) unless open orders can fill one.
 *
 * Loads the planner has edited or confirmed are frozen and passed through
 * unchanged; an order only partly on them (a split piece) has the rest
 * planned as usual. Frozen loads are checked rather than trusted: over
 * capacity, more drops than the run allows, drops further apart than its
 * radius, or a day the route does not depart on are all warned about.
 * The function is pure: the same export, settings, decisions and day give
 * the same plan.
 */

import {
  PART_LOAD,
  dueDate,
  stagingCapacity,
  groupBase,
  routeFor,
  type DayKey,
  type DeadlineField,
  type DispatchDecisions,
  type DispatchMode,
  type DispatchSettings,
  type Equipment,
  type FirmLoad,
  type Route,
  type ShipmentOrder,
  type VolumeSource,
} from '@/domain/dispatch';
import { isFullCube } from '@/domain/cubics';
import { distanceKm, locate, normalizeCity, type LatLon } from '@/domain/dispatchLocations';
import {
  addCalendarDays,
  addWorkingDays,
  dispatchDays,
  isoWeekday,
  isWorkingDay,
  workingDaysBetween,
} from './calendar';

const EPS = 1e-6;

export type OrderFlag =
  | 'overdue'
  | 'late'
  | 'not-ready'
  | 'credit-hold'
  | 'on-hold'
  | 'held'
  | 'no-volume'
  | 'no-date'
  | 'unrouted'
  | 'split'
  | 'pulled-forward'
  | 'pinned'
  | 'firm'
  | 'no-location'
  | 'cube-partial';

export const ORDER_FLAG_LABEL: Record<OrderFlag, string> = {
  overdue: 'Due date already passed',
  late: 'No dispatch day on or before its due date',
  'not-ready': 'Due inside the firm window but goods not ready',
  'credit-hold': 'Credit hold — release before dispatch',
  'on-hold': 'Order on hold',
  held: 'Held back by the planner',
  'no-volume': 'Volume unknown — enter m³',
  'no-date': 'No Need By or Ship By date — pin a day',
  unrouted: 'Delivery zone not routed — add it in Settings',
  split: 'Split across loads (bigger than the largest vehicle)',
  'pulled-forward': 'Pulled forward to fill a load',
  pinned: 'Day pinned by the planner',
  firm: 'On a load the planner edited or confirmed',
  'no-location': 'City has no map location — grouped by zone only',
  'cube-partial': 'Some parts are missing from the cubics sheet',
};

/** Flags that keep an order off every load until someone acts. */
export const BLOCKING_FLAGS: readonly OrderFlag[] = [
  'credit-hold',
  'on-hold',
  'held',
  'no-date',
  'unrouted',
];

export interface PlannedDrop {
  orderId: string;
  /** Null when a confirmed load names an order no longer in the export. */
  order: ShipmentOrder | null;
  volumeM3: number;
  volumeKnown: boolean;
  volumeSource: VolumeSource;
  /** Weight of this drop from the cubics sheet, kg; null when unknown. */
  weightKg: number | null;
  /** Set when the order is split across loads. */
  piece: { index: number; of: number } | null;
  /** The part of the order this drop carries, 0–1: 1 unless split. */
  share: number;
  /** Working days ahead of the order's latest dispatch day. */
  daysEarly: number;
}

export interface PlannedLoad {
  id: string;
  group: string;
  mode: DispatchMode;
  label: string;
  day: DayKey;
  /** Vehicle or container name, or `Part load`, `LTL`, `LCL`, `Pickup`. */
  equipment: string;
  capacityM3: number | null;
  drops: PlannedDrop[];
  volumeM3: number;
  /** Volume over capacity, 0–1+; null for part loads and pickups. */
  fill: number | null;
  /** Known weight, kg, and whether every drop's weight was known. */
  weightKg: number;
  weightComplete: boolean;
  /** Status when the planner has confirmed it; null for a proposal. */
  firm: FirmLoad['status'] | null;
  warnings: string[];
  /**
   * Brought forward from `from` because that day was over its truck or
   * container limit or its marshalling capacity.
   */
  levelled?: { from: DayKey; reason: DayLimit };
}

/** The daily limit a day can be over. */
export type DayLimit = 'trucks' | 'containers' | 'marshalling';

export interface OrderPlan {
  orderId: string;
  route: Route | null;
  /** First day the order may leave; null when it is not planned. */
  earliest: DayKey | null;
  /** Last dispatch day that still meets the due date (or the first open one if none). */
  latest: DayKey | null;
  /** Day the order is planned to leave (the first piece, when split). */
  day: DayKey | null;
  loadIds: string[];
  volumeM3: number;
  volumeKnown: boolean;
  volumeSource: VolumeSource;
  /** Weight from the cubics sheet when it covers the whole order, kg. */
  weightKg: number | null;
  flags: OrderFlag[];
}

export interface DayTotal {
  day: DayKey;
  /** Volume still to go out (dispatched loads aside). */
  volumeM3: number;
  loads: number;
  /** Whole trucks: NSW truck runs and linehaul FTL, dispatched ones included. */
  trucks: number;
  /** FCL containers, dispatched ones included. */
  containers: number;
  /** Over the marshalling area's capacity. */
  overStaging: boolean;
  /** More trucks than the dock loads out in a day. */
  overTrucks: boolean;
  /** More containers than are stuffed in a day. */
  overContainers: boolean;
}

export interface DispatchPlan {
  today: DayKey;
  loads: PlannedLoad[];
  orders: Map<string, OrderPlan>;
  days: DayTotal[];
  /** The waybill date the plan treats as the last ship day. */
  deadline: DeadlineField;
}

interface Candidate {
  order: ShipmentOrder;
  plan: OrderPlan;
  route: Route;
  /** Last day it may leave. */
  due: DayKey | null;
  /** What is left to plan: the whole order, or what frozen loads do not carry. */
  volume: number;
  loc: LatLon | null;
  city: string;
}

interface Piece {
  c: Candidate;
  volume: number;
  piece: { index: number; of: number } | null;
  daysEarly: number;
}

interface Bin {
  pieces: Piece[];
  volume: number;
}

const byCapacity = (list: readonly Equipment[]): Equipment[] =>
  [...list].filter((e) => e.capacityM3 > 0).sort((a, b) => a.capacityM3 - b.capacityM3);

/** Smallest equipment that holds `volume`; the largest when none does. */
const rightSize = (list: Equipment[], volume: number): Equipment =>
  list.find((e) => e.capacityM3 + EPS >= volume) ?? list[list.length - 1];

/** Full loads of `max` plus a remainder; one piece when it fits. */
function splitPieces(c: Candidate, max: number): Piece[] {
  if (c.volume <= max + EPS) return [{ c, volume: c.volume, piece: null, daysEarly: 0 }];
  const full = Math.floor(c.volume / max);
  const rest = c.volume - full * max;
  const volumes = Array<number>(full).fill(max);
  if (rest > 0.01) volumes.push(rest);
  return volumes.map((volume, i) => ({
    c,
    volume,
    piece: { index: i + 1, of: volumes.length },
    daysEarly: 0,
  }));
}

/** First-fit decreasing into bins of `capacity`; pieces are never divided. */
function packFirstFit(pieces: Piece[], capacity: number): Bin[] {
  const bins: Bin[] = [];
  for (const p of [...pieces].sort((a, b) => b.volume - a.volume)) {
    const bin = bins.find((b) => b.volume + p.volume <= capacity + EPS);
    if (bin) {
      bin.pieces.push(p);
      bin.volume += p.volume;
    } else {
      bins.push({ pieces: [p], volume: p.volume });
    }
  }
  return bins;
}

// ---- NSW delivery geography --------------------------------------------------

const sameCity = (a: Candidate, b: Candidate) => a.city === b.city;

/** Can `c` ride with every drop already on the bin? */
function geoFits(bin: Bin, c: Candidate, radiusKm: number): boolean {
  return bin.pieces.every(({ c: other }) => {
    if (other.order.id === c.order.id || sameCity(other, c)) return true;
    if (other.loc && c.loc) return distanceKm(other.loc, c.loc) <= radiusKm;
    // Without a map location, the delivery zone is the only proximity known.
    return other.order.zone === c.order.zone;
  });
}

const dropsOn = (bin: Bin): number => new Set(bin.pieces.map((p) => p.c.order.id)).size;

/** Lower is better: same customer, then same city, then distance. */
function affinity(bin: Bin, c: Candidate): [number, number] {
  if (bin.pieces.some((p) => p.c.order.custId && p.c.order.custId === c.order.custId)) return [0, 0];
  if (bin.pieces.some((p) => sameCity(p.c, c))) return [1, 0];
  let far = 0;
  for (const { c: other } of bin.pieces) {
    if (other.loc && c.loc) far = Math.max(far, distanceKm(other.loc, c.loc));
  }
  return [2, far];
}

const compareAffinity = (a: [number, number], b: [number, number]): number =>
  a[0] - b[0] || a[1] - b[1];

function fitsFleet(bin: Bin, c: Candidate, volume: number, cap: number, route: Route): boolean {
  if (route.mode !== 'fleet') return false;
  if (bin.volume + volume > cap + EPS) return false;
  const newDrop = !bin.pieces.some((p) => p.c.order.id === c.order.id);
  if (newDrop && dropsOn(bin) + 1 > route.runClass.maxDrops) return false;
  return geoFits(bin, c, route.runClass.radiusKm);
}

function packFleet(pieces: Piece[], cap: number, route: Route): Bin[] {
  const bins: Bin[] = [];
  for (const p of [...pieces].sort((a, b) => b.volume - a.volume)) {
    let best: Bin | null = null;
    let bestScore: [number, number] | null = null;
    for (const bin of bins) {
      if (!fitsFleet(bin, p.c, p.volume, cap, route)) continue;
      const score = affinity(bin, p.c);
      if (!bestScore || compareAffinity(score, bestScore) < 0) {
        best = bin;
        bestScore = score;
      }
    }
    if (best) {
      best.pieces.push(p);
      best.volume += p.volume;
    } else {
      bins.push({ pieces: [p], volume: p.volume });
    }
  }
  return bins;
}

/**
 * What a planner should know about a full load's cube: space going empty, or
 * a load only just too big for the next size down.
 */
export function volumeAdvice(
  equipment: readonly Equipment[],
  unit: Equipment,
  volume: number,
  minFill: number,
): string[] {
  const advice: string[] = [];
  const fill = volume / unit.capacityM3;
  if (fill < minFill - EPS) {
    advice.push(
      `Low fill ${Math.round(fill * 100)}% — ${(unit.capacityM3 - volume).toFixed(1)} m³ spare`,
    );
  }
  const smaller = equipment.filter((e) => e.capacityM3 < unit.capacityM3).pop();
  if (smaller && volume - smaller.capacityM3 <= smaller.capacityM3 * 0.1) {
    advice.push(
      `Only ${(volume - smaller.capacityM3).toFixed(1)} m³ over a ${smaller.name} — ` +
        'holding that back would save a size',
    );
  }
  return advice;
}

// ---- the plan -------------------------------------------------------------

interface RouteRules {
  equipment: Equipment[];
  weekdays: readonly number[] | null;
  earlyDays: number;
  /** Part-load label and ceiling for pooled routes; null for the fleet. */
  partLoad: { label: 'LTL' | 'LCL'; maxM3: number; minFill: number } | null;
}

function rulesFor(route: Route, s: DispatchSettings): RouteRules {
  switch (route.mode) {
    case 'fleet':
      return { equipment: byCapacity(s.fleet.trucks), weekdays: null, earlyDays: s.fleet.earlyDays, partLoad: null };
    case 'linehaul':
      return {
        equipment: byCapacity([s.linehaul.trailer]),
        weekdays: route.hub.departureWeekdays,
        earlyDays: s.linehaul.earlyDays,
        partLoad: { label: 'LTL', maxM3: s.linehaul.ltlMaxM3, minFill: s.linehaul.minFtlFill },
      };
    case 'container':
      return {
        equipment: byCapacity(s.container.containers),
        weekdays: s.container.departureWeekdays,
        earlyDays: s.container.earlyDays,
        partLoad: { label: 'LCL', maxM3: s.container.lclMaxM3, minFill: s.container.minFclFill },
      };
    case 'pickup':
      return { equipment: [], weekdays: null, earlyDays: 0, partLoad: null };
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface ResolvedVolume {
  volume: number;
  known: boolean;
  source: VolumeSource;
  weightKg: number | null;
}

/**
 * An order's volume: what the planner entered, else the packed cube from the
 * pick-list comment (measured, so it beats any estimate), else the preferred
 * of the cubics sheet (only when it covers every goods line) and the freight
 * line, else whatever part of the order the sheet does cover.
 */
export function resolveVolume(
  order: ShipmentOrder,
  override: number | undefined,
  prefer: DispatchSettings['preferVolume'],
): ResolvedVolume {
  const weight = isFullCube(order.cube) && order.cube.linesWithoutWeight === 0 ? order.cube.weightKg : null;
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return { volume: override, known: true, source: 'entered', weightKg: weight };
  }
  if (order.packedM3 != null && order.packedM3 > 0) {
    return { volume: order.packedM3, known: true, source: 'packed', weightKg: weight };
  }
  const cubics: ResolvedVolume | null = isFullCube(order.cube)
    ? { volume: order.cube.volumeM3, known: true, source: 'cubics', weightKg: weight }
    : null;
  const freight: ResolvedVolume | null =
    order.volumeM3 !== null
      ? { volume: order.volumeM3, known: true, source: 'freight', weightKg: null }
      : null;
  const pick = prefer === 'cubics' ? cubics ?? freight : freight ?? cubics;
  if (pick) return pick;
  if (order.cube && order.cube.matchedLines > 0) {
    return { volume: order.cube.volumeM3, known: true, source: 'cubics-partial', weightKg: null };
  }
  return { volume: 0, known: false, source: 'none', weightKg: null };
}

/** The share of an order's weight a piece of it carries. */
const pieceWeight = (weight: number | null, piece: number, whole: number): number | null =>
  weight === null ? null : whole > 0 ? (weight * piece) / whole : weight;

const loadWeight = (drops: PlannedDrop[]) => ({
  weightKg: sum(drops.map((d) => d.weightKg ?? 0)),
  weightComplete: drops.every((d) => d.weightKg !== null),
});

export function planDispatch(
  orders: readonly ShipmentOrder[],
  settings: DispatchSettings,
  decisions: DispatchDecisions,
  today: DayKey,
): DispatchPlan {
  const holidays = new Set(settings.holidays);
  const firmEnd = addWorkingDays(today, settings.firmDays, holidays);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const loads: PlannedLoad[] = [];
  const plans = new Map<string, OrderPlan>();
  // The dispatch days each optimised load's route may leave on.
  const allowed = new Map<string, DayKey[]>();

  const volumeOf = (o: ShipmentOrder): ResolvedVolume =>
    resolveVolume(o, decisions.volumeOverrides[o.id], settings.preferVolume);

  const dueOf = (o: ShipmentOrder): DayKey | null => dueDate(o, settings.deadline);

  // Edited and confirmed loads are frozen: emitted as the planner left them,
  // and what they carry kept out of the optimiser. `frozen` holds `whole` for
  // an order that is entirely on frozen loads, else the m³ of its frozen
  // pieces — the rest of it is still planned.
  const frozen = new Map<string, 'whole' | number>();
  for (const firm of decisions.firmLoads) {
    const drops: PlannedDrop[] = firm.orderIds.map((id) => {
      const order = byId.get(id) ?? null;
      const v: ResolvedVolume = order
        ? volumeOf(order)
        : { volume: firm.volumes[id] ?? 0, known: id in firm.volumes, source: 'entered', weightKg: null };
      const share = firm.pieces?.[id];
      const before = frozen.get(id);
      if (share === undefined) frozen.set(id, 'whole');
      else if (before !== 'whole') frozen.set(id, (before ?? 0) + share);
      return {
        orderId: id,
        order,
        volumeM3: share ?? v.volume,
        volumeKnown: v.known,
        volumeSource: v.source,
        weightKg: share === undefined ? v.weightKg : pieceWeight(v.weightKg, share, v.volume),
        piece: null,
        share: share === undefined || v.volume <= 0 ? 1 : Math.min(1, share / v.volume),
        daysEarly: 0,
      };
    });
    const volume = sum(drops.map((d) => d.volumeM3));
    loads.push({
      id: firm.id,
      group: firm.group,
      mode: firm.mode,
      label: firm.label,
      day: firm.day,
      equipment: firm.equipment,
      capacityM3: firm.capacityM3,
      drops,
      volumeM3: volume,
      fill: firm.capacityM3 ? volume / firm.capacityM3 : null,
      ...loadWeight(drops),
      firm: firm.status,
      warnings: firm.status === 'dispatched' ? [] : frozenWarnings(firm, drops, volume, settings, today, holidays),
    });
    for (const d of drops) {
      if (!d.order) continue;
      const existing = plans.get(d.orderId);
      if (existing) {
        existing.loadIds.push(firm.id);
        if (firm.day < existing.day!) existing.day = firm.day;
        continue;
      }
      const due = dueOf(d.order);
      plans.set(d.orderId, {
        orderId: d.orderId,
        route: routeFor(d.order.zone, d.order.city, settings, d.order.shipVia),
        earliest: firm.day,
        latest: firm.day,
        day: firm.day,
        loadIds: [firm.id],
        volumeM3: d.volumeM3,
        volumeKnown: d.volumeKnown,
        volumeSource: d.volumeSource,
        weightKg: d.weightKg,
        flags:
          firm.status !== 'dispatched' && due && due < today ? ['firm', 'overdue'] : ['firm'],
      });
    }
  }

  // Route and window every other order.
  const groups = new Map<string, Candidate[]>();
  for (const order of orders) {
    const share = frozen.get(order.id);
    if (share === 'whole') continue;
    const route = routeFor(order.zone, order.city, settings, order.shipVia);
    const { volume: whole, known, source, weightKg } = volumeOf(order);
    // Only what frozen loads do not already carry is left to plan.
    const volume = share === undefined ? whole : whole - share;
    if (share !== undefined && volume <= 0.01) continue;
    const existing = plans.get(order.id);
    const flags: OrderFlag[] = existing?.flags ?? [];
    if (!known) flags.push('no-volume');
    if (order.cube && order.cube.unmatched.length > 0 && order.cube.matchedLines > 0) {
      flags.push('cube-partial');
    }
    const plan: OrderPlan = existing
      ? Object.assign(existing, { volumeM3: whole })
      : {
          orderId: order.id,
          route,
          earliest: null,
          latest: null,
          day: null,
          loadIds: [],
          volumeM3: whole,
          volumeKnown: known,
          volumeSource: source,
          weightKg,
          flags,
        };
    plans.set(order.id, plan);

    if (!route) flags.push('unrouted');
    if (order.creditHold) flags.push('credit-hold');
    if (order.onHold) flags.push('on-hold');
    if (decisions.holds[order.id] !== undefined) flags.push('held');
    const pin = decisions.pins[order.id];
    const due = dueOf(order);
    if (!due && !pin) flags.push('no-date');
    if (flags.some((f) => BLOCKING_FLAGS.includes(f)) || !route) continue;

    const loc = route.mode === 'fleet' ? locate(order.city) : null;
    if (route.mode === 'fleet' && !loc) flags.push('no-location');
    const c: Candidate = { order, plan, route, due, volume, loc, city: normalizeCity(order.city) };
    const list = groups.get(route.group);
    if (list) list.push(c);
    else groups.set(route.group, [c]);
  }

  for (const [group, candidates] of groups) {
    const route = candidates[0].route;
    const rules = rulesFor(route, settings);

    // Every dispatch day the route has, far enough out to cover the latest
    // due date or pin in the group.
    const lastDate = candidates
      .map((c) => decisions.pins[c.order.id] ?? c.due ?? today)
      .reduce((a, b) => (a > b ? a : b), today);
    const days = dispatchDays(today, addCalendarDays(lastDate, 21), rules.weekdays, holidays);
    if (days.length === 0) continue;

    for (const c of candidates) {
      const pin = decisions.pins[c.order.id];
      if (pin) {
        const day = pin < today ? days[0] : pin;
        c.plan.earliest = day;
        c.plan.latest = day;
        c.plan.flags.push('pinned');
        if (c.due && c.due < today && !c.plan.flags.includes('overdue')) c.plan.flags.push('overdue');
        continue;
      }
      const due = c.due!;
      const onOrBefore = days.filter((d) => d <= due);
      const latest = onOrBefore.length > 0 ? onOrBefore[onOrBefore.length - 1] : days[0];
      if (due < today) {
        if (!c.plan.flags.includes('overdue')) c.plan.flags.push('overdue');
      } else if (latest > due) c.plan.flags.push('late');
      const openFrom = addWorkingDays(due, -rules.earlyDays, holidays);
      const earliest = days.find((d) => d >= openFrom) ?? latest;
      c.plan.earliest = earliest > latest ? latest : earliest;
      c.plan.latest = latest;
    }

    const assigned = new Set<string>();
    const scheduleDays = [...new Set(candidates.map((c) => c.plan.latest!))].sort();
    let counter = 0;

    for (const day of scheduleDays) {
      const due = candidates.filter((c) => c.plan.latest === day && !assigned.has(c.order.id));
      if (due.length === 0) continue;
      for (const c of due) {
        assigned.add(c.order.id);
        if (day < firmEnd && (c.order.readiness === 'not-ready' || c.order.readiness === 'partial')) {
          c.plan.flags.push('not-ready');
        }
      }

      // Orders with time left that may ride today.
      const open = candidates.filter(
        (c) =>
          !assigned.has(c.order.id) &&
          !decisions.pins[c.order.id] &&
          c.plan.volumeKnown &&
          c.volume > 0 &&
          c.plan.earliest! <= day &&
          day < c.plan.latest! &&
          (day >= firmEnd || c.order.readiness === 'ready' || c.order.readiness === 'no-goods'),
      );
      const daysEarly = (c: Candidate) => workingDaysBetween(day, c.plan.latest!, holidays);

      const emit = (bin: Bin, equipment: string, capacity: number | null, advice: string[] = []) => {
        const id = `${group}|${day}|${++counter}`;
        allowed.set(id, days);
        const warnings: string[] = [...advice];
        const drops: PlannedDrop[] = bin.pieces.map((p) => ({
          orderId: p.c.order.id,
          order: p.c.order,
          volumeM3: p.volume,
          volumeKnown: p.c.plan.volumeKnown,
          volumeSource: p.c.plan.volumeSource,
          weightKg: pieceWeight(p.c.plan.weightKg, p.volume, p.c.volume),
          piece: p.piece,
          share: p.c.plan.volumeM3 > 0 ? Math.min(1, p.volume / p.c.plan.volumeM3) : 1,
          daysEarly: p.daysEarly,
        }));
        if (bin.pieces.some((p) => !p.c.plan.volumeKnown)) {
          warnings.push('Contains orders with unknown volume');
        }
        if (capacity !== null && bin.volume > capacity + EPS) {
          warnings.push(`Over capacity by ${(bin.volume - capacity).toFixed(1)} m³`);
        }
        loads.push({
          id,
          group,
          mode: route.mode,
          label: route.label,
          day,
          equipment,
          capacityM3: capacity,
          drops,
          volumeM3: bin.volume,
          fill: capacity ? bin.volume / capacity : null,
          ...loadWeight(drops),
          firm: null,
          warnings,
        });
        for (const p of bin.pieces) {
          const plan = p.c.plan;
          plan.loadIds.push(id);
          if (!plan.day || day < plan.day) plan.day = day;
          if (p.piece && !plan.flags.includes('split')) plan.flags.push('split');
          if (p.daysEarly > 0 && !plan.flags.includes('pulled-forward')) plan.flags.push('pulled-forward');
        }
      };

      /** Add open orders to a bin while they fit, best first. */
      const topUp = (bin: Bin, capacity: number, fits: (c: Candidate) => boolean, rank: (a: Candidate, b: Candidate) => number) => {
        for (;;) {
          const choices = open.filter(
            (c) => !assigned.has(c.order.id) && bin.volume + c.volume <= capacity + EPS && fits(c),
          );
          if (choices.length === 0) return;
          choices.sort(rank);
          const pick = choices[0];
          assigned.add(pick.order.id);
          bin.pieces.push({ c: pick, volume: pick.volume, piece: null, daysEarly: daysEarly(pick) });
          bin.volume += pick.volume;
        }
      };

      const byDeadline = (a: Candidate, b: Candidate) =>
        a.plan.latest!.localeCompare(b.plan.latest!) || b.volume - a.volume;

      if (route.mode === 'pickup') {
        emit({ pieces: due.map((c) => ({ c, volume: c.volume, piece: null, daysEarly: 0 })), volume: sum(due.map((c) => c.volume)) }, 'Pickup', null);
        continue;
      }

      const equipment = rules.equipment;
      if (equipment.length === 0) continue;
      const maxCap = equipment[equipment.length - 1].capacityM3;
      const pieces = due.flatMap((c) => splitPieces(c, maxCap));

      if (route.mode === 'fleet') {
        const bins = packFleet(pieces, maxCap, route);
        for (const bin of bins) {
          topUp(
            bin,
            maxCap,
            (c) => fitsFleet(bin, c, c.volume, maxCap, route),
            (a, b) =>
              compareAffinity(affinity(bin, a), affinity(bin, b)) || byDeadline(a, b),
          );
          const known = bin.pieces.every((p) => p.c.plan.volumeKnown);
          if (known && bin.volume <= settings.fleet.carrierMaxM3 + EPS) {
            // A truck run for a pallet or two costs more than the freight is
            // worth; hand it to a carrier.
            emit(bin, PART_LOAD, null, ['Too small for a whole truck — book as a part load']);
            continue;
          }
          const truck = rightSize(equipment, bin.volume);
          emit(bin, truck.name, truck.capacityM3);
        }
        continue;
      }

      // Linehaul and containers: one consolidation per departure.
      const part = rules.partLoad!;
      const bins = packFirstFit(pieces, maxCap);
      for (const bin of bins) {
        if (bin.volume <= part.maxM3 + EPS) {
          // Too small for a full load on its own. Pull open orders forward
          // only if together they make a properly filled one.
          const smallest = equipment[0];
          const fillable = open
            .filter((c) => !assigned.has(c.order.id))
            .sort(byDeadline);
          let reach = bin.volume;
          for (const c of fillable) {
            if (reach + c.volume <= smallest.capacityM3 + EPS) reach += c.volume;
          }
          if (reach >= smallest.capacityM3 * part.minFill - EPS) {
            topUp(bin, smallest.capacityM3, () => true, byDeadline);
            emit(bin, smallest.name, smallest.capacityM3);
          } else {
            emit(bin, part.label, null);
          }
          continue;
        }
        topUp(bin, maxCap, () => true, byDeadline);
        const unit = rightSize(equipment, bin.volume);
        emit(bin, unit.name, unit.capacityM3, volumeAdvice(equipment, unit, bin.volume, part.minFill));
      }
    }
  }

  if (settings.levelToLimits) level(loads, plans, allowed, decisions, settings, today, firmEnd, holidays);

  // Within a day: NSW delivery first, then linehaul, containers and pickups —
  // the order the dock loads them in.
  const rank: Record<DispatchMode, number> = { fleet: 0, linehaul: 1, container: 2, pickup: 3 };
  loads.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      rank[a.mode] - rank[b.mode] ||
      a.group.localeCompare(b.group) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );

  // An order on more than one load — split by the optimiser, by the planner,
  // or partly frozen — is numbered across all of them in dispatch order.
  const onLoads = new Map<string, PlannedDrop[]>();
  for (const load of loads) {
    for (const d of load.drops) {
      const list = onLoads.get(d.orderId);
      if (list) list.push(d);
      else onLoads.set(d.orderId, [d]);
    }
  }
  for (const [id, list] of onLoads) {
    if (list.length < 2) continue;
    list.forEach((d, i) => (d.piece = { index: i + 1, of: list.length }));
    const plan = plans.get(id);
    if (plan && !plan.flags.includes('split')) plan.flags.push('split');
  }

  const totals = new Map<DayKey, DayTotal>();
  for (const load of loads) {
    const t: DayTotal = totals.get(load.day) ?? {
      day: load.day,
      volumeM3: 0,
      loads: 0,
      trucks: 0,
      containers: 0,
      overStaging: false,
      overTrucks: false,
      overContainers: false,
    };
    const kind = limitKind(load);
    if (kind === 'trucks') t.trucks += 1;
    if (kind === 'containers') t.containers += 1;
    if (load.firm !== 'dispatched') {
      t.volumeM3 += load.volumeM3;
      t.loads += 1;
    }
    totals.set(load.day, t);
  }
  const staging = stagingCapacity(settings);
  for (const [day, t] of totals) {
    if (t.loads === 0) totals.delete(day);
    t.overStaging = staging > 0 && t.volumeM3 > staging + EPS;
    t.overTrucks = settings.trucksPerDay > 0 && t.trucks > settings.trucksPerDay;
    t.overContainers = settings.containersPerDay > 0 && t.containers > settings.containersPerDay;
  }

  return {
    today,
    loads,
    orders: plans,
    days: [...totals.values()].sort((a, b) => a.day.localeCompare(b.day)),
    deadline: settings.deadline,
  };
}

/** Which daily limit a load counts against: whole trucks, FCL containers, or none (part loads, pickups). */
export function limitKind(load: { mode: DispatchMode; capacityM3: number | null }): 'trucks' | 'containers' | null {
  if (load.capacityM3 === null || load.mode === 'pickup') return null;
  return load.mode === 'container' ? 'containers' : 'trucks';
}

/**
 * Bring proposed loads forward off days over their limits — trucks,
 * containers, then marshalling volume — onto the latest earlier day the
 * route departs that still has room. A load only moves inside every one of
 * its orders' pull-forward windows, never before today, into the firm window
 * only with all its goods ready, and never when it carries a pinned order.
 * Nothing moves later: what cannot be brought forward stays, and the day is
 * flagged over its limit.
 */
function level(
  loads: PlannedLoad[],
  plans: Map<string, OrderPlan>,
  allowed: ReadonlyMap<string, DayKey[]>,
  decisions: DispatchDecisions,
  settings: DispatchSettings,
  today: DayKey,
  firmEnd: DayKey,
  holidays: ReadonlySet<string>,
): void {
  const limit = { trucks: settings.trucksPerDay, containers: settings.containersPerDay };
  const staging = stagingCapacity(settings);
  const use = new Map<DayKey, { trucks: number; containers: number; volume: number }>();
  const at = (day: DayKey) => {
    let u = use.get(day);
    if (!u) use.set(day, (u = { trucks: 0, containers: 0, volume: 0 }));
    return u;
  };
  for (const l of loads) {
    const kind = limitKind(l);
    if (kind) at(l.day)[kind] += 1;
    if (l.firm !== 'dispatched') at(l.day).volume += l.volumeM3;
  }

  const overBy = (day: DayKey): DayLimit | null => {
    const u = at(day);
    if (limit.trucks > 0 && u.trucks > limit.trucks) return 'trucks';
    if (limit.containers > 0 && u.containers > limit.containers) return 'containers';
    if (staging > 0 && u.volume > staging + EPS) return 'marshalling';
    return null;
  };
  const roomFor = (day: DayKey, l: PlannedLoad): boolean => {
    const u = at(day);
    const kind = limitKind(l);
    if (kind && limit[kind] > 0 && u[kind] + 1 > limit[kind]) return false;
    return staging <= 0 || u.volume + l.volumeM3 <= staging + EPS;
  };
  const ready = (l: PlannedLoad) =>
    l.drops.every((d) => !d.order || d.order.readiness === 'ready' || d.order.readiness === 'no-goods');

  const days = [...use.keys()].sort();
  for (const day of days) {
    for (let reason = overBy(day); reason; reason = overBy(day)) {
      let best: { load: PlannedLoad; to: DayKey } | null = null;
      for (const l of loads) {
        if (l.day !== day || l.firm !== null || l.mode === 'pickup') continue;
        if (reason !== 'marshalling' && limitKind(l) !== reason) continue;
        if (l.drops.some((d) => decisions.pins[d.orderId])) continue;
        const earliest = l.drops.reduce((e, d) => {
          const o = plans.get(d.orderId)?.earliest;
          return o && o > e ? o : e;
        }, today);
        const canFirm = ready(l);
        const to = (allowed.get(l.id) ?? [])
          .filter((d) => d >= earliest && d < day && (d >= firmEnd || canFirm) && roomFor(d, l))
          .pop();
        if (to && (!best || to > best.to || (to === best.to && l.volumeM3 > best.load.volumeM3))) {
          best = { load: l, to };
        }
      }
      if (!best) break;
      const { load, to } = best;
      const kind = limitKind(load);
      if (kind) {
        at(day)[kind] -= 1;
        at(to)[kind] += 1;
      }
      at(day).volume -= load.volumeM3;
      at(to).volume += load.volumeM3;
      const early = workingDaysBetween(to, day, holidays);
      load.levelled = { from: day, reason };
      load.day = to;
      for (const d of load.drops) {
        d.daysEarly += early;
        const plan = plans.get(d.orderId);
        if (!plan) continue;
        if (!plan.day || to < plan.day) plan.day = to;
        if (!plan.flags.includes('pulled-forward')) plan.flags.push('pulled-forward');
      }
    }
  }
}

/** The NSW run class a load's group names, if it is an NSW delivery load. */
const runClassOf = (group: string, settings: DispatchSettings) =>
  settings.fleet.runClasses.find((c) => groupBase(group) === `fleet:${c.id}`) ?? null;

/**
 * What is wrong with a load the planner built or kept by hand. Nothing is
 * refused — the planner may know better — but nothing is hidden either.
 */
function frozenWarnings(
  firm: FirmLoad,
  drops: PlannedDrop[],
  volume: number,
  settings: DispatchSettings,
  today: DayKey,
  holidays: ReadonlySet<DayKey>,
): string[] {
  const warnings: string[] = [];
  const gone = drops.filter((d) => !d.order).map((d) => d.orderId);
  if (gone.length > 0) warnings.push(`Not in the latest waybill: ${gone.join(', ')}`);
  if (firm.day < today) warnings.push(`${firm.status === 'edited' ? 'Planned' : 'Confirmed'} for a past day — mark dispatched or release`);
  if (firm.capacityM3 && volume > firm.capacityM3 + EPS) {
    warnings.push(`Over capacity by ${(volume - firm.capacityM3).toFixed(1)} m³`);
  }

  const late = drops.filter((d) => {
    const due = d.order ? dueDate(d.order, settings.deadline) : null;
    return due !== null && due < firm.day;
  });
  if (late.length > 0) {
    warnings.push(`Leaves after the due date of ${late.map((d) => d.orderId).join(', ')}`);
  }

  // Orders moved onto a load that does not go their way: another mode or
  // hub, or — for linehaul and containers — another carrier or zone.
  const mix = new Map<string, { label: string; n: number }>();
  for (const d of drops) {
    if (!d.order) continue;
    const route = routeFor(d.order.zone, d.order.city, settings, d.order.shipVia);
    if (!route) continue;
    if (route.mode !== firm.mode || (firm.mode !== 'fleet' && groupBase(route.group) !== groupBase(firm.group))) {
      warnings.push(`${d.orderId} is routed ${route.label}`);
      continue;
    }
    const m = mix.get(route.group);
    if (m) m.n += 1;
    else mix.set(route.group, { label: `${d.order.zone.trim()}${d.order.shipVia ? ` (${d.order.shipVia})` : ''}`, n: 1 });
  }
  const keptApart = firm.mode !== 'fleet' || settings.fleet.keepShipViaApart;
  if (keptApart && mix.size > 1) {
    warnings.push(
      `Mixes carriers or zones — book each separately: ${[...mix.values()]
        .map((m) => `${m.label} ×${m.n}`)
        .join(', ')}`,
    );
  }

  const hub = firm.mode === 'linehaul'
    ? settings.linehaul.hubs.find((h) => groupBase(firm.group) === `linehaul:${h.id}`) ?? null
    : null;
  const departs = hub ? hub.departureWeekdays : firm.mode === 'container' ? settings.container.departureWeekdays : null;
  if (!isWorkingDay(firm.day, holidays)) {
    warnings.push('Not a working day');
  } else if (departs && !departs.includes(isoWeekday(firm.day))) {
    warnings.push(`No ${hub ? hub.label : 'container'} departure on this weekday`);
  }

  const run = firm.mode === 'fleet' ? runClassOf(firm.group, settings) : null;
  if (run) {
    const stops = new Set(drops.map((d) => d.orderId)).size;
    if (stops > run.maxDrops) warnings.push(`${stops} drops — a ${run.label} run takes ${run.maxDrops}`);
    let far = { km: 0, a: '', b: '' };
    const placed = drops
      .filter((d) => d.order)
      .map((d) => ({ city: d.order!.city, at: locate(d.order!.city) }))
      .filter((p): p is { city: string; at: LatLon } => p.at !== null);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const km = distanceKm(placed[i].at, placed[j].at);
        if (km > far.km) far = { km, a: placed[i].city, b: placed[j].city };
      }
    }
    if (far.km > run.radiusKm + EPS) {
      warnings.push(
        `${far.a} and ${far.b} are ${Math.round(far.km)} km apart — beyond the ${run.radiusKm} km run radius`,
      );
    }
  }
  return warnings;
}

/**
 * The vehicle, container or part load a volume needs on a route — the same
 * rule the optimiser sizes with, for loads the planner changes by hand.
 */
export function fitEquipment(
  mode: DispatchMode,
  volume: number,
  settings: DispatchSettings,
): { equipment: string; capacityM3: number | null } {
  switch (mode) {
    case 'pickup':
      return { equipment: 'Pickup', capacityM3: null };
    case 'fleet': {
      if (settings.fleet.carrierMaxM3 > 0 && volume <= settings.fleet.carrierMaxM3 + EPS) {
        return { equipment: PART_LOAD, capacityM3: null };
      }
      const trucks = byCapacity(settings.fleet.trucks);
      if (trucks.length === 0) return { equipment: PART_LOAD, capacityM3: null };
      const t = rightSize(trucks, volume);
      return { equipment: t.name, capacityM3: t.capacityM3 };
    }
    case 'linehaul': {
      if (volume <= settings.linehaul.ltlMaxM3 + EPS) return { equipment: 'LTL', capacityM3: null };
      const t = settings.linehaul.trailer;
      return { equipment: t.name, capacityM3: t.capacityM3 };
    }
    case 'container': {
      const boxes = byCapacity(settings.container.containers);
      if (volume <= settings.container.lclMaxM3 + EPS || boxes.length === 0) {
        return { equipment: 'LCL', capacityM3: null };
      }
      const c = rightSize(boxes, volume);
      return { equipment: c.name, capacityM3: c.capacityM3 };
    }
  }
}
