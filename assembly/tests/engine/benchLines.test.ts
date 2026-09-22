/**
 * The benches, on the board.
 *
 * `routing.test.ts` has the arithmetic; this is what the supervisor sees. One
 * order is one row, standing at the bench working it now — not three rows
 * standing at three benches — the lane above carries the whole line's work,
 * and the bench the order has not reached yet shows what is coming without
 * pretending it can be started.
 */

import { describe, it, expect } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { buildIndexes } from '@/engine/indexes';
import { JobId, PartId, WorkCenterId, WorkerId } from '@/domain/ids';
import {
  LINES,
  type CrewAssignment,
  type LineKey,
  type Worker,
} from '@/domain/assembly';
import type {
  InventoryItem,
  Job,
  JobMaterialLink,
  PlanningDataset,
} from '@/domain/types';
import type { ProductionEntry } from '@/store/planStore';

/** Thursday 10 Sep 2026. */
const THU = new Date(2026, 8, 10);

const worker = (id: string, skills: LineKey[]): Worker => ({
  id: WorkerId(id),
  name: id,
  skills,
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

/** A shift that closed an operation, which is what moves the order on. */
const closed = (date: string): ProductionEntry => ({
  date,
  complete: 0,
  reject: 0,
  rework: 0,
  shiftOutput: 0,
  paused: false,
  pauseReason: null,
  jobCompleted: true,
  completedAt: `${date}T15:00:00.000Z`,
  notes: '',
});

/**
 * Lay the board out with a crew on every row.
 *
 * Nothing is placed by hand: the rows land on the bench their operation names,
 * which is the behaviour under test. The crew is allocated after the fact by
 * row key, because a row key is only knowable once the route has been walked.
 */
function board(
  jobs: Job[],
  links: JobMaterialLink[] = [],
  production: Record<string, ProductionEntry[]> = {},
  inventory: InventoryItem[] = [],
) {
  const workers = jobs.flatMap((_job, i) =>
    [0, 1, 2].map((n) => worker(`W${i}${n}`, ['UPL_SOFTIE', 'UPL_GLUING'])),
  );
  const dataset: PlanningDataset = {
    workCenters: LINES.map((line) => ({
      id: line.id,
      kind: 'area' as const,
      name: line.name,
      department: 'assembly' as const,
      sortIndex: line.sortIndex,
    })),
    jobs,
    routing: [],
    inventory,
    bom: [],
    po: [],
    demand: [],
    jobLinks: links,
    workers,
    fetchedAt: THU,
  };
  const indexes = buildIndexes(dataset);
  const input = {
    dataset,
    indexes,
    containers: {},
    orderStarts: {},
    orderActualStarts: {},
    progress: {},
    production,
    workers,
    today: THU,
  };
  /*
   * One pass to learn the row keys, a second to place them and put people on
   * them — which is exactly the sequence a supervisor goes through after a
   * refresh, because a row key is only knowable once the route has been
   * walked.
   */
  const first = computeAssemblyGantt({ ...input, orderCrewAssignments: {} });
  const rows = [
    ...first.pool,
    ...first.groups.flatMap((g) => g.rows.map((row) => row.job)),
  ];
  const containers: Record<string, string[]> = {};
  const orderCrewAssignments: Record<string, CrewAssignment[]> = {};
  rows.forEach((held, i) => {
    const key = String(held.line);
    containers[key] = [...(containers[key] ?? []), String(held.id)];
    orderCrewAssignments[String(held.id)] = [
      {
        workerId: String(workers[i % workers.length].id),
        fromDay: null,
        toDayExclusive: null,
      },
    ];
  });
  return computeAssemblyGantt({ ...input, containers, orderCrewAssignments });
}

const groupOf = (b: ReturnType<typeof board>, key: LineKey) =>
  b.groups.find((group) => group.line.key === key)!;

const rowsOn = (b: ReturnType<typeof board>, key: LineKey): string[] =>
  groupOf(b, key).rows.map((r) => String(r.job.id));

describe('UPL-SSS on the board', () => {
  const built = (production: Record<string, ProductionEntry[]> = {}) =>
    board(
      [job('FOAM1', 'UPL_SOFTIE', 6.8), job('STAP1', 'UPL_SOFTIE', 26.3)],
      [foamLink('FOAM1')],
      production,
    );

  it('stands each order at the one bench working it', () => {
    const b = built();
    expect(rowsOn(b, 'UPL_SOFTIE_FOAM')).toEqual(['FOAM1#10']);
    expect(rowsOn(b, 'UPL_SOFTIE_SEW')).toEqual(['STAP1#10']);
    // Not on the stapling bench: nobody can staple a cover nobody has sewn.
    expect(rowsOn(b, 'UPL_SOFTIE_STAPLE')).toEqual([]);
    expect(rowsOn(b, 'UPL_SOFTIE')).toEqual([]);
  });

  it('moves the order to stapling when the sewing is closed', () => {
    const b = built({ 'STAP1#10': [closed('2026-09-10')] });
    expect(rowsOn(b, 'UPL_SOFTIE_SEW')).toEqual([]);
    expect(rowsOn(b, 'UPL_SOFTIE_STAPLE')).toEqual(['STAP1#20']);
  });

  it('counts the stapling that is coming without putting a bar on it', () => {
    const staple = groupOf(built(), 'UPL_SOFTIE_STAPLE');
    expect(staple.rows).toEqual([]);
    expect(staple.load.hours).toBeCloseTo(21.8, 6);
    expect(staple.load.incomingHours).toBeCloseTo(21.8, 6);
  });

  it('carries the whole line on the lane above the benches', () => {
    const lane = groupOf(built(), 'UPL_SOFTIE');
    // 33.1 h — the figure the line had before it was split into three, and
    // each operation counted exactly once towards it.
    expect(lane.load.hours).toBeCloseTo(6.8 + 26.3, 6);
  });

  it('has the order finish when its route does, not when its bench does', () => {
    const b = built();
    const sew = b.rowsByJob.get('STAP1#10')!;
    // 4.5 h of sewing with one person is most of a day; the 21.8 h still to
    // staple are three more. The expected finish has to say so.
    expect(sew.job.operation!.tailHours).toBeCloseTo(21.8, 6);
    expect(sew.expectDate!.getTime()).toBeGreaterThan(
      sew.planThrough!.getTime(),
    );
  });

  it('gives each bench its own people', () => {
    const b = built();
    const crews = (['UPL_SOFTIE_FOAM', 'UPL_SOFTIE_SEW'] as const).map((key) =>
      groupOf(b, key).rows.flatMap((r) => r.workers.map((w) => String(w.id))),
    );
    expect(crews.every((crew) => crew.length > 0)).toBe(true);
    expect(new Set(crews.flat()).size).toBe(crews.flat().length);
  });
});

describe('UPL-Gluing on the board', () => {
  const built = (production: Record<string, ProductionEntry[]> = {}) =>
    board([job('GLU1', 'UPL_GLUING', 37.9)], [], production);

  it('stands one order at the two benches that can work it together', () => {
    const b = built();
    expect(rowsOn(b, 'UPL_GLUING_FOAM')).toEqual(['GLU1#10']);
    expect(rowsOn(b, 'UPL_GLUING_SEW')).toEqual(['GLU1#20']);
    expect(rowsOn(b, 'UPL_GLUING_STAPLE')).toEqual([]);
  });

  it('is one order number on both of them', () => {
    const b = built();
    for (const id of ['GLU1#10', 'GLU1#20']) {
      expect(String(b.rowsByJob.get(id)!.job.operation!.jobNum)).toBe('GLU1');
    }
  });

  it('works foaming and sewing side by side', () => {
    const b = built();
    const foam = b.rowsByJob.get('GLU1#10')!;
    const sew = b.rowsByJob.get('GLU1#20')!;
    expect(foam.waitingOn).toBeNull();
    expect(sew.waitingOn).toBeNull();
    expect(foam.start).toEqual(sew.start);
  });

  it('reaches stapling only when both are closed', () => {
    const half = built({ 'GLU1#10': [closed('2026-09-10')] });
    expect(rowsOn(half, 'UPL_GLUING_SEW')).toEqual(['GLU1#20']);
    expect(rowsOn(half, 'UPL_GLUING_STAPLE')).toEqual([]);

    const both = built({
      'GLU1#10': [closed('2026-09-10')],
      'GLU1#20': [closed('2026-09-10')],
    });
    expect(rowsOn(both, 'UPL_GLUING_STAPLE')).toEqual(['GLU1#30']);
  });

  it('gives every bench row the order’s pick list', () => {
    /*
     * JobMaterialReq.csv knows GLU1; the board's rows are GLU1#10 / #20 / #30.
     * Looked up by the row key the list came back empty, so tapping a bench
     * order showed nothing to pick. The material belongs to the order, and
     * every operation of it is working towards the same one.
     */
    const b = board([job('GLU1', 'UPL_GLUING', 37.9)], [foamLink('GLU1')]);
    for (const id of ['GLU1#10', 'GLU1#20']) {
      const picks = b.rowsByJob.get(id)!.pickList ?? [];
      expect(picks.map((p) => String(p.childPart))).toEqual(['FM0012']);
    }
  });

  it('tells every bench row the foam is short', () => {
    // Order-level material, so it stops every operation of the order — and
    // the bench standing idle for want of it is the one the supervisor is
    // looking at.
    const b = board(
      [job('GLU1', 'UPL_GLUING', 37.9)],
      [foamLink('GLU1')],
      {},
      [
        {
          partNum: PartId('FM0012'),
          description: 'Foam: seat',
          typeCode: null,
          onHand: 0,
          cmplWip: 0,
          supply: 0,
          demand: 0,
          calculatedDemand: null,
          freeOnHand: 0,
        },
      ],
    );
    for (const id of ['GLU1#10', 'GLU1#20']) {
      expect(
        b.rowsByJob.get(id)!.shortPicks?.map((s) => String(s.part)),
      ).toEqual(['FM0012']);
    }
  });

  it('splits the hours three ways and counts each third once', () => {
    const b = built();
    const third = 37.9 / 3;
    expect(b.rowsByJob.get('GLU1#10')!.job.laborHrs).toBeCloseTo(third, 6);
    expect(b.rowsByJob.get('GLU1#20')!.job.laborHrs).toBeCloseTo(third, 6);
    // A parallel sibling is nobody's tail, so the lane totals the order once.
    expect(groupOf(b, 'UPL_GLUING').load.hours).toBeCloseTo(37.9, 6);
  });

  it('receives the units at stapling and nowhere else', () => {
    const b = built({
      'GLU1#10': [closed('2026-09-10')],
      'GLU1#20': [closed('2026-09-10')],
    });
    expect(b.rowsByJob.get('GLU1#30')!.job.operation!.last).toBe(true);
    const fresh = built();
    for (const id of ['GLU1#10', 'GLU1#20']) {
      expect(fresh.rowsByJob.get(id)!.job.operation!.last).toBe(false);
    }
  });
});

describe('what this floor calls its lines', () => {
  it('takes the name off the plan, on a lane and on a bench alike', () => {
    const jobs = [job('GLU1', 'UPL_GLUING', 37.9)];
    const dataset: PlanningDataset = {
      workCenters: LINES.map((line) => ({
        id: line.id,
        kind: 'area' as const,
        name: line.name,
        department: 'assembly' as const,
        sortIndex: line.sortIndex,
      })),
      jobs,
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
      today: THU,
      lineNames: { UPL_GLUING: 'Glue line', UPL_GLUING_SEW: 'Machines' },
    });
    const name = (key: LineKey) =>
      b.groups.find((group) => group.line.key === key)!.line.name;
    expect(name('UPL_GLUING')).toBe('Glue line');
    expect(name('UPL_GLUING_SEW')).toBe('Machines');
    // Untouched benches keep the name the process gave them.
    expect(name('UPL_GLUING_FOAM')).toBe('Foaming');
  });
});
