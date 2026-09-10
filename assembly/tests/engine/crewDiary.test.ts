/**
 * What a person's other bookings do to the order in front of them.
 *
 * The board plans one order at a time and writes each crew member's days into
 * a shared diary as it goes. The question these ask is what the *next* order
 * is allowed to see of that diary.
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
import type { Job, PlanningDataset } from '@/domain/types';

const TABLE = LINES.find((l) => l.key === 'TABLE')!;

/** Thursday 10 Sep 2026. */
const THU = new Date(2026, 8, 10);

const worker = (id: string): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: ['TABLE'],
  onShift: true,
});

const job = (id: string, days: number, over: Partial<Job> = {}): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId('P1'),
  description: `order ${id}`,
  remainingQty: 10,
  qtyPerHr: null,
  laborHrs: days * PRODUCTIVE_HOURS_PER_PERSON,
  dueDate: new Date(2026, 8, 30),
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'final-assembly',
  line: TABLE.id,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const crewOf = (byJob: Record<string, string[]>): Record<string, CrewAssignment[]> =>
  Object.fromEntries(
    Object.entries(byJob).map(([jobId, ids]) => [
      jobId,
      ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null })),
    ]),
  );

function board(
  jobs: Job[],
  crew: Record<string, string[]>,
  orderStarts: Record<string, string> = {},
) {
  const workers = [...new Set(Object.values(crew).flat())].map(worker);
  const dataset: PlanningDataset = {
    workCenters: [
      {
        id: WorkCenterId(String(TABLE.id)),
        kind: 'area',
        name: 'TABLE',
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
    jobLinks: [],
    workers,
    fetchedAt: THU,
  };
  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers: { [String(TABLE.id)]: jobs.map((j) => j.id) },
    orderCrewAssignments: crewOf(crew),
    orderDoubleBooked: {},
    orderStarts,
    orderOvertime: {},
    progress: {},
    production: {},
    workers,
    today: THU,
  });
}

describe('a day already spoken for', () => {
  /*
   * The case from the floor: an order with two people on it and no finish
   * date, on a line whose crew were plainly not full. One booking on a later
   * day used to close the whole rest of the diary — the order got the days
   * before it and nothing after — so five days of work covered two and the
   * Expect Date went blank.
   */
  it('does not cost this order every day after it', () => {
    const b = board(
      // Pinned to the Monday, so it resolves first and books that day.
      [job('LATER', 1), job('BIG', 5)],
      { LATER: ['W0'], BIG: ['W0'] },
      { LATER: '2026-09-14' },
    );
    const big = b.rowsByJob.get('BIG')!;

    expect(b.rowsByJob.get('LATER')!.crewDays.map((d) => d.day)).toEqual(['2026-09-14']);
    // Thu, Fri, then over the booked Monday and on: five days of work, five
    // days of capacity, and a date the floor can be held to.
    expect(big.uncoveredHours).toBe(0);
    expect(big.expectDate).not.toBeNull();
    expect(big.crewDays.map((d) => d.day)).toEqual([
      '2026-09-10',
      '2026-09-11',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
    ]);
  });

  it('still refuses to split one person’s day between two orders', () => {
    // W0 gives LATER a fifth of the Monday. The rest of that day is not
    // offered to BIG: capacity is charged a day at a time, so a sliver of an
    // afternoon cannot be handed to a second order.
    const b = board(
      [job('LATER', 0.2), job('BIG', 2)],
      { LATER: ['W0'], BIG: ['W0'] },
      { LATER: '2026-09-14' },
    );
    expect(b.rowsByJob.get('BIG')!.crewDays.map((d) => d.day)).toEqual([
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('lets each of a pair work around their own bookings', () => {
    const b = board(
      [job('A', 1), job('B', 1), job('BIG', 4)],
      { A: ['W0'], B: ['W1'], BIG: ['W0', 'W1'] },
      { A: '2026-09-11', B: '2026-09-15' },
    );
    const big = b.rowsByJob.get('BIG')!;
    expect(big.uncoveredHours).toBe(0);
    // Thursday has both, Friday only W1 — W0 is on A — and Monday both again,
    // which finishes it. Neither booking costs the order the days beyond it.
    expect(big.crewDays.map((d) => d.workerIds.length)).toEqual([2, 1, 2]);
  });

  /*
   * The bounds the planner set by hand are a decision, not an inference, so
   * they still stop the order dead. This is the case the blank Expect Date is
   * *for*: work with nobody left to do it has no finish date, and saying so is
   * the point.
   */
  it('still reports work it genuinely cannot cover', () => {
    const b = board([job('BIG', 3)], { BIG: ['W0'] });
    expect(b.rowsByJob.get('BIG')!.uncoveredHours).toBe(0);

    const bounded = computeBounded();
    expect(bounded.uncoveredHours).toBeCloseTo(PRODUCTIVE_HOURS_PER_PERSON * 2, 6);
    expect(bounded.expectDate).toBeNull();
    expect(bounded.crewWithoutRoom).toEqual([]);
  });
});

/** The same order, with the planner holding W0 to the Thursday only. */
function computeBounded() {
  const jobs = [job('BIG', 3)];
  const workers = [worker('W0')];
  const dataset: PlanningDataset = {
    workCenters: [
      { id: WorkCenterId(String(TABLE.id)), kind: 'area', name: 'TABLE', department: 'assembly', sortIndex: 1 },
    ],
    jobs,
    routing: [],
    inventory: [],
    bom: [],
    po: [],
    demand: [],
    jobLinks: [],
    workers,
    fetchedAt: THU,
  };
  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers: { [String(TABLE.id)]: jobs.map((j) => j.id) },
    orderCrewAssignments: {
      BIG: [{ workerId: 'W0', fromDay: null, toDayExclusive: '2026-09-11' }],
    },
    orderDoubleBooked: {},
    orderStarts: {},
    orderOvertime: {},
    progress: {},
    production: {},
    workers,
    today: THU,
  }).rowsByJob.get('BIG')!;
}
