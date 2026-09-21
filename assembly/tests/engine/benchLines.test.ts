/**
 * The three benches, on the board.
 *
 * `steps.test.ts` has the arithmetic; this is what the supervisor sees: one
 * row per bench, each with its own people, the lane above them carrying the
 * three added up, and the sewing finished before the stapling starts.
 */

import { describe, it, expect } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { buildIndexes } from '@/engine/indexes';
import { withStepOrders } from '@/engine/assembly/steps';
import { JobId, PartId, WorkCenterId, WorkerId } from '@/domain/ids';
import {
  LINES,
  type CrewAssignment,
  type LineKey,
  type Worker,
} from '@/domain/assembly';
import type { Job, JobMaterialLink, PlanningDataset } from '@/domain/types';

/** Thursday 10 Sep 2026. */
const THU = new Date(2026, 8, 10);

const worker = (id: string, line: LineKey): Worker => ({
  id: WorkerId(id),
  name: id,
  skills: [line],
  trades: ['smart-softie', 'upholstery'],
  onShift: true,
});

const job = (id: string, line: string, laborHrs: number, qty = 9): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId(`P_${id}`),
  description: id,
  remainingQty: qty,
  qtyPerHr: null,
  laborHrs,
  dueDate: new Date(2026, 8, 30),
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'upholstery',
  line: WorkCenterId(line),
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
});

const foamLink = (jobNum: string): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId('P'),
  childPart: PartId('FM0012'),
  requiredQty: 1,
  childDescription: 'Foam: seat',
  uom: 'EA',
});

const crewOf = (byJob: Record<string, string[]>): Record<string, CrewAssignment[]> =>
  Object.fromEntries(
    Object.entries(byJob).map(([jobId, ids]) => [
      jobId,
      ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null })),
    ]),
  );

/** Expand the orders the way the data store does, then lay the board out. */
function board(jobs: Job[], links: JobMaterialLink[] = []) {
  const expanded = withStepOrders({ jobs, jobLinks: links }).jobs;
  const benches = LINES.filter((line) => line.step || line.schedulable);
  const workers = expanded.map((held, i) =>
    worker(`W${i}`, (LINES.find((l) => String(l.id) === String(held.line))?.key ?? 'ASSY')),
  );
  const dataset: PlanningDataset = {
    workCenters: benches.map((line) => ({
      id: line.id,
      kind: 'area' as const,
      name: line.name,
      department: 'assembly' as const,
      sortIndex: line.sortIndex,
    })),
    jobs: expanded,
    routing: [],
    inventory: [],
    bom: [],
    po: [],
    demand: [],
    jobLinks: links,
    workers,
    fetchedAt: THU,
  };

  const containers: Record<string, string[]> = {};
  expanded.forEach((held) => {
    const key = String(held.line);
    containers[key] = [...(containers[key] ?? []), String(held.id)];
  });

  return computeAssemblyGantt({
    dataset,
    indexes: buildIndexes(dataset),
    containers,
    orderCrewAssignments: crewOf(
      Object.fromEntries(expanded.map((held, i) => [String(held.id), [`W${i}`]])),
    ),
    orderStarts: {},
    orderActualStarts: {},
    progress: {},
    production: {},
    workers,
    today: THU,
  });
}

const groupOf = (b: ReturnType<typeof board>, key: LineKey) =>
  b.groups.find((group) => group.line.key === key);

describe('UPL-SSS on the board', () => {
  const built = () =>
    board(
      [job('FOAM1', 'UPL_SOFTIE', 6.8), job('STAP1', 'UPL_SOFTIE', 26.3)],
      [foamLink('FOAM1')],
    );

  it('puts each order on the bench that works it', () => {
    const b = built();
    expect(groupOf(b, 'UPL_SOFTIE_FOAM')!.rows.map((r) => String(r.job.id)))
      .toEqual(['FOAM1']);
    expect(groupOf(b, 'UPL_SOFTIE_SEW')!.rows.map((r) => String(r.job.id)))
      .toEqual(['STAP1#SEW']);
    expect(groupOf(b, 'UPL_SOFTIE_STAPLE')!.rows.map((r) => String(r.job.id)))
      .toEqual(['STAP1']);
    // Nothing is left on the lane itself.
    expect(groupOf(b, 'UPL_SOFTIE')!.rows).toEqual([]);
  });

  it('carries the three benches added up on the lane above them', () => {
    const b = built();
    const lane = groupOf(b, 'UPL_SOFTIE')!;
    const benches = (['UPL_SOFTIE_FOAM', 'UPL_SOFTIE_SEW', 'UPL_SOFTIE_STAPLE'] as const)
      .map((key) => groupOf(b, key)!.load.hours);

    expect(benches[0]).toBeCloseTo(6.8, 6);
    expect(benches[1]).toBeCloseTo(4.5, 6);
    expect(benches[2]).toBeCloseTo(21.8, 6);
    // 33.1 h — the figure the line had before it was split into three.
    expect(lane.load.hours).toBeCloseTo(6.8 + 26.3, 6);
    expect(lane.benchOrders).toBe(3);
  });

  it('finishes the sewing before the stapling starts', () => {
    const b = built();
    const sew = b.rowsByJob.get('STAP1#SEW')!;
    const staple = b.rowsByJob.get('STAP1')!;

    expect(staple.start!.getTime()).toBeGreaterThanOrEqual(
      sew.expectDate!.getTime(),
    );
    expect(String(staple.waitingOn?.onJobId)).toBe('STAP1#SEW');
  });

  it('gives every bench its own people rather than one crew for the lane', () => {
    const b = built();
    const crews = (['UPL_SOFTIE_FOAM', 'UPL_SOFTIE_SEW', 'UPL_SOFTIE_STAPLE'] as const)
      .map((key) => groupOf(b, key)!.rows.flatMap((r) => r.workers.map((w) => String(w.id))));
    expect(crews.every((crew) => crew.length > 0)).toBe(true);
    expect(new Set(crews.flat()).size).toBe(crews.flat().length);
  });
});

describe('UPL-Gluing on the board', () => {
  const built = () => board([job('GLU1', 'UPL_GLUING', 37.9)]);

  it('splits one order across the three benches, evenly', () => {
    const b = built();
    for (const key of ['UPL_GLUING_FOAM', 'UPL_GLUING_SEW', 'UPL_GLUING_STAPLE'] as const) {
      expect(groupOf(b, key)!.load.hours).toBeCloseTo(37.9 / 3, 6);
    }
    expect(groupOf(b, 'UPL_GLUING')!.load.hours).toBeCloseTo(37.9, 6);
  });

  it('works foaming and sewing side by side', () => {
    const b = built();
    const foam = b.rowsByJob.get('GLU1#FOAM')!;
    const sew = b.rowsByJob.get('GLU1#SEW')!;
    // Same day, neither waiting on the other.
    expect(foam.waitingOn).toBeNull();
    expect(sew.waitingOn).toBeNull();
    expect(foam.start).toEqual(sew.start);
  });

  it('staples after both of them', () => {
    const b = built();
    const staple = b.rowsByJob.get('GLU1')!;
    const foam = b.rowsByJob.get('GLU1#FOAM')!;
    const sew = b.rowsByJob.get('GLU1#SEW')!;

    expect(staple.start!.getTime()).toBeGreaterThanOrEqual(
      Math.max(foam.expectDate!.getTime(), sew.expectDate!.getTime()),
    );
  });

  it('marks the two copies derived and leaves the job number on the stapling row', () => {
    const b = built();
    expect(b.rowsByJob.get('GLU1')!.job.step!.derived).toBe(false);
    expect(b.rowsByJob.get('GLU1#FOAM')!.job.step!.derived).toBe(true);
    expect(b.rowsByJob.get('GLU1#SEW')!.job.step!.derived).toBe(true);
  });
});

describe('what this floor calls its lines', () => {
  it('takes the name off the plan, on a lane and on a bench alike', () => {
    const jobs = [job('GLU1', 'UPL_GLUING', 37.9)];
    const expanded = withStepOrders({ jobs, jobLinks: [] }).jobs;
    const dataset: PlanningDataset = {
      workCenters: LINES.map((line) => ({
        id: line.id,
        kind: 'area' as const,
        name: line.name,
        department: 'assembly' as const,
        sortIndex: line.sortIndex,
      })),
      jobs: expanded,
      routing: [], inventory: [], bom: [], po: [], demand: [],
      jobLinks: [], workers: [], fetchedAt: THU,
    };
    const b = computeAssemblyGantt({
      dataset,
      indexes: buildIndexes(dataset),
      containers: {},
      orderCrewAssignments: {},
      orderStarts: {},
      orderActualStarts: {},
      progress: {},
      production: {},
      workers: [],
      lineNames: { UPL_GLUING: 'Bench 4', UPL_GLUING_SEW: 'Machining' },
      today: THU,
    });

    expect(groupOf(b, 'UPL_GLUING')!.line.name).toBe('Bench 4');
    expect(groupOf(b, 'UPL_GLUING_SEW')!.line.name).toBe('Machining');
    // Everything else keeps the name the plant gave it.
    expect(groupOf(b, 'UPL_GLUING_FOAM')!.line.name).toBe('Foaming');
  });
});
