/**
 * Load planning rules: route by zone, keep orders whole, consolidate nearby
 * customers, pull forward only inside the window, and freeze what the
 * planner confirmed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import {
  DEFAULT_DISPATCH_SETTINGS,
  EMPTY_DECISIONS,
  routeFor,
  type DispatchDecisions,
  type DispatchSettings,
  type FirmLoad,
  type ShipmentOrder,
} from '@/domain/dispatch';
import { planDispatch, type DispatchPlan } from '@/engine/dispatch/plan';
import { addWorkingDays, dispatchDays, workingDaysBetween } from '@/engine/dispatch/calendar';

const sample = readFileSync(
  fileURLToPath(new URL('../fixtures/waybill.sample.csv', import.meta.url)),
  'utf8',
);
const orders = parseWaybillCsv(sample).orders;

/** Thursday. The firm window (2 working days) runs to Monday 12 October. */
const TODAY = '2026-10-08';

const plan = (
  decisions: Partial<DispatchDecisions> = {},
  settings: DispatchSettings = DEFAULT_DISPATCH_SETTINGS,
  list: ShipmentOrder[] = orders,
  today = TODAY,
): DispatchPlan => planDispatch(list, settings, { ...EMPTY_DECISIONS, ...decisions }, today);

const loadsWith = (p: DispatchPlan, id: string) =>
  p.loads.filter((l) => l.drops.some((d) => d.orderId === id));

const base = plan();

const make = (id: string, patch: Partial<ShipmentOrder>): ShipmentOrder => ({
  id,
  custId: `C${id}`,
  shipToName: `Customer ${id}`,
  address: '',
  state: '',
  postcode: '',
  shipVia: 'X',
  zone: 'NSW-Metro-South',
  city: 'Liverpool',
  shipBy: '2026-10-14',
  needBy: null,
  expDelivery: null,
  pickListComment: '',
  packedM3: null,
  volumeM3: 1,
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

describe('calendar', () => {
  it('steps over weekends', () => {
    expect(addWorkingDays('2026-10-09', 1, new Set())).toBe('2026-10-12');
    expect(addWorkingDays('2026-10-12', -1, new Set())).toBe('2026-10-09');
    expect(workingDaysBetween('2026-10-12', '2026-10-14', new Set())).toBe(2);
  });

  it('keeps only the listed departure weekdays and skips holidays', () => {
    expect(dispatchDays('2026-10-12', '2026-10-18', [2, 4], new Set())).toEqual([
      '2026-10-13',
      '2026-10-15',
    ]);
    expect(dispatchDays('2026-10-12', '2026-10-14', null, new Set(['2026-10-13']))).toEqual([
      '2026-10-12',
      '2026-10-14',
    ]);
  });
});

describe('routing', () => {
  const s = DEFAULT_DISPATCH_SETTINGS;

  it('sends NSW zones to the fleet, other states to their hub, export to containers', () => {
    expect(routeFor('NSW-Metro-South', 'Liverpool', s)?.mode).toBe('fleet');
    expect(routeFor('NSW-Reg-North', 'Lismore', s, 'ANRN')?.group).toBe('fleet:reg-north|NSW-Reg-North|ANRN');
    expect(routeFor('NSW-Reg-North', 'Lismore', { ...s, fleet: { ...s.fleet, keepShipViaApart: false } })?.group).toBe('fleet:reg-north');
    expect(routeFor('QLD- Reg-North', 'Mt Isa', s, 'AQRN')?.group).toBe('linehaul:QLD|QLD- Reg-North|AQRN');
    expect(routeFor('WA-Metro', 'Perth', s, 'AWMC')?.label).toBe('Perth hub · WA-Metro · AWMC');
    expect(routeFor('NZ-North', 'Auckland', s)?.group).toBe('container:NZ-North|');
    expect(routeFor('Hong Kong', 'San Po Kong', s)?.mode).toBe('container');
    expect(routeFor('NSW-Customer Pickup', 'Minto', s)?.mode).toBe('pickup');
  });

  it('consolidates rest-of-world exports per destination city', () => {
    expect(routeFor('Export-ROW', 'Lautoka', s)?.group).toBe('container:Export-ROW · Lautoka|');
    expect(routeFor('Export-ROW', 'Taipei', s, 'EXRO')?.group).toBe('container:Export-ROW · Taipei|EXRO');
  });

  it('does not let a state prefix claim a longer word', () => {
    expect(routeFor('SAMOA', 'Apia', s)).toBeNull();
    expect(routeFor('Mars-Base', 'Olympus', s)).toBeNull();
  });
});

describe('NSW fleet', () => {
  it('puts a nearby order with time left on a truck that is going anyway', () => {
    const [load] = loadsWith(base, '90001');
    expect(load.day).toBe('2026-10-12');
    const prestons = load.drops.find((d) => d.orderId === '90002');
    expect(prestons?.daysEarly).toBe(2);
    expect(base.orders.get('90002')!.flags).toContain('pulled-forward');
  });

  it('does not put distant customers on one run', () => {
    const [narrabeen] = loadsWith(base, '90003');
    expect(narrabeen.drops.map((d) => d.orderId)).toEqual(['90003']);
    expect(narrabeen.equipment).toBe('Rigid 8-pallet');
  });

  it('does not pull an order forward beyond the early window', () => {
    expect(base.orders.get('90004')!.day).toBe('2026-10-23');
    expect(loadsWith(base, '90001')[0].drops.some((d) => d.orderId === '90004')).toBe(false);
  });

  it('pulls nothing forward when the warehouse window is zero', () => {
    const tight = plan({}, {
      ...DEFAULT_DISPATCH_SETTINGS,
      fleet: { ...DEFAULT_DISPATCH_SETTINGS.fleet, earlyDays: 0 },
    });
    expect(tight.orders.get('90002')!.day).toBe('2026-10-14');
  });

  it('splits an order only when it is bigger than the largest truck', () => {
    const loads = loadsWith(base, '90005');
    expect(loads.map((l) => l.drops[0].volumeM3).sort((a, b) => b - a)).toEqual([75, 25]);
    expect(base.orders.get('90005')!.flags).toContain('split');
    expect(base.orders.get('90001')!.flags).not.toContain('split');
  });

  it('right-sizes each run to the smallest truck that holds it', () => {
    const [liverpool] = loadsWith(base, '90001');
    expect(liverpool.volumeM3).toBe(18);
    expect(liverpool.equipment).toBe('Rigid 8-pallet');
  });

  it('respects the drop limit of the run class', () => {
    const list = ['a', 'b', 'c'].map((id) => make(id, { shipBy: '2026-10-12', custId: id }));
    const settings: DispatchSettings = {
      ...DEFAULT_DISPATCH_SETTINGS,
      fleet: {
        ...DEFAULT_DISPATCH_SETTINGS.fleet,
        carrierMaxM3: 0,
        runClasses: DEFAULT_DISPATCH_SETTINGS.fleet.runClasses.map((c) =>
          c.id === 'metro' ? { ...c, maxDrops: 2 } : c,
        ),
      },
    };
    const p = plan({}, settings, list);
    expect(p.loads.map((l) => l.drops.length).sort()).toEqual([1, 2]);
  });

  it('books a run of a pallet or two as a part load', () => {
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, [make('tiny', { volumeM3: 1.5, shipBy: '2026-10-12' })]);
    expect(p.loads[0].equipment).toBe('Part load');
  });

  it('pulls forward inside the firm window only when the goods are ready', () => {
    const list = [
      make('due', { shipBy: '2026-10-12', volumeM3: 10 }),
      make('ready', { shipBy: '2026-10-13', volumeM3: 2, readiness: 'ready' }),
      make('wip', { shipBy: '2026-10-13', volumeM3: 2, readiness: 'not-ready' }),
    ];
    // Friday: the firm window runs to Tuesday, so Monday is inside it.
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, list, '2026-10-09');
    const monday = loadsWith(p, 'due')[0];
    expect(monday.drops.map((d) => d.orderId).sort()).toEqual(['due', 'ready']);
    expect(p.orders.get('wip')!.day).toBe('2026-10-13');
  });
});

describe('NSW fleet by zone and Ship Via', () => {
  const north = make('n', { zone: 'NSW-Metro-North', shipVia: 'ANMN', city: 'Parramatta', shipBy: '2026-10-12', volumeM3: 5 });
  const south = make('s', { zone: 'NSW-Metro-South', shipVia: 'ANMS', city: 'Bankstown', shipBy: '2026-10-12', volumeM3: 5 });

  it('keeps neighbouring zones on their own runs', () => {
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, [north, south]);
    expect(loadsWith(p, 'n')[0].id).not.toBe(loadsWith(p, 's')[0].id);
    expect(loadsWith(p, 's')[0].label).toBe('NSW-Metro-South · ANMS');
  });

  it('lets them share a truck when Settings allow it', () => {
    const s = { ...DEFAULT_DISPATCH_SETTINGS, fleet: { ...DEFAULT_DISPATCH_SETTINGS.fleet, keepShipViaApart: false } };
    const p = plan({}, s, [north, south]);
    expect(loadsWith(p, 'n')[0].id).toBe(loadsWith(p, 's')[0].id);
  });
});

describe('interstate linehaul', () => {
  it('never puts different carriers or zones on one departure', () => {
    const qld = (id: string, zone: string, shipVia: string) =>
      make(id, { zone, shipVia, city: 'Brisbane', shipBy: '2026-10-15', volumeM3: 20 });
    const list = [
      qld('m1', 'QLD- Metro', 'AQMC'),
      qld('m2', 'QLD- Metro', 'AQMC'),
      qld('n1', 'QLD- Reg-North', 'AQRN'),
      qld('r1', 'QLD- Reg', 'AQRC'),
    ];
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, list);
    for (const load of p.loads) {
      expect(new Set(load.drops.map((d) => `${d.order!.zone}|${d.order!.shipVia}`)).size).toBe(1);
    }
    expect(loadsWith(p, 'm1')[0].id).toBe(loadsWith(p, 'm2')[0].id);
    expect(loadsWith(p, 'n1')[0].label).toBe('Brisbane hub · QLD- Reg-North · AQRN');
  });

  it('warns on a frozen load that mixes carriers', () => {
    const a = make('a', { zone: 'QLD- Metro', shipVia: 'AQMC', city: 'Brisbane', volumeM3: 20 });
    const b = make('b', { zone: 'QLD- Reg-North', shipVia: 'AQRN', city: 'Mt Isa', volumeM3: 20 });
    const firm: FirmLoad = {
      id: 'old',
      group: 'linehaul:QLD',
      mode: 'linehaul',
      label: 'Brisbane hub',
      day: '2026-10-13',
      equipment: 'FTL semi',
      capacityM3: 75,
      orderIds: ['a', 'b'],
      volumes: { a: 20, b: 20 },
      status: 'confirmed',
      confirmedAt: '',
    };
    const p = plan({ firmLoads: [firm] }, DEFAULT_DISPATCH_SETTINGS, [a, b]);
    expect(p.loads[0].warnings.join()).toMatch(/Mixes carriers or zones — book each separately: QLD- Metro \(AQMC\) ×1, QLD- Reg-North \(AQRN\) ×1/);
  });

  it('leaves on the last hub departure on or before Ship By', () => {
    const [load] = loadsWith(base, '90006');
    // Friday Ship By, Brisbane departs Tuesday and Thursday.
    expect(load.day).toBe('2026-10-15');
    expect(load.label).toBe('Brisbane hub · QLD- Metro · AQMC');
    expect(load.equipment).toBe('LTL');
  });

  it('builds a full truck from open orders only when it fills one', () => {
    const list = [
      make('q1', { zone: 'QLD- Metro', city: 'Brisbane', shipBy: '2026-10-13', volumeM3: 20 }),
      make('q2', { zone: 'QLD- Metro', city: 'Brisbane', shipBy: '2026-10-15', volumeM3: 45 }),
    ];
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, list);
    expect(p.loads).toHaveLength(1);
    expect(p.loads[0].equipment).toBe('FTL semi');
    expect(p.loads[0].day).toBe('2026-10-13');
  });
});

describe('export containers', () => {
  it('sizes the container by volume and says when it is just over a smaller one', () => {
    const [load] = loadsWith(base, '90007');
    expect(load.equipment).toBe("40' GP");
    expect(load.warnings.join()).toMatch(/over a 20' GP/);
    expect(load.warnings.join()).toMatch(/Low fill/);
  });

  it('turns an LCL into an FCL when open orders fill a container', () => {
    const list = [
      make('e1', { zone: 'NZ-North', city: 'Auckland', shipBy: '2026-10-15', volumeM3: 10 }),
      make('e2', { zone: 'NZ-North', city: 'Auckland', shipBy: '2026-10-22', volumeM3: 15 }),
    ];
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, list);
    expect(p.loads).toHaveLength(1);
    expect(p.loads[0].equipment).toBe("20' GP");
  });

  it('ships LCL when nothing can fill a container', () => {
    const list = [make('e1', { zone: 'NZ-North', city: 'Auckland', shipBy: '2026-10-15', volumeM3: 4 })];
    expect(plan({}, DEFAULT_DISPATCH_SETTINGS, list).loads[0].equipment).toBe('LCL');
  });
});

describe('exceptions', () => {
  it('keeps a credit-hold order off every load', () => {
    expect(loadsWith(base, '90008')).toHaveLength(0);
    expect(base.orders.get('90008')!.flags).toContain('credit-hold');
  });

  it('flags an unrouted zone instead of dropping the order', () => {
    expect(base.orders.get('90012')!.flags).toContain('unrouted');
  });

  it('plans an unknown volume but says so', () => {
    expect(base.orders.get('90009')!.flags).toContain('no-volume');
    expect(loadsWith(base, '90009')[0].warnings.join()).toMatch(/unknown volume/);
  });

  it('marks an order whose Ship By has passed', () => {
    const p = plan({}, DEFAULT_DISPATCH_SETTINGS, [make('old', { shipBy: '2026-09-30', volumeM3: 5 })]);
    expect(p.orders.get('old')!.flags).toContain('overdue');
    expect(p.orders.get('old')!.day).toBe(TODAY);
  });
});

describe('planner decisions', () => {
  it('moves a pinned order to its day', () => {
    const p = plan({ pins: { '90004': '2026-10-12' } });
    expect(p.orders.get('90004')!.day).toBe('2026-10-12');
    expect(p.orders.get('90004')!.flags).toContain('pinned');
  });

  it('holds an order back', () => {
    const p = plan({ holds: { '90001': 'Site not ready' } });
    expect(loadsWith(p, '90001')).toHaveLength(0);
    expect(p.orders.get('90001')!.flags).toContain('held');
  });

  it('uses an entered volume', () => {
    const p = plan({ volumeOverrides: { '90009': 4 } });
    expect(p.orders.get('90009')!.volumeKnown).toBe(true);
    expect(p.orders.get('90009')!.volumeM3).toBe(4);
  });

  it('freezes a confirmed load against re-planning', () => {
    const [load] = loadsWith(base, '90001');
    const firm: FirmLoad = {
      id: 'firm-1',
      group: load.group,
      mode: load.mode,
      label: load.label,
      day: load.day,
      equipment: load.equipment,
      capacityM3: load.capacityM3,
      orderIds: load.drops.map((d) => d.orderId),
      volumes: Object.fromEntries(load.drops.map((d) => [d.orderId, d.volumeM3])),
      status: 'confirmed',
      confirmedAt: '2026-10-08T00:00:00Z',
    };
    // Pinning a member elsewhere must not pull it off the confirmed load.
    const p = plan({ firmLoads: [firm], pins: { '90002': '2026-10-14' } });
    const frozen = p.loads.find((l) => l.id === 'firm-1')!;
    expect(frozen.firm).toBe('confirmed');
    expect(frozen.drops.map((d) => d.orderId)).toEqual(firm.orderIds);
    expect(loadsWith(p, '90002')).toHaveLength(1);
    expect(p.orders.get('90002')!.flags).toContain('firm');
  });
});
