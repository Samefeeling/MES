/**
 * "short material" instead of "no crew".
 *
 * An order with nobody on it and no foam in the racks used to show the floor a
 * label asking for people, so that is what the supervisor went and did —
 * allocated a crew to an order that still could not start. The shortage the
 * pick list already knew about now reaches the board.
 */

import { describe, it, expect } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { isPurchased, pickLedger, pickShortages, pickShortfall } from '@/engine/assembly/pickShortage';
import { buildIndexes } from '@/engine/indexes';
import { JobId, PartId, WorkCenterId, WorkerId } from '@/domain/ids';
import {
  LINES,
  PRODUCTIVE_HOURS_PER_PERSON,
  type CrewAssignment,
  type Worker,
} from '@/domain/assembly';
import type {
  InventoryItem,
  Job,
  JobMaterialLink,
  PlanningDataset,
  PoLine,
} from '@/domain/types';

const LANE = LINES.find((l) => l.key === 'ASSY')!;

/** Thursday 10 Sep 2026. */
const THU = new Date(2026, 8, 10);

const worker = (id: string): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: ['ASSY'],
  onShift: true,
});

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId('CHAIR'),
  description: `order ${id}`,
  remainingQty: 10,
  qtyPerHr: null,
  laborHrs: 2 * PRODUCTIVE_HOURS_PER_PERSON,
  dueDate: new Date(2026, 8, 30),
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'upholstery',
  line: LANE.id,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const link = (
  jobNum: string,
  child: string,
  requiredQty: number | null,
  childDescription = `component ${child}`,
): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId('CHAIR'),
  childPart: PartId(child),
  requiredQty,
  childDescription,
  uom: 'EA',
});

const stock = (part: string, onHand: number, description = part): InventoryItem => ({
  partNum: PartId(part),
  description,
  typeCode: null,
  onHand,
  cmplWip: 0,
  supply: 0,
  demand: 0,
  calculatedDemand: null,
  freeOnHand: onHand,
});

const indexOf = (items: InventoryItem[]) =>
  new Map(items.map((item) => [item.partNum, item]));

/** One order on the assembly lane, with or without a crew on it. */
function board(
  jobs: Job[],
  over: {
    links?: JobMaterialLink[];
    inventory?: InventoryItem[];
    po?: PoLine[];
    /** Orders to put a person on; the rest stand there unstaffed. */
    crewed?: string[];
  } = {},
) {
  const workers = jobs.map((_, i) => worker(`W${i}`));
  const dataset: PlanningDataset = {
    workCenters: [
      {
        id: WorkCenterId(String(LANE.id)),
        kind: 'area',
        name: 'ASSY',
        department: 'assembly',
        sortIndex: 1,
      },
    ],
    jobs,
    routing: [],
    inventory: over.inventory ?? [],
    bom: [],
    po: over.po ?? [],
    demand: [],
    jobLinks: over.links ?? [],
    workers,
    fetchedAt: THU,
  };
  const crewed = over.crewed ?? jobs.map((j) => String(j.id));
  const orderCrewAssignments: Record<string, CrewAssignment[]> = {};
  jobs.forEach((j, i) => {
    if (!crewed.includes(String(j.id))) return;
    orderCrewAssignments[String(j.id)] = [
      { workerId: `W${i}`, fromDay: null, toDayExclusive: null },
    ];
  });
  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers: { [String(LANE.id)]: jobs.map((j) => j.id) },
    orderCrewAssignments,
    orderDoubleBooked: {},
    orderStarts: {},
    orderOvertime: {},
    progress: {},
    production: {},
    workers,
    today: THU,
  });
}

describe('the pick list’s shortage rule', () => {
  it('marks a component the order needs more of than the warehouse has', () => {
    expect(pickShortfall(40, 12)).toBe(28);
  });

  it('says nothing about a component that is covered, exactly or over', () => {
    expect(pickShortfall(40, 40)).toBe(0);
    expect(pickShortfall(40, 400)).toBe(0);
  });

  it('never calls a figure it does not have short', () => {
    // A part missing from the loaded OnHandInventory.csv, and a material line
    // the order export gave no required quantity. Both are unknown, and
    // unknown is not a shortage — the sheet shows "—" for them.
    expect(pickShortfall(40, undefined)).toBe(0);
    expect(pickShortfall(null, 0)).toBe(0);
  });

  it('treats nothing in stock against a real requirement as short', () => {
    expect(pickShortfall(40, 0)).toBe(40);
  });
});

describe('what the shelf cannot cover on a pick list', () => {
  const picks = [
    link('ASM1', 'FOAM', 40),
    link('ASM1', 'GLUE', 5),
    link('ASM1', 'CLOTH', 100),
    // Unknown on both counts: no quantity asked for, and a part the on-hand
    // export has never heard of.
    link('ASM1', 'STAPLES', null),
    link('ASM1', 'THREAD', 3),
  ];
  const inventory = indexOf([
    stock('FOAM', 12, 'Foam: seat'),
    stock('GLUE', 5),
    stock('CLOTH', 0),
    stock('STAPLES', 0),
  ]);

  it('lists only the short lines, worst shortfall first', () => {
    expect(
      pickShortages(picks, inventory).map((s) => [String(s.part), s.shortQty]),
    ).toEqual([
      ['CLOTH', 100],
      ['FOAM', 28],
    ]);
  });

  it('carries the figures the supervisor needs to chase it', () => {
    const [, foam] = pickShortages(picks, inventory);
    expect(foam).toEqual({
      part: PartId('FOAM'),
      description: 'Foam: seat',
      requiredQty: 40,
      onHand: 12,
      heldEarlier: 0,
      shortQty: 28,
      incoming: null,
      // Nothing on the board builds foam: bought in.
      purchased: true,
    });
  });

  it('adds what is on order when PODetail.csv has the part', () => {
    const po = new Map([[PartId('FOAM'), [
      { partNum: PartId('FOAM'), poNum: 'P1', outstandingQty: 30, dueDate: new Date(2026, 9, 5), promiseDate: new Date(2026, 9, 7), buyer: null },
    ]]]);
    const [, foam] = pickShortages(picks, inventory, po);
    expect(foam.incoming).toMatchObject({ qty: 30, availableDate: new Date(2026, 9, 7), coversShort: true });
  });

  it('falls back to the material row’s own description', () => {
    const [only] = pickShortages(
      [link('ASM1', 'FOAM', 40, 'Foam: seat, 50 mm')],
      indexOf([{ ...stock('FOAM', 0), description: '' }]),
    );
    expect(only.description).toBe('Foam: seat, 50 mm');
  });

  it('has nothing to say about an order with no pick list at all', () => {
    expect(pickShortages(undefined, inventory)).toEqual([]);
    expect(pickShortages([], inventory)).toEqual([]);
  });
});

describe('the board carries the shortage onto the row', () => {
  it('names what is short on an order the racks cannot supply', () => {
    const b = board([job('ASM1')], {
      links: [link('ASM1', 'FOAM', 40)],
      inventory: [stock('FOAM', 12, 'Foam: seat')],
      crewed: [],
    });
    const row = b.rowsByJob.get('ASM1')!;
    expect(row.shortPicks?.map((s) => String(s.part))).toEqual(['FOAM']);
    expect(row.shortPicks?.[0].shortQty).toBe(28);
  });

  it('says nothing when the shelf covers the order', () => {
    const b = board([job('ASM1')], {
      links: [link('ASM1', 'FOAM', 40)],
      inventory: [stock('FOAM', 40)],
      crewed: [],
    });
    expect(b.rowsByJob.get('ASM1')!.shortPicks).toEqual([]);
  });

  it('claims no shortage with no on-hand export loaded', () => {
    /*
     * The live source only sometimes carries OnHandInventory.csv. Without it
     * every part is unknown, and unknown must not read as empty racks — a
     * board that called every order short of material would be telling the
     * floor nothing at all.
     */
    const b = board([job('ASM1')], { links: [link('ASM1', 'FOAM', 40)], crewed: [] });
    expect(b.rowsByJob.get('ASM1')!.shortPicks).toEqual([]);
  });
});

const po = (part: string, qty: number, due: Date, promise: Date | null = null, poNum = 'P'): PoLine => ({
  partNum: PartId(part), poNum, outstandingQty: qty, dueDate: due, promiseDate: promise, buyer: null,
});

describe('stock and purchase orders are handed out one order at a time', () => {
  it('gives the shelf to the first order, and the next one waits for the PO', () => {
    const ledger = pickLedger(
      indexOf([stock('FRAME', 40)]),
      new Map([[PartId('FRAME'), [po('FRAME', 50, new Date(2026, 9, 5), new Date(2026, 9, 7), 'P1')]]]),
    );
    expect(ledger.take([link('A', 'FRAME', 30)])).toEqual([]);
    const [b] = ledger.take([link('B', 'FRAME', 30)]);
    // 40 on the shelf, 30 of them A's: B is 20 short, and the PO (due the
    // 5th, promised the 7th — the later counts) covers it.
    expect(b).toMatchObject({ onHand: 40, heldEarlier: 30, shortQty: 20 });
    expect(b.incoming).toMatchObject({ qty: 50, heldEarlier: 0, coversShort: true, availableDate: new Date(2026, 9, 7) });
    // What B drew from the PO is gone for C.
    const [c] = ledger.take([link('C', 'FRAME', 40)]);
    expect(c).toMatchObject({ heldEarlier: 40, shortQty: 40 });
    expect(c.incoming).toMatchObject({ heldEarlier: 20, coversShort: false });
  });

  it('dates an order by the last release it has to draw on', () => {
    const ledger = pickLedger(
      indexOf([stock('FRAME', 0)]),
      new Map([[PartId('FRAME'), [po('FRAME', 50, new Date(2026, 9, 20)), po('FRAME', 25, new Date(2026, 9, 5))]]]),
    );
    expect(ledger.take([link('A', 'FRAME', 30)])[0].incoming?.availableDate).toEqual(new Date(2026, 9, 20));
    expect(ledger.take([link('B', 'FRAME', 20)])[0].incoming).toMatchObject({
      heldEarlier: 30, availableDate: new Date(2026, 9, 20), coversShort: true,
    });
  });
});

describe('an order short of bought-in material waits for its PO', () => {
  it('does not start before the PO that makes it whole', () => {
    const b = board([job('A')], {
      links: [link('A', 'FRAME', 30)],
      inventory: [stock('FRAME', 10)],
      po: [po('FRAME', 50, new Date(2026, 8, 17), new Date(2026, 8, 16))],
    });
    const row = b.rowsByJob.get('A')!;
    expect(row.materialReadyAt).toEqual(new Date(2026, 8, 17));
    expect(row.start!.getTime()).toBeGreaterThanOrEqual(new Date(2026, 8, 17).getTime());
  });

  it('holds nothing back when no PO covers the shortfall — there is no date to wait for', () => {
    const b = board([job('A')], { links: [link('A', 'FRAME', 30)], inventory: [stock('FRAME', 10)] });
    const row = b.rowsByJob.get('A')!;
    expect(row.materialReadyAt).toBeNull();
    expect(row.start!.getTime()).toBeLessThan(new Date(2026, 8, 17).getTime());
  });

  it('gives the shelf to the more urgent order, and the other waits for the PO', () => {
    const b = board(
      [job('LATER', { dueDate: new Date(2026, 9, 30) }), job('SOONER', { dueDate: new Date(2026, 8, 18) })],
      {
        links: [link('LATER', 'FRAME', 30), link('SOONER', 'FRAME', 30)],
        inventory: [stock('FRAME', 30)],
        po: [po('FRAME', 30, new Date(2026, 8, 24))],
      },
    );
    expect(b.rowsByJob.get('SOONER')!.shortPicks).toEqual([]);
    expect(b.rowsByJob.get('LATER')!.materialReadyAt).toEqual(new Date(2026, 8, 24));
  });
});

describe('bought in or made here', () => {
  const item = (typeCode: string | null) => ({ typeCode }) as never;
  it('reads Part_TypeCode when the export carries it', () => {
    expect(isPurchased(item('P'), false, true)).toBe(true);
    expect(isPurchased(item('M'), false, false)).toBe(false);
  });
  it('without it, calls a part some order builds made here, and anything else bought', () => {
    expect(isPurchased(item(null), false, true)).toBe(false);
    expect(isPurchased(item(null), false, false)).toBe(true);
    expect(isPurchased(undefined, false, false)).toBe(true);
  });
  it('calls a part with a purchase order open bought, whatever else is said', () => {
    expect(isPurchased(item('M'), true, true)).toBe(true);
  });
  it('puts the bought-in lines of a pick list first', () => {
    const inv = new Map([
      [PartId('COVER'), { partNum: PartId('COVER'), description: 'Cover', typeCode: null, onHand: 0 }],
      [PartId('FRAME'), { partNum: PartId('FRAME'), description: 'Frame', typeCode: null, onHand: 0 }],
    ]) as never;
    const list = [
      { childPart: PartId('COVER'), requiredQty: 50, childDescription: 'Cover' },
      { childPart: PartId('FRAME'), requiredQty: 5, childDescription: 'Frame' },
    ] as never;
    const short = pickShortages(list, inv, new Map(), new Set(['COVER']));
    expect(short.map((s) => [String(s.part), s.purchased])).toEqual([
      ['FRAME', true],
      ['COVER', false],
    ]);
  });
});
