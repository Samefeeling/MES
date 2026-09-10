/**
 * Turning material lines into an order-waits-for-order graph.
 *
 * The rule the shop floor works to: an order cannot start until every
 * component another open order is still making has been finished.
 */

import { describe, it, expect } from 'vitest';
import { JobId, PartId } from '@/domain/ids';
import type { Job, JobMaterialLink } from '@/domain/types';
import { buildDependencies } from '@/engine/assembly/dependencies';

/** An open order making `part`, optionally scheduled on `startDay`. */
const job = (
  id: string,
  part: string,
  over: Partial<Job> = {},
): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId(part),
  description: part,
  remainingQty: 10,
  qtyPerHr: null,
  laborHrs: 8,
  dueDate: null,
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: null,
  line: null,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const link = (jobNum: string, parent: string, child: string): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId(parent),
  childPart: PartId(child),
  requiredQty: 1,
  childDescription: '',
  uom: '',
});

/** `A→B` pairs, sorted, so an expectation reads as the graph itself. */
const edges = (g: ReturnType<typeof buildDependencies>): string[] =>
  [...g.byJob.values()]
    .flat()
    .map((d) => `${String(d.jobId)}→${String(d.onJobId)}`)
    .sort();

describe('buildDependencies', () => {
  it('makes the parent wait for the order that builds its component', () => {
    const jobs = [job('ASSY1', 'CHAIR'), job('UPL1', 'COVER')];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'COVER'),
      link('UPL1', 'COVER', 'FABRIC'),
    ]);

    expect(edges(g)).toEqual(['ASSY1→UPL1']);
    expect(String(g.byJob.get('ASSY1')![0].part)).toBe('COVER');
  });

  it('waits for every component, not just the first', () => {
    const jobs = [
      job('ASSY1', 'CHAIR'),
      job('UPL1', 'COVER'),
      job('PMD1', 'SHELL'),
    ];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'COVER'),
      link('ASSY1', 'CHAIR', 'SHELL'),
      link('UPL1', 'COVER', 'FABRIC'),
      link('PMD1', 'SHELL', 'RESIN'),
    ]);
    expect(edges(g)).toEqual(['ASSY1→PMD1', 'ASSY1→UPL1']);
  });

  it('crosses departments — a chair waits on a press', () => {
    const jobs = [
      job('ASSY1', 'CHAIR'),
      job('SFM1', 'SHELL', { department: 'moulding' }),
    ];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'SHELL'),
      link('SFM1', 'SHELL', 'RESIN'),
    ]);
    expect(edges(g)).toEqual(['ASSY1→SFM1']);
  });

  it('chains through several stages', () => {
    const jobs = [
      job('CUT', 'FABRIC'),
      job('UPL_GLUING', 'COVER'),
      job('ASSY', 'CHAIR'),
    ];
    const g = buildDependencies(jobs, [
      link('CUT', 'FABRIC', 'RAW-FABRIC'),
      link('UPL_GLUING', 'COVER', 'FABRIC'),
      link('ASSY', 'CHAIR', 'COVER'),
    ]);
    expect(edges(g)).toEqual(['ASSY→UPL_GLUING', 'UPL_GLUING→CUT']);
  });

  it('ignores a component nobody is making — it is bought or in stock', () => {
    const jobs = [job('ASSY1', 'TABLE')];
    const g = buildDependencies(jobs, [link('ASSY1', 'TABLE', 'MDF-TOP')]);
    expect(edges(g)).toEqual([]);
  });

  it('ignores a component whose order is already finished', () => {
    const jobs = [
      job('ASSY1', 'CHAIR'),
      job('PMD1', 'SHELL', { remainingQty: 0, completedQty: 100 }),
    ];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'SHELL'),
      link('PMD1', 'SHELL', 'RESIN'),
    ]);
    expect(edges(g)).toEqual([]);
  });

  it('keeps every JobMtl job for several open batches of the same part', () => {
    const early = new Date(2026, 8, 10);
    const late = new Date(2026, 8, 24);
    const jobs = [
      job('ASSY1', 'CHAIR'),
      job('PMD-LATE', 'SHELL', { startDate: late }),
      job('PMD-EARLY', 'SHELL', { startDate: early }),
    ];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'SHELL'),
      link('PMD-LATE', 'SHELL', 'RESIN-LATE'),
      link('PMD-EARLY', 'SHELL', 'RESIN-EARLY'),
    ]);
    expect(edges(g)).toEqual(['ASSY1→PMD-EARLY', 'ASSY1→PMD-LATE']);
  });

  it('deduplicates repeated material rows without dropping distinct job numbers', () => {
    const jobs = [job('ASSY1', 'CHAIR'), job('PMD-B', 'SHELL'), job('PMD-A', 'SHELL')];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'SHELL'),
      link('PMD-B', 'SHELL', 'RESIN-B'),
      link('PMD-A', 'SHELL', 'RESIN-A'),
    ]);
    expect(edges(g)).toEqual(['ASSY1→PMD-A', 'ASSY1→PMD-B']);
  });

  it('keeps a predecessor named directly in the order export', () => {
    const jobs = [
      job('ASSY1', 'CHAIR', { predecessors: [JobId('UPL1')] }),
      job('UPL1', 'COVER'),
    ];
    const g = buildDependencies(jobs, []);
    expect(edges(g)).toEqual(['ASSY1→UPL1']);
    expect(g.byJob.get('ASSY1')![0].part).toBeNull();
  });

  it('does not list the same pair twice when both sources agree', () => {
    const jobs = [
      job('ASSY1', 'CHAIR', { predecessors: [JobId('UPL1')] }),
      job('UPL1', 'COVER'),
    ];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', 'COVER'),
      link('UPL1', 'COVER', 'FABRIC'),
    ]);
    expect(edges(g)).toEqual(['ASSY1→UPL1']);
    // …and keeps the component, which only the material file knows.
    expect(String(g.byJob.get('ASSY1')![0].part)).toBe('COVER');
  });

  it('never makes an order wait for itself', () => {
    // A rework line where the job consumes its own part number.
    const jobs = [job('ASSY1', 'CHAIR')];
    const g = buildDependencies(jobs, [link('ASSY1', 'CHAIR', 'CHAIR')]);
    expect(edges(g)).toEqual([]);
  });

  it('skips a link for an order that is not open', () => {
    const jobs = [job('UPL1', 'COVER')];
    const g = buildDependencies(jobs, [link('GONE', 'CHAIR', 'COVER')]);
    expect(edges(g)).toEqual([]);
    expect(g.warnings[0]).toMatch(/GONE/);
    expect(g.warnings[0]).toMatch(/not present in Planning1/);
  });

  it('breaks a circular pair and says which one it dropped', () => {
    const jobs = [job('A', 'PA'), job('B', 'PB')];
    const g = buildDependencies(jobs, [
      link('A', 'PA', 'PB'),
      link('B', 'PB', 'PA'),
    ]);

    // One edge survives — waiting both ways is not a schedule.
    expect(edges(g)).toHaveLength(1);
    expect(g.warnings).toHaveLength(1);
    expect(g.warnings[0]).toMatch(/Circular material link/);
  });

  it('flags an order whose two exports disagree about the part it builds', () => {
    const jobs = [job('ASSY1', 'CHAIR'), job('UPL1', 'COVER')];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'STOOL', 'COVER'),
      link('UPL1', 'COVER', 'FABRIC'),
    ]);

    // Still used: the job number is what matters, the part is a cross-check.
    expect(edges(g)).toEqual(['ASSY1→UPL1']);
    expect(g.warnings[0]).toMatch(/different part/);
    expect(g.warnings[0]).toMatch(/ASSY1/);
  });

  it('recognises a supplier that has no material rows of its own', () => {
    // A press job moulds a shell from bulk resin, so the material export has
    // nothing to say about it and it never appears as a JobMtl_JobNum. Its
    // Planning1 header still says it builds SHELL, and the chair still cannot
    // be assembled until it is done — requiring a job to consume something
    // before it counts as producing anything drops the link silently.
    const jobs = [
      job('ASSY1', 'CHAIR'),
      job('SFM507623', 'SHELL', { department: 'moulding' }),
    ];
    const g = buildDependencies(jobs, [link('ASSY1', 'CHAIR', 'SHELL')]);

    expect(edges(g)).toEqual(['ASSY1→SFM507623']);
    expect(String(g.byJob.get('ASSY1')![0].part)).toBe('SHELL');
  });

  it('lets one supplier feed several orders', () => {
    // The case from the floor: one press job under two assembly orders.
    const jobs = [
      job('015539-8-1', 'CHAIR-A'),
      job('018291-38-1', 'CHAIR-B'),
      job('SFM507623', 'SHELL', { department: 'moulding' }),
    ];
    const g = buildDependencies(jobs, [
      link('015539-8-1', 'CHAIR-A', 'SHELL'),
      link('018291-38-1', 'CHAIR-B', 'SHELL'),
    ]);

    expect(edges(g)).toEqual([
      '015539-8-1→SFM507623',
      '018291-38-1→SFM507623',
    ]);
  });

  it('matches parent and child parts without case or surrounding whitespace', () => {
    const jobs = [job('ASSY1', 'CHAIR'), job('UPL1', 'COVER')];
    const g = buildDependencies(jobs, [
      link('ASSY1', 'CHAIR', ' cover '),
      link('UPL1', 'Cover', 'FABRIC'),
    ]);

    expect(edges(g)).toEqual(['ASSY1→UPL1']);
  });
});
