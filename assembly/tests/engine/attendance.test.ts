/**
 * Somebody not being at work, and what the board does about it.
 *
 * Before this, absence was a fact about the roster and nothing else: the name
 * left the line strip and the "11 of 14" ratio, and the two orders that person
 * was half-way through carried on exactly as if they were standing at them.
 * These fix the other behaviour — the schedule stops planning hours nobody is
 * going to work, and it does so without taking anybody off an order.
 */

import { describe, it, expect } from 'vitest';
import {
  awayOnDay,
  awayWorkers,
  isAwayOn,
  withAbsence,
} from '@/engine/assembly/attendance';
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
const THU_KEY = '2026-09-10';
const FRI_KEY = '2026-09-11';

const worker = (id: string, over: Partial<Worker> = {}): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: ['TABLE'],
  onShift: true,
  ...over,
});

describe('who is not in', () => {
  it('reads a board mark, planned leave and the roster flag as one answer', () => {
    const marked = worker('W0');
    const leave = worker('W1', { plannedLeave: [FRI_KEY] });
    const off = worker('W2', { onShift: false });
    const absence = { W0: [THU_KEY] };

    expect(isAwayOn(marked, THU_KEY, absence, THU_KEY)).toBe(true);
    expect(isAwayOn(marked, FRI_KEY, absence, THU_KEY)).toBe(false);
    expect(isAwayOn(leave, FRI_KEY, absence, THU_KEY)).toBe(true);
    expect(isAwayOn(off, THU_KEY, absence, THU_KEY)).toBe(true);
  });

  it('never reads the roster flag as an answer about another day', () => {
    // `onShift` is what the list said this morning and carries no history.
    // Striking somebody off next Friday for it would take a week of capacity
    // off the board on the strength of one day's attendance.
    const off = worker('W2', { onShift: false });
    expect(isAwayOn(off, FRI_KEY, {}, THU_KEY)).toBe(false);
  });

  it('does not decide for somebody the roster has never heard of', () => {
    // A crew can carry an id the current export no longer lists. Guessing that
    // they are absent would stop an order for a reason nobody can see.
    const away = awayOnDay([worker('W0')], { GHOST: [THU_KEY] }, THU);
    expect(away('GHOST', THU_KEY)).toBe(false);
    expect(away('W0', THU_KEY)).toBe(false);
  });

  it('lists the day\'s absentees in roster order', () => {
    const roster = [worker('W0'), worker('W1'), worker('W2', { onShift: false })];
    expect(
      awayWorkers(roster, { W1: [THU_KEY] }, THU).map((w) => w.name),
    ).toEqual(['W1', 'W2']);
  });
});

describe('marking somebody off', () => {
  it('adds and removes one day without touching the others', () => {
    const one = withAbsence({}, 'W0', THU_KEY, true, '2026-09-01');
    expect(one).toEqual({ W0: [THU_KEY] });
    const two = withAbsence(one, 'W0', FRI_KEY, true, '2026-09-01');
    expect(two.W0).toEqual([THU_KEY, FRI_KEY]);
    expect(withAbsence(two, 'W0', THU_KEY, false, '2026-09-01').W0).toEqual([
      FRI_KEY,
    ]);
  });

  it('marking the same day twice does not record it twice', () => {
    const once = withAbsence({}, 'W0', THU_KEY, true, '2026-09-01');
    expect(withAbsence(once, 'W0', THU_KEY, true, '2026-09-01').W0).toEqual([
      THU_KEY,
    ]);
  });

  it('forgets days older than the plan keeps, and empty people with them', () => {
    const old = { W0: ['2026-08-01'], W1: ['2026-08-01', THU_KEY] };
    const kept = withAbsence(old, 'W2', FRI_KEY, true, '2026-09-01');
    expect(kept.W0).toBeUndefined();
    expect(kept.W1).toEqual([THU_KEY]);
    expect(kept.W2).toEqual([FRI_KEY]);
  });
});

// ---------------------------------------------------------------------------
// What it costs the schedule
// ---------------------------------------------------------------------------

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
  crew: Record<string, string[]>,
  workerAbsence: Record<string, string[]> = {},
  orderStarts: Record<string, string> = {},
  roster: Worker[] = [...new Set(Object.values(crew).flat())].map((id) =>
    worker(id),
  ),
  orderDoubleBooked: Record<string, string[]> = {},
) {
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
    workers: roster,
    fetchedAt: THU,
  };
  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers: { [String(TABLE.id)]: jobs.map((j) => j.id) },
    orderCrewAssignments: crewOf(crew),
    orderDoubleBooked,
    orderStarts,
    orderOvertime: {},
    progress: {},
    production: {},
    workers: roster,
    workerAbsence,
    today: THU,
  });
}

describe('an order somebody is away from', () => {
  it('runs on the hands that are actually there, and takes longer for it', () => {
    const together = board([job('J1', 2)], { J1: ['W0', 'W1'] });
    const short = board([job('J1', 2)], { J1: ['W0', 'W1'] }, { W1: [THU_KEY] });

    // Two people, two days' work: one day each. Today one of them is at home,
    // so today is a one-person day and the order runs into a third.
    expect(together.rowsByJob.get('J1')!.crewDays[0].workerIds).toEqual([
      'W0',
      'W1',
    ]);
    const days = short.rowsByJob.get('J1')!.crewDays;
    expect(days[0].day).toBe(THU_KEY);
    expect(days[0].workerIds).toEqual(['W0']);
    expect(days.length).toBeGreaterThan(together.rowsByJob.get('J1')!.crewDays.length);
  });

  it('keeps them on the order — a day off is not a hand-over', () => {
    const b = board([job('J1', 2)], { J1: ['W0', 'W1'] }, { W1: [THU_KEY] });
    const row = b.rowsByJob.get('J1')!;

    expect(row.workers.map((w) => w.name)).toEqual(['W0', 'W1']);
    expect(row.crewAssignments?.map((a) => a.workerId)).toEqual(['W0', 'W1']);
    // And the row says which of the names is not behind the work today.
    expect(row.crewAwayToday?.map((w) => w.name)).toEqual(['W1']);
  });

  it('leaves the day empty when the only person on it is away', () => {
    const b = board([job('J1', 2)], { J1: ['W0'] }, { W0: [THU_KEY] });
    const row = b.rowsByJob.get('J1')!;

    expect(row.crewDays.some((day) => day.day === THU_KEY)).toBe(false);
    expect(row.crewDays[0].day).toBe(FRI_KEY);
    // Not "unstaffed": the order still has its crew, they are simply not in.
    expect(row.workers).toHaveLength(1);
    expect(row.crewAwayToday).toHaveLength(1);
  });

  it('applies to a bar the planner pinned, which consults no diary', () => {
    // A dragged start is a decision about when the order runs. It is not a
    // claim that the people on it are at work, so absence still counts.
    const b = board(
      [job('J1', 2)],
      { J1: ['W0'] },
      { W0: [THU_KEY] },
      { J1: THU_KEY },
    );
    expect(
      b.rowsByJob.get('J1')!.crewDays.some((day) => day.day === THU_KEY),
    ).toBe(false);
  });

  it('outranks an approval to work two orders at once', () => {
    // Agreeing that somebody may split their day between two orders says
    // nothing at all about a day they are not at work. The approval exempts
    // them from the diary; it does not put them in the building.
    const b = board(
      [job('J1', 1)],
      { J1: ['W0'] },
      { W0: [THU_KEY] },
      {},
      [worker('W0')],
      { J1: ['W0'] },
    );
    expect(
      b.rowsByJob.get('J1')!.crewDays.some((d) => d.day === THU_KEY),
    ).toBe(false);
  });

  it('reads annual leave off the roster without anybody marking it', () => {
    const roster = [worker('W0', { plannedLeave: [THU_KEY] })];
    const b = board([job('J1', 2)], { J1: ['W0'] }, {}, {}, roster);
    expect(
      b.rowsByJob.get('J1')!.crewDays.some((day) => day.day === THU_KEY),
    ).toBe(false);
  });

  it('carries the absence it was built with on the view', () => {
    const b = board([job('J1', 1)], { J1: ['W0'] }, { W0: [THU_KEY] });
    expect(b.workerAbsence).toEqual({ W0: [THU_KEY] });
  });
});
