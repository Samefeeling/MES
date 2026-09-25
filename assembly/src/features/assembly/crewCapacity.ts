/**
 * What each day can deliver, and how much of it is asked for — one sum that
 * the banner over the dates and every folded line's row are both read from.
 *
 * Demand on a line is the hours its crew is planned to work that day plus the
 * hours of orders nobody is on yet that have to land on that day to make
 * their Due Date (`lineDayLoads`). Capacity is not a line's: it belongs to the
 * crews the supervisor sets (`CrewPool`), and a line two crews share is
 * served by the first it is listed under, then by the next for whatever that
 * one has no room for.
 *
 * Pure. No React, no store.
 */

import {
  PRODUCTIVE_HOURS_PER_PERSON,
  rootLineKey,
  type CrewPool,
  type LineKey,
} from '@/domain/assembly';
import type { OrderRow } from '@/engine/assembly/board';
import { isWeekend, startOfDay } from '@/engine/assembly/dates';
import { remainingHours } from '@/engine/assembly/duration';
import { loadBand, type LoadBand } from '@/engine/assembly/workload';
import { toDayKey } from '@/lib/time';
import { lineDayLoads, type LineDayLoad } from './boardView';

/** One crew's day. */
export interface PoolDay {
  id: string;
  name: string;
  people: number;
  /** Hours the crew can work: people × a productive shift; none at the weekend. */
  capacity: number;
  /** Hours of its lines' demand it carries, after sharing. */
  demand: number;
  pct: number;
}

/** How a line reads against the crews it draws on. */
export interface LineCapacity {
  /** Crews it draws on, by name; empty when no crew lists it. */
  pools: string[];
  capacity: number;
  demand: number;
  pct: number | null;
  band: LoadBand | null;
}

export interface CapacityDay {
  key: string;
  date: Date;
  isToday: boolean;
  /** Behind today: `crewed` is output that was booked. */
  past: boolean;
  working: boolean;
  /** Hours with people on them — booked, on a day already gone. */
  crewed: number;
  /** Hours of orders nobody is on yet that belong on this day. */
  waiting: number;
  capacity: number;
  /** (crewed + waiting) ÷ capacity, as a percentage; 0 with no capacity. */
  pct: number;
  band: LoadBand;
  pools: PoolDay[];
  /** Per lane, the same day as its folded row draws it. */
  lines: Map<LineKey, { load: LineDayLoad; capacity: LineCapacity }>;
  /** Demand on lanes no crew lists: counted in `crewed`/`waiting`, not in capacity. */
  unpooled: number;
}

/**
 * Share one day's demand out over the crews.
 *
 * A lane in one crew goes to it whole. A lane in several fills the first one's
 * spare hours, then the next one's; what none of them has room for stays on the
 * first, which then reads over. Exclusive lanes are placed before shared ones,
 * so help only goes where there is room once a crew's own work is counted.
 */
export function shareDay(
  demand: ReadonlyMap<LineKey, number>,
  pools: readonly CrewPool[],
  working: boolean,
): { pools: PoolDay[]; lines: Map<LineKey, LineCapacity>; unpooled: number } {
  const capacity = pools.map((p) => (working ? p.people * PRODUCTIVE_HOURS_PER_PERSON : 0));
  const carried = pools.map(() => 0);
  const of = (line: LineKey) =>
    pools.map((p, i) => (p.lines.includes(line) ? i : -1)).filter((i) => i >= 0);
  let unpooled = 0;

  const shared: [LineKey, number][] = [];
  for (const [line, hours] of demand) {
    const mine = of(line);
    if (mine.length === 0) unpooled += hours;
    else if (mine.length === 1) carried[mine[0]] += hours;
    else shared.push([line, hours]);
  }
  for (const [line, hours] of shared) {
    const mine = of(line);
    let left = hours;
    for (const i of mine) {
      const take = Math.min(left, Math.max(0, capacity[i] - carried[i]));
      carried[i] += take;
      left -= take;
    }
    if (left > 0) carried[mine[0]] += left;
  }

  const pct = (d: number, c: number) => (c > 0 ? (d / c) * 100 : d > 0 ? Infinity : 0);
  const lines = new Map<LineKey, LineCapacity>();
  for (const line of demand.keys()) {
    const mine = of(line);
    if (mine.length === 0) {
      lines.set(line, { pools: [], capacity: 0, demand: 0, pct: null, band: null });
      continue;
    }
    const cap = mine.reduce((s, i) => s + capacity[i], 0);
    const dem = mine.reduce((s, i) => s + carried[i], 0);
    const p = pct(dem, cap);
    lines.set(line, {
      pools: mine.map((i) => pools[i].name),
      capacity: cap,
      demand: dem,
      pct: p,
      band: loadBand(p),
    });
  }
  return {
    pools: pools.map((p, i) => ({
      id: p.id,
      name: p.name,
      people: working ? p.people : 0,
      capacity: capacity[i],
      demand: carried[i],
      pct: pct(carried[i], capacity[i]),
    })),
    lines,
    unpooled,
  };
}

/**
 * The board's days against its crews.
 *
 * Rows are grouped by lane (a bench counts on its lane), each lane's days come
 * from `lineDayLoads` — the very figures its folded row shows — and the banner
 * total is their sum, so the two can only agree.
 */
export function capacityDays(
  rows: readonly OrderRow[],
  pools: readonly CrewPool[],
  positionsOf: (line: LineKey) => number,
  dates: readonly Date[],
  today: Date,
): CapacityDay[] {
  const todayKey = toDayKey(startOfDay(today));
  const byLane = new Map<LineKey, OrderRow[]>();
  for (const row of rows) {
    if (!row.line.schedulable) continue;
    const lane = rootLineKey(row.line.key);
    const held = byLane.get(lane);
    if (held) held.push(row);
    else byLane.set(lane, [row]);
  }
  const laneDays = new Map(
    [...byLane].map(([lane, laneRows]) => [
      lane,
      lineDayLoads(laneRows, positionsOf(lane), dates, today),
    ]),
  );

  return dates.map((date, i) => {
    const key = toDayKey(date);
    const working = !isWeekend(date);
    const demand = new Map<LineKey, number>();
    let crewed = 0;
    let waiting = 0;
    for (const [lane, days] of laneDays) {
      const day = days[i];
      crewed += day.hours;
      waiting += day.unstaffedHours;
      demand.set(lane, day.hours + day.unstaffedHours);
    }
    const shared = shareDay(demand, pools, working);
    const capacity = shared.pools.reduce((s, p) => s + p.capacity, 0);
    const pct = capacity > 0 ? ((crewed + waiting) / capacity) * 100 : 0;
    const lines = new Map<LineKey, { load: LineDayLoad; capacity: LineCapacity }>();
    for (const [lane, days] of laneDays) {
      lines.set(lane, { load: days[i], capacity: shared.lines.get(lane)! });
    }
    return {
      key,
      date,
      isToday: key === todayKey,
      past: key < todayKey,
      working,
      crewed,
      waiting,
      capacity,
      pct,
      band: loadBand(pct),
      pools: shared.pools,
      lines,
      unpooled: shared.unpooled,
    };
  });
}

/** One crew's share of the hours still on the board, and how long it needs. */
export interface PoolHours {
  id: string;
  name: string;
  people: number;
  /** Hours on its lines; a line two crews share is split by headcount. */
  hours: number;
  /** What the crew can work in a day: people × a productive shift. */
  perDay: number;
  /** Working days to clear its hours at that; null with nobody in it. */
  days: number | null;
  lines: { key: LineKey; hours: number; shared: boolean }[];
}

export interface BoardHours {
  /** Every standard hour still to run on the assembly lines. */
  total: number;
  pools: PoolHours[];
  /** Lines no crew lists, and their hours — counted in `total`, not in any crew. */
  unpooled: { key: LineKey; hours: number }[];
  /** What every crew together can work in a day. */
  perDay: number;
  /** Working days for every crew together to clear the pooled hours. */
  days: number | null;
}

/**
 * Hours on the board, read against the crews on Crew capacity.
 *
 * The board's total used to be broken down line by line against whoever was
 * planned on each line — a count that is not the crew the supervisor set, so
 * the two figures side by side on the header disagreed. This reads the same
 * hours against the same crews the day columns are measured with. A line two
 * crews share is split between them by headcount: over a queue of days that
 * is how the help it gets evens out.
 */
export function boardHours(rows: readonly OrderRow[], pools: readonly CrewPool[]): BoardHours {
  const byLine = new Map<LineKey, number>();
  for (const row of rows) {
    if (!row.line.schedulable) continue;
    const lane = rootLineKey(row.line.key);
    byLine.set(lane, (byLine.get(lane) ?? 0) + remainingHours(row.job));
  }
  const out: PoolHours[] = pools.map((p) => ({
    id: p.id,
    name: p.name,
    people: p.people,
    hours: 0,
    perDay: p.people * PRODUCTIVE_HOURS_PER_PERSON,
    days: null,
    lines: [],
  }));
  const unpooled: { key: LineKey; hours: number }[] = [];
  let total = 0;
  for (const [key, hours] of byLine) {
    total += hours;
    if (hours <= 0) continue;
    const mine = pools.map((p, i) => (p.lines.includes(key) ? i : -1)).filter((i) => i >= 0);
    if (mine.length === 0) {
      unpooled.push({ key, hours });
      continue;
    }
    const heads = mine.reduce((n, i) => n + pools[i].people, 0);
    for (const i of mine) {
      const share = heads > 0 ? (hours * pools[i].people) / heads : hours / mine.length;
      out[i].hours += share;
      out[i].lines.push({ key, hours: share, shared: mine.length > 1 });
    }
  }
  for (const p of out) {
    p.days = p.perDay > 0 ? p.hours / p.perDay : null;
    p.lines.sort((a, b) => b.hours - a.hours);
  }
  const perDay = out.reduce((n, p) => n + p.perDay, 0);
  const pooled = out.reduce((n, p) => n + p.hours, 0);
  return {
    total,
    pools: out,
    unpooled: unpooled.sort((a, b) => b.hours - a.hours),
    perDay,
    days: perDay > 0 ? pooled / perDay : null,
  };
}
