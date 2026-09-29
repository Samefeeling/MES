/**
 * The level-loading plan against the real schedule: the overload it predicts
 * after its moves is what the board then draws, because it writes the same
 * pinned starts the board reads.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockSource } from '@/data/mock/MockSource';
import { buildIndexes } from '@/engine/indexes';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { addCalendarDays, isWeekend } from '@/engine/assembly/dates';
import { usePlanStore } from '@/store/planStore';
import { DEFAULT_CREW_POOLS, type LineKey } from '@/domain/assembly';
import type { PlanningDataset } from '@/domain/types';
import { capacityDays } from '@/features/assembly/crewCapacity';
import { timelineDays } from '@/features/assembly/boardView';
import { pickedOverload, pinsOf, planLevelLoad } from '@/features/assembly/levelLoad';

const TODAY = new Date('2026-09-11T00:00:00');
let dataset: PlanningDataset;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  const result = await new MockSource().loadAll();
  if (!result.ok) throw new Error(result.error);
  dataset = result.value;
});
afterAll(() => vi.useRealTimers());

/** The seed with nobody crewed, so every order is drawn as waiting for a crew. */
function build(starts: Record<string, string> = {}) {
  const indexes = buildIndexes(dataset);
  usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs, undefined, dataset.jobLinks);
  const state = usePlanStore.getState();
  return computeAssemblyGantt({
    dataset, indexes, containers: state.containers, orderCrewAssignments: {},
    orderStarts: starts, orderActualStarts: {}, progress: {}, progressBaselines: {}, production: {},
    workers: dataset.workers, today: TODAY,
  });
}

function overload(board: ReturnType<typeof build>): number {
  const days = Array.from({ length: timelineDays(board, 8) }, (_, i) => addCalendarDays(board.horizonStart, i))
    .filter((d) => !isWeekend(d));
  const cap = capacityDays(board.groups.flatMap((g) => g.rows), DEFAULT_CREW_POOLS, () => 3, days, board.today);
  return cap.reduce((n, d) => n + d.pools.reduce((m, p) => m + Math.max(0, p.demand - p.capacity), 0), 0);
}

describe('level loading against the schedule', () => {
  it('predicts the overload the board then shows', () => {
    const board = build();
    const rows = board.groups.flatMap((g) => g.rows);
    const capacity = capacityDays(rows, DEFAULT_CREW_POOLS, () => 3,
      Array.from({ length: timelineDays(board, 8) }, (_, i) => addCalendarDays(board.horizonStart, i)).filter((d) => !isWeekend(d)),
      board.today);
    const picks = new Map<LineKey, Set<string>>();
    for (const day of capacity) {
      for (const lane of day.lines.keys()) {
        picks.set(lane, (picks.get(lane) ?? new Set<string>()).add(day.key));
      }
    }
    const plan = planLevelLoad({ rows, pools: DEFAULT_CREW_POOLS, today: TODAY, picks });

    expect(plan.moves.length).toBeGreaterThan(0);
    expect(plan.after.hours).toBeLessThan(plan.before.hours);
    // Every day it read as over is read the same afterwards.
    expect(overload(board)).toBeCloseTo(plan.before.hours, 1);
    expect(overload(build(pinsOf(plan)))).toBeCloseTo(plan.after.hours, 1);
  });

  it('predicts the room a picked stretch of empty days is left with', () => {
    const board = build();
    const rows = board.groups.flatMap((g) => g.rows);
    const days = Array.from({ length: timelineDays(board, 8) }, (_, i) => addCalendarDays(board.horizonStart, i))
      .filter((d) => !isWeekend(d));
    const read = (b: ReturnType<typeof build>) =>
      capacityDays(b.groups.flatMap((g) => g.rows), DEFAULT_CREW_POOLS, () => 3, days, b.today);
    // The first working week from today, on every lane.
    const week = read(board).filter((d) => !d.past).slice(0, 5);
    const picks = new Map<LineKey, Set<string>>();
    for (const day of week) {
      for (const lane of day.lines.keys()) picks.set(lane, (picks.get(lane) ?? new Set<string>()).add(day.key));
    }
    const plan = planLevelLoad({ rows, pools: DEFAULT_CREW_POOLS, today: TODAY, picks });

    expect(plan.moves.some((m) => m.kind === 'fill')).toBe(true);
    expect(plan.room.after).toBeLessThan(plan.room.before);
    expect(pickedOverload(read(board), picks, DEFAULT_CREW_POOLS).room).toBeCloseTo(plan.room.before, 1);
    const after = pickedOverload(read(build(pinsOf(plan))), picks, DEFAULT_CREW_POOLS);
    expect(after.room).toBeCloseTo(plan.room.after, 1);
    expect(after.hours).toBeCloseTo(plan.after.hours, 1);
  });

  it('leaves alone what it says it leaves alone', () => {
    const board = build();
    const rows = board.groups.flatMap((g) => g.rows);
    const picks = new Map<LineKey, Set<string>>([['UPL_GLUING', new Set(['2026-09-18'])]]);
    const plan = planLevelLoad({ rows, pools: DEFAULT_CREW_POOLS, today: TODAY, picks });
    const routed = new Set(rows.filter((r) => r.job.operation).map((r) => String(r.job.id)));
    expect(plan.moves.some((m) => routed.has(m.jobId))).toBe(false);
    expect(plan.left.some((l) => l.kind === 'fixed')).toBe(true);
  });
});
