/**
 * Level loading: take the load blocks somebody picked and re-place the orders
 * behind them so no day asks more of a crew than the crew can work.
 *
 * What it moves, and what it does not.
 *
 *   - It moves orders nobody is on yet. Their start is a plan and nothing
 *     else: the box is drawn from the day it is given (`unstaffedWindow`), so
 *     writing a start is all it takes. An order with a crew is left where it
 *     is — its days come out of the crew's diary, and moving one by a pin
 *     would quietly re-sequence whoever is on it. Its hours still count against
 *     the day. So do orders already begun, support orders (hours typed by
 *     hand), routed operations (their bench is the route's) and anything with
 *     weekend overtime approved.
 *   - It never moves an order past what holds it. Nothing starts before today,
 *     before the day its material lands, or before the component it is made
 *     from is finished; and nothing is pushed past the last day it can run and
 *     still make its Due Date. An order short of material with no dated PO is
 *     held where it is — there is no honest day to move it to.
 *
 * Linked orders. An order that has to finish before another starts is a chain,
 * and a chain is moved as one: putting an order later pushes whatever waits for
 * it to start after it, and pulling one earlier brings the order it waits on
 * earlier with it, so nothing ever ends up starting before its supplier is
 * done. Each of those moves is listed against the order that caused it, and
 * the room they need is counted like any other order's.
 *
 * Capacity is the crews', not the line's: a day's room is read off the same
 * `shareDay` the banner and the folded rows are drawn from, so the plan agrees
 * with what the board shows afterwards. Orders are placed nearest Due Date
 * first, each staying where it is when it fits and otherwise taking the closest
 * day that has room — the day before before the day after, since finishing
 * early costs a shelf and finishing late costs a customer.
 *
 * Pure. No React, no store.
 */

import { rootLineKey, type CrewPool, type LineKey } from '@/domain/assembly';
import { jobNumOf } from '@/domain/routing';
import type { OrderRow } from '@/engine/assembly/board';
import { addCalendarDays, isWeekend, startOfDay } from '@/engine/assembly/dates';
import { remainingHours } from '@/engine/assembly/duration';
import { shiftOpensOn } from '@/engine/assembly/shift';
import { formatShortDay, fromDayKey, toDayKey } from '@/lib/time';
import {
  hasBegun,
  lastWorkingDayFor,
  unstaffedSpanDays,
  unstaffedWindow,
} from './boardView';
import { shareDay } from './crewCapacity';
import { rowIndex } from './rowIndex';

/** Hours under which a day is not read as over: rounding, not a load. */
const EPS = 0.05;
/** Working days planned beyond the last Due Date, so a run has somewhere to land. */
const TAIL_DAYS = 14;
/** Guards the calendar against a Due Date years out on a bad export. */
const MAX_HORIZON_DAYS = 400;

export interface LevelInput {
  /** Every row on the board, moulding's included — an order may wait on one. */
  rows: readonly OrderRow[];
  pools: readonly CrewPool[];
  today: Date;
  /**
   * Per line, the day keys of the load blocks that were picked. A lane's block
   * covers its benches' orders too; a bench's block only its own.
   */
  picks: ReadonlyMap<LineKey, ReadonlySet<string>>;
  /** Share of a crew's day the plan may fill, 0–1. Defaults to all of it. */
  ceiling?: number;
}

export type LeftKind = 'fixed' | 'held' | 'window';

export interface LevelMove {
  jobId: string;
  order: string;
  description: string;
  line: string;
  lane: LineKey;
  hours: number;
  /** The day it starts now, or null when it has no day of its own yet. */
  fromDay: string | null;
  toDay: string;
  /** What to pin: the open of the shift on `toDay`. */
  startISO: string;
  kind: 'level' | 'linked';
  /** For a linked move: the order that pulled it, and which way. */
  because?: { order: string; effect: 'follows' | 'ahead of' };
  /** Still over capacity on some of its days, even here. */
  stillOver: boolean;
}

export interface LevelLeft {
  jobId: string;
  order: string;
  line: string;
  hours: number;
  kind: LeftKind;
  why: string;
}

export interface OverDay {
  day: string;
  pool: string;
  demand: number;
  capacity: number;
}

export interface LevelPlan {
  moves: LevelMove[];
  left: LevelLeft[];
  /** Lanes that were picked but that no crew group lists — nothing to level against. */
  noCrew: LineKey[];
  /** Hours over capacity, and days over, across the picked days. */
  before: { hours: number; days: number };
  after: { hours: number; days: number };
  /** What is still over after the plan, worst first. */
  stillOver: OverDay[];
  /** Orders behind the picked blocks, moved or not. */
  inScope: number;
}

type Mobility = 'free' | 'held' | 'fixed';

interface Item {
  id: string;
  row: OrderRow;
  lane: LineKey;
  order: string;
  kind: Mobility;
  /** Why it is fixed or held — the words the plan shows. */
  why: string;
  hours: number;
  /** Working days it takes when planned by us. */
  span: number;
  /** Day key → hours, as the board draws it now. Empty when it draws nothing. */
  profile: Map<string, number>;
  /** Position of the first / last day of that profile; null with none. */
  first: number | null;
  last: number | null;
  E: number;
  L: number;
  /** Set when the plan puts it somewhere new. */
  placed?: number;
  linked?: { order: string; effect: 'follows' | 'ahead of' };
  inScope: boolean;
  /** What it waits on, grouped by the component that is waited for. */
  groups: Supplier[];
  /** Orders that wait on this one and on nothing else for the same part. */
  succs: Item[];
}

/** The open batches of one component: whichever finishes first serves. */
interface Supplier {
  items: Item[];
  /** Press work and the like, which this board reads but does not plan. */
  outside: OrderRow[];
}

/** Weekdays from `from`, in order — the days a crew can work. */
interface Calendar {
  days: Date[];
  keys: string[];
}

function buildCalendar(from: Date, until: Date): Calendar {
  const days: Date[] = [];
  const keys: string[] = [];
  for (let d = startOfDay(from); d <= until; d = addCalendarDays(d, 1)) {
    if (isWeekend(d)) continue;
    days.push(d);
    keys.push(toDayKey(d));
  }
  return { days, keys };
}

/** Index of the first key >= `key`; `keys.length` when there is none. */
function lowerBound(keys: readonly string[], key: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const dayNameOf = (key: string): string => formatShortDay(fromDayKey(key));

export function planLevelLoad(input: LevelInput): LevelPlan {
  const { rows, pools, today, picks } = input;
  const ceiling = Math.min(1, Math.max(0.1, input.ceiling ?? 1));
  const todayKey = toDayKey(startOfDay(today));

  // ---- the calendar ------------------------------------------------------
  let horizon = addCalendarDays(startOfDay(today), 8 * 7);
  for (const row of rows) {
    const due = row.job.dueDate;
    if (due && due > horizon) horizon = due;
  }
  const cap = addCalendarDays(startOfDay(today), MAX_HORIZON_DAYS);
  if (horizon > cap) horizon = cap;
  const cal = buildCalendar(today, addCalendarDays(horizon, TAIL_DAYS));
  const posOnOrAfter = (d: Date) => lowerBound(cal.keys, toDayKey(startOfDay(d)));
  /** The last working day at or before `d`, or -1 when that is before today. */
  const posOnOrBefore = (d: Date): number => {
    const key = toDayKey(startOfDay(d));
    const i = lowerBound(cal.keys, key);
    return cal.keys[i] === key ? i : i - 1;
  };

  // ---- the items ---------------------------------------------------------
  const byId = rowIndex(rows);
  const items = new Map<string, Item>();
  const held = (row: OrderRow): boolean =>
    row.material.level === 'short' ||
    (row.shortPicks ?? []).some(
      (s) => !(s.incoming?.coversShort && s.incoming.availableDate),
    );

  const classify = (row: OrderRow): { kind: Mobility; why: string } => {
    if (row.job.manual) return { kind: 'fixed', why: 'support order — its hours are typed in on its own form' };
    if (row.actualStart || hasBegun(row)) return { kind: 'fixed', why: 'production has started' };
    if (row.job.operation) return { kind: 'fixed', why: 'routed operation — its bench follows the route' };
    if (row.overtime) return { kind: 'fixed', why: 'weekend overtime approved on it' };
    if (row.start) {
      return {
        kind: 'fixed',
        why: 'has a crew — its days come from the crew, so it is left where it is',
      };
    }
    if (held(row)) return { kind: 'held', why: 'short of material with no dated PO' };
    return { kind: 'free', why: '' };
  };

  /** What the board draws for this row now: day key → hours. */
  const profileOf = (row: OrderRow): Map<string, number> => {
    const out = new Map<string, number>();
    if (row.completedToday) return out;
    if (row.start) {
      for (const day of row.crewDays) {
        if (day.hours > 0 && day.day >= todayKey) out.set(day.day, (out.get(day.day) ?? 0) + day.hours);
      }
      return out;
    }
    const window = unstaffedWindow(row);
    const hours = row.uncoveredHours ?? remainingHours(row.job);
    if (!window || hours <= 0) return out;
    const open: string[] = [];
    for (let d = startOfDay(window.from); d < window.to; d = addCalendarDays(d, 1)) {
      if (!isWeekend(d)) open.push(toDayKey(d));
    }
    if (open.length === 0) open.push(toDayKey(startOfDay(window.from)));
    for (const key of open) out.set(key, (out.get(key) ?? 0) + hours / open.length);
    return out;
  };

  for (const row of rows) {
    if (!row.line.schedulable) continue;
    const id = String(row.job.id);
    const { kind, why } = classify(row);
    const profile = profileOf(row);
    const keys = [...profile.keys()].sort();
    items.set(id, {
      id,
      row,
      lane: rootLineKey(row.line.key),
      order: row.job.operation
        ? `${jobNumOf(id)} #${row.job.operation.seq}`
        : jobNumOf(id),
      kind,
      why,
      // What the order is worth, for the list: a crewed row has no uncovered hours.
      hours: row.start ? remainingHours(row.job) : (row.uncoveredHours ?? remainingHours(row.job)),
      span: unstaffedSpanDays(row),
      profile,
      first: keys.length ? posOnOrAfter(fromDayKey(keys[0])) : null,
      last: keys.length ? posOnOrBefore(fromDayKey(keys[keys.length - 1])) : null,
      E: 0,
      L: Number.MAX_SAFE_INTEGER,
      inScope: false,
      groups: [],
      succs: [],
    });
  }

  // What a row that is not on an assembly line — a press job — finishes and
  // starts, for the orders waiting on it.
  const outside = (row: OrderRow): { start: number; finish: number } | null => {
    const end = row.expectDate ?? row.planThrough;
    if (!row.start || !end) return null;
    return {
      start: posOnOrAfter(row.start),
      finish: posOnOrBefore(new Date(end.getTime() - 1)),
    };
  };
  const fixedFinish = (row: OrderRow, item: Item | undefined): number => {
    if (item && item.last !== null) return item.last;
    const o = outside(row);
    return o ? o.finish : -1;
  };
  const fixedStart = (row: OrderRow, item: Item | undefined): number => {
    if (item && item.first !== null) return item.first;
    const o = outside(row);
    return o ? o.start : Number.MAX_SAFE_INTEGER;
  };

  // The wait-for edges, grouped by the component that is waited for: several
  // open batches of one part are alternatives, and the first ready serves.
  const consumers = new Map<string, Item[]>();
  for (const item of items.values()) {
    const groups = new Map<string, Supplier>();
    for (const dep of item.row.predecessors) {
      if (dep.coveredFraction >= 1) continue;
      const pred = byId.get(String(dep.onJobId));
      if (!pred || pred === item.row) continue;
      const key = dep.part ? `part:${String(dep.part)}` : `job:${String(dep.onJobId)}`;
      const group = groups.get(key) ?? { items: [], outside: [] };
      const supplier = items.get(String(pred.job.id));
      if (supplier) group.items.push(supplier);
      else group.outside.push(pred);
      groups.set(key, group);
    }
    item.groups = [...groups.values()];
    for (const group of item.groups) {
      // Only a lone supplier binds its consumer: with alternatives the
      // consumer can take the other batch.
      if (group.items.length === 1 && group.outside.length === 0) group.items[0].succs.push(item);
      for (const p of group.items) {
        const list = consumers.get(p.id) ?? [];
        if (!list.includes(item)) list.push(item);
        consumers.set(p.id, list);
      }
    }
  }

  // ---- windows -----------------------------------------------------------
  const memoE = new Map<string, number>();
  const visiting = new Set<string>();
  /** The day a component is first there: its earliest-finishing batch. */
  const servedAt = (group: Supplier, of: (p: Item) => number): number =>
    Math.min(
      ...group.items.map(of),
      ...group.outside.map((r) => fixedFinish(r, undefined)),
    );
  const finishEarliest = (p: Item): number =>
    p.kind === 'free' ? earliest(p) + p.span - 1 : fixedFinish(p.row, p);
  function earliest(item: Item): number {
    const held = memoE.get(item.id);
    if (held !== undefined) return held;
    if (visiting.has(item.id)) return 0;
    visiting.add(item.id);
    let e = 0;
    const material = [item.row.materialReadyAt, item.row.material.earliestStart].filter(
      (d): d is Date => Boolean(d),
    );
    for (const when of material) e = Math.max(e, posOnOrAfter(when));
    for (const group of item.groups) e = Math.max(e, servedAt(group, finishEarliest) + 1);
    visiting.delete(item.id);
    memoE.set(item.id, e);
    return e;
  }

  const memoL = new Map<string, number>();
  function latest(item: Item): number {
    const held = memoL.get(item.id);
    if (held !== undefined) return held;
    if (visiting.has(item.id)) return Number.MAX_SAFE_INTEGER;
    visiting.add(item.id);
    const due = item.row.job.dueDate;
    let l = due ? posOnOrBefore(lastWorkingDayFor(due)) - item.span + 1 : cal.days.length;
    for (const succ of item.succs) {
      const bound =
        succ.kind === 'fixed' ? fixedStart(succ.row, succ) : latest(succ);
      l = Math.min(l, bound - item.span);
    }
    visiting.delete(item.id);
    memoL.set(item.id, l);
    return l;
  }
  for (const item of items.values()) {
    item.E = earliest(item);
    item.L = latest(item);
  }

  // ---- the ledger --------------------------------------------------------
  const ledger = new Map<string, Map<LineKey, number>>();
  const put = (lane: LineKey, profile: ReadonlyMap<string, number>, sign: 1 | -1) => {
    for (const [day, hours] of profile) {
      if (day < todayKey) continue;
      const lanes = ledger.get(day) ?? new Map<LineKey, number>();
      lanes.set(lane, Math.max(0, (lanes.get(lane) ?? 0) + sign * hours));
      ledger.set(day, lanes);
    }
  };
  const poolsFor = (lane: LineKey) => pools.filter((p) => p.lines.includes(lane));
  const dayShare = (day: string, extra?: { lane: LineKey; hours: number }) => {
    const demand = new Map(ledger.get(day) ?? []);
    if (extra) demand.set(extra.lane, (demand.get(extra.lane) ?? 0) + extra.hours);
    return shareDay(demand, pools, !isWeekend(fromDayKey(day))).pools;
  };
  const overOf = (poolsDay: ReturnType<typeof dayShare>): number =>
    poolsDay.reduce((n, p) => n + Math.max(0, p.demand - p.capacity * ceiling), 0);
  const overloadOn = (day: string, extra?: { lane: LineKey; hours: number }): number =>
    overOf(dayShare(day, extra));

  for (const item of items.values()) put(item.lane, item.profile, 1);

  // ---- scope -------------------------------------------------------------
  const noCrew: LineKey[] = [];
  const pickedPools = new Set<string>();
  for (const [line, days] of picks) {
    if (days.size === 0) continue;
    const lane = rootLineKey(line);
    const mine = poolsFor(lane);
    if (mine.length === 0 && !noCrew.includes(lane)) noCrew.push(lane);
    for (const p of mine) pickedPools.add(p.id);
  }
  /** The picked days that reach this order: its own line's, and its lane's. */
  const pickedFor = (item: Item): ReadonlySet<string> | null => {
    const own = picks.get(item.row.line.key);
    const lane = item.row.line.key === item.lane ? undefined : picks.get(item.lane);
    if (own && lane) return new Set([...own, ...lane]);
    return own ?? lane ?? null;
  };
  const pickedDays = new Set<string>();
  for (const days of picks.values()) for (const d of days) if (d >= todayKey) pickedDays.add(d);

  const measure = (): { hours: number; days: number; over: OverDay[] } => {
    let hours = 0;
    let days = 0;
    const over: OverDay[] = [];
    for (const day of [...pickedDays].sort()) {
      let dayOver = 0;
      for (const p of dayShare(day)) {
        if (!pickedPools.has(p.id)) continue;
        const excess = p.demand - p.capacity * ceiling;
        if (excess > EPS) {
          dayOver += excess;
          over.push({ day, pool: p.name, demand: p.demand, capacity: p.capacity * ceiling });
        }
      }
      hours += dayOver;
      if (dayOver > EPS) days++;
    }
    return { hours, days, over };
  };
  const before = measure();

  const left: LevelLeft[] = [];
  const scope: Item[] = [];
  for (const item of items.values()) {
    const days = pickedFor(item);
    if (!days || ![...item.profile.keys()].some((d) => days.has(d) && d >= todayKey)) continue;
    item.inScope = true;
    if (noCrew.includes(item.lane)) continue;
    if (item.kind === 'fixed' || item.kind === 'held') {
      left.push({
        jobId: item.id,
        order: item.order,
        line: item.row.line.name,
        hours: item.hours,
        kind: item.kind,
        why: item.why,
      });
      continue;
    }
    scope.push(item);
  }
  const inScope = [...items.values()].filter((i) => i.inScope).length;

  // ---- placement ---------------------------------------------------------
  const startOf = (item: Item): number | null =>
    item.placed !== undefined ? item.placed : item.first;
  const finishOf = (item: Item): number | null =>
    item.placed !== undefined ? item.placed + item.span - 1 : item.last;
  const uniform = (item: Item, s: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i < item.span && s + i < cal.keys.length; i++) {
      out.set(cal.keys[s + i], item.hours / item.span);
    }
    return out;
  };
  const current = (item: Item): Map<string, number> =>
    item.placed !== undefined ? uniform(item, item.placed) : item.profile;

  /** Overload added by putting `profile` on `lane`'s days, on top of the ledger. */
  const added = (lane: LineKey, profile: ReadonlyMap<string, number>): number => {
    let sum = 0;
    for (const [day, hours] of profile) {
      sum += overloadOn(day, { lane, hours }) - overloadOn(day);
    }
    return sum;
  };

  const moveTo = (
    item: Item,
    s: number,
    linked?: { order: string; effect: 'follows' | 'ahead of' },
  ) => {
    put(item.lane, current(item), -1);
    item.placed = s;
    if (linked) item.linked = linked;
    else delete item.linked;
    put(item.lane, uniform(item, s), 1);
  };

  /** Where a supplier stands now: placed, or as early as it could be pulled to. */
  const finishNow = (p: Item): number => {
    if (p.placed !== undefined) return p.placed + p.span - 1;
    return p.kind === 'free' ? finishEarliest(p) : fixedFinish(p.row, p);
  };
  /** Where a supplier is drawn now, for the orders that wait on it. */
  const finishDrawn = (p: Item): number => finishOf(p) ?? finishNow(p);

  /** The first day `item` may start, given where its suppliers now are. */
  const releaseOf = (item: Item): number => {
    let r = item.E;
    for (const group of item.groups) r = Math.max(r, servedAt(group, finishNow) + 1);
    return r;
  };

  /** Push whatever waits for `item` to start after it, and so on down the chain. */
  const followers = (item: Item, seen: Set<string> = new Set([item.id])) => {
    if (finishOf(item) === null) return;
    for (const succ of consumers.get(item.id) ?? []) {
      if (succ.kind === 'fixed' || seen.has(succ.id)) continue;
      const start = startOf(succ);
      if (start === null) continue;
      // Only the component this order supplies: another supplier's lateness
      // is not this move's to answer for.
      const group = succ.groups.find((g) => g.items.includes(item));
      if (!group) continue;
      const need = servedAt(group, finishDrawn) + 1;
      if (start >= need) continue;
      if (need > succ.L || need + succ.span > cal.keys.length) continue;
      seen.add(succ.id);
      moveTo(succ, need, { order: item.order, effect: 'follows' });
      followers(succ, seen);
    }
  };

  /** Bring the suppliers of `item` in ahead of it when it has been pulled forward. */
  const leaders = (item: Item, seen: Set<string> = new Set([item.id])) => {
    const start = startOf(item);
    if (start === null) return;
    for (const group of item.groups) {
      if (servedAt(group, finishDrawn) < start) continue;
      const p = group.items.reduce<Item | null>(
        (a, b) => (a === null || finishDrawn(b) < finishDrawn(a) ? b : a),
        null,
      );
      if (!p || p.kind !== 'free' || seen.has(p.id)) continue;
      const to = start - p.span;
      if (to < p.E) continue;
      seen.add(p.id);
      moveTo(p, to, { order: item.order, effect: 'ahead of' });
      leaders(p, seen);
    }
  };

  interface Offer {
    item: Item;
    /** Overload it adds where it stands, and at the best other day it could take. */
    stay: number;
    over: number;
    at: number;
    distance: number;
  }
  /** The best other start for `item` — the closest that adds least overload. */
  const offerFor = (item: Item): Offer | null => {
    const now = startOf(item);
    if (now === null) return null;
    const cur = current(item);
    put(item.lane, cur, -1);
    const stay = added(item.lane, cur);
    const lo = Math.max(0, releaseOf(item));
    const hi = Math.min(item.L, cal.keys.length - item.span);
    let best: Offer | null = null;
    for (let s = lo; s <= hi; s++) {
      if (s === now) continue;
      const over = Math.round(added(item.lane, uniform(item, s)) / EPS) * EPS;
      const distance = Math.abs(s - now);
      // Least overload, then the least far to go, then the earlier day: a
      // finished order waits on a shelf, a late one costs a customer.
      if (
        !best ||
        over < best.over - 1e-9 ||
        (Math.abs(over - best.over) < 1e-9 && distance < best.distance)
      ) {
        best = { item, stay, over, at: s, distance };
      }
    }
    put(item.lane, cur, 1);
    return best;
  };

  // Chronologically, each picked day over capacity gives up whichever order
  // can leave it for the least disturbance — a move that lands somewhere with
  // room beating one that only spreads the overload — until the day fits or
  // nothing left on it can go anywhere better. A move can tip a neighbouring
  // day over, so the days are swept again.
  const limit = scope.length * 4 + 20;
  let spent = 0;
  const sweeps = 3;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let changed = false;
    for (const day of [...pickedDays].sort()) {
      while (spent < limit) {
        const over = dayShare(day)
          .filter((p) => pickedPools.has(p.id))
          .reduce((n, p) => n + Math.max(0, p.demand - p.capacity * ceiling), 0);
        if (over <= EPS) break;
        const offers = scope
          .filter((item) => (current(item).get(day) ?? 0) > 0)
          .map(offerFor)
          .filter((o): o is Offer => o !== null && o.stay - o.over > EPS);
        if (offers.length === 0) break;
        offers.sort(
          (a, b) =>
            Number(a.over > EPS) - Number(b.over > EPS) ||
            a.distance - b.distance ||
            (b.item.row.job.dueDate?.getTime() ?? 0) - (a.item.row.job.dueDate?.getTime() ?? 0) ||
            b.item.hours - a.item.hours ||
            a.item.id.localeCompare(b.item.id),
        );
        const pick = offers[0];
        moveTo(pick.item, pick.at);
        followers(pick.item);
        leaders(pick.item);
        spent++;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // What is still over, and which orders it is standing on.
  const overNow = new Set<string>();
  for (const day of pickedDays) {
    if (dayShare(day).some((p) => pickedPools.has(p.id) && p.demand - p.capacity * ceiling > EPS)) {
      overNow.add(day);
    }
  }
  const stillOverOrders = new Set<string>();
  for (const item of scope) {
    if ([...current(item).keys()].some((d) => overNow.has(d))) stillOverOrders.add(item.id);
  }
  for (const item of scope) {
    if (!stillOverOrders.has(item.id) || item.placed !== undefined) continue;
    left.push({
      jobId: item.id,
      order: item.order,
      line: item.row.line.name,
      hours: item.hours,
      kind: 'window',
      why: stayReason(item),
    });
  }
  // ---- the answer --------------------------------------------------------
  const after = measure();
  const moves: LevelMove[] = [];
  for (const item of items.values()) {
    if (item.placed === undefined || item.placed === item.first) continue;
    const toKey = cal.keys[item.placed];
    const fromKey = item.first !== null ? cal.keys[item.first] : null;
    const lanePools = new Set(poolsFor(item.lane).map((p) => p.id));
    const over = [...uniform(item, item.placed).keys()].some((day) =>
      dayShare(day).some((p) => lanePools.has(p.id) && p.demand - p.capacity * ceiling > EPS),
    );
    moves.push({
      jobId: item.id,
      order: item.order,
      description: item.row.job.description ?? '',
      line: item.row.line.name,
      lane: item.lane,
      hours: item.hours,
      fromDay: fromKey,
      toDay: toKey,
      startISO: shiftOpensOn(cal.days[item.placed]).toISOString(),
      kind: item.linked ? 'linked' : 'level',
      because: item.linked,
      stillOver: over,
    });
  }
  moves.sort(
    (a, b) =>
      Number(a.kind === 'linked') - Number(b.kind === 'linked') ||
      a.toDay.localeCompare(b.toDay) ||
      a.order.localeCompare(b.order),
  );
  return {
    moves,
    left,
    noCrew,
    before: { hours: before.hours, days: before.days },
    after: { hours: after.hours, days: after.days },
    stillOver: after.over.sort((a, b) => b.demand - b.capacity - (a.demand - a.capacity)),
    inScope,
  };

  function windowReason(item: Item, release: number): string {
    const due = item.row.job.dueDate;
    const dueLast = due ? posOnOrBefore(lastWorkingDayFor(due)) : -1;
    if (due && dueLast < 0) return `already past its Due Date ${dayNameOf(toDayKey(due))}`;
    const material = [item.row.materialReadyAt, item.row.material.earliestStart]
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (material && posOnOrAfter(material) >= release && posOnOrAfter(material) > item.L) {
      return `material lands ${dayNameOf(toDayKey(material))}, after the last day it can start and make its Due Date`;
    }
    for (const group of item.groups) {
      if (servedAt(group, finishNow) + 1 <= item.L) continue;
      const named = group.items[0]?.order ?? (group.outside[0] ? jobNumOf(String(group.outside[0].job.id)) : 'a component');
      return `waits for ${named}, which cannot be finished in time for this order to make its Due Date`;
    }
    return due
      ? `cannot make its Due Date ${dayNameOf(toDayKey(due))} from here`
      : 'no Due Date to place it against';
  }

  /** Why an order that had somewhere to go is still where it was. */
  function stayReason(item: Item): string {
    const lo = releaseOf(item);
    const hi = Math.min(item.L, cal.keys.length - item.span);
    if (lo > hi) return windowReason(item, lo);
    const due = item.row.job.dueDate;
    const byDue = due ? posOnOrBefore(lastWorkingDayFor(due)) - item.span + 1 : Number.MAX_SAFE_INTEGER;
    if (item.L < byDue) {
      const holder = item.succs
        .filter((succ) => (succ.kind === 'fixed' ? fixedStart(succ.row, succ) : latest(succ)) - item.span === item.L)[0];
      if (holder) {
        return `${holder.order} waits for it and has to start by ${dayNameOf(cal.keys[Math.max(0, item.L + item.span)] ?? '')}, so it cannot be put later — and nothing earlier has room`;
      }
    }
    return 'no other day it may run on has room for it — it needs overtime or more people';
  }
}

/** The pins a plan writes: order id → the shift open of its new start day. */
export function pinsOf(plan: Pick<LevelPlan, 'moves'>): Record<string, string> {
  return Object.fromEntries(plan.moves.map((m) => [m.jobId, m.startISO]));
}

/** One load block's day, as the selection stores it: `line|YYYY-MM-DD`. */
export const loadPickKey = (line: LineKey, day: string): string => `${line}|${day}`;

/** The stored selection, back into a line → days map. */
export function parseLoadPicks(keys: readonly string[]): Map<LineKey, Set<string>> {
  const out = new Map<LineKey, Set<string>>();
  for (const key of keys) {
    const at = key.lastIndexOf('|');
    if (at < 0) continue;
    const line = key.slice(0, at) as LineKey;
    const days = out.get(line) ?? new Set<string>();
    days.add(key.slice(at + 1));
    out.set(line, days);
  }
  return out;
}

/**
 * Hours over capacity across the picked days, read off the board's own
 * capacity figures — the same sum the plan predicts, taken from a real
 * schedule. What is asked of a crew is measured against the crews that serve
 * the picked lines, at the share of the day the plan was allowed to fill.
 */
export function pickedOverload(
  capacity: readonly { key: string; pools: readonly { id: string; demand: number; capacity: number }[] }[],
  picks: ReadonlyMap<LineKey, ReadonlySet<string>>,
  pools: readonly CrewPool[],
  ceiling = 1,
): { hours: number; days: number } {
  const served = new Set<string>();
  const days = new Set<string>();
  for (const [line, picked] of picks) {
    for (const p of pools) if (p.lines.includes(rootLineKey(line))) served.add(p.id);
    for (const d of picked) days.add(d);
  }
  let hours = 0;
  let over = 0;
  for (const day of capacity) {
    if (!days.has(day.key)) continue;
    let dayOver = 0;
    for (const p of day.pools) {
      if (served.has(p.id)) dayOver += Math.max(0, p.demand - p.capacity * ceiling);
    }
    if (dayOver > EPS) over++;
    hours += dayOver > EPS ? dayOver : 0;
  }
  return { hours, days: over };
}
