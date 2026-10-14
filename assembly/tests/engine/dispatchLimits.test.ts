/**
 * Daily load-out limits: the dock loads out about three trucks and two
 * containers a day, the marshalling area is sized from that, and loads are
 * brought forward — never later — off a day over its limits.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPATCH_SETTINGS as S,
  EMPTY_DECISIONS,
  stagingCapacity,
  type DispatchSettings,
  type ShipmentOrder,
} from '@/domain/dispatch';
import { planDispatch, type DispatchPlan } from '@/engine/dispatch/plan';

const TODAY = '2026-10-08'; // Thursday; the firm window runs to Monday 12 October

const make = (id: string, patch: Partial<ShipmentOrder> = {}): ShipmentOrder => ({
  id,
  custId: `C${id}`,
  shipToName: `Customer ${id}`,
  address: '',
  state: '',
  postcode: '',
  shipVia: id,
  zone: 'NSW-Metro-South',
  city: 'Liverpool',
  shipBy: null,
  needBy: '2026-10-16',
  expDelivery: null,
  pickListComment: '',
  packedM3: null,
  volumeM3: 20,
  value: 0,
  goodsValue: 0,
  freightValue: 0,
  lineCount: 1,
  goodsLines: 1,
  readyLines: 1,
  readiness: 'ready',
  inPicking: false,
  onHold: false,
  creditHold: false,
  notes: [],
  ...patch,
});

const plan = (orders: ShipmentOrder[], settings: DispatchSettings = S): DispatchPlan =>
  planDispatch(orders, settings, EMPTY_DECISIONS, TODAY);

const dayOf = (p: DispatchPlan, id: string) => p.loads.find((l) => l.drops.some((d) => d.orderId === id))!.day;
const total = (p: DispatchPlan, day: string) => p.days.find((t) => t.day === day);

// Four NSW runs due the same Friday, each on its own Ship Via.
const four = ['a', 'b', 'c', 'd'].map((id) => make(id));

describe('marshalling capacity', () => {
  it('is three full semis and two full 40-foot high cubes by default', () => {
    expect(stagingCapacity(S)).toBe(3 * 75 + 2 * 68);
  });

  it('takes the set figure when not derived, or when a limit is off', () => {
    expect(stagingCapacity({ ...S, stagingAuto: false, stagingCapacityM3: 200 })).toBe(200);
    expect(stagingCapacity({ ...S, containersPerDay: 0, stagingCapacityM3: 200 })).toBe(200);
  });
});

describe('levelling to the daily limits', () => {
  it('brings the fourth truck forward to the day before', () => {
    const p = plan(four);
    expect(total(p, '2026-10-16')).toMatchObject({ trucks: 3, overTrucks: false });
    expect(total(p, '2026-10-15')).toMatchObject({ trucks: 1 });
    const moved = p.loads.find((l) => l.day === '2026-10-15')!;
    expect(moved.levelled).toEqual({ from: '2026-10-16', reason: 'trucks' });
    expect(moved.drops[0].daysEarly).toBe(1);
    expect(p.orders.get(moved.drops[0].orderId)!.flags).toContain('pulled-forward');
  });

  it('leaves the day over its limit when switched off', () => {
    const p = plan(four, { ...S, levelToLimits: false });
    expect(total(p, '2026-10-16')).toMatchObject({ trucks: 4, overTrucks: true });
  });

  it('never moves a load outside its orders’ pull-forward window', () => {
    const p = plan(four, { ...S, fleet: { ...S.fleet, earlyDays: 0 } });
    expect(new Set(four.map((o) => dayOf(p, o.id)))).toEqual(new Set(['2026-10-16']));
    expect(total(p, '2026-10-16')!.overTrucks).toBe(true);
  });

  it('moves into the firm window only with every order ready', () => {
    // Due Monday 12th; the only earlier day, Friday 9th, is in the firm window.
    const due = ['a', 'b', 'c', 'd'].map((id) => make(id, { needBy: '2026-10-12', readiness: 'partial' }));
    const p = plan(due);
    // Goods not ready: the loads stay on Monday, over the limit.
    expect(total(p, '2026-10-12')).toMatchObject({ trucks: 4, overTrucks: true });
    const ready = plan(due.map((o) => ({ ...o, readiness: 'ready' as const })));
    expect(total(ready, '2026-10-12')!.trucks).toBe(3);
    expect(total(ready, '2026-10-09')!.trucks).toBe(1);
  });

  it('brings a third container forward to the previous stuffing day', () => {
    const boxes = ['x', 'y', 'z'].map((id) =>
      make(id, { zone: 'NZ-North', city: 'Auckland', needBy: '2026-10-22', volumeM3: 40 }),
    );
    const p = plan(boxes);
    expect(total(p, '2026-10-22')).toMatchObject({ containers: 2, overContainers: false });
    expect(total(p, '2026-10-15')).toMatchObject({ containers: 1 });
  });
});
