/**
 * What the Assembly board says about the orders Dispatch is shipping.
 *
 * Every job on the board built for a sales order (see `domain/orderLink`) is
 * filed under that order with the board's own forecast: where it is, what is
 * left to build, and its Expect Date — the moment the goods come off the line
 * at the crew it has. Dispatch then asks one question of a load: does the
 * factory finish before the truck leaves?
 *
 * One job per job number, however many rows the board draws it as. A routed
 * order (`domain/routing`) is at one or two benches at once — `018532-5-1#20`
 * sewing beside `#10` foaming — and each of those rows already carries the
 * benches still in front of it in its Expect Date, so the order is finished
 * when the latest of them is. A press run on a PMD sub-line counts too: a
 * moulded part sold as it is has no Assembly row at all, and the press plan's
 * end of run is the only date there is for it.
 *
 * The answer is only as good as the board. An order on no line, or on a line
 * with nobody on it, has no Expect Date, and says so rather than passing.
 */

import type { DayKey } from '@/domain/dispatch';
import { lineKey, orderKey, salesOrderOfJob } from '@/domain/orderLink';
import { jobNumOf } from '@/domain/routing';
import type { Job } from '@/domain/types';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import type { StockJob } from './lineSupply';
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
  /** The job number — never a row key: `018532-5-1`, not `018532-5-1#20`. */
  jobId: string;
  /** Order line and release from the job number. */
  orderLine: string | null;
  rel: string | null;
  /**
   * Where it is: the line, or the lane and bench — `UPL-Gluing › Sewing`,
   * `PMD › M12` — the ones still to finish first. Null in the pool.
   */
  lineName: string | null;
  partNum: string;
  description: string;
  remainingQty: number;
  /** Bar start, when it has one. */
  start: Date | null;
  /** The order's Expect Date: the end of the route, not of one bench. */
  expect: Date | null;
  /** Epicor's required due date for the job. */
  due: Date | null;
  state: BuildState;
}

export interface OrderBuild {
  order: string;
  jobs: BuildJob[];
}

const isDone = (row: OrderRow): boolean =>
  row.job.remainingQty <= 0 || Boolean(row.completedAt) || Boolean(row.completedToday);

/** A board row and the place it is drawn in, in words. */
interface Placed {
  row: OrderRow;
  place: string;
}

const unique = (names: readonly string[]): string[] => [...new Set(names)];

/**
 * The job, read off every row the board draws it as; `pooled` when it is on
 * none. Only a job built for a sales order, unless `stock` asks for the others.
 */
function buildJob(jobNum: string, rows: readonly Placed[], pooled: Job | null, stock = false): BuildJob | null {
  const ref = salesOrderOfJob(jobNum);
  if (!ref && !stock) return null;
  const job = rows[0]?.row.job ?? pooled;
  if (!job) return null;
  const pending = rows.filter((p) => !isDone(p.row));
  // Finished once nothing is left at any operation it is at, and one of those
  // is the operation that receives: a routed order between benches is not.
  const done =
    rows.length > 0 &&
    pending.length === 0 &&
    rows.some((p) => !p.row.job.operation || p.row.job.operation.last);
  // The latest of the operations still open: each one's Expect Date already
  // carries the benches still in front of it.
  const open = pending.length > 0 ? pending : rows;
  const ends = open.map((p) => p.row.expectDate);
  const expect =
    ends.length > 0 && ends.every(Boolean) ? new Date(Math.max(...ends.map((d) => d!.getTime()))) : null;
  const starts = rows.flatMap((p) => (p.row.start ? [p.row.start.getTime()] : []));
  return {
    jobId: jobNum,
    orderLine: ref?.line ?? null,
    rel: ref?.rel ?? null,
    lineName: rows.length > 0 ? unique(open.map((p) => p.place)).join(' · ') : null,
    partNum: String(job.partNum),
    description: job.description,
    // What the order still owes, as the export has it: a bench row's own
    // quantity is that operation's, not the order's.
    remainingQty: Math.max(
      0,
      ...rows.map((p) => p.row.sourceRemainingQty ?? p.row.job.remainingQty),
      ...(rows.length === 0 && pooled ? [pooled.remainingQty] : []),
    ),
    start: starts.length > 0 ? new Date(Math.min(...starts)) : null,
    expect,
    due: job.dueDate,
    state: rows.length === 0
      ? job.remainingQty <= 0 ? 'done' : 'unplaced'
      : done ? 'done' : expect ? 'dated' : 'no-crew',
  };
}

/**
 * Every job on the board, by job number: the rows it is drawn as, and the
 * place each is in. A job in the pool and on no line is in `pooled` instead.
 */
function jobsOnBoard(view: AssemblyGanttView): { rowsOf: Map<string, Placed[]>; pooled: Map<string, Job> } {
  const names = new Map(view.groups.map((g) => [g.line.key, g.line.name]));
  const rowsOf = new Map<string, Placed[]>();
  for (const group of view.groups) {
    const line = group.line;
    const place = line.parent ? `${names.get(line.parent) ?? line.parent} › ${line.name}` : line.name;
    for (const row of group.rows) {
      // A press changeover is a row between orders, not an order.
      if (row.job.press?.change) continue;
      const jobNum = jobNumOf(String(row.job.id));
      const held = rowsOf.get(jobNum);
      if (held) held.push({ row, place });
      else rowsOf.set(jobNum, [{ row, place }]);
    }
  }
  const pooled = new Map<string, Job>();
  for (const job of view.pool) {
    const jobNum = jobNumOf(String(job.id));
    if (!rowsOf.has(jobNum) && !pooled.has(jobNum)) pooled.set(jobNum, job);
  }
  return { rowsOf, pooled };
}

/** Every job on the board built for a sales order, filed under that order. */
export function buildsByOrder(view: AssemblyGanttView): Map<string, OrderBuild> {
  const { rowsOf, pooled } = jobsOnBoard(view);
  const out = new Map<string, OrderBuild>();
  const add = (job: BuildJob | null) => {
    if (!job) return;
    const order = salesOrderOfJob(job.jobId)!.order;
    const build = out.get(order) ?? { order, jobs: [] };
    build.jobs.push(job);
    out.set(order, build);
  };
  for (const [jobNum, rows] of rowsOf) add(buildJob(jobNum, rows, null));
  for (const [jobNum, job] of pooled) add(buildJob(jobNum, [], job));
  for (const b of out.values()) b.jobs.sort((a, b2) => a.jobId.localeCompare(b2.jobId, undefined, { numeric: true }));
  return out;
}

/**
 * The jobs on the board built for no order — `ASM…`, `SFM…` — still making
 * something: the stock a waybill line short of that part can wait for.
 */
export function stockJobsOf(view: AssemblyGanttView): StockJob[] {
  const { rowsOf, pooled } = jobsOnBoard(view);
  const out: StockJob[] = [];
  const add = (job: BuildJob | null) => {
    if (!job || job.state === 'done' || job.remainingQty <= 0) return;
    out.push({ jobId: job.jobId, partNum: job.partNum, qty: job.remainingQty, expect: job.expect, place: job.lineName });
  };
  for (const [jobNum, rows] of rowsOf) if (!salesOrderOfJob(jobNum)) add(buildJob(jobNum, rows, null, true));
  for (const [jobNum, job] of pooled) if (!salesOrderOfJob(jobNum)) add(buildJob(jobNum, [], job, true));
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
