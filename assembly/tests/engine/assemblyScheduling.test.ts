/**
 * How a line places its orders in time.
 *
 * A line has three build positions, so three orders run side by side and a
 * fourth waits for the first to clear. Within that, an order keeps the day it
 * was dragged to — which is what makes every bar movable rather than only the
 * first on the line. Bars step over Saturday and Sunday unless the supervisor
 * has approved overtime, and nothing here ever touches a Due Date.
 */

import { describe, it, expect } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { buildIndexes } from '@/engine/indexes';
import { JobId, PartId, WorkCenterId, WorkerId } from '@/domain/ids';
import {
  LINES,
  PARALLEL_ORDERS_PER_LINE,
  PRODUCTIVE_HOURS_PER_PERSON,
  type Worker,
  type CrewAssignment,
} from '@/domain/assembly';
import { isWeekend } from '@/engine/assembly/dates';
import type { Job, JobMaterialLink, PlanningDataset } from '@/domain/types';

const UPL = LINES.find((l) => l.key === 'UPL')!;

/** Thursday 10 Sep 2026 — two working days before the weekend. */
const THU = new Date(2026, 8, 10);
const day = (n: number, hour = 0) => new Date(2026, 8, n, hour);

const worker = (id: string): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: ['UPL'],
  onShift: true,
});

/** An order needing exactly `days` of work from one person. */
const job = (id: string, days: number, over: Partial<Job> = {}): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId('P1'),
  description: `order ${id}`,
  remainingQty: 10,
  qtyPerHr: null,
  laborHrs: days * PRODUCTIVE_HOURS_PER_PERSON,
  dueDate: day(30),
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'upholstery',
  line: UPL.id,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

/** Whole-order allocations, which is what most of these cases want. */
const crewOf = (
  byJob: Record<string, string[]>,
): Record<string, CrewAssignment[]> =>
  Object.fromEntries(
    Object.entries(byJob).map(([jobId, ids]) => [
      jobId,
      ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null })),
    ]),
  );

function board(
  jobs: Job[],
  over: {
    orderStarts?: Record<string, string>;
    orderOvertime?: Record<string, boolean>;
    crew?: Record<string, string[]>;
    orderDoubleBooked?: Record<string, string[]>;
    jobLinks?: JobMaterialLink[];
    today?: Date;
  } = {},
) {
  const workers = jobs.map((_, i) => worker(`W${i}`));
  const dataset: PlanningDataset = {
    workCenters: [
      {
        id: WorkCenterId(String(UPL.id)),
        kind: 'area',
        name: 'UPL',
        department: 'assembly',
        sortIndex: 1,
      },
    ],
    jobs,
    routing: [],
    inventory: [],
    bom: [],
    po: [],
    demand: [],
    jobLinks: over.jobLinks ?? [],
    workers,
    fetchedAt: THU,
  };

  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    // Moulding orders belong to the press, not to an assembly line.
    containers: {
      [String(UPL.id)]: jobs
        .filter((j) => j.department === 'assembly')
        .map((j) => j.id),
    },
    // One person each, so a bar is exactly as long as the order's days.
    orderCrewAssignments: crewOf(
      over.crew ??
        Object.fromEntries(jobs.map((j, i) => [String(j.id), [`W${i}`]])),
    ),
    orderDoubleBooked: over.orderDoubleBooked ?? {},
    orderStarts: over.orderStarts ?? {},
    orderOvertime: over.orderOvertime ?? {},
    progress: {},
    production: {},
    workers,
    today: over.today ?? THU,
  });
}

describe('parallel build positions', () => {
  it('runs three orders side by side rather than queueing them', () => {
    const b = board([job('A', 1), job('B', 1), job('C', 1)]);
    const rows = ['A', 'B', 'C'].map((id) => b.rowsByJob.get(id)!);

    for (const row of rows) expect(row.start).toEqual(THU);
    // Each took a different position on the line.
    expect(new Set(rows.map((r) => r.slot)).size).toBe(
      PARALLEL_ORDERS_PER_LINE,
    );
  });

  it('queues the fourth order behind whichever position frees first', () => {
    // A finishes after one day, B and C after two — so D follows A.
    const b = board([job('A', 1), job('B', 2), job('C', 2), job('D', 1)]);
    const a = b.rowsByJob.get('A')!;
    const d = b.rowsByJob.get('D')!;

    expect(d.start).toEqual(a.expectDate);
    expect(d.slot).toBe(a.slot);
  });

  it('keeps the day an order was dragged to while a position is free', () => {
    const b = board([job('A', 1), job('B', 1)], {
      orderStarts: { B: day(16).toISOString() },
    });
    expect(b.rowsByJob.get('A')!.start).toEqual(THU);
    expect(b.rowsByJob.get('B')!.start).toEqual(day(16));
  });

  it('moves any order on the line, not only the first', () => {
    // Four orders, so one is genuinely queued; dragging the last one earlier
    // used to be ignored, because the line had a single moving cursor and a
    // start before it simply lost.
    const jobs = [job('A', 2), job('B', 2), job('C', 2), job('D', 2)];
    const before = board(jobs);
    expect(before.rowsByJob.get('D')!.start).toEqual(day(14)); // queued to Mon

    const after = board(jobs, { orderStarts: { D: day(11).toISOString() } });
    expect(after.rowsByJob.get('D')!.start).toEqual(day(11));
    // The three it joined stay where they were: a drag over-commits the line
    // rather than shuffling everyone else around behind the planner's back.
    for (const id of ['A', 'B', 'C']) {
      expect(after.rowsByJob.get(id)!.start).toEqual(THU);
    }
  });

  it('leaves the queue behind a pinned order intact', () => {
    // E is not dragged, so it still waits for a position — and the position D
    // was pinned over does not come free early just because D sits on it.
    const jobs = [
      job('A', 2),
      job('B', 2),
      job('C', 2),
      job('D', 4),
      job('E', 1),
    ];
    const b = board(jobs, { orderStarts: { D: day(11).toISOString() } });

    expect(b.rowsByJob.get('D')!.start).toEqual(day(11));
    // A, B and C free their positions on Monday; E takes the first of them.
    expect(b.rowsByJob.get('E')!.start).toEqual(day(14));
  });

  it('starts as soon as it can, not on the day Epicor pencilled in', () => {
    // Epicor works its Start Date back from the due date, so it is the last
    // day this could begin, not an instruction to stand idle until then. The
    // board carries it as `Must start` and schedules the work now.
    const b = board([job('A', 1, { startDate: new Date(2026, 8, 16, 7, 30) })]);
    expect(b.rowsByJob.get('A')!.start).toEqual(THU);
    expect(b.rowsByJob.get('A')!.job.startDate).toEqual(
      new Date(2026, 8, 16, 7, 30),
    );
  });

  it('never starts before the board opens, however old the export is', () => {
    const b = board([job('A', 1, { startDate: day(1) })]);
    expect(b.rowsByJob.get('A')!.start).toEqual(THU);
  });
});

describe('the closed weekend', () => {
  it('steps a bar over Saturday and Sunday', () => {
    // Three days from Thursday: Thu, Fri, then Monday.
    const b = board([job('A', 3)]);
    const row = b.rowsByJob.get('A')!;
    expect(row.start).toEqual(THU);
    expect(row.expectDate).toEqual(day(15));
    expect(row.overtime).toBe(false);
  });

  it('pushes a start pinned to a weekend on to the Monday', () => {
    const b = board([job('A', 1)], {
      orderStarts: { A: day(12).toISOString() }, // Saturday
    });
    const start = b.rowsByJob.get('A')!.start!;
    expect(isWeekend(start)).toBe(false);
    expect(start).toEqual(day(14));
  });

  it('honours a weekend once the supervisor approves overtime', () => {
    const b = board([job('A', 2)], {
      orderStarts: { A: day(12).toISOString() },
      orderOvertime: { A: true },
    });
    const row = b.rowsByJob.get('A')!;
    expect(row.start).toEqual(day(12)); // Saturday, as dropped
    expect(row.expectDate).toEqual(day(14)); // straight through Sunday
    expect(row.overtime).toBe(true);
  });

  it('finishing during the due date is on time, even after a weekend', () => {
    // Two days of work from Friday would finish Saturday if the factory ran;
    // it does not, so the second day is the Monday. The bar therefore ends at
    // Monday's close — Tuesday midnight — and an order due Monday has made it.
    const jobs = [job('A', 2, { dueDate: day(14) })];
    const b = board(jobs, { orderStarts: { A: day(11).toISOString() } });
    const row = b.rowsByJob.get('A')!;

    expect(row.expectDate).toEqual(day(15));
    expect(row.status.color).toBe('green');
    expect(row.job.dueDate).toEqual(day(14));
  });

  it('turns red only once the work runs past the due date', () => {
    // A third day puts it on the Tuesday, which is past a Monday due date.
    const jobs = [job('A', 3, { dueDate: day(14) })];
    const b = board(jobs, { orderStarts: { A: day(11).toISOString() } });
    const row = b.rowsByJob.get('A')!;

    expect(row.expectDate).toEqual(day(16));
    expect(row.status.color).toBe('red');
    // The commitment itself is untouched — only the expectation moved.
    expect(row.job.dueDate).toEqual(day(14));
  });
});

describe('waiting on the orders that build the components', () => {
  const link = (
    jobNum: string,
    parent: string,
    child: string,
  ): JobMaterialLink => ({
    jobNum: JobId(jobNum),
    parentPart: PartId(parent),
    childPart: PartId(child),
    requiredQty: 1,
  });

  it('starts the parent when the child order finishes, not before', () => {
    const cover = job('COVER1', 1, { partNum: PartId('COVER') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([cover, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'COVER'),
        link('COVER1', 'COVER', 'FABRIC'),
      ],
    });

    const upstream = b.rowsByJob.get('COVER1')!;
    const downstream = b.rowsByJob.get('CHAIR1')!;

    // Both could have started today — the line has three free positions — so
    // the only thing holding the chair back is the cover.
    expect(upstream.start).toEqual(THU);
    expect(downstream.start).toEqual(upstream.expectDate);
    expect(downstream.start).toEqual(day(11));
    expect(String(downstream.waitingOn!.onJobId)).toBe('COVER1');
    expect(String(downstream.waitingOn!.part)).toBe('COVER');
  });

  it('waits for the Monday when the child order finishes on a Friday', () => {
    // Two days from Thursday runs out the end of Friday. There is no working
    // Saturday to hand the components over on, so the parent starts Monday.
    const cover = job('COVER1', 2, { partNum: PartId('COVER') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([cover, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'COVER'),
        link('COVER1', 'COVER', 'FABRIC'),
      ],
    });

    expect(b.rowsByJob.get('COVER1')!.expectDate).toEqual(day(12));
    expect(b.rowsByJob.get('CHAIR1')!.start).toEqual(day(14));
  });

  it('waits for the last component, not the first one it reads', () => {
    const quick = job('COVER1', 1, { partNum: PartId('COVER') });
    const slow = job('FRAME1', 3, { partNum: PartId('FRAME') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([quick, slow, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'COVER'),
        link('CHAIR1', 'CHAIR', 'FRAME'),
        link('COVER1', 'COVER', 'FABRIC'),
        link('FRAME1', 'FRAME', 'STEEL'),
      ],
    });

    const row = b.rowsByJob.get('CHAIR1')!;
    expect(row.predecessors).toHaveLength(2);
    expect(row.start).toEqual(b.rowsByJob.get('FRAME1')!.expectDate);
    expect(String(row.waitingOn!.onJobId)).toBe('FRAME1');
  });

  it('holds an assembly order behind the press job making its shell', () => {
    // The moulding row keeps moulding's own dates; assembly reads them.
    const shell = job('SFM1', 1, {
      department: 'moulding',
      partNum: PartId('SHELL'),
      line: null,
      startDate: day(16),
      laborHrs: 24, // a full day on a press running around the clock
    });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([shell, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'SHELL'),
        link('SFM1', 'SHELL', 'RESIN'),
      ],
    });

    const row = b.rowsByJob.get('CHAIR1')!;
    expect(row.start).toEqual(day(17));
    expect(String(row.waitingOn!.onJobId)).toBe('SFM1');

    // And the press job is on the PMD row, so it can be seen and chased.
    const pmd = b.groups.find((g) => !g.line.schedulable)!;
    expect(pmd.rows.map((r) => String(r.job.id))).toContain('SFM1');
  });

  it('leaves an order alone when nobody is making its components', () => {
    const table = job('TBL1', 1, { partNum: PartId('TABLE') });
    const b = board([table], { jobLinks: [link('TBL1', 'TABLE', 'MDF-TOP')] });

    expect(b.rowsByJob.get('TBL1')!.start).toEqual(THU);
    expect(b.rowsByJob.get('TBL1')!.waitingOn).toBeNull();
  });

  it('moves the whole chain when the first order is dragged out', () => {
    const cover = job('COVER1', 1, { partNum: PartId('COVER') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const links = [
      link('CHAIR1', 'CHAIR', 'COVER'),
      link('COVER1', 'COVER', 'FABRIC'),
    ];

    const before = board([cover, chair], { jobLinks: links });
    const after = board([cover, chair], {
      jobLinks: links,
      orderStarts: { COVER1: day(14).toISOString() },
    });

    expect(before.rowsByJob.get('CHAIR1')!.start).toEqual(day(11));
    expect(after.rowsByJob.get('CHAIR1')!.start).toEqual(day(15));
    // Pushed out by three working days, and still nothing touched a Due Date.
    expect(after.rowsByJob.get('CHAIR1')!.job.dueDate).toEqual(day(30));
  });

  it('schedules both ends of a circular pair rather than deadlocking', () => {
    const a = job('A', 1, { partNum: PartId('PA') });
    const b2 = job('B', 1, { partNum: PartId('PB') });
    const b = board([a, b2], {
      jobLinks: [link('A', 'PA', 'PB'), link('B', 'PB', 'PA')],
    });

    expect(b.rowsByJob.get('A')!.start).not.toBeNull();
    expect(b.rowsByJob.get('B')!.start).not.toBeNull();
    expect(b.dependencyWarnings[0]).toMatch(/Circular/);
  });
});

/**
 * The other chain: the people. A team finishes one order and picks up the
 * next, so two bars sharing a person neither overlap nor leave a gap.
 */
describe('the crew hand-over', () => {
  /** Two orders for one person, the second scheduled well into the future. */
  const pair = (secondStart: Date) => [
    job('FIRST', 2),
    job('SECOND', 2, { startDate: secondStart }),
  ];
  const bothOnBill = { FIRST: ['W0'], SECOND: ['W0'] };

  it('starts an order the shift after its crew finishes the last one', () => {
    const b = board(pair(day(28)), { crew: bothOnBill });
    const first = b.rowsByJob.get('FIRST')!;
    const second = b.rowsByJob.get('SECOND')!;

    // Thursday and Friday finish FIRST, so it ends at the close of the week;
    // SECOND takes the next shift going rather than waiting for the day
    // Epicor had pencilled in.
    expect(first.start).toEqual(THU);
    expect(first.expectDate).toEqual(day(12));
    expect(second.start).toEqual(day(14));
  });

  it('never has one person on two orders at once', () => {
    const b = board(pair(day(11)), { crew: bothOnBill });
    const first = b.rowsByJob.get('FIRST')!;
    const second = b.rowsByJob.get('SECOND')!;

    expect(first.expectDate!.getTime()).toBeLessThanOrEqual(
      second.start!.getTime(),
    );
  });

  it('starts an order at once when its crew has nothing else on', () => {
    // Different people, so nothing holds SECOND back and it runs alongside
    // FIRST rather than waiting for the day Epicor worked back to.
    const b = board(pair(day(28)), {
      crew: { FIRST: ['W0'], SECOND: ['W1'] },
    });
    expect(b.rowsByJob.get('SECOND')!.start).toEqual(THU);
    expect(b.rowsByJob.get('FIRST')!.start).toEqual(THU);
  });

  it('starts with whoever is free and lets the rest catch up', () => {
    // W0 comes off SHORT at the end of the week, W1 off LONG on Wednesday.
    // BOTH does not stand idle until Wednesday: W0 starts it as soon as they
    // are free, and W1 joins when they arrive.
    const jobs = [job('SHORT', 2), job('LONG', 4), job('BOTH', 3)];
    const b = board(jobs, {
      crew: { SHORT: ['W0'], LONG: ['W1'], BOTH: ['W0', 'W1'] },
    });
    const short = b.rowsByJob.get('SHORT')!;
    const long = b.rowsByJob.get('LONG')!;
    const both = b.rowsByJob.get('BOTH')!;

    expect(short.expectDate).toEqual(day(12)); // the end of Friday
    expect(long.expectDate).toEqual(day(16));
    // Starts the moment W0 is free — the Monday, the weekend being shut —
    // rather than waiting for W1 on the Wednesday.
    expect(both.start).toEqual(day(14));
    // W0 alone at first; W1 is on it only from the day after they finish LONG.
    expect(both.crewDays![0].workerIds).toEqual(['W0']);
    expect(both.crewDays!.at(-1)!.workerIds).toEqual(['W0', 'W1']);
  });

  it('fills the gap in front of an order dragged out', () => {
    const jobs = pair(day(28));
    const after = board(jobs, {
      crew: bothOnBill,
      orderStarts: { FIRST: day(16).toISOString() },
    });
    // Dragging FIRST to the Wednesday leaves Bill with nothing until then.
    // He spends it on SECOND and steps off the day FIRST is due to start:
    // these are two independent orders that happen to share one person, so
    // there is no reason for the week in front of the drag to go to waste.
    const first = after.rowsByJob.get('FIRST')!;
    const second = after.rowsByJob.get('SECOND')!;
    expect(first.start).toEqual(day(16));
    expect(second.start).toEqual(day(10));
    // And Bill is never on both at once: SECOND is done before FIRST opens.
    expect(second.expectDate!.getTime()).toBeLessThanOrEqual(
      first.start!.getTime(),
    );
  });

  it('gives back the days when that order is dragged earlier again', () => {
    const jobs = pair(day(28));
    const late = board(jobs, {
      crew: bothOnBill,
      orderStarts: { FIRST: day(18).toISOString() },
    });
    const early = board(jobs, {
      crew: bothOnBill,
      orderStarts: { FIRST: day(14).toISOString() },
    });

    // Wherever FIRST is dragged to, SECOND takes the room in front of it and
    // stops before it — the drag moves the wall, not the work behind it.
    for (const [name, b] of [
      ['late', late],
      ['early', early],
    ] as const) {
      const first = b.rowsByJob.get('FIRST')!;
      const second = b.rowsByJob.get('SECOND')!;
      expect(second.start, name).toEqual(day(10));
      expect(second.expectDate!.getTime(), name).toBeLessThanOrEqual(
        first.start!.getTime(),
      );
    }
  });

  it('lets the pair the supervisor approved run side by side', () => {
    const jobs = pair(day(11));
    const b = board(jobs, {
      crew: bothOnBill,
      orderDoubleBooked: { SECOND: ['W0'] },
    });
    // Explicitly allowed, so SECOND is not held back for W0 and the two run
    // together — the board marks that rather than rescheduling around it.
    expect(b.rowsByJob.get('SECOND')!.start).toEqual(THU);
    expect(b.rowsByJob.get('FIRST')!.expectDate!.getTime()).toBeGreaterThan(
      b.rowsByJob.get('SECOND')!.start!.getTime(),
    );
  });

});

/**
 * Tight. An order picks up the shift the one before it left off, part-way
 * through a day if that is where it ended — the day plan gives a late start
 * only what is left of the shift, so nothing is over-booked and nothing waits.
 */
describe('one order against the next', () => {
  const link = (
    jobNum: string,
    parent: string,
    child: string,
  ): JobMaterialLink => ({
    jobNum: JobId(jobNum),
    parentPart: PartId(parent),
    childPart: PartId(child),
    requiredQty: 1,
  });

  it('starts a successor the moment its component is finished', () => {
    const cover = job('COVER1', 1.5, { partNum: PartId('COVER') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([cover, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'COVER'),
        link('COVER1', 'COVER', 'FABRIC'),
      ],
      // Different people, so only the component holds the chair back.
      crew: { COVER1: ['W0'], CHAIR1: ['W1'] },
    });
    const first = b.rowsByJob.get('COVER1')!;
    const next = b.rowsByJob.get('CHAIR1')!;

    // A day and a half ends at noon on the Friday, and the chair starts then —
    // not on the Monday, and not at midnight on the Friday either.
    expect(first.expectDate).toEqual(day(11, 12));
    expect(next.start).toEqual(first.expectDate);
  });

  it('gives that first day only what is left of its shift', () => {
    const cover = job('COVER1', 1.5, { partNum: PartId('COVER') });
    const chair = job('CHAIR1', 1, { partNum: PartId('CHAIR') });
    const b = board([cover, chair], {
      jobLinks: [
        link('CHAIR1', 'CHAIR', 'COVER'),
        link('COVER1', 'COVER', 'FABRIC'),
      ],
      crew: { COVER1: ['W0'], CHAIR1: ['W1'] },
    });
    const next = b.rowsByJob.get('CHAIR1')!;

    // Half of the Friday, then the rest on the Monday.
    expect(next.crewDays!.map((d) => [d.day, d.from, d.used])).toEqual([
      ['2026-09-11', 0.5, 0.5],
      ['2026-09-14', 0, 0.5],
    ]);
    expect(next.expectDate).toEqual(day(14, 12));
  });

  it('hands a crew straight on, with neither a gap nor a double shift', () => {
    // One person, two orders: the second starts where the first ended, and
    // the day they share is one shift between them.
    const b = board([job('A', 1.5), job('B', 1)], {
      crew: { A: ['W0'], B: ['W0'] },
    });
    const a = b.rowsByJob.get('A')!;
    const bRow = b.rowsByJob.get('B')!;

    expect(bRow.start).toEqual(a.expectDate);
    const friday = (row: (typeof a)) =>
      row.crewDays!.find((d) => d.day === '2026-09-11')!;
    expect(friday(a).used + friday(bRow).used).toBeCloseTo(1, 6);
  });
});
