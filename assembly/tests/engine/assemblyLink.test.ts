/**
 * The join between the two pages: an Assembly job number is `0` + the sales
 * order, then line and release, and Dispatch asks of each load whether the
 * Assembly board has its orders off the line before it leaves.
 */

import { describe, expect, it } from 'vitest';
import { orderKey, salesOrderOfJob } from '@/domain/orderLink';
import { buildsByOrder, checkBuild, openLinesByOrder, type OrderBuild } from '@/engine/dispatch/assemblyLink';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import type { Job } from '@/domain/types';

describe('salesOrderOfJob', () => {
  it('reads order, line and release off a make-to-order job', () => {
    expect(salesOrderOfJob('018140-1-1')).toEqual({ order: '18140', line: '1', rel: '1' });
    expect(salesOrderOfJob('018321-12-2')).toEqual({ order: '18321', line: '12', rel: '2' });
    expect(salesOrderOfJob('018140')).toEqual({ order: '18140', line: null, rel: null });
  });

  it('maps a stock job to no order', () => {
    expect(salesOrderOfJob('SFM507615')).toBeNull();
    expect(salesOrderOfJob('ASM80010')).toBeNull();
    expect(salesOrderOfJob('507615')).toBeNull(); // no leading 0, no dashes
  });

  it('compares order numbers whatever their leading zeros', () => {
    expect(orderKey('018140')).toBe(orderKey('18140'));
  });
});

const job = (id: string, patch: Partial<Job> = {}): Job =>
  ({ id, partNum: 'P', description: 'Chair', remainingQty: 10, dueDate: null, ...patch }) as Job;

const row = (j: Job, expect: Date | null, patch: Partial<OrderRow> = {}): OrderRow =>
  ({ job: j, start: expect ? new Date(2026, 9, 12) : null, expectDate: expect, completedAt: null, completedToday: false, ...patch }) as OrderRow;

const view = (rows: OrderRow[], pool: Job[] = []): AssemblyGanttView =>
  ({
    groups: [
      { line: { name: 'ASSY 1', schedulable: true }, rows },
      { line: { name: 'PMD', schedulable: false }, rows: [row(job('018140-9-9'), new Date(2026, 11, 1))] },
    ],
    pool,
  }) as unknown as AssemblyGanttView;

describe('buildsByOrder', () => {
  const builds = buildsByOrder(
    view(
      [
        row(job('018140-1-1'), new Date(2026, 9, 14, 11, 0)),
        row(job('018140-2-1'), new Date(2026, 9, 15, 14, 30)),
        row(job('SFM507615'), new Date(2026, 9, 13)),
        row(job('018200-1-1'), null),
      ],
      [job('018300-1-1')],
    ),
  );

  it('files every make-to-order job under its order, with the board’s dates', () => {
    expect([...builds.keys()].sort()).toEqual(['18140', '18200', '18300']);
    const b = builds.get('18140')!;
    expect(b.jobs.map((j) => [j.jobId, j.lineName, j.state])).toEqual([
      ['018140-1-1', 'ASSY 1', 'dated'],
      ['018140-2-1', 'ASSY 1', 'dated'],
    ]);
    expect(builds.get('18200')!.jobs[0].state).toBe('no-crew');
    expect(builds.get('18300')!.jobs[0]).toMatchObject({ state: 'unplaced', lineName: null });
  });

  it('leaves the PMD mirror out', () => {
    expect(builds.get('18140')!.jobs.some((j) => j.jobId === '018140-9-9')).toBe(false);
  });

  it('checks a load against the last job off the line', () => {
    const b = builds.get('18140');
    expect(checkBuild(b, '2026-10-16')).toMatchObject({ verdict: 'ok', finish: '2026-10-15' });
    expect(checkBuild(b, '2026-10-15')!.verdict).toBe('same-day');
    expect(checkBuild(b, '2026-10-14')!.verdict).toBe('late');
  });

  it('counts only the order lines still open on the waybill', () => {
    const lines = openLinesByOrder([{ order: '18140', line: '1' }]);
    expect(checkBuild(builds.get('18140'), '2026-10-14', lines.get('18140'))).toMatchObject({
      verdict: 'same-day',
      finish: '2026-10-14',
    });
    expect(checkBuild(builds.get('18140'), '2026-10-14', new Set(['7']))).toBeNull();
  });

  it('says when a job still to build has no date, and when all are done', () => {
    expect(checkBuild(builds.get('18200'), '2026-10-20')!.verdict).toBe('unknown');
    expect(checkBuild(builds.get('18300'), '2026-10-20')!.verdict).toBe('unknown');
    const done: OrderBuild = buildsByOrder(view([row(job('018400-1-1', { remainingQty: 0 }), null)])).get('18400')!;
    expect(checkBuild(done, '2026-10-01')!.verdict).toBe('done');
    expect(checkBuild(undefined, '2026-10-01')).toBeNull();
  });
});
