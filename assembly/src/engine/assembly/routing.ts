/**
 * The route each order on the two benched lines takes, and where it is on it.
 *
 * UPL-SSS and UPL-Gluing are each three benches — foaming, sewing, stapling —
 * and the export says nothing about that: one order, one line, one figure for
 * the hours. So the route is worked out here from what the export *does* say,
 * and the order is placed on the bench it has reached.
 *
 * The two lines are organised differently, and this is the whole difference:
 *
 *   UPL-SSS foams to stock. An order that consumes foam is a foaming order and
 *   has only that one operation. Every other order on the line is sewn and
 *   then stapled: half an hour a unit for the sewing, taken **out** of the
 *   order's hours rather than added to them, because it was always in there.
 *
 *   UPL-Gluing does all three against one order. The hours split three ways
 *   evenly, and foaming and sewing are worked side by side — neither waits for
 *   the other, and the staplers wait for both.
 *
 * What this file does not do is invent an order. There is one order number and
 * one set of quantities; the operations divide the hours between them and the
 * last one receives the units. See `domain/routing`.
 *
 * Pure. No React, no store.
 */

import type { Job, JobMaterialLink } from '@/domain/types';
import {
  readLineKey,
  stepLine,
  type LineKey,
  type ProductionStep,
} from '@/domain/assembly';
import { classifyMaterial } from '@/domain/lineRules';
import {
  opRowId,
  tailHoursOf,
  tailOf,
  workableOps,
  type Operation,
} from '@/domain/routing';

/**
 * Sewing, per unit, on UPL-SSS.
 *
 * The floor's own figure. A rate rather than a share, because sewing a cover
 * takes the same half hour whatever else the order carries — which is exactly
 * why it could not be read off the order's total.
 */
export const SEWING_HOURS_PER_UNIT = 0.5;

/** Lines that are really three benches. */
export type BenchedLine = 'UPL_SOFTIE' | 'UPL_GLUING';
const BENCHED: BenchedLine[] = ['UPL_SOFTIE', 'UPL_GLUING'];

/** Is this line one of the two the export under-describes? */
export const isBenchedLine = (key: LineKey | null): key is BenchedLine =>
  key !== null && (BENCHED as LineKey[]).includes(key);

/** Does this order consume foam? That is what makes it a foaming order. */
export function consumesFoam(
  jobId: string,
  links: readonly JobMaterialLink[],
): boolean {
  return links.some(
    (link) =>
      String(link.jobNum) === jobId &&
      classifyMaterial(
        String(link.childPart),
        link.childDescription,
        link.uom,
      ) === 'FOAM',
  );
}

/** The order's whole quantity, made and still to make. */
export const wholeQty = (job: Job): number =>
  Math.max(0, job.completedQty) + Math.max(0, job.remainingQty);

const bench = (line: BenchedLine, step: ProductionStep): LineKey =>
  stepLine(line, step)?.key ?? line;

/**
 * The route an order takes, or `null` for an order that has none — which is
 * every order on the other twelve lines, and they are left exactly as they are.
 */
export function routingOf(
  job: Job,
  links: readonly JobMaterialLink[],
): Operation[] | null {
  const line =
    job.department === 'assembly' ? readLineKey(String(job.line ?? '')) : null;
  if (!isBenchedLine(line)) return null;
  const hours = Math.max(0, job.laborHrs);

  if (line === 'UPL_SOFTIE') {
    // Foam is made to stock against its own order; it is not a step of the
    // upholstery order that later consumes it.
    if (consumesFoam(String(job.id), links)) {
      return [
        { seq: 10, step: 'foaming', line: bench(line, 'foaming'), stdHours: hours, after: [] },
      ];
    }
    /*
     * Everything else is sewn and then stapled. The sewing hours come out of
     * the order's figure, so the line's total is what it always was: 26.3
     * becomes 21.8 + 4.5, not 26.3 + 4.5.
     */
    const sewing = Math.min(hours, SEWING_HOURS_PER_UNIT * wholeQty(job));
    return [
      { seq: 10, step: 'sewing', line: bench(line, 'sewing'), stdHours: sewing, after: [] },
      { seq: 20, step: 'stapling', line: bench(line, 'stapling'), stdHours: hours - sewing, after: [10] },
    ];
  }

  // Gluing: one order, three benches, an even third each, the first two side
  // by side.
  const third = hours / 3;
  return [
    { seq: 10, step: 'foaming', line: bench(line, 'foaming'), stdHours: third, after: [] },
    { seq: 20, step: 'sewing', line: bench(line, 'sewing'), stdHours: third, after: [] },
    { seq: 30, step: 'stapling', line: bench(line, 'stapling'), stdHours: third, after: [10, 20] },
  ];
}

/**
 * What the board knows about work already confirmed at an operation.
 *
 * Passed in rather than read here, because it lives in the plan store and this
 * file is pure. `done` is the units confirmed through that operation's row and
 * `closed` is a supervisor having said the operation is finished whatever the
 * count says — the two ways an operation can be behind you.
 */
export interface OperationProgress {
  done: (rowId: string) => number;
  closed: (rowId: string) => boolean;
}

const NO_PROGRESS: OperationProgress = { done: () => 0, closed: () => false };

/** Which operations of this order are behind it. */
export function finishedSeqs(
  job: Job,
  ops: readonly Operation[],
  progress: OperationProgress,
): Set<number> {
  const qty = wholeQty(job);
  const lastSeq = ops[ops.length - 1]?.seq;
  const done = new Set<number>();
  for (const op of ops) {
    const rowId = String(opRowId(String(job.id), op.seq));
    if (progress.closed(rowId)) {
      done.add(op.seq);
      continue;
    }
    if (op.seq === lastSeq) {
      // The last operation is the order: Epicor's own remaining quantity is
      // the answer, because that is the receipt.
      if (job.remainingQty <= 0 && qty > 0) done.add(op.seq);
      continue;
    }
    // Every operation before it is counted locally — the ERP never sees a
    // cover that has been sewn and not yet stapled.
    if (qty > 0 && progress.done(rowId) >= qty) done.add(op.seq);
  }
  return done;
}

/**
 * One board row per operation the order has actually reached.
 *
 * The row carries the operation's hours and the order's quantities, and is
 * filed under `ASM8001#20`. That key is the board's, not the plant's: the
 * order number on the row, in the inspector and in everything written back is
 * `ASM8001`, once.
 *
 * An operation still in front of the order gets no row. The bench it is bound
 * for is not empty in the numbers — `tailHours` is what the lane header counts
 * as on its way — it just has nothing to allocate people to yet, which is the
 * truth: you cannot staple a cover that has not been sewn.
 */
function operationRow(
  job: Job,
  op: Operation,
  ops: readonly Operation[],
): Job {
  const index = ops.findIndex((held) => held.seq === op.seq);
  const last = index === ops.length - 1;
  const def = stepLine(
    readLineKey(String(job.line ?? '')) ?? op.line,
    op.step,
  );
  return {
    ...job,
    id: opRowId(String(job.id), op.seq),
    laborHrs: Math.max(0, op.stdHours),
    line: def?.id ?? job.line,
    /*
     * Before the last operation the ERP's quantities say nothing useful: they
     * move on receipt, and nothing has been received. So the operation starts
     * with the whole order in front of it and is worked down by what the shift
     * confirms on this bench. The last operation keeps the ERP's figures,
     * because there they are the same fact.
     */
    ...(last
      ? {}
      : { completedQty: 0, remainingQty: wholeQty(job) }),
    operation: {
      jobNum: job.id,
      seq: op.seq,
      step: op.step,
      index: index + 1,
      of: ops.length,
      last,
      tail: tailOf(ops, op.seq),
      tailHours: tailHoursOf(ops, op.seq),
      orderHours: ops.reduce((sum, held) => sum + Math.max(0, held.stdHours), 0),
    },
  };
}

/**
 * Place every routed order on the bench it has reached, and leave the rest
 * alone.
 *
 * Run where the progress is known, which is the board — an order's position on
 * its route is a function of what has been booked against it, so it cannot be
 * settled when the export lands.
 */
export function expandRouting(
  jobs: readonly Job[],
  links: readonly JobMaterialLink[],
  progress: OperationProgress = NO_PROGRESS,
): Job[] {
  const out: Job[] = [];
  for (const job of jobs) {
    const ops = routingOf(job, links);
    if (!ops || ops.length === 0) {
      out.push(job);
      continue;
    }
    const done = finishedSeqs(job, ops, progress);
    const live = workableOps(ops, done);
    // Nothing workable means the route is finished. The order stays on the
    // board at its last operation for the confirmation day, exactly as an
    // unrouted order does.
    const rows = live.length > 0 ? live : [ops[ops.length - 1]];
    for (const op of rows) out.push(operationRow(job, op, ops));
  }
  return out;
}
