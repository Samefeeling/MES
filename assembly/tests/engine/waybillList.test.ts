/**
 * The Waybill list: Waybill.csv kept in it cell by cell, and the dispatch
 * planner's decisions in columns of their own beside it — written per order,
 * read back the same.
 */

import { describe, expect, it } from 'vitest';
import {
  cellFromCsv,
  cellFromList,
  csvTable,
  decisionWrites,
  decisionsByOrder,
  decisionsFromRows,
  planSync,
  rowsToCsv,
  type CsvTable,
  type ListColumn,
  type ListRow,
} from '@/engine/dispatch/waybillList';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import type { DispatchDecisions, FirmLoad } from '@/domain/dispatch';
import type { ShipmentRecord } from '@/engine/dispatch/shipments';

const col = (name: string, kind: ListColumn['kind'], internal = name.replace(/[^A-Za-z0-9]/g, '')): ListColumn => ({
  name,
  internal,
  kind,
  readOnly: false,
  fromBase: false,
});

const COLUMNS: ListColumn[] = [
  { name: 'Title', internal: 'Title', kind: 'text', readOnly: false, fromBase: true },
  { name: 'Modified', internal: 'Modified', kind: 'date', readOnly: true, fromBase: true },
  col('Order', 'number'),
  col('Line', 'number'),
  col('Rel', 'number'),
  col('Description', 'text'),
  col('Part', 'text'),
  col('LeftToShip', 'number'),
  col('UOM', 'text'),
  col('On Hold', 'boolean', 'On_x0020_Hold'),
  col('Need By', 'date', 'Need_x0020_By'),
  col('Ship By', 'date', 'Ship_x0020_By'),
  col('FulfillmentMethod', 'text'),
  col('PlannedDay', 'date'),
  col('HoldReason', 'text'),
  col('VolumeM3', 'number'),
  col('LoadId', 'text'),
  col('LoadDetail', 'note'),
  col('DispatchedAt', 'date'),
  col('ClosedAt', 'date'),
];

const CSV = [
  'Order,Line,Rel,Description,Part,LeftToShip,On Hold,Need By,Ship By,FulfillmentMethod,Description',
  '17919,1,1,NSW-Metro-South,CHAIR-A,"1,200",FALSE,22/10/2026,15/10/2026,Stock,Chair',
  '17919,2,1,NSW-Metro-South,FRTNSW,5,FALSE,22/10/2026,15/10/2026,Other,Freight',
  '17920,1,1,QLD- Metro,DESK,3,TRUE,04/11/2026,21/10/2026,Job,Desk',
].join('\n');

const table = csvTable(CSV) as CsvTable;

// Sydney midnight, as SharePoint answers a date-only column.
const sydney = (day: string) => new Date(`${day}T00:00:00+11:00`).toISOString();

const row = (id: string, values: Record<string, unknown>): ListRow => ({ id, values });
const listRow = (id: string, order: number, line: number, patch: Record<string, unknown> = {}): ListRow =>
  row(id, {
    Title: `${order}-${line}-1`,
    Order: order,
    Line: line,
    Rel: 1,
    Description: 'NSW-Metro-South',
    Part: line === 1 ? 'CHAIR-A' : 'FRTNSW',
    LeftToShip: line === 1 ? 1200 : 5,
    UOM: line === 1 ? 'EA' : 'CBM',
    On_x0020_Hold: false,
    Need_x0020_By: sydney('2026-10-22'),
    Ship_x0020_By: sydney('2026-10-15'),
    FulfillmentMethod: line === 1 ? 'Stock' : 'Other',
    ...patch,
  });

describe('csvTable', () => {
  it('keeps the column the parser reads where the export names one twice', () => {
    expect(table.headers.filter((h) => h === 'Description')).toHaveLength(1);
    expect(table.rows[0].Description).toBe('NSW-Metro-South');
    expect(table.rows[2].Description).toBe('QLD- Metro');
    expect([table.order, table.line, table.rel]).toEqual(['Order', 'Line', 'Rel']);
  });
});

describe('cells', () => {
  it('reads a date the export writes d/mm/yyyy the same as the list’s instant', () => {
    expect(cellFromCsv('date', '15/10/2026')).toBe('2026-10-15');
    expect(cellFromList('date', sydney('2026-10-15'))).toBe('2026-10-15');
    expect(cellFromList('date', '2026-10-15')).toBe('2026-10-15');
  });

  it('reads numbers with thousands separators, and the export’s TRUE and FALSE', () => {
    expect(cellFromCsv('number', '1,200')).toBe(1200);
    expect(cellFromCsv('number', '')).toBeNull();
    expect(cellFromCsv('boolean', 'TRUE')).toBe(true);
    expect(cellFromCsv('text', 'x'.repeat(300))).toHaveLength(255);
  });
});

describe('planSync', () => {
  it('writes only the cells that changed, adds new releases, and closes the ones gone', () => {
    const open = [
      listRow('1', 17919, 1, { Need_x0020_By: sydney('2026-10-20') }), // re-dated in Epicor since
      listRow('2', 17919, 2),
      listRow('3', 17800, 1), // shipped: no longer exported
      listRow('4', 17919, 2), // a duplicate of row 2
    ];
    const plan = planSync({ table, columns: COLUMNS, open });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.updates).toEqual([{ id: '1', fields: { Need_x0020_By: '2026-10-22' } }]);
    expect(plan.unchanged).toBe(1);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({
      Title: '17920-1-1',
      Order: 17920,
      Description: 'QLD- Metro',
      On_x0020_Hold: true,
      Ship_x0020_By: '2026-10-21',
    });
    expect(plan.closes.sort()).toEqual(['3', '4']);
    expect(plan.duplicates).toBe(1);
    expect(plan.missing).toEqual([]);
  });

  it('opens a closed release again when it is back on the export', () => {
    const plan = planSync({
      table,
      columns: COLUMNS,
      open: [listRow('1', 17919, 1), listRow('2', 17919, 2)],
      closed: [listRow('9', 17920, 1, { Part: 'DESK', ClosedAt: '2026-10-01T00:00:00Z' })],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates.find((u) => u.id === '9')!.fields).toMatchObject({ ClosedAt: null, Description: 'QLD- Metro' });
  });

  it('says which headers have no column, and refuses a list it cannot match rows on', () => {
    const plan = planSync({ table, columns: COLUMNS.filter((c) => c.name !== 'FulfillmentMethod'), open: [] });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.missing).toEqual(['FulfillmentMethod']);
    expect(planSync({ table, columns: COLUMNS.filter((c) => c.name !== 'Rel'), open: [] })).toHaveProperty('error');
  });
});

describe('rowsToCsv', () => {
  it('gives the waybill parser the list’s open rows as the export would', () => {
    const parsed = parseWaybillCsv(rowsToCsv([listRow('1', 17919, 1), listRow('2', 17919, 2)], COLUMNS));
    expect(parsed.error).toBeNull();
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.orders[0]).toMatchObject({ id: '17919', shipBy: '2026-10-15', needBy: '2026-10-22', volumeM3: 5 });
  });
});

describe('decisions on the list', () => {
  const load = (patch: Partial<FirmLoad>): FirmLoad => ({
    id: 'firm-a',
    group: 'fleet:metro|NSW-Metro-South|ANMS',
    mode: 'fleet',
    label: 'NSW-Metro-South · ANMS',
    day: '2026-10-15',
    equipment: 'Rigid 8-pallet',
    capacityM3: 30,
    orderIds: ['17919', '17920'],
    volumes: { '17919': 5, '17920': 8 },
    pieces: { '17920': 4 },
    status: 'confirmed',
    confirmedAt: '2026-10-14T01:00:00.000Z',
    ...patch,
  });
  const shipment: ShipmentRecord = {
    loadId: 'firm-b',
    day: '2026-10-13',
    dispatchedAt: '2026-10-13T05:00:00.000Z',
    mode: 'fleet',
    label: 'NSW-Metro-South · ANMS',
    equipment: 'Part load',
    capacityM3: null,
    volumeM3: 2,
    orders: [
      {
        orderId: '17800',
        custId: 'C',
        shipToName: 'School',
        zone: 'NSW-Metro-South',
        goodsValue: 1000,
        freightValue: 50,
        volumeM3: 2,
        due: '2026-10-13',
        expDelivery: '2026-10-20',
        ready: true,
        piece: null,
      },
    ],
  };
  const decisions: DispatchDecisions = {
    pins: { '17919': '2026-10-15' },
    holds: { '17920': '' },
    volumeOverrides: { '17919': 5.5 },
    firmLoads: [
      load({}),
      load({
        id: 'firm-b',
        day: '2026-10-13',
        equipment: 'Part load',
        capacityM3: null,
        orderIds: ['17800'],
        volumes: { '17800': 2 },
        pieces: undefined,
        status: 'dispatched',
        dispatchedAt: '2026-10-13T05:00:00.000Z',
      }),
    ],
  };

  const rows = [
    listRow('1', 17919, 1),
    listRow('2', 17919, 2),
    listRow('3', 17920, 1, { Part: 'DESK' }),
    listRow('4', 17800, 1, { Part: 'TABLE', PlannedDay: sydney('2026-10-01') }), // a stale pin
  ];

  it('writes each order’s decisions to every open line of it, and clears what was undone', () => {
    const writes = decisionWrites(decisionsByOrder(decisions, [shipment]), rows, COLUMNS);
    const of = (id: string) => writes.find((w) => w.id === id)!.fields;
    expect(of('1')).toMatchObject({ PlannedDay: '2026-10-15', VolumeM3: 5.5, LoadId: 'firm-a' });
    expect(of('2')).toEqual(of('1'));
    expect(of('3')).toMatchObject({ HoldReason: 'Held', LoadId: 'firm-a' });
    expect(of('4')).toMatchObject({ PlannedDay: null, LoadId: 'firm-b', DispatchedAt: '2026-10-13T05:00:00.000Z' });
  });

  it('reads back what it wrote: pins, holds, volumes, loads with their pieces, and what left', () => {
    const written = rows.map((r) => {
      const w = decisionWrites(decisionsByOrder(decisions, [shipment]), [r], COLUMNS)[0];
      return w ? row(r.id, { ...r.values, ...w.fields }) : r;
    });
    const open = written.filter((r) => r.id !== '4');
    const back = decisionsFromRows(open, written, COLUMNS);
    expect(back.decisions.pins).toEqual(decisions.pins);
    expect(back.decisions.holds).toEqual(decisions.holds);
    expect(back.decisions.volumeOverrides).toEqual(decisions.volumeOverrides);
    expect(back.decisions.firmLoads).toEqual([
      { ...decisions.firmLoads[1], pieces: undefined },
      decisions.firmLoads[0],
    ].map((f) => JSON.parse(JSON.stringify(f))));
    expect(back.shipments).toEqual([shipment]);
    // And writing the same decisions again changes nothing.
    expect(decisionWrites(decisionsByOrder(back.decisions, back.shipments), written, COLUMNS)).toEqual([]);
  });

  it('keeps a load however long ago it left, so writing back never wipes it', () => {
    const written = rows.map((r) => {
      const w = decisionWrites(decisionsByOrder(decisions, [shipment]), [r], COLUMNS)[0];
      return w ? row(r.id, { ...r.values, ...w.fields }) : r;
    });
    const back = decisionsFromRows([], written, COLUMNS);
    expect(back.decisions.firmLoads.map((f) => f.id)).toEqual(['firm-b', 'firm-a']);
    expect(back.shipments.map((s) => s.loadId)).toEqual(['firm-b']);
  });
});
