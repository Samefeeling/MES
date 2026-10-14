/**
 * What the Assembly board says about the orders Dispatch is shipping.
 *
 * Every job on the board built for a sales order (see `domain/orderLink`) is
 * filed under that order with the board's own forecast: the line it is on,
 * what is left to build, and its Expect Date — the end of its bar, the moment
 * the goods come off the line at the crew it has. Dispatch then asks one
 * question of a load: does Assembly finish before the truck leaves?
 *
 * The answer is only as good as the board. An order on no line, or on a line
 * with nobody on it, has no Expect Date, and says so rather than passing.
 */

import type { DayKey } from '@/domain/dispatch';
import { lineKey, orderKey, salesOrderOfJob } from '@/domain/orderLink';
import type { Job } from '@/domain/types';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import { toDayKey } from '@/lib/time';

/** Where an Assembly job stands. */
export type BuildState =
  /** Finished, or nothing left to build. */
  | 'done'
  /** On a line with a crew: it has an Expect Date. */
  | 'dated'
  /** On a line with nobody on it: no Expect Date yet. */
  | 'no-crew'
  /** Not on any line yet. */
  | 'unplaced';

export interface BuildJob {
  jobId: string;
  /** Order line and release from the job number. */
  orderLine: string | null;
  rel: string | null;
  /** The Assembly line it is on; null in the pool. */
  lineName: string | null;
  partNum: string;
  description: string;
  remainingQty: number;
  /** Bar start, when it has one. */
  start: Date | null;
  /** Bar end — the Expect Date. */
  expect: Date | null;
  /** Epicor's required due date for the job. */
  due: Date | null;
  state: BuildState;
}

export interface OrderBuild {
  order: string;
  jobs: BuildJob[];
}

const isDone = (job: Job, row: OrderRow | null): boolean =>
  job.remainingQty <= 0 || Boolean(row?.completedAt) || Boolean(row?.completedToday);

const buildJob = (job: Job, row: OrderRow | null, lineName: string | null): BuildJob | null => {
  const ref = salesOrderOfJob(String(job.id));
  if (!ref) return null;
  const done = isDone(job, row);
  return {
    jobId: String(job.id),
    orderLine: ref.line,
    rel: ref.rel,
    lineName,
    partNum: String(job.partNum),
    description: job.description,
    remainingQty: job.remainingQty,
    start: row?.start ?? null,
    expect: row?.expectDate ?? null,
    due: job.dueDate,
    state: done ? 'done' : row?.expectDate ? 'dated' : row ? 'no-crew' : 'unplaced',
  };
};

/** Every job on the board built for a sales order, filed under that order. */
export function buildsByOrder(view: AssemblyGanttView): Map<string, OrderBuild> {
  const out = new Map<string, OrderBuild>();
  const add = (job: BuildJob | null) => {
    if (!job) return;
    const order = salesOrderOfJob(job.jobId)!.order;
    const build = out.get(order) ?? { order, jobs: [] };
    build.jobs.push(job);
    out.set(order, build);
  };
  for (const group of view.groups) {
    if (!group.line.schedulable) continue;
    for (const row of group.rows) add(buildJob(row.job, row, group.line.name));
  }
  for (const job of view.pool) add(buildJob(job, null, null));
  for (const b of out.values()) b.jobs.sort((a, b2) => a.jobId.localeCompare(b2.jobId, undefined, { numeric: true }));
  return out;
}

/**
 * - `done` — every job finished;
 * - `ok` — Assembly finishes on a day before the load leaves;
 * - `same-day` — it finishes the day the load leaves: tight;
 * - `late` — it finishes after the load has left;
 * - `unknown` — a job still to build has no Expect Date (no crew, no line).
 */
export type BuildVerdict = 'done' | 'ok' | 'same-day' | 'late' | 'unknown';

export interface BuildCheck {
  verdict: BuildVerdict;
  /** The day the last job comes off the line; null when done or unknown. */
  finish: DayKey | null;
  /** The jobs the check was made on. */
  jobs: BuildJob[];
}

/**
 * Can the order leave on `day`, as far as Assembly is concerned? Only jobs for
 * the order lines still open on the waybill count, when those are given — a
 * line already shipped is not waiting on anything. Null when no job on the
 * board is built for what is shipping: stock goods, or a board without them.
 */
export function checkBuild(
  build: OrderBuild | undefined,
  day: DayKey,
  openLines?: ReadonlySet<string>,
): BuildCheck | null {
  if (!build) return null;
  const byLine = openLines && openLines.size > 0;
  const jobs = build.jobs.filter((j) => !byLine || j.orderLine === null || openLines.has(j.orderLine));
  if (jobs.length === 0) return null;
  const todo = jobs.filter((j) => j.state !== 'done');
  if (todo.length === 0) return { verdict: 'done', finish: null, jobs };
  if (todo.some((j) => !j.expect)) return { verdict: 'unknown', finish: null, jobs };
  const finish = todo.map((j) => toDayKey(j.expect!)).sort().at(-1)!;
  return { verdict: finish > day ? 'late' : finish === day ? 'same-day' : 'ok', finish, jobs };
}

/** The open order lines per order, in the job numbers' spelling. */
export function openLinesByOrder(lines: Iterable<{ order: string; line: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of lines) {
    const key = orderKey(l.order);
    const set = out.get(key) ?? new Set<string>();
    if (l.line.trim()) set.add(lineKey(l.line));
    out.set(key, set);
  }
  return out;
}
