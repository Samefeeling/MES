/**
 * The planner's hand edits and what the plan does with them: moved orders
 * stay where they were put, the rest is planned around them, and a load
 * that breaks a rule says so instead of refusing.
 *
 * Also the dates and volumes the waybill now carries: Need By is the last
 * ship day, and the packed cube on the pick list beats every estimate.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPATCH_SETTINGS,
  EMPTY_DECISIONS,
  type DispatchSettings,
  type FirmLoad,
  type ShipmentOrder,
} from '@/domain/dispatch';
import { fitEquipment, planDispatch, resolveVolume, type DispatchPlan } from '@/engine/dispatch/plan';
import { confirm, moveOrder, redateLoad, resizeLoad } from '@/engine/dispatch/edits';

const TODAY = '2026-10-08';
const NOW = '2026-10-08T09:00:00.000Z';
const S = DEFAULT_DISPATCH_SETTINGS;

const make = (id: string, patch: Partial<ShipmentOrder> = {}): ShipmentOrder => ({
  id,
  custId: `C${id}`,
  shipToName: `Customer ${id}`,
  address: '',
  state: '',
  postcode: '',
  shipVia: 'X',
  zone: 'NSW-Metro-South',
  city: 'Liverpool',
  shipBy: null,
  needBy: '2026-10-12',
  expDelivery: null,
  pickListComment: '',
  packedM3: null,
  volumeM3: 5,
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

const plan = (list: ShipmentOrder[], firmLoads: FirmLoad[] = [], settings: DispatchSettings = S): DispatchPlan =>
  planDispatch(list, settings, { ...EMPTY_DECISIONS, firmLoads }, TODAY);

const loadOf = (p: DispatchPlan, id: string) => p.loads.find((l) => l.drops.some((d) => d.orderId === id))!;

describe('due date', () => {
  it('plans to Need By, not the earlier Ship By', () => {
    const p = plan([make('a', { shipBy: '2026-10-01', needBy: '2026-10-14' })]);
    expect(p.orders.get('a')!.flags).not.toContain('overdue');
    expect(loadOf(p, 'a').day).toBe('2026-10-14');
  });

  it('falls back to Ship By when Need By is blank, and can be switched back', () => {
    const p = plan([make('a', { shipBy: '2026-10-13', needBy: null })]);
    expect(loadOf(p, 'a').day).toBe('2026-10-13');
    const q = plan([make('b', { shipBy: '2026-10-13', needBy: '2026-10-16' })], [], { ...S, deadline: 'shipBy' });
    expect(loadOf(q, 'b').day).toBe('2026-10-13');
  });

  it('holds an order with neither date', () => {
    const p = plan([make('a', { needBy: null, shipBy: null })]);
    expect(p.orders.get('a')!.flags).toContain('no-date');
    expect(p.loads).toHaveLength(0);
  });
});

describe('packed cube', () => {
  it('beats the cubics sheet and the freight line, but not a typed volume', () => {
    const o = make('a', { volumeM3: 9, packedM3: 2 });
    expect(resolveVolume(o, undefined, 'cubics')).toMatchObject({ volume: 2, source: 'packed' });
    expect(resolveVolume(o, 4, 'cubics')).toMatchObject({ volume: 4, source: 'entered' });
  });
});

describe('hand edits', () => {
  // Two neighbours the optimiser puts on one truck.
  const a = make('a', { city: 'Liverpool', volumeM3: 10 });
  const b = make('b', { city: 'Prestons', volumeM3: 12 });
  const base = plan([a, b]);

  it('starts with both on one truck', () => {
    expect(loadOf(base, 'a').id).toBe(loadOf(base, 'b').id);
  });

  it('moves an order onto a truck of its own, and re-sizes both', () => {
    const firm = moveOrder([], S, 'b', loadOf(base, 'b'), null, NOW);
    expect(firm).toHaveLength(2);
    expect(firm.every((f) => f.status === 'edited')).toBe(true);
    const p = plan([a, b], firm);
    const la = loadOf(p, 'a');
    const lb = loadOf(p, 'b');
    expect(la.id).not.toBe(lb.id);
    expect(la.firm).toBe('edited');
    expect(la.equipment).toBe('Rigid 8-pallet');
    expect(lb.drops).toHaveLength(1);
  });

  it('moves an order onto another load', () => {
    const c = make('c', { city: 'Chipping Norton', needBy: '2026-10-16', volumeM3: 6 });
    const p0 = plan([a, b, c]);
    expect(loadOf(p0, 'c').day).toBe('2026-10-16');
    const firm = moveOrder([], S, 'c', loadOf(p0, 'c'), loadOf(p0, 'a'), NOW);
    const p = plan([a, b, c], firm);
    expect(loadOf(p, 'c').id).toBe(loadOf(p, 'a').id);
    expect(loadOf(p, 'c').day).toBe('2026-10-12');
    // Neighbours of Liverpool: inside the run radius, no warning.
    expect(loadOf(p, 'c').warnings).toEqual([]);
  });

  it('warns, not refuses, when a hand-built run spreads too far', () => {
    const far = make('far', { city: 'Penrith', zone: 'NSW-Metro', volumeM3: 3 });
    const near = make('near', { city: 'Randwick', zone: 'NSW-Metro', volumeM3: 3 });
    const p0 = plan([far, near]);
    expect(loadOf(p0, 'far').id).not.toBe(loadOf(p0, 'near').id);
    const firm = moveOrder([], S, 'far', loadOf(p0, 'far'), loadOf(p0, 'near'), NOW);
    const p = plan([far, near], firm);
    expect(loadOf(p, 'far').id).toBe(loadOf(p, 'near').id);
    expect(loadOf(p, 'far').warnings.join()).toMatch(/km apart — beyond the 30 km run radius/);
  });

  it('takes an order off a load and lets the optimiser place it elsewhere', () => {
    const firm = moveOrder([], S, 'b', loadOf(base, 'b'), 'replan', NOW);
    expect(firm).toHaveLength(1);
    expect(firm[0].orderIds).toEqual(['a']);
    const p = plan([a, b], firm);
    expect(loadOf(p, 'b').firm).toBeNull();
    expect(loadOf(p, 'b').id).not.toBe(loadOf(p, 'a').id);
  });

  it('keeps a size the planner picked when orders move', () => {
    let firm = resizeLoad([], loadOf(base, 'a'), 'Semi 22-pallet', 75, NOW);
    let p = plan([a, b], firm);
    expect(loadOf(p, 'a').equipment).toBe('Semi 22-pallet');
    firm = moveOrder(firm, S, 'b', loadOf(p, 'b'), null, NOW);
    p = plan([a, b], firm);
    expect(loadOf(p, 'a').equipment).toBe('Semi 22-pallet');
  });

  it('re-dates a load and warns when it leaves after a due date', () => {
    const firm = redateLoad([], loadOf(base, 'a'), '2026-10-13', NOW);
    const p = plan([a, b], firm);
    expect(loadOf(p, 'a').day).toBe('2026-10-13');
    expect(loadOf(p, 'a').warnings.join()).toMatch(/after the due date of (a, b|b, a)$/);
  });

  it('warns when an interstate load is moved to a day the hub does not depart', () => {
    const q = make('q', { zone: 'QLD- Metro', city: 'Brisbane', needBy: '2026-10-15', volumeM3: 30 });
    const p0 = plan([q]);
    const firm = redateLoad([], loadOf(p0, 'q'), '2026-10-14', NOW);
    expect(loadOf(plan([q], firm), 'q').warnings.join()).toMatch(/No Brisbane hub departure/);
  });

  it('warns when an order is moved onto a load going somewhere else', () => {
    const q = make('q', { zone: 'QLD- Metro', city: 'Brisbane', volumeM3: 30 });
    const p0 = plan([a, q]);
    const firm = moveOrder([], S, 'a', loadOf(p0, 'a'), loadOf(p0, 'q'), NOW);
    expect(loadOf(plan([a, q], firm), 'a').warnings.join()).toMatch(/a is routed NSW-Metro-South · X/);
  });

  it('confirms an edited load', () => {
    const edited = moveOrder([], S, 'b', loadOf(base, 'b'), null, NOW);
    const firm = confirm(edited, loadOf(plan([a, b], edited), 'a'), NOW);
    expect(firm).toHaveLength(2);
    expect(firm.find((f) => f.orderIds.includes('a'))!.status).toBe('confirmed');
    expect(firm.find((f) => f.orderIds.includes('b'))!.status).toBe('edited');
  });
});

describe('split orders', () => {
  it('moves one piece and still plans the rest', () => {
    const big = make('big', { volumeM3: 100 });
    const p0 = plan([big]);
    const pieces = p0.loads.filter((l) => l.drops.some((d) => d.orderId === 'big'));
    expect(pieces).toHaveLength(2);
    const firm = moveOrder([], S, 'big', pieces[1], null, NOW);
    const p = plan([big], firm);
    const all = p.loads.flatMap((l) => l.drops.filter((d) => d.orderId === 'big'));
    expect(all.reduce((s, d) => s + d.volumeM3, 0)).toBeCloseTo(100);
    expect(all.map((d) => d.piece)).toEqual([
      { index: 1, of: 2 },
      { index: 2, of: 2 },
    ]);
  });
});

describe('fitEquipment', () => {
  it('sizes a hand-built load by the optimiser’s rules', () => {
    expect(fitEquipment('fleet', 1, S).equipment).toBe('Part load');
    expect(fitEquipment('fleet', 40, S)).toEqual({ equipment: 'Rigid 12-pallet', capacityM3: 45 });
    expect(fitEquipment('linehaul', 10, S).equipment).toBe('LTL');
    expect(fitEquipment('container', 30, S)).toEqual({ equipment: "40' GP", capacityM3: 58 });
  });
});
