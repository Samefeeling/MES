/**
 * Stock before the order that makes more of it.
 *
 * The board used to hold a parent order behind whatever job was building its
 * component, whether or not the component was already in the racks — and,
 * where several batches of one part were open, behind the *last* of them. Both
 * are answered here: free stock is allocated first, and what is left of the
 * requirement waits for the earliest batch that can supply it.
 */

import { describe, it, expect } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
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
} from '@/domain/types';

const LANE = LINES.find((l) => l.key === 'ASSY')!;

/** Thursday 10 Sep 2026 — two working days before the weekend. */
const THU = new Date(2026, 8, 10);
const day = (n: number, hour = 0) => new Date(2026, 8, n, hour);
const opens = (n: number) => new Date(2026, 8, n, 7);

const worker = (id: string): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: ['ASSY'],
  onShift: true,
});

/** An order needing exactly `days` of work from one person. */
const job = (
  id: string,
  part: string,
  days: number,
  over: Partial<Job> = {},
): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId(part),
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
  line: LANE.id,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const link = (
  jobNum: string,
  parent: string,
  child: string,
  requiredQty: number | null,
): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId(parent),
  childPart: PartId(child),
  requiredQty,
  childDescription: child,
  uom: 'EA',
});

const stock = (part: string, freeOnHand: number): InventoryItem => ({
  partNum: PartId(part),
  description: part,
  typeCode: null,
  onHand: freeOnHand,
  cmplWip: 0,
  supply: 0,
  demand: 0,
  calculatedDemand: null,
  freeOnHand,
});

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
    links?: JobMaterialLink[];
    inventory?: InventoryItem[];
    placed?: string[];
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
    po: [],
    demand: [],
    jobLinks: over.links ?? [],
    workers,
    fetchedAt: THU,
  };
  const onLine = over.placed ?? jobs.map((j) => String(j.id));

  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers: {
      [String(LANE.id)]: jobs
        .filter((j) => onLine.includes(String(j.id)))
        .map((j) => j.id),
    },
    // One person each, so a bar is exactly as long as the order's days.
    orderCrewAssignments: crewOf(
      Object.fromEntries(jobs.map((j, i) => [String(j.id), [`W${i}`]])),
    ),
    orderDoubleBooked: {},
    orderStarts: {},
    orderOvertime: {},
    progress: {},
    production: {},
    workers,
    today: THU,
  });
}

/** The chair, the cover order it consumes, and the link between them. */
const chairAndCover = (coverDays = 5) => ({
  jobs: [job('ASM1', 'CHAIR', 2), job('UPL1', 'COVER', coverDays)],
  links: [link('ASM1', 'CHAIR', 'COVER', 10)],
});

describe('stock is allocated before an order waits for one', () => {
  it('holds the parent behind the component order when nothing is in stock', () => {
    const { jobs, links } = chairAndCover();
    const b = board(jobs, { links });
    const chair = b.rowsByJob.get('ASM1')!;
    const cover = b.rowsByJob.get('UPL1')!;

    expect(chair.start!.getTime()).toBeGreaterThanOrEqual(
      cover.expectDate!.getTime(),
    );
    expect(String(chair.waitingOn?.onJobId)).toBe('UPL1');
  });

  it('lets it start at once when the shelf covers the whole requirement', () => {
    const { jobs, links } = chairAndCover();
    const b = board(jobs, { links, inventory: [stock('COVER', 10)] });
    const chair = b.rowsByJob.get('ASM1')!;

    expect(chair.start).toEqual(opens(10));
    expect(chair.waitingOn).toBeNull();
  });

  it('matches the part however the two exports spell it', () => {
    const b = board([job('ASM1', 'CHAIR', 2), job('UPL1', 'cover', 5)], {
      links: [link('ASM1', 'CHAIR', 'Cover', 10)],
      inventory: [stock('COVER', 10)],
    });

    expect(b.rowsByJob.get('ASM1')!.start).toEqual(opens(10));
  });

  it('still waits when the shelf holds less than the order needs', () => {
    const { jobs, links } = chairAndCover();
    const short = board(jobs, { links, inventory: [stock('COVER', 4)] });
    const none = board(jobs, { links });

    expect(short.rowsByJob.get('ASM1')!.waitingOn).not.toBeNull();
    // Four of the ten it needs buys 0.4 of a two-day run — nearly a day of
    // head start on the same component date, not a free pass.
    expect(short.rowsByJob.get('ASM1')!.start!.getTime()).toBeLessThan(
      none.rowsByJob.get('ASM1')!.start!.getTime(),
    );
  });

  it('pulls the start back by the work the stock supports', () => {
    const { jobs, links } = chairAndCover();
    const half = board(jobs, { links, inventory: [stock('COVER', 5)] });
    const none = board(jobs, { links });
    const chair = half.rowsByJob.get('ASM1')!;

    // Half of a two-day run is one working day before the covers land.
    const gapMs =
      none.rowsByJob.get('ASM1')!.start!.getTime() - chair.start!.getTime();
    expect(gapMs).toBe(24 * 60 * 60 * 1000);
  });

  it('gives the stock to the order that needs it first, not to both', () => {
    const b = board(
      [
        job('ASM1', 'CHAIR', 2, { dueDate: day(18) }),
        job('ASM2', 'CHAIR', 2, { dueDate: day(25) }),
        job('UPL1', 'COVER', 5),
      ],
      {
        links: [
          link('ASM1', 'CHAIR', 'COVER', 10),
          link('ASM2', 'CHAIR', 'COVER', 10),
        ],
        // Ten covers: enough for one of the two orders, not for both.
        inventory: [stock('COVER', 10)],
      },
    );

    expect(b.rowsByJob.get('ASM1')!.waitingOn).toBeNull();
    expect(String(b.rowsByJob.get('ASM2')!.waitingOn?.onJobId)).toBe('UPL1');
  });

  it('cannot net a material row the export gave no quantity', () => {
    const b = board([job('ASM1', 'CHAIR', 2), job('UPL1', 'COVER', 5)], {
      links: [link('ASM1', 'CHAIR', 'COVER', null)],
      inventory: [stock('COVER', 999)],
    });

    // A missing quantity column is not evidence that the shelf covers it.
    expect(b.rowsByJob.get('ASM1')!.waitingOn).not.toBeNull();
  });

  it('keeps waiting for a second component the shelf does not cover', () => {
    const b = board(
      [job('ASM1', 'CHAIR', 2), job('UPL1', 'COVER', 5), job('UPL2', 'FOAM', 5)],
      {
        links: [
          link('ASM1', 'CHAIR', 'COVER', 10),
          link('ASM1', 'CHAIR', 'FOAM', 10),
        ],
        inventory: [stock('COVER', 10)],
      },
    );

    expect(String(b.rowsByJob.get('ASM1')!.waitingOn?.onJobId)).toBe('UPL2');
  });
});

describe('several open batches of one part are alternatives', () => {
  it('waits for the first batch to finish, not the last', () => {
    const b = board(
      [
        job('ASM1', 'CHAIR', 2),
        job('UPL1', 'COVER', 1, { dueDate: day(12) }),
        job('UPL2', 'COVER', 5, { dueDate: day(20) }),
      ],
      { links: [link('ASM1', 'CHAIR', 'COVER', 10)] },
    );
    const chair = b.rowsByJob.get('ASM1')!;
    const first = b.rowsByJob.get('UPL1')!;
    const last = b.rowsByJob.get('UPL2')!;

    expect(chair.start!.getTime()).toBeGreaterThanOrEqual(
      first.expectDate!.getTime(),
    );
    expect(chair.start!.getTime()).toBeLessThan(last.expectDate!.getTime());
    expect(String(chair.waitingOn?.onJobId)).toBe('UPL1');
  });

  it('takes a dated batch over one nobody has put on a line', () => {
    const b = board(
      [
        job('ASM1', 'CHAIR', 2),
        job('UPL1', 'COVER', 1),
        job('UPL2', 'COVER', 5),
      ],
      {
        links: [link('ASM1', 'CHAIR', 'COVER', 10)],
        // UPL2 is open but unplanned: it has no date to wait for, and the
        // board should use the batch that has one rather than stall.
        placed: ['ASM1', 'UPL1'],
      },
    );
    const chair = b.rowsByJob.get('ASM1')!;

    expect(chair.start).not.toBeNull();
    expect(String(chair.waitingOn?.onJobId)).toBe('UPL1');
  });

  it('still stalls when no batch of the part has been planned at all', () => {
    const b = board(
      [job('ASM1', 'CHAIR', 2), job('UPL1', 'COVER', 1)],
      {
        links: [link('ASM1', 'CHAIR', 'COVER', 10)],
        placed: ['ASM1'],
      },
    );

    expect(b.rowsByJob.get('ASM1')!.start).toBeNull();
    expect(String(b.rowsByJob.get('ASM1')!.waitingOn?.onJobId)).toBe('UPL1');
  });
});
