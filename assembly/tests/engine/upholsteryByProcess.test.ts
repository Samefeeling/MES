/**
 * Upholstery scheduled by process.
 *
 * By product, Smart Soft Seating and Upholstery each have a foaming, a sewing
 * and a stapling bench. By process there is one of each, working the orders
 * of both with the people of both — and switching back puts everything where
 * it was, because nothing is rewritten for it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { buildIndexes } from '@/engine/indexes';
import { expandRouting } from '@/engine/assembly/routing';
import { lineOfWorkerToday } from '@/features/assembly/boardView';
import { JobId, PartId, WorkCenterId, WorkerId } from '@/domain/ids';
import {
  LINES,
  activeLineKey,
  canWorkKind,
  onSameLane,
  setUpholsteryByProcess,
  worksLine,
  type LineKey,
  type Worker,
} from '@/domain/assembly';
import type { Job, JobMaterialLink, PlanningDataset } from '@/domain/types';
import { usePlanStore } from '@/store/planStore';

/** Thursday 10 Sep 2026. */
const THU = new Date(2026, 8, 10);

const worker = (id: string, skills: LineKey[], trades?: Worker['trades']): Worker => ({
  id: WorkerId(id),
  name: id,
  skills,
  ...(trades ? { trades } : {}),
  onShift: true,
});

const job = (id: string, line: string, laborHrs = 9): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId(`P_${id}`),
  description: id,
  remainingQty: 9,
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

const workCenters: PlanningDataset['workCenters'] = LINES.map((line) => ({
  id: line.id,
  kind: 'area' as const,
  name: line.name,
  department: 'assembly' as const,
  sortIndex: line.sortIndex,
}));

/** A softie that is foamed, a softie that is sewn and stapled, an upholstery
 *  order (foamed and sewn side by side, then stapled) and a cutting order. */
const jobs = [
  job('SSFOAM', 'UPL_SOFTIE'),
  job('SSSEW', 'UPL_SOFTIE'),
  job('UPH', 'UPL_GLUING'),
  job('CUT', 'UPL_CUT_SEW'),
];
const links = [foamLink('SSFOAM')];

const linesOf = (rows: Job[]): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [String(row.id), String(row.line)]));

const board = (containers: Record<string, string[]> = {}, lineNames: Record<string, string> = {}) => {
  const dataset: PlanningDataset = {
    workCenters, jobs, routing: [], inventory: [], bom: [], po: [], demand: [],
    jobLinks: links, workers: [], fetchedAt: THU,
  };
  return computeAssemblyGantt({
    dataset, indexes: buildIndexes(dataset), containers, orderStarts: {}, orderActualStarts: {},
    progress: {}, production: {}, workers: [], today: THU, orderCrewAssignments: {}, lineNames,
  });
};
const rowsOn = (b: ReturnType<typeof board>, key: LineKey): string[] =>
  (b.groups.find((group) => group.line.key === key)?.rows ?? []).map((row) => String(row.job.id)).sort();

afterEach(() => setUpholsteryByProcess(false));

describe('by product, as the board has always been', () => {
  it('walks each family to its own benches', () => {
    expect(linesOf(expandRouting(jobs, links))).toEqual({
      'SSFOAM#10': 'UPL_SOFTIE_FOAM',
      'SSSEW#10': 'UPL_SOFTIE_SEW',
      'UPH#10': 'UPL_GLUING_FOAM',
      'UPH#20': 'UPL_GLUING_SEW',
      CUT: 'UPL_CUT_SEW',
    });
  });
});

describe('by process', () => {
  beforeEach(() => setUpholsteryByProcess(true));

  it('walks both families to the one bench there is for each step', () => {
    // The same rows, under the same ids — what was booked against an
    // operation is still booked against it — at the shared benches.
    expect(linesOf(expandRouting(jobs, links))).toEqual({
      'SSFOAM#10': 'UPL_GLUING_FOAM',
      'SSSEW#10': 'UPL_GLUING_SEW',
      'UPH#10': 'UPL_GLUING_FOAM',
      'UPH#20': 'UPL_GLUING_SEW',
      CUT: 'UPL_CUT_SEW',
    });
  });

  it('draws one Foaming, one Sewing and one Stapling, and no Smart Soft Seating lane', () => {
    // Routed orders stand where their route says; the cutting order is
    // filed, as the plan files it.
    const b = board({ UPL_CUT_SEW: ['CUT'] }, { UPL_GLUING: 'Upholstery', UPL_SOFTIE: 'Smart Soft Seating' });
    expect(rowsOn(b, 'UPL_GLUING_FOAM')).toEqual(['SSFOAM#10', 'UPH#10']);
    expect(rowsOn(b, 'UPL_GLUING_SEW')).toEqual(['SSSEW#10', 'UPH#20']);
    expect(rowsOn(b, 'UPL_CUT_SEW')).toEqual(['CUT']);
    expect(b.groups.some((group) => String(group.line.key).startsWith('UPL_SOFTIE'))).toBe(false);
    // Nothing is left on no line for want of its old bench.
    expect(b.pool).toEqual([]);
    // The lane over the three says whose work it is.
    expect(b.groups.find((group) => group.line.key === 'UPL_GLUING')!.line.name).toBe(
      'Upholstery + Smart Soft Seating',
    );
  });

  it('reads the people of both families as one crew, without rewriting anybody', () => {
    const chanthan = worker('Chanthan', ['UPL_SOFTIE']);
    const larry = worker('Larry', ['UPL_GLUING']);
    const overrides: Record<string, LineKey> = { Chanthan: 'UPL_SOFTIE_FOAM', Larry: 'UPL_GLUING_FOAM' };
    const at = lineOfWorkerToday([chanthan, larry], [], THU, overrides);
    expect(at.get('Chanthan')).toBe('UPL_GLUING_FOAM');
    expect(at.get('Larry')).toBe('UPL_GLUING_FOAM');
    // The allocation itself is untouched, for the day the board goes back.
    expect(overrides.Chanthan).toBe('UPL_SOFTIE_FOAM');
    // Somebody listed for the softies is qualified at the shared bench…
    expect(worksLine(chanthan, 'UPL_GLUING_FOAM')).toBe(true);
    expect(onSameLane('UPL_SOFTIE_SEW', 'UPL_GLUING_STAPLE')).toBe(true);
    // …and a softie hand takes upholstery there, but a cutter still does not.
    expect(canWorkKind(worker('S', ['UPL_SOFTIE'], ['smart-softie']), 'upholstery')).toBe(true);
    expect(canWorkKind(worker('C', ['UPL_CUT_SEW'], ['cut-sew']), 'upholstery')).toBe(false);
  });

  it('leaves every other line as it is', () => {
    expect(activeLineKey('ASSY')).toBe('ASSY');
    expect(activeLineKey('UPL_CUT_SEW')).toBe('UPL_CUT_SEW');
    expect(activeLineKey('VL_RUSH')).toBe('VL_RUSH');
  });
});

describe('switching the plan over, and back', () => {
  const state = () => usePlanStore.getState();
  const reconcile = () => state().reconcile(workCenters, jobs, THU, links);
  const filed = (key: string): string[] => (state().containers[key] ?? []).map(String).sort();

  beforeEach(() => {
    usePlanStore.setState({
      containers: {}, lastSeen: {}, pooledByHand: [], uplByProcess: false, lineLayoutVersion: 0,
      progress: {}, production: {}, manualOrders: {}, virtualLines: [], workerLines: { Chanthan: 'UPL_SOFTIE_FOAM' },
    });
  });

  it('files the orders of both lanes at the shared benches, and back at their own', () => {
    reconcile();
    expect(filed('UPL_SOFTIE_FOAM')).toEqual(['SSFOAM#10']);
    expect(filed('UPL_GLUING_FOAM')).toEqual(['UPH#10']);

    state().setUplByProcess(true);
    reconcile();
    expect(filed('UPL_GLUING_FOAM')).toEqual(['SSFOAM#10', 'UPH#10']);
    expect(filed('UPL_GLUING_SEW')).toEqual(['SSSEW#10', 'UPH#20']);
    expect(filed('UPL_SOFTIE_FOAM')).toEqual([]);
    expect(filed('UPL_SOFTIE_SEW')).toEqual([]);
    expect(filed('__pool__')).toEqual([]);
    expect(filed('UPL_CUT_SEW')).toEqual(['CUT']);
    // Who is where was not rewritten.
    expect(state().workerLines).toEqual({ Chanthan: 'UPL_SOFTIE_FOAM' });

    state().setUplByProcess(false);
    reconcile();
    expect(filed('UPL_SOFTIE_FOAM')).toEqual(['SSFOAM#10']);
    expect(filed('UPL_SOFTIE_SEW')).toEqual(['SSSEW#10']);
    expect(filed('UPL_GLUING_FOAM')).toEqual(['UPH#10']);
    expect(filed('UPL_GLUING_SEW')).toEqual(['UPH#20']);
  });

  it('opens a plan stored by process the way it was stored, on a board that was by product', () => {
    reconcile();
    // Another board changed over and saved; this one reads that plan.
    state().setAssemblyPlan({ uplByProcess: true });
    reconcile();
    expect(filed('UPL_GLUING_FOAM')).toEqual(['SSFOAM#10', 'UPH#10']);
    expect(filed('UPL_SOFTIE_FOAM')).toEqual([]);
  });
});
