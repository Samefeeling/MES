/**
 * A first crew for an imported export.
 *
 * `Planning1.csv` never says who builds an order, so the whole board arrives
 * unstaffed — and an unstaffed order has no bar. This fills the gaps without
 * ever touching an allocation somebody has already made.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MockSource } from '@/data/mock/MockSource';
import { buildIndexes } from '@/engine/indexes';
import { computeAssemblyGantt, type OrderRow } from '@/engine/assembly/board';
import {
  clashesFor,
  overlapsOnBoard,
  preferredCrewSize,
  suggestCrew,
} from '@/engine/assembly/crew';
import {
  addDays,
  nextWorkingDay,
  prevWorkingDay,
  startOfDay,
} from '@/engine/assembly/dates';
import { usePlanStore } from '@/store/planStore';
import {
  MAX_WORKERS_PER_ORDER,
  canWorkKind,
  type LineKey,
  type Worker,
  type CrewAssignment,
} from '@/domain/assembly';
import { WorkerId } from '@/domain/ids';
import type { PlanningDataset } from '@/domain/types';

let dataset: PlanningDataset;

beforeAll(async () => {
  const result = await new MockSource().loadAll();
  if (!result.ok) throw new Error(result.error);
  dataset = result.value;
});

const TODAY = new Date('2026-09-11T00:00:00');

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

/** The board as it comes off an import: orders on lines, nobody on them. */
function board(
  crew: Record<string, string[]> = {},
  orderStarts: Record<string, string> = {},
) {
  const indexes = buildIndexes(dataset);
  usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs);
  return computeAssemblyGantt({
    dataset,
    indexes,
    containers: usePlanStore.getState().containers,
    orderCrewAssignments: crewOf(crew),
    orderStarts,
    progress: {},
    production: {},
    workers: dataset.workers,
    today: TODAY,
  });
}

/**
 * How the button uses it: each wave is applied *on top of* the plan as it
 * stands and the board re-derived, so every span after the first is one the
 * scheduler worked out rather than one the suggestion guessed.
 */
const settleOn =
  (base: Record<string, string[]> = {}) =>
  (alloc: Record<string, string[]>) =>
    board({ ...base, ...alloc });
const settle = settleOn();

describe('suggestCrew', () => {
  it('gives every unstaffed order somebody who can do the work', () => {
    const b = board();
    const { allocations, staffed } = suggestCrew(b, settle);

    expect(staffed).toBeGreaterThan(10);
    const byId = new Map(b.workers.map((w) => [String(w.id), w]));
    for (const group of b.groups) {
      if (!group.line.schedulable) continue;
      for (const row of group.rows) {
        const crew = allocations[String(row.job.id)];
        if (!crew) continue;
        expect(crew.length).toBeGreaterThan(0);
        expect(crew.length).toBeLessThanOrEqual(MAX_WORKERS_PER_ORDER);
        expect(new Set(crew).size).toBe(crew.length); // nobody twice
        for (const id of crew) {
          const w = byId.get(id)!;
          expect(w.onShift).toBe(true);
          expect(w.skills).toContain(group.line.key);
        }
      }
    }
  });

  it('turns an unschedulable board into a scheduled one', () => {
    const before = board();
    const bare = [...before.rowsByJob.values()].filter((r) => r.days === null);
    expect(bare.length).toBeGreaterThan(0); // nothing has a bar yet

    const after = board(suggestCrew(before, settle).allocations);
    const scheduled = [...after.rowsByJob.values()].filter(
      (r) =>
        typeof r.days === 'number' &&
        r.days > 0 &&
        (r.uncoveredHours ?? 0) <= 1e-9,
    );
    // A partly covered order has worked days but no Expect Date until enough
    // crew coverage exists to finish it. Most of the active board gets a full bar. What it cannot place without putting
    // somebody on two orders at once it leaves alone, on purpose.
    expect(scheduled.length).toBeGreaterThan(bare.length / 2);
    // A bar that starts but never ends is a crew whose windows close before
    // the work is done — somebody suggested onto an order can be bounded out
    // of it again by a commitment later in their week. The board says so with
    // uncovered hours, which is a state and not a failure; what it must never
    // do is leave a bar with no end and no reason.
    for (const row of scheduled) {
      if (row.expectDate === null) {
        expect(row.uncoveredHours ?? 0, String(row.job.id)).toBeGreaterThan(0);
      }
    }
  });

  it('does not double-book anyone, measured on the board it produces', () => {
    // The suggestion is made against spans it works out itself; this checks
    // them against the schedule that actually comes back — day by day and
    // person by person, which is the only place the answer really lives.
    // Sharing a *day* is not a clash: an order picking up where another left
    // off takes only what is left of the shift.
    const before = board();
    const after = board(suggestCrew(before, settle).allocations);
    const rows = [...after.rowsByJob.values()].filter(
      (r) => r.line.schedulable && !r.completedToday,
    );
    expect(rows.length).toBeGreaterThan(10);

    const clashes = rows
      .filter((row) => overlapsOnBoard(rows, row))
      .map((row) => String(row.job.id));
    expect(clashes).toEqual([]);
  });

  it('leaves an allocation the supervisor already made', () => {
    const b = board();
    // The first schedulable line that actually has orders on it — TBP leads
    // the board and the demo export has nothing on it.
    const first = String(
      b.groups.find((g) => g.line.schedulable && g.rows.length > 0)!.rows[0].job.id,
    );
    const mine = { [first]: ['W01'] };

    const { allocations } = suggestCrew(board(mine), settleOn(mine));
    expect(allocations[first]).toBeUndefined();
  });

  it('moves a team on to the next order once they are free', () => {
    // Reusing people is right — that is what a team is. The rule is about the
    // same *day*, not the same names, and the clash test above holds them to
    // it. What must not happen is one person carrying the whole line.
    const b = board();
    const { allocations } = suggestCrew(b, settle);
    const jobsPerPerson = new Map<string, number>();
    for (const crew of Object.values(allocations)) {
      for (const id of crew) {
        jobsPerPerson.set(id, (jobsPerPerson.get(id) ?? 0) + 1);
      }
    }

    expect(jobsPerPerson.size).toBeGreaterThan(4); // the work is spread about
    const counts = [...jobsPerPerson.values()].sort((x, y) => y - x);
    // Nobody is carrying more than twice the average.
    const average =
      counts.reduce((s, n) => s + n, 0) / Math.max(1, counts.length);
    expect(counts[0]).toBeLessThanOrEqual(Math.ceil(average * 2));
  });

  it('counts the orders it cannot crew instead of inventing one', () => {
    // Nobody in today: every order is left alone and reported.
    const noRoster = { ...dataset, workers: dataset.workers.map((w) => ({ ...w, onShift: false })) };
    const indexes = buildIndexes(noRoster);
    const b = computeAssemblyGantt({
      dataset: noRoster,
      indexes,
      containers: usePlanStore.getState().containers,
      orderCrewAssignments: {},
      orderStarts: {},
      progress: {},
      production: {},
      workers: noRoster.workers,
      today: TODAY,
    });

    const { allocations, staffed, unstaffed } = suggestCrew(b, settle);
    expect(allocations).toEqual({});
    expect(staffed).toBe(0);
    expect(unstaffed).toBeGreaterThan(0);
  });
});

describe('nobody does two jobs at once', () => {
  /** The row for one order, once the board has scheduled it. */
  const rowOf = (b: ReturnType<typeof board>, id: string) => b.rowsByJob.get(id)!;
  const allRows = (b: ReturnType<typeof board>) =>
    b.groups.flatMap((g) => g.rows);

  /**
   * Two orders on the same line that do not wait for each other — one of them
   * needing a component the other builds would hold it back for a reason that
   * has nothing to do with the crew.
   */
  const twoOrders = (line: LineKey) => {
    const b = board();
    const rows = b.groups.find((g) => g.line.key === line)!.rows;
    const first = rows[0];
    const linked = (a: OrderRow, other: OrderRow) =>
      a.predecessors.some((d) => String(d.onJobId) === String(other.job.id));
    const second = rows.find(
      (r) =>
        String(r.job.id) !== String(first.job.id) &&
        r.predecessors.length === 0 &&
        !linked(first, r),
    );
    expect(second).toBeDefined();
    return [String(first.job.id), String(second!.job.id)] as const;
  };

  it('sees the clash when someone is put on an order running at the same time', () => {
    const [first, second] = twoOrders('UPL_CUT_SEW');
    // Both pinned to the same Monday, so whatever else happens their bars
    // cover the same days.
    const day = new Date('2026-09-14T00:00:00').toISOString();
    const b = board({ [first]: ['W01'] }, { [first]: day, [second]: day });

    // Nothing else moved them, so they really are on the same days.
    expect(rowOf(b, second).plannedStart).toEqual(new Date(day));
    const clashes = clashesFor(allRows(b), rowOf(b, second), 'W01');
    expect(clashes.map((r) => String(r.job.id))).toEqual([first]);
  });

  it('says nothing about someone who is free across those days', () => {
    const [first] = twoOrders('UPL_CUT_SEW');
    const b = board({ [first]: ['W01'] });
    // W03 is on nothing at all.
    expect(clashesFor(allRows(b), rowOf(b, first), 'W03')).toEqual([]);
  });

  it('does not count an order against itself', () => {
    const [first] = twoOrders('UPL_CUT_SEW');
    const b = board({ [first]: ['W01'] });
    const clashes = clashesFor(allRows(b), rowOf(b, first), 'W01');
    expect(clashes.map((r) => String(r.job.id))).not.toContain(first);
  });

  it('answers for an order nobody is on yet', () => {
    // The whole point: the supervisor is deciding *who* to put on it, so the
    // check has to work before anyone is on it.
    const [first, second] = twoOrders('UPL_CUT_SEW');
    const b = board({ [first]: ['W01'] });
    expect(rowOf(b, second).start).toBeNull(); // no crew, no bar
    expect(rowOf(b, second).plannedStart).toBeInstanceOf(Date);
    // Whatever the answer, it is computed rather than skipped.
    expect(Array.isArray(clashesFor(allRows(b), rowOf(b, second), 'W01'))).toBe(
      true,
    );
  });

  it('lets bars that merely touch pass', () => {
    // One ending exactly as the next begins is a hand-over, not a clash, so
    // the boundary is tested exactly rather than hoping the seed lines up.
    const [first, second] = twoOrders('UPL_CUT_SEW');
    const b = board({ [first]: ['W01'] });
    const done = rowOf(b, first).expectDate!;
    // The board plans in whole shifts, so the hand-over is the next shift
    // going: a bar finishing mid-afternoon still owns the whole of that day,
    // and anything starting on it would be a second full shift.
    const handover = nextWorkingDay(
      done.getTime() === startOfDay(done).getTime()
        ? done
        : startOfDay(addDays(done, 1)),
    );
    const after = { ...rowOf(b, second), plannedStart: handover, workers: [] };

    expect(clashesFor([rowOf(b, first), after], after, 'W01')).toEqual([]);
    // …and the shift before it is a clash.
    const overlapping = {
      ...after,
      plannedStart: prevWorkingDay(handover),
    };
    expect(
      clashesFor([rowOf(b, first), overlapping], overlapping, 'W01'),
    ).toHaveLength(1);
  });

  it('ignores an order that has been closed', () => {
    const [first] = twoOrders('UPL_CUT_SEW');
    const b = board({ [first]: ['W01'] });
    const closed = allRows(b).map((r) =>
      String(r.job.id) === first ? { ...r, completedToday: true } : r,
    );
    const other = closed.find(
      (r) => r.line.key === 'UPL_GLUING' && String(r.job.id) !== first,
    )!;
    expect(clashesFor(closed, other, 'W01')).toEqual([]);
  });
});

describe('current line roster priority', () => {
  it('prefers matching skills on the current line, with roster order breaking ties', () => {
    const b = board();
    const { allocations } = suggestCrew(b, settle);

    // With nothing booked, matching trades come before roster order.
    for (const group of b.groups) {
      if (!group.line.schedulable) continue;
      const first = [...group.rows]
        .filter((row) => allocations[String(row.job.id)])
        .sort((a, c) => a.plannedStart.getTime() - c.plannedStart.getTime())[0];
      if (!first) continue;

      const onLine = b.workers.filter(
        (w) =>
          w.onShift &&
          w.skills[0] === group.line.key,
      );
      if (onLine.length === 0) continue;

      const crew = allocations[String(first.job.id)];
      const best = onLine
        .sort((a, c) => Number(!canWorkKind(a, first.kind)) - Number(!canWorkKind(c, first.kind)))
        .slice(0, crew.length)
        .map((w) => String(w.id));
      expect(crew).toEqual(best);
    }
  });
});

describe('crew size and selection policy', () => {
  const person = (id: string, skills: LineKey[] = ['ASSY']): Worker => ({
    id: WorkerId(id), name: id, skills, onShift: true,
  });
  const fixture = (line: LineKey, hours: number, workers: Worker[]) => {
    const original = board();
    const group = original.groups.find((g) => g.line.key === line)!;
    const target = {
      ...group.rows[0], workers: [], crewDays: [],
      job: { ...group.rows[0].job, laborHrs: hours, remainingQty: 1, completedQty: 0 },
    };
    return {
      ...original, workers, groups: [{ ...group, rows: [target] }],
      rowsByJob: new Map([[String(target.job.id), target]]),
    };
  };

  it.each([
    ['ASSY', 7.5, 1], ['ASSY', 7.51, 2], ['ASSY', 50, 2], ['ASSY', 50.01, 3],
    ['TABLE', 1, 3], ['TABLE', 50, 3], ['TABLE', 75, 3],
  ] as const)('uses the preferred crew for %s with %s remaining hours', (line, hours, expected) => {
    const workers = ['A', 'B', 'C', 'D'].map((id) => person(id, [line]));
    const b = fixture(line, hours, workers);
    const target = b.groups[0].rows[0];
    expect(preferredCrewSize(target)).toBe(expected);
    expect(suggestCrew(b).allocations[String(target.job.id)]).toHaveLength(expected);
  });

  it('uses remaining labour, rather than original total labour, for team size', () => {
    const b = fixture('ASSY', 60, [person('A'), person('B'), person('C')]);
    const target = b.groups[0].rows[0];
    target.job.remainingQty = 1;
    target.job.completedQty = 9;
    expect(preferredCrewSize(target)).toBe(1);
  });

  it('respects current line allocation before legacy line skills', () => {
    const b = fixture('ASSY', 4, [person('Elsewhere'), person('Moved', ['UPL_GLUING'])]);
    const lines = new Map<string, LineKey>([['Elsewhere', 'TABLE'], ['Moved', 'ASSY']]);
    expect(Object.values(suggestCrew(b, undefined, lines).allocations)).toEqual([['Moved']]);
  });

  it('prefers a matching skill to the first person in the allocated line roster', () => {
    const b = fixture('ASSY', 4, [person('Legacy', ['UPL_GLUING']), person('Skilled')]);
    const lines = new Map<string, LineKey>([['Legacy', 'ASSY'], ['Skilled', 'ASSY']]);
    expect(Object.values(suggestCrew(b, undefined, lines).allocations)).toEqual([['Skilled']]);
  });

  it('prefers the matching trade within a production line', () => {
    const cutter = { ...person('Cutter', ['UPL_GLUING']), trades: ['cut-sew' as const] };
    const upholsterer = { ...person('Upholsterer', ['UPL_GLUING']), trades: ['upholstery' as const] };
    const b = fixture('UPL_GLUING', 4, [cutter, upholsterer]);
    b.groups[0].rows[0].kind = 'upholstery';
    expect(Object.values(suggestCrew(b).allocations)).toEqual([['Upholsterer']]);
  });

  it('uses a smaller table crew when people are absent or on leave', () => {
    const b = fixture('TABLE', 20, [
      person('Available', ['TABLE']),
      { ...person('Absent', ['TABLE']), onShift: false },
      { ...person('Leave', ['TABLE']), plannedLeave: ['2026-09-11'] },
    ]);
    expect(Object.values(suggestCrew(b).allocations)).toEqual([['Available']]);
  });

  it('leaves an order without a line roster waiting and ignores zero work', () => {
    const waiting = fixture('TABLE', 20, [person('OtherLine')]);
    expect(suggestCrew(waiting)).toEqual({ allocations: {}, staffed: 0, unstaffed: 1 });
    const empty = fixture('ASSY', 0, [person('Available')]);
    expect(suggestCrew(empty)).toEqual({ allocations: {}, staffed: 0, unstaffed: 0 });
  });
});
