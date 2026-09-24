import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import type { ProductionEntry } from '@/store/planStore';
import {
  activeCrewOf,
  bulkTargets,
  planComplete,
  planStart,
  startRecord,
} from '@/features/assembly/bulkPlan';

const TODAY = '2026-09-24';
const ok = { level: 'ready', releasable: true, reason: '', needsOverride: false, unconfirmed: false };

const row = (id: string, over: Partial<Record<string, unknown>> = {}): OrderRow =>
  ({
    job: { id, released: true, remainingQty: 10, completedQty: 2, manual: false, ...(over.job as object) },
    line: { schedulable: true, name: 'Assembly' },
    workers: [
      { id: 'w1', name: 'Ann' },
      { id: 'w2', name: 'Bo' },
    ],
    crewDays: [],
    release: ok,
    actualStart: null,
    completedToday: false,
    ...over,
  }) as unknown as OrderRow;

const started = { startedAt: '2026-09-23T07:00:00.000Z', overrideReason: null, operatorIds: ['w1'], operatorNames: ['Ann'] };

const entry = (over: Partial<ProductionEntry>): ProductionEntry => ({
  date: TODAY,
  complete: 0,
  reject: 0,
  rework: 0,
  shiftOutput: 0,
  paused: false,
  pauseReason: null,
  jobCompleted: false,
  notes: '',
  ...over,
});

describe('which orders a right-click acts on', () => {
  it('acts on the whole marked set when the pressed order is in it, else on that order alone', () => {
    expect(bulkTargets('B', ['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
    expect(bulkTargets('D', ['A', 'B'])).toEqual(['D']);
    expect(bulkTargets('A', [])).toEqual(['A']);
  });
});

describe('starting several orders at once', () => {
  it('holds each order to its own start gate and says why the rest are left out', () => {
    const plan = planStart(
      [
        row('READY'),
        row('RUNNING', { actualStart: started }),
        row('NOCREW', { workers: [] }),
        row('HELD', { job: { id: 'HELD', released: false, remainingQty: 5, completedQty: 0 } }),
        row('SUPPORT', { job: { id: 'SUPPORT', manual: true, released: true, remainingQty: 1, completedQty: 0 } }),
        row('PMD', { line: { schedulable: false, name: 'PMD' } }),
        row('CLOSED'),
      ],
      { CLOSED: [entry({ jobCompleted: true, completedAt: 'x' })] },
    );
    expect(plan.ready.map((r) => r.job.id)).toEqual(['READY']);
    // Not released: a supervisor may override it.
    expect(plan.override.map((o) => o.row.job.id)).toEqual(['HELD']);
    expect(plan.override[0].reasons).toEqual(['Order is not released']);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.row.job.id, s.reason]))).toEqual({
      RUNNING: 'already started',
      NOCREW: 'Allocate at least one employee',
      SUPPORT: 'support order — book it from its own form',
      PMD: 'not planned on this board',
      CLOSED: 'already completed',
    });
  });

  it('starts an order with the crew the day plan has on it today, else its own people', () => {
    const planned = row('A', {
      crewDays: [{ day: TODAY, workerIds: ['w2'] }],
    });
    expect(activeCrewOf(planned, TODAY).map((w) => w.name)).toEqual(['Bo']);
    expect(activeCrewOf(row('B'), TODAY).map((w) => w.name)).toEqual(['Ann', 'Bo']);
    expect(startRecord(planned, TODAY, 'now', 'kit checked')).toEqual({
      startedAt: 'now',
      overrideReason: 'kit checked',
      operatorIds: ['w2'],
      operatorNames: ['Bo'],
    });
  });
});

describe('completing several orders at once', () => {
  it('books the rest of each order as complete today and closes it', () => {
    const plan = planComplete([row('A', { actualStart: started })], {}, TODAY, 'T');
    expect(plan.skipped).toEqual([]);
    expect(plan.ready[0].rebooks).toBe(false);
    expect(plan.ready[0].entry).toMatchObject({
      date: TODAY,
      complete: 10,
      jobCompleted: true,
      completedAt: 'T',
      paused: false,
      operatorIds: ['w1', 'w2'],
    });
  });

  it('keeps what today already booked and adds the rest to it', () => {
    const plan = planComplete(
      [row('A', { actualStart: started })],
      { A: [entry({ complete: 4, reject: 1, shiftOutput: 6, paused: true, pauseReason: 'material-shortage', notes: 'late foam' })] },
      TODAY,
      'T',
    );
    expect(plan.ready[0].rebooks).toBe(true);
    expect(plan.ready[0].entry).toMatchObject({
      complete: 14,
      reject: 1,
      shiftOutput: 6,
      notes: 'late foam',
      // An order cannot be paused and completed in the same entry.
      paused: false,
      pauseReason: null,
    });
  });

  it('leaves out an order nobody has started, and one already closed', () => {
    const plan = planComplete(
      [row('NEW'), row('DONE', { actualStart: started, completedToday: true })],
      {},
      TODAY,
      'T',
    );
    expect(plan.ready).toEqual([]);
    expect(plan.skipped.map((s) => [s.row.job.id, s.reason])).toEqual([
      ['NEW', 'not started — start production first'],
      ['DONE', 'already completed'],
    ]);
  });
});
