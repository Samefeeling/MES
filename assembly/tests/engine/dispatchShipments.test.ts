/**
 * Shipped dollars, SIFOT and vehicle counts: what a dispatch manager reads
 * first. Shipments come from the log written when loads are dispatched; the
 * waybill only ever holds what is still open.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPATCH_SETTINGS as S,
  EMPTY_DECISIONS,
  type FirmLoad,
  type ShipmentOrder,
} from '@/domain/dispatch';
import { planDispatch } from '@/engine/dispatch/plan';
import { dispatchLoad } from '@/engine/dispatch/edits';
import {
  dispatchKpis,
  monthDays,
  monthWeeks,
  shipmentRecord,
  sifot,
  type ShipmentRecord,
} from '@/engine/dispatch/shipments';

const TODAY = '2026-10-09'; // Friday

const make = (id: string, patch: Partial<ShipmentOrder> = {}): ShipmentOrder => ({
  id,
  custId: `C${id}`,
  shipToName: `Customer ${id}`,
  address: '',
  state: '',
  postcode: '',
  shipVia: 'ANMS',
  zone: 'NSW-Metro-South',
  city: 'Liverpool',
  shipBy: null,
  needBy: TODAY,
  expDelivery: null,
  pickListComment: '',
  packedM3: null,
  volumeM3: 10,
  value: 1100,
  goodsValue: 1000,
  freightValue: 100,
  lineCount: 2,
  goodsLines: 1,
  readyLines: 1,
  readiness: 'ready',
  inPicking: false,
  onHold: false,
  creditHold: false,
  notes: [],
  ...patch,
});

const plan = (orders: ShipmentOrder[], firmLoads: FirmLoad[] = [], settings = S) =>
  planDispatch(orders, settings, { ...EMPTY_DECISIONS, firmLoads }, TODAY);

const shipped = (id: string, day: string, patch: Partial<ShipmentRecord['orders'][number]> = {}): ShipmentRecord => ({
  loadId: `L-${id}`,
  day,
  dispatchedAt: `${day}T08:00:00Z`,
  mode: 'fleet',
  label: 'NSW-Metro-South · ANMS',
  equipment: 'Rigid 8-pallet',
  capacityM3: 30,
  volumeM3: 10,
  orders: [
    {
      orderId: id,
      custId: `C${id}`,
      shipToName: '',
      zone: 'NSW-Metro-South',
      goodsValue: 1000,
      freightValue: 100,
      volumeM3: 10,
      due: '2026-10-07',
      expDelivery: null,
      ready: true,
      piece: null,
      ...patch,
    },
  ],
});

describe('shipment record', () => {
  it('logs the value carried, the due date and readiness', () => {
    const p = plan([make('a', { readiness: 'partial' })]);
    const r = shipmentRecord(p.loads[0], 'needBy', TODAY, 'now');
    expect(r.day).toBe(TODAY);
    expect(r.orders[0]).toMatchObject({ orderId: 'a', goodsValue: 1000, freightValue: 100, due: TODAY, ready: false });
  });

  it('pro-rates the value of a split piece', () => {
    const p = plan([make('big', { volumeM3: 100 })]);
    const pieces = p.loads.map((l) => shipmentRecord(l, 'needBy', TODAY, 'now').orders[0]);
    expect(pieces.reduce((s, o) => s + o.goodsValue, 0)).toBeCloseTo(1000);
    expect(pieces[0].goodsValue).toBeCloseTo(750);
  });

  it('files the record under the frozen load, so undoing finds it', () => {
    const p = plan([make('a')]);
    const { firmLoads, id } = dispatchLoad([], p.loads[0], 'now');
    expect(firmLoads[0]).toMatchObject({ id, status: 'dispatched' });
    expect(plan([make('a')], firmLoads).loads[0].firm).toBe('dispatched');
  });
});

describe('SIFOT', () => {
  const window = (log: ShipmentRecord[], open: ShipmentOrder[] = []) =>
    sifot(log, open, 'needBy', '2026-10-01', TODAY, TODAY);

  it('is not reported before anything is logged', () => {
    expect(window([], [make('x', { needBy: '2026-10-02' })]).rate).toBeNull();
  });

  it('counts on time and in full as a hit, late and short as misses', () => {
    const r = window([
      shipped('hit', '2026-10-06'),
      shipped('late', '2026-10-08'),
      shipped('short', '2026-10-06', { ready: false }),
    ]);
    expect(r).toMatchObject({ hits: 1, late: 1, short: 1, due: 3 });
    expect(r.rate).toBeCloseTo(1 / 3);
  });

  it('counts a late shipment even when it was due before the first record', () => {
    const r = window([shipped('late', '2026-10-08', { due: '2026-10-02' })]);
    expect(r).toMatchObject({ late: 1, due: 1 });
  });

  it('counts open orders past due as misses, but not ones due today', () => {
    const r = window([shipped('hit', '2026-10-06')], [
      make('overdue', { needBy: '2026-10-08' }),
      make('today', { needBy: TODAY }),
      make('before-log', { needBy: '2026-10-02' }),
    ]);
    expect(r.open).toBe(1);
    expect(r.since).toBe('2026-10-06');
    expect(r.orders.map((o) => o.orderId)).toEqual(['hit', 'overdue']);
  });

  it('waits for every piece of a split order', () => {
    const one = shipped('s', '2026-10-06', { piece: { index: 1, of: 2 } });
    expect(window([one]).due).toBe(0);
    const two = shipped('s', '2026-10-08', { piece: { index: 2, of: 2 } });
    expect(window([one, { ...two, loadId: 'L-s2' }])).toMatchObject({ hits: 0, late: 1 });
  });
});

describe('headline figures', () => {
  const orders = [
    make('fleet', { volumeM3: 20 }),
    make('box', { zone: 'NZ-North', shipVia: 'NZNI', city: 'Auckland', volumeM3: 40 }),
    make('ltl', { zone: 'QLD- Metro', shipVia: 'AQMC', city: 'Brisbane', volumeM3: 5, needBy: '2026-10-13' }),
  ];
  // Containers leave on Fridays here, so one leaves this week.
  const s = { ...S, container: { ...S.container, departureWeekdays: [5] } };
  const p = plan(orders, [], s);
  const log = [shipped('old', '2026-10-06'), shipped('t', TODAY)];
  const k = dispatchKpis(p, log, orders, s, TODAY);

  it('splits today into shipped and still planned, goods value by default', () => {
    expect(k.today.shipped).toBe(1000);
    expect(k.today.planned).toBe(2000);
  });

  it('adds the rest of the month to month-to-date for the forecast', () => {
    expect(k.month.shipped).toBe(2000);
    expect(k.month.forecast).toBe(5000);
    const withFreight = dispatchKpis(p, log, orders, { ...s, shipmentValue: 'goods-freight' }, TODAY);
    expect(withFreight.month.shipped).toBe(2200);
  });

  it('counts whole trucks today and containers this week', () => {
    expect(k.trucks).toMatchObject({ count: 1, dispatched: 0 });
    expect(k.containers.count).toBe(1);
    expect(k.containers.mix).toEqual({ "40' GP": 1 });
  });

  it('lays the month out by day and week', () => {
    const days = monthDays(p, log, s, TODAY);
    expect(days.find((d) => d.day === '2026-10-06')!.shipped).toBe(1000);
    expect(days.find((d) => d.day === TODAY)).toMatchObject({ shipped: 1000, planned: 2000 });
    expect(days.some((d) => d.day === '2026-10-10')).toBe(false); // Saturday
    const weeks = monthWeeks(p, log, orders, s, TODAY);
    expect(weeks[0].weekStart).toBe('2026-09-28');
    expect(weeks[1]).toMatchObject({ weekStart: '2026-10-05', shipped: 2000, trucks: 3 });
  });
});
