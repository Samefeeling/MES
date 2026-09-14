/**
 * End-to-end assembly Gantt over the real seed data: orders group under their
 * line, crew size drives bar length and Expect Date, booking output pulls the
 * Expect Date in, and predecessors push successors out.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MockSource } from '@/data/mock/MockSource';
import { buildIndexes } from '@/engine/indexes';
import { computeAssemblyGantt, type OrderRow } from '@/engine/assembly/board';
import { workerLoad } from '@/engine/assembly/workload';
import { remainingHours } from '@/engine/assembly/duration';
import { POOL_ID, usePlanStore } from '@/store/planStore';
import {
  DEFAULT_HORIZON_DAYS,
  LINES,
  canWorkKind,
  type CrewAssignment,
} from '@/domain/assembly';
import { overlapsOnBoard, suggestCrew } from '@/engine/assembly/crew';
import { addDays } from '@/engine/assembly/dates';
import { shiftOpensOn } from '@/engine/assembly/shift';
import { activeWorkerIdsOnDay } from '@/features/assembly/boardView';
import type { PlanningDataset } from '@/domain/types';
import type {
  ActualStartRecord,
  ProductionEntry,
  ProgressBaseline,
} from '@/store/planStore';

let dataset: PlanningDataset;

beforeAll(async () => {
  const result = await new MockSource().loadAll();
  if (!result.ok) throw new Error(result.error);
  dataset = result.value;
});

const TODAY = new Date('2026-09-11T00:00:00');

/** Whole-order allocations, the shape most of these cases want. */
const crewOf = (
  byJob: Record<string, string[]>,
): Record<string, CrewAssignment[]> =>
  Object.fromEntries(
    Object.entries(byJob).map(([jobId, ids]) => [
      jobId,
      ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null })),
    ]),
  );

function build(over: {
  orderCrewAssignments?: Record<string, CrewAssignment[]>;
  orderStarts?: Record<string, string>;
  orderActualStarts?: Record<string, ActualStartRecord>;
  progress?: Record<string, { date: string; qty: number }[]>;
  progressBaselines?: Record<string, ProgressBaseline>;
  production?: Record<string, ProductionEntry[]>;
} = {}) {
  const indexes = buildIndexes(dataset);
  usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs);
  const state = usePlanStore.getState();
  return computeAssemblyGantt({
    dataset,
    indexes,
    containers: state.containers,
    orderCrewAssignments:
      over.orderCrewAssignments ?? state.orderCrewAssignments,
    orderStarts: over.orderStarts ?? {},
    orderActualStarts: over.orderActualStarts ?? {},
    progress: over.progress ?? {},
    progressBaselines: over.progressBaselines ?? {},
    production: over.production ?? {},
    workers: dataset.workers,
    today: TODAY,
  });
}

describe('assembly Gantt (mock data)', () => {
  it('loads a roster and shows every line group in the floor’s order', () => {
    const b = build();
    expect(dataset.workers.length).toBeGreaterThan(10);
    expect(b.groups.map((g) => g.line.key)).toEqual(
      LINES.map((l) => l.key),
    );
    // PMD is context only — it mirrors moulding's plan and is scheduled there.
    expect(b.groups.find((g) => g.line.key === 'PMD')!.line.schedulable).toBe(false);
  });

  it('puts every assembly order on a schedulable line or in the pool', () => {
    const b = build();
    const scheduled = b.groups
      .filter((g) => g.line.schedulable)
      .flatMap((g) => g.rows);
    const assemblyJobs = dataset.jobs.filter((j) => j.department === 'assembly');
    expect(assemblyJobs.length).toBeGreaterThan(10);
    expect(scheduled.length + b.pool.length).toBe(assemblyJobs.length);
    for (const g of b.groups) {
      if (!g.line.schedulable) continue;
      for (const r of g.rows) {
        expect(r.job.department).toBe('assembly');
        expect(String(r.line.id)).toBe(String(g.line.id));
      }
    }
  });

  it('only ever allocates at most four people to an order', () => {
    const b = build();
    for (const g of b.groups) {
      for (const r of g.rows) expect(r.workers.length).toBeLessThanOrEqual(4);
    }
  });

  it('shortens the bar and pulls in Expect Date when people are added', () => {
    const base = build();
    const row = base.groups
      .flatMap((g) => g.rows)
      .find((r) => r.line.schedulable && r.workers.length === 1);
    expect(row).toBeDefined();
    const id = String(row!.job.id);

    const more = build({
      orderCrewAssignments: {
        ...usePlanStore.getState().orderCrewAssignments,
        ...crewOf({ [id]: ['W01', 'W03', 'W12'] }),
      },
    });
    const after = more.rowsByJob.get(id)!;

    // Measured across the bar's own span, not against the calendar: people
    // already on other orders bring their commitments with them, so putting
    // them on this one can start it later even as it shortens the work.
    const span = (r: OrderRow): number =>
      r.expectDate!.getTime() - r.start!.getTime();
    expect(after.days!).toBeLessThan(row!.days!);
    expect(span(after)).toBeLessThan(span(row!));
  });

  it('never has anyone working two orders in the same hours', () => {
    // Day by day and person by person, on what the schedule actually planned.
    // Two bars can overlap without anyone being in two places: somebody still
    // busy elsewhere joins the second one on the day they come free, and an
    // order picking up where another left off takes only the rest of the shift.
    const b = build();
    const rows = b.groups
      .filter((g) => g.line.schedulable)
      .flatMap((g) => g.rows)
      .filter((r) => !r.completedToday);
    expect(rows.length).toBeGreaterThan(10);

    const clashes = rows
      .filter((row) => overlapsOnBoard(rows, row))
      .map((row) => String(row.job.id));
    expect(clashes).toEqual([]);
  });

  it('hands a crew straight on to their next order', () => {
    // Every order that follows another with the same people on it begins on
    // the next shift going, not days later — allowing for the weekend and for
    // the bar the crew is waiting on ending part-way through a day.
    const b = build();
    const rows = b.groups
      .filter((g) => g.line.schedulable)
      .flatMap((g) => g.rows)
      .filter((r) => r.start && r.expectDate);

    let handovers = 0;
    for (const row of rows) {
      // The order this crew finished last before starting this one.
      const previous = rows
        .filter(
          (other) =>
            other !== row &&
            other.expectDate! <= row.start! &&
            other.workers.some((w) =>
              row.workers.some((mine) => String(mine.id) === String(w.id)),
            ) &&
            // Only a crew this order kept whole — a team that splits up waits
            // for its slowest member, which is a gap with a reason.
            row.workers.every((mine) =>
              rows.some(
                (o) =>
                  o !== row &&
                  o.expectDate! <= row.start! &&
                  o.workers.some((w) => String(w.id) === String(mine.id)),
              ),
            ),
        )
        .sort((x, y) => y.expectDate!.getTime() - x.expectDate!.getTime())[0];
      if (!previous || row.waitingOn) continue;
      handovers++;
      const gapDays =
        (row.start!.getTime() - previous.expectDate!.getTime()) / 86_400_000;
      expect(gapDays).toBeLessThanOrEqual(3.01); // ≤ a rounded shift + a weekend
    }
    expect(handovers).toBeGreaterThan(0);
  });

  /**
   * A press job holds up the chair it moulds the shell for.
   *
   * The supplier side of a material link is proved by `JobMaterialReq` — a row
   * naming the produced part as that order's own parent part — so a press job
   * with no material rows of its own silently stops being anyone's supplier.
   * That is easy to lose and impossible to see on the board, hence a test on
   * the demo data rather than a hand-built graph.
   */
  it('carries the moulding-to-assembly links, not just the ones inside assembly', () => {
    const b = build();
    const rows = b.groups.flatMap((g) => g.rows);
    const pressLinks = rows.flatMap((row) =>
      row.predecessors
        .filter((dep) => /^(SFM|SUNF)/.test(String(dep.onJobId)))
        .map((dep) => `${String(row.job.id)}→${String(dep.onJobId)}`),
    );

    expect(pressLinks.sort()).toEqual([
      'ASM80011→SFM507014',
      'ASM80013→SFM507068',
      'ASM8008→SFM507016',
      // Two open press jobs build G11881000, 86 and 258 against a requirement
      // of 240, so neither batch alone covers the chair and it waits for both.
      'ASM8008→SUNF0000000230',
      'ASM8008→SUNF0000000231',
      'ASM8009→SFM507066',
      'ASM8009→SFM507067',
    ]);
    // Every wait on this board names the component it is for, which only
    // happens when the material file proved it: an order carried by the
    // export's `Predecessor` column alone knows a job number and no part.
    expect(
      rows.flatMap((row) => row.predecessors).every((dep) => dep.part !== null),
    ).toBe(true);
  });

  /**
   * The board must not wear a name it does not use.
   *
   * A crew ledger that recorded only "free after" read someone booked three
   * weeks out as unavailable for all three weeks. An order starting today then
   * either ran short-handed or, when their supposed release fell past its end,
   * dropped them from the plan entirely — while still showing their chip on the
   * row. On screen that is a person crewed on a bar running today whom the
   * header calls free.
   */
  /**
   * The moulding lane is context: press work the assembly side is waiting for.
   * It used to be padded out with the next few press jobs by date, which put
   * work nothing on the board depended on at the top of the screen.
   */
  it('shows only the press work something on the board is waiting for', () => {
    const b = build();
    const pmd = b.groups.find((g) => !g.line.schedulable);
    const needed = new Set(
      [...b.rowsByJob.values()]
        .flatMap((r) => r.predecessors)
        .map((d) => String(d.onJobId)),
    );
    expect(pmd).toBeDefined();
    expect(pmd!.rows.length).toBeGreaterThan(0);
    for (const row of pmd!.rows) {
      expect(needed.has(String(row.job.id)), String(row.job.id)).toBe(true);
    }
  });

  it('drops the moulding lane when nothing is waiting on a press', () => {
    // The same board with the material links taken away: no assembly order
    // waits for a press job, so the lane has nothing to say and is not drawn.
    const indexes = buildIndexes(dataset);
    usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs);
    const state = usePlanStore.getState();
    const bare = computeAssemblyGantt({
      dataset: { ...dataset, jobLinks: [], jobs: dataset.jobs.map((j) => ({ ...j, predecessors: [] })) },
      indexes,
      containers: state.containers,
      orderCrewAssignments: state.orderCrewAssignments,
      orderStarts: {},
      orderActualStarts: {},
      progress: {},
      progressBaselines: {},
      production: {},
      workers: dataset.workers,
      today: TODAY,
    });
    expect(bare.groups.every((g) => g.line.schedulable)).toBe(true);
  });

  it('names anyone it shows on a crew but never plans a day for', () => {
    const b = build();
    const rows = b.groups.flatMap((g) => g.rows).filter((r) => r.line.schedulable);
    for (const row of rows) {
      if (!row.crewDays || row.crewDays.length === 0) continue;
      const unused = row.workers.filter(
        (worker) =>
          !row.crewDays!.some((day) =>
            day.workerIds.includes(String(worker.id)),
          ),
      );
      // Whoever the plan could not fit in is reported, never silently dropped:
      // an order quietly running a person short is the one thing a supervisor
      // cannot see by looking at the row.
      expect(
        (row.crewWithoutRoom ?? []).map((w) => String(w.id)).sort(),
        String(row.job.id),
      ).toEqual(unused.map((w) => String(w.id)).sort());
    }
  });

  it('counts a crewed order running today as work for the people on it', () => {
    const b = build();
    const rows = b.groups.flatMap((g) => g.rows);
    const busy = activeWorkerIdsOnDay(rows, TODAY);
    const missed: string[] = [];
    for (const row of rows) {
      if (!row.line.schedulable || row.completedToday) continue;
      const runsToday =
        row.start !== null &&
        row.expectDate !== null &&
        row.start <= addDays(TODAY, 1) &&
        row.expectDate >= TODAY;
      if (!runsToday) continue;
      for (const worker of row.workers) {
        if (!busy.has(String(worker.id))) {
          missed.push(`${worker.name} on ${String(row.job.id)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it('leaves an order unschedulable when nobody is on it', () => {
    const b = build({ orderCrewAssignments: {} });
    const rows = b.groups.filter((g) => g.line.schedulable).flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.days === null && r.expectDate === null)).toBe(
      true,
    );
  });

  it('pulls the Expect Date in when output is booked', () => {
    const base = build();
    const row = base.groups
      .flatMap((g) => g.rows)
      .find((r) => r.line.schedulable && r.expectDate && r.job.remainingQty > 10);
    expect(row).toBeDefined();
    const id = String(row!.job.id);

    const booked = build({
      progress: { [id]: [{ date: '2026-09-11', qty: Math.floor(row!.job.remainingQty / 2) }] },
    });
    const after = booked.rowsByJob.get(id)!;

    expect(after.job.completedQty).toBeGreaterThan(row!.job.completedQty);
    expect(after.days!).toBeLessThan(row!.days!);
  });

  it('does not deduct a local booking twice after the source catches up', () => {
    const base = build();
    const row = [...base.rowsByJob.values()].find((candidate) => candidate.job.remainingQty > 10)!;
    const id = String(row.job.id);
    const qty = 5;
    const baseline = {
      remainingQty: row.sourceRemainingQty!,
      completedQty: row.sourceCompletedQty!,
    };
    const refreshed: PlanningDataset = {
      ...dataset,
      jobs: dataset.jobs.map((job) =>
        String(job.id) === id
          ? {
              ...job,
              remainingQty: job.remainingQty - qty,
              completedQty: job.completedQty + qty,
            }
          : job,
      ),
    };
    const state = usePlanStore.getState();
    const after = computeAssemblyGantt({
      dataset: refreshed,
      indexes: buildIndexes(refreshed),
      containers: state.containers,
      orderCrewAssignments: state.orderCrewAssignments,
      orderStarts: {},
      progress: { [id]: [{ date: '2026-09-11', qty }] },
      progressBaselines: { [id]: baseline },
      production: {},
      workers: refreshed.workers,
      today: TODAY,
    });

    expect(after.rowsByJob.get(id)!.job.remainingQty).toBe(
      baseline.remainingQty - qty,
    );
  });

  it('uses the confirmed actual start and ignores later planned dragging', () => {
    const base = build();
    const row = [...base.rowsByJob.values()].find((candidate) => candidate.workers.length > 0)!;
    const id = String(row.job.id);
    const actual: ActualStartRecord = {
      // A local morning, not an instant: 03:15Z is the previous evening west
      // of Greenwich, and the day a shift started is a local day.
      startedAt: '2026-09-11T09:15:00',
      overrideReason: null,
      operatorIds: row.workers.map((worker) => String(worker.id)),
      operatorNames: row.workers.map((worker) => worker.name),
    };
    const after = build({
      orderStarts: { [id]: '2026-09-25T00:00:00.000Z' },
      orderActualStarts: { [id]: actual },
    });
    expect(after.rowsByJob.get(id)!.actualStart).toEqual(actual);
    expect(after.rowsByJob.get(id)!.start).toEqual(TODAY);
  });

  it('greys a completed job today and removes it the following day', () => {
    const base = build();
    const row = [...base.rowsByJob.values()][0];
    const completed: ProductionEntry = {
      date: '2026-09-11',
      shiftOutput: 8,
      complete: 8,
      reject: 0,
      rework: 0,
      paused: false,
      pauseReason: null,
      jobCompleted: true,
      notes: '',
    };
    const today = build({ production: { [String(row.job.id)]: [completed] } });
    expect(today.rowsByJob.get(String(row.job.id))?.completedToday).toBe(true);
    expect(today.rowsByJob.get(String(row.job.id))?.status.color).toBe('grey');

    const tomorrow = computeAssemblyGantt({
      dataset,
      indexes: buildIndexes(dataset),
      containers: usePlanStore.getState().containers,
      orderCrewAssignments: usePlanStore.getState().orderCrewAssignments,
      orderStarts: {},
      progress: {},
      production: { [String(row.job.id)]: [completed] },
      workers: dataset.workers,
      today: new Date('2026-09-12T00:00:00'),
    });
    expect(tomorrow.jobsById.has(String(row.job.id))).toBe(false);
  });

  it('starts a successor only after every predecessor finishes', () => {
    const b = build();
    const rows = b.groups.flatMap((g) => g.rows);
    const byId = new Map(rows.map((r) => [String(r.job.id), r]));
    const withPred = [...b.rowsByJob.values()].filter(
      (r) => r.predecessors.length > 0,
    );
    expect(withPred.length).toBeGreaterThan(0);

    for (const row of withPred) {
      for (const dep of row.predecessors) {
        const pred = byId.get(String(dep.onJobId));
        if (!pred?.expectDate || !row.start) continue;
        expect(row.start.getTime()).toBeGreaterThanOrEqual(
          pred.expectDate.getTime(),
        );
      }
    }
  });

  it('holds a successor whose component is on no line, and draws neither', () => {
    /*
     * An order can end up on no line: the planner took it off one, or the
     * export named a line this board does not know. It used to be scheduled
     * onto whichever line came second in the list the moment something waiting
     * on it was resolved — taking a build position and that line's people for
     * a bar nothing drew, and handing its successor a finish date to start
     * from. The successor is really waiting for somebody to place it.
     */
    const indexes = buildIndexes(dataset);
    usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs);
    const state = usePlanStore.getState();

    const settled = build();
    const successor = [...settled.rowsByJob.values()].find(
      (row) => row.line.schedulable && row.predecessors.length > 0 &&
        settled.rowsByJob.has(String(row.predecessors[0].onJobId)),
    );
    expect(successor).toBeDefined();
    const componentId = String(successor!.predecessors[0].onJobId);

    // Take the component off its line, leaving everything else alone.
    const containers = Object.fromEntries(
      Object.entries(state.containers).map(([key, ids]) => [
        key,
        key === POOL_ID
          ? [...ids, componentId as unknown as (typeof ids)[number]]
          : ids.filter((id) => String(id) !== componentId),
      ]),
    );
    const b = computeAssemblyGantt({
      dataset,
      indexes,
      containers,
      orderCrewAssignments: state.orderCrewAssignments,
      orderStarts: {},
      orderActualStarts: {},
      progress: {},
      progressBaselines: {},
      production: {},
      workers: dataset.workers,
      today: TODAY,
    });

    // The component is in the pool and has no row anywhere on the board.
    expect(b.pool.map((job) => String(job.id))).toContain(componentId);
    expect(b.rowsByJob.has(componentId)).toBe(false);
    expect(
      b.groups.flatMap((g) => g.rows).map((r) => String(r.job.id)),
    ).not.toContain(componentId);

    // And its successor is held, naming it, rather than coming free because
    // the date it was waiting for went missing.
    const held = b.rowsByJob.get(String(successor!.job.id))!;
    expect(held.expectDate).toBeNull();
    expect(held.start).toBeNull();
    expect(String(held.waitingOn?.onJobId)).toBe(componentId);
  });

  it('carries a work load on every line group and on the board total', () => {
    const b = build();
    const summed = b.groups
      .filter((g) => g.line.schedulable)
      .reduce((s, g) => s + g.load.hours, 0);

    expect(summed).toBeGreaterThan(0);
    expect(summed).toBeCloseTo(b.totals.remainingHours, 6);

    for (const g of b.groups) {
      if (!g.line.schedulable || g.rows.length === 0) continue;
      expect(g.load.crew).toBeGreaterThan(0);
      // Days to clear the queue = hours ÷ what the crew delivers in a day.
      expect(g.load.daysOfWork).toBeCloseTo(
        g.load.hours / g.load.capacityPerDay,
        6,
      );
    }
  });

  it('books a person’s week against the orders they are actually on', () => {
    const b = build();
    const row = [...b.rowsByJob.values()].find((r) => r.workers.length > 0)!;
    const person = row.workers[0];
    const load = workerLoad(
      person,
      b.groups.flatMap((g) => g.rows),
      b.horizonStart,
    );

    expect(load.orderCount).toBeGreaterThan(0);
    expect(load.totalHours).toBeGreaterThan(0);
    // Nobody can be booked for more hours than the orders they are on hold.
    const theirs = [...b.rowsByJob.values()].filter((r) =>
      r.workers.some((w) => String(w.id) === String(person.id)),
    );
    const ceiling = theirs.reduce(
      (s, r) => s + remainingHours(r.job) / r.workers.length,
      0,
    );
    expect(load.totalHours).toBeLessThanOrEqual(ceiling + 1e-6);
  });

  it('colours every scheduled row and the totals add up', () => {
    const b = build();
    const rows = [...b.rowsByJob.values()];
    for (const r of rows) {
      expect(['green', 'red', 'grey']).toContain(r.status.color);
    }
    expect(b.totals.green + b.totals.red).toBeLessThanOrEqual(b.totals.orders);
    expect(b.totals.orders).toBe(rows.length);
  });
});

describe('the board the planner laid out', () => {
  it('keeps the rows where they were put when a bar is dragged out', () => {
    const before = build();
    const line = before.groups.find(
      (g) => g.line.schedulable && g.rows.length >= 2,
    )!;
    const ids = line.rows.map((r) => String(r.job.id));

    // Push the first order a fortnight out — far enough that sorting by date
    // would drop it to the bottom of its line.
    const after = build({
      orderStarts: { [ids[0]]: new Date('2026-09-25T00:00:00').toISOString() },
    });
    const moved = after.groups.find((g) => g.line.key === line.line.key)!;

    expect(moved.rows.map((r) => String(r.job.id))).toEqual(ids);
    // …and the bar really did move; it is the row that stayed put.
    expect(moved.rows[0].start!.getTime()).toBeGreaterThan(
      line.rows[0].start!.getTime(),
    );
  });

  it('still lets a bar dragged earlier take a build position first', () => {
    // Row order is the planner's; the queue is by date. An order pulled to the
    // front of the week gets the free position even from the bottom row.
    const before = build();
    const line = before.groups.find(
      (g) => g.line.schedulable && g.rows.length >= 3,
    )!;
    const last = String(line.rows.at(-1)!.job.id);

    const after = build({
      orderStarts: { [last]: new Date('2026-09-11T00:00:00').toISOString() },
    });
    const row = after.rowsByJob.get(last)!;
    // The day the board opens on, at the hour the floor opens on it.
    expect(row.start!.getTime()).toBe(shiftOpensOn(after.today).getTime());
  });
});

describe('yesterday, still on the board', () => {
  it('opens on the previous working day', () => {
    const b = build();
    // TODAY is Friday 11 Sep 2026, so the board opens on the Thursday.
    expect(b.today).toEqual(new Date('2026-09-11T00:00:00'));
    expect(b.horizonStart).toEqual(new Date('2026-09-10T00:00:00'));
  });

  it('plans nothing into a day that has already gone', () => {
    const b = build();
    for (const r of b.rowsByJob.values()) {
      if (!r.start) continue;
      expect(r.start.getTime()).toBeGreaterThanOrEqual(b.today.getTime());
    }
  });

  it('still shows the usual run of days ahead', () => {
    // The history column is extra, not taken out of the planning window.
    const b = build();
    expect(b.horizonDays).toBeGreaterThanOrEqual(DEFAULT_HORIZON_DAYS + 1);
  });

  it('carries the shift log on the row, valued in hours', () => {
    const base = build();
    const row = [...base.rowsByJob.values()].find(
      (r) => r.line.schedulable && r.job.remainingQty > 4,
    )!;
    const id = String(row.job.id);
    const qty = 2;

    const booked = build({ progress: { [id]: [{ date: '2026-09-10', qty }] } });
    const after = booked.rowsByJob.get(id)!;

    expect(after.booked).toHaveLength(1);
    expect(after.booked[0].day).toBe('2026-09-10');
    expect(after.booked[0].qty).toBe(qty);
    // Two units of an order worth `laborHrs` over its whole quantity.
    const total = row.job.remainingQty + row.job.completedQty;
    expect(after.booked[0].hours).toBeCloseTo((row.job.laborHrs / total) * qty, 6);
  });
});

/**
 * UPL is three benches, and the chain through them. Cutting and sewing, the
 * softies and the upholstering are different trades on one line, and the
 * material links say which order has to finish before which.
 */
describe('the UPL benches and the chain through them', () => {
  it('never puts anyone on a bench they do not work', () => {
    const b = build();
    for (const group of b.groups) {
      for (const row of group.rows) {
        for (const worker of row.workers) {
          expect(
            canWorkKind(worker, row.kind),
            `${worker.name} is on ${String(row.job.id)} (${row.kind})`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps the softies for the two people trained on them', () => {
    const b = build();
    const softie = [...b.rowsByJob.values()].filter(
      (row) => row.kind === 'smart-softie',
    );
    expect(softie.length).toBeGreaterThan(1);
    const named = b.workers
      .filter((worker) => worker.trades?.includes('smart-softie'))
      .map((worker) => worker.name);
    expect(named).toEqual(['Bill', 'Gate']);
    for (const row of softie) {
      for (const worker of row.workers) expect(named).toContain(worker.name);
    }
  });

  it('holds the cutters to cutting', () => {
    const b = build();
    const cutters = b.workers.filter((w) => w.trades?.includes('cut-sew'));
    expect(cutters.map((w) => w.name)).toEqual(['Mary', 'Nina']);
    for (const row of b.rowsByJob.values()) {
      if (row.workers.some((w) => cutters.some((c) => c.id === w.id))) {
        // Cutting on UPL, or any work at all on a line without benches.
        expect(['cut-sew', 'general']).toContain(row.kind);
      }
    }
  });

  it('runs the three UPL steps one after another, then final assembly', () => {
    const b = build();
    const chain = ['ASM8018', 'ASM8019', 'ASM8020', 'ASM8021'].map(
      (id) => b.rowsByJob.get(id)!,
    );
    for (const row of chain) expect(row).toBeDefined();
    expect(chain.map((row) => row.kind)).toEqual([
      'cut-sew',
      'smart-softie',
      'upholstery',
      'general',
    ]);
    // Each waits on the one before it, and none of them starts early.
    for (let i = 1; i < chain.length; i++) {
      expect(
        chain[i].predecessors.map((dep) => String(dep.onJobId)),
      ).toContain(String(chain[i - 1].job.id));
      expect(chain[i].start!.getTime()).toBeGreaterThanOrEqual(
        chain[i - 1].expectDate!.getTime(),
      );
    }
  });

  it('offers auto-fill only from the operator current line roster', () => {
    // Nothing crewed at all, so every order is filled from scratch.
    const bare = build({ orderCrewAssignments: {} });
    const { allocations } = suggestCrew(bare, (soFar) =>
      build({ orderCrewAssignments: crewOf(soFar) }),
    );
    const byId = new Map(bare.workers.map((w) => [String(w.id), w]));
    let checked = 0;
    for (const [jobId, crew] of Object.entries(allocations)) {
      const row = bare.rowsByJob.get(jobId)!;
      for (const id of crew) {
        expect(byId.get(id)!.skills[0], `${byId.get(id)!.name} on ${jobId}`)
          .toBe(row.line.key);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
