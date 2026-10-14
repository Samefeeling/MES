/**
 * What has shipped, and the figures a dispatch manager is judged on.
 *
 * The waybill export only carries open orders — a shipped order drops out of
 * it — so shipped dollars and SIFOT cannot be read from it. They come from the
 * shipment log: each load marked dispatched writes a record of what left, its
 * value (`ReleaseVal`, the open value, pro-rated for a split piece), its due
 * date and whether its goods were all ready.
 *
 * **SIFOT** (Shipped In Full, On Time) is measured on the orders *due* in the
 * period, the strict form that counts backlog:
 *
 * - **hit** — every piece shipped, on or before the due date (`Need By` by
 *   default), with every goods line ready when it left;
 * - **late** — shipped in full but after the due date;
 * - **short** — shipped with goods lines not ready (a part shipment);
 * - **open** — still on the waybill after its due date.
 *
 * Shipped orders count by their due date in the period, so an order due
 * last week and shipped today is a late shipment. Open orders past due only
 * count from the first recorded dispatch: before the log existed an order
 * missing from the waybill may simply have shipped.
 */

import {
  dueDate,
  type DayKey,
  type DeadlineField,
  type DispatchMode,
  type DispatchSettings,
  type ShipmentOrder,
} from '@/domain/dispatch';
import type { DispatchPlan, PlannedDrop, PlannedLoad } from './plan';
import { addCalendarDays, isoWeekday, isWorkingDay } from './calendar';

export interface ShippedOrder {
  orderId: string;
  custId: string;
  shipToName: string;
  zone: string;
  /** Goods and freight value carried, pro-rated for a split piece. */
  goodsValue: number;
  freightValue: number;
  volumeM3: number;
  due: DayKey | null;
  expDelivery: DayKey | null;
  /** Every goods line was ready (or allocated) when it left. */
  ready: boolean;
  piece: { index: number; of: number } | null;
}

export interface ShipmentRecord {
  loadId: string;
  /** The day it left. */
  day: DayKey;
  dispatchedAt: string;
  mode: DispatchMode;
  label: string;
  equipment: string;
  capacityM3: number | null;
  volumeM3: number;
  orders: ShippedOrder[];
}

/** Shipment records are kept this long, enough for a year-on-year look. */
export const SHIPMENT_RETENTION_DAYS = 400;

/**
 * The record of a load leaving. It leaves on its planned day, or today when
 * it is marked dispatched ahead of that day.
 */
export function shipmentRecord(
  load: PlannedLoad,
  deadline: DeadlineField,
  today: DayKey,
  now: string,
): ShipmentRecord {
  return {
    loadId: load.id,
    day: load.day <= today ? load.day : today,
    dispatchedAt: now,
    mode: load.mode,
    label: load.label,
    equipment: load.equipment,
    capacityM3: load.capacityM3,
    volumeM3: load.volumeM3,
    orders: load.drops.map((d) => {
      const o = d.order;
      return {
        orderId: d.orderId,
        custId: o?.custId ?? '',
        shipToName: o?.shipToName ?? '',
        zone: o?.zone ?? '',
        goodsValue: (o?.goodsValue ?? 0) * d.share,
        freightValue: (o?.freightValue ?? 0) * d.share,
        volumeM3: d.volumeM3,
        due: o ? dueDate(o, deadline) : null,
        expDelivery: o?.expDelivery ?? null,
        ready: !o || o.readiness === 'ready' || o.readiness === 'no-goods',
        piece: d.piece,
      };
    }),
  };
}

type Basis = DispatchSettings['shipmentValue'];

export const shippedValue = (o: ShippedOrder, basis: Basis): number =>
  o.goodsValue + (basis === 'goods-freight' ? o.freightValue : 0);

export const dropValue = (d: PlannedDrop, basis: Basis): number =>
  d.order ? (d.order.goodsValue + (basis === 'goods-freight' ? d.order.freightValue : 0)) * d.share : 0;

export const loadValue = (load: PlannedLoad, basis: Basis): number =>
  load.drops.reduce((s, d) => s + dropValue(d, basis), 0);

/** A whole truck or trailer: NSW truck runs and linehaul FTL, not part loads. */
export const isTruck = (l: { mode: DispatchMode; capacityM3: number | null }): boolean =>
  (l.mode === 'fleet' || l.mode === 'linehaul') && l.capacityM3 !== null;

export const isContainer = (l: { mode: DispatchMode; capacityM3: number | null }): boolean =>
  l.mode === 'container' && l.capacityM3 !== null;

/** NSW part loads, LTL and LCL: booked by the cube, not by the vehicle. */
export const isPartLoad = (l: { mode: DispatchMode; capacityM3: number | null }): boolean =>
  l.mode !== 'pickup' && l.capacityM3 === null;

export const monthStart = (day: DayKey): DayKey => `${day.slice(0, 7)}-01`;

export const weekOf = (day: DayKey): DayKey => addCalendarDays(day, 1 - isoWeekday(day));

const monthEnd = (day: DayKey): DayKey => {
  const [y, m] = day.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, '0')}`;
};

// ---- SIFOT -----------------------------------------------------------------

export type SifotOutcome = 'hit' | 'late' | 'short' | 'open';

export interface SifotOrder {
  orderId: string;
  shipToName: string;
  custId: string;
  due: DayKey;
  /** Day the last piece left; null while open. */
  shipped: DayKey | null;
  outcome: SifotOutcome;
}

export interface SifotResult {
  /** Hits over orders due; null when nothing was due or nothing is logged. */
  rate: number | null;
  hits: number;
  due: number;
  late: number;
  short: number;
  open: number;
  /**
   * First due date open orders are counted from: the later of the period
   * start and the first record.
   */
  since: DayKey | null;
  orders: SifotOrder[];
}

/**
 * SIFOT for orders due from `from` to `to` (inclusive). Open orders only
 * count once their due date is behind `today`.
 */
export function sifot(
  log: readonly ShipmentRecord[],
  open: readonly ShipmentOrder[],
  deadline: DeadlineField,
  from: DayKey,
  to: DayKey,
  today: DayKey,
): SifotResult {
  const first = log.reduce<DayKey | null>((a, r) => (a === null || r.day < a ? r.day : a), null);
  const empty: SifotResult = { rate: null, hits: 0, due: 0, late: 0, short: 0, open: 0, since: null, orders: [] };
  if (first === null) return empty;
  const since = first > from ? first : from;

  // Everything logged per order: last day out, pieces seen, all ready.
  const shipped = new Map<
    string,
    { o: ShippedOrder; last: DayKey; pieces: Set<number>; of: number; whole: boolean; ready: boolean }
  >();
  for (const r of log) {
    for (const o of r.orders) {
      const s = shipped.get(o.orderId);
      if (!s) {
        shipped.set(o.orderId, {
          o,
          last: r.day,
          pieces: new Set(o.piece ? [o.piece.index] : []),
          of: o.piece?.of ?? 1,
          whole: !o.piece,
          ready: o.ready,
        });
        continue;
      }
      if (r.day > s.last) s.last = r.day;
      if (o.piece) {
        s.pieces.add(o.piece.index);
        s.of = Math.max(s.of, o.piece.of);
      } else s.whole = true;
      s.ready &&= o.ready;
      s.o = { ...s.o, due: s.o.due ?? o.due };
    }
  }
  const complete = (s: { whole: boolean; pieces: Set<number>; of: number }) => s.whole || s.pieces.size >= s.of;

  const orders: SifotOrder[] = [];
  const inPeriod = (d: DayKey | null): d is DayKey => d !== null && d >= from && d <= to;
  const counted = new Set<string>();
  for (const [id, s] of shipped) {
    if (!inPeriod(s.o.due) || s.o.due > today || !complete(s)) continue;
    counted.add(id);
    orders.push({
      orderId: id,
      shipToName: s.o.shipToName,
      custId: s.o.custId,
      due: s.o.due,
      shipped: s.last,
      outcome: !s.ready ? 'short' : s.last > s.o.due ? 'late' : 'hit',
    });
  }
  for (const o of open) {
    const due = dueDate(o, deadline);
    if (counted.has(o.id) || !inPeriod(due) || due < since || due >= today) continue;
    const s = shipped.get(o.id);
    if (s && complete(s)) continue;
    counted.add(o.id);
    orders.push({ orderId: o.id, shipToName: o.shipToName, custId: o.custId, due, shipped: null, outcome: 'open' });
  }
  orders.sort((a, b) => a.due.localeCompare(b.due) || a.orderId.localeCompare(b.orderId));
  const n = (k: SifotOutcome) => orders.filter((o) => o.outcome === k).length;
  return {
    rate: orders.length > 0 ? n('hit') / orders.length : null,
    hits: n('hit'),
    due: orders.length,
    late: n('late'),
    short: n('short'),
    open: n('open'),
    since,
    orders,
  };
}

// ---- headline figures -----------------------------------------------------

export interface DispatchKpis {
  today: { shipped: number; planned: number; loadsShipped: number };
  month: { from: DayKey; shipped: number; stillPlanned: number; forecast: number };
  sifot: SifotResult;
  trucks: { count: number; dispatched: number; partLoads: number };
  containers: { weekStart: DayKey; count: number; mix: Record<string, number>; lcl: number };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function dispatchKpis(
  plan: DispatchPlan,
  log: readonly ShipmentRecord[],
  open: readonly ShipmentOrder[],
  settings: DispatchSettings,
  today: DayKey,
): DispatchKpis {
  const basis = settings.shipmentValue;
  const recordValue = (r: ShipmentRecord) => sum(r.orders.map((o) => shippedValue(o, basis)));
  const pending = plan.loads.filter((l) => l.firm !== 'dispatched');
  const from = monthStart(today);
  const end = monthEnd(today);

  const todayLog = log.filter((r) => r.day === today);
  const monthLog = log.filter((r) => r.day >= from && r.day <= today);
  const shippedMonth = sum(monthLog.map(recordValue));
  // Loads still to go this month; anything planned for a past day is
  // overdue and counted as going today.
  const stillPlanned = sum(pending.filter((l) => l.day <= end).map((l) => loadValue(l, basis)));

  const todays = plan.loads.filter((l) => l.day === today);
  const week = weekOf(today);
  const weekEnd = addCalendarDays(week, 6);
  const boxes = plan.loads.filter((l) => l.mode === 'container' && l.day >= week && l.day <= weekEnd);
  const mix: Record<string, number> = {};
  for (const b of boxes.filter(isContainer)) mix[b.equipment] = (mix[b.equipment] ?? 0) + 1;

  return {
    today: {
      shipped: sum(todayLog.map(recordValue)),
      planned: sum(pending.filter((l) => l.day <= today).map((l) => loadValue(l, basis))),
      loadsShipped: todayLog.length,
    },
    month: { from, shipped: shippedMonth, stillPlanned, forecast: shippedMonth + stillPlanned },
    sifot: sifot(log, open, settings.deadline, from, today, today),
    trucks: {
      count: todays.filter(isTruck).length,
      dispatched: todays.filter((l) => isTruck(l) && l.firm === 'dispatched').length,
      partLoads: todays.filter(isPartLoad).length,
    },
    containers: { weekStart: week, count: boxes.filter(isContainer).length, mix, lcl: boxes.filter(isPartLoad).length },
  };
}

// ---- the month, for the Performance tab -----------------------------------

export interface DayValue {
  day: DayKey;
  /** Value logged as shipped that day. */
  shipped: number;
  /** Value still planned for the day (today onwards). */
  planned: number;
}

/** Every working day of the month, shipped behind and planned ahead. */
export function monthDays(
  plan: DispatchPlan,
  log: readonly ShipmentRecord[],
  settings: DispatchSettings,
  today: DayKey,
): DayValue[] {
  const basis = settings.shipmentValue;
  const holidays = new Set(settings.holidays);
  const out: DayValue[] = [];
  for (let d = monthStart(today); d <= monthEnd(today); d = addCalendarDays(d, 1)) {
    const shipped = sum(log.filter((r) => r.day === d).flatMap((r) => r.orders.map((o) => shippedValue(o, basis))));
    const planned =
      d < today
        ? 0
        : sum(
            plan.loads
              .filter((l) => l.firm !== 'dispatched' && (d === today ? l.day <= today : l.day === d))
              .map((l) => loadValue(l, basis)),
          );
    if (isWorkingDay(d, holidays) || shipped > 0 || planned > 0) out.push({ day: d, shipped, planned });
  }
  return out;
}

export interface WeekPerformance {
  weekStart: DayKey;
  shipped: number;
  planned: number;
  /** Logged and still planned, so the whole week reads in one figure. */
  trucks: number;
  containers: number;
  partLoads: number;
  sifot: SifotResult;
}

/** The weeks touching this month: value, vehicles and SIFOT per week. */
export function monthWeeks(
  plan: DispatchPlan,
  log: readonly ShipmentRecord[],
  open: readonly ShipmentOrder[],
  settings: DispatchSettings,
  today: DayKey,
): WeekPerformance[] {
  const basis = settings.shipmentValue;
  const pending = plan.loads.filter((l) => l.firm !== 'dispatched');
  const weeks: WeekPerformance[] = [];
  for (let w = weekOf(monthStart(today)); w <= monthEnd(today); w = addCalendarDays(w, 7)) {
    const end = addCalendarDays(w, 6);
    const logged = log.filter((r) => r.day >= w && r.day <= end);
    const ahead = pending.filter((l) => (l.day < today ? today : l.day) >= w && (l.day < today ? today : l.day) <= end);
    const both = [...logged, ...ahead];
    weeks.push({
      weekStart: w,
      shipped: sum(logged.flatMap((r) => r.orders.map((o) => shippedValue(o, basis)))),
      planned: sum(ahead.map((l) => loadValue(l, basis))),
      trucks: both.filter(isTruck).length,
      containers: both.filter(isContainer).length,
      partLoads: both.filter(isPartLoad).length,
      sifot: sifot(log, open, settings.deadline, w, end < today ? end : today, today),
    });
  }
  return weeks;
}
