/**
 * A production order's routing: the operations it passes through, in order.
 *
 * This is the standard shape every ERP uses and the one the floor works to. An
 * order is *one* order with *one* number. What changes as it is built is its
 * position in the routing — operation 10 foaming, then 20 sewing, then 30
 * stapling. The order is at exactly one of them at a time, except where two
 * are genuinely worked side by side.
 *
 * The board used to copy the order once per bench, which gave one job three
 * numbers, three bars and three quantities standing in three places at once.
 * That is not what a second bench is: it is the same order, one step further
 * along. So nothing here derives an order. It derives the *route* an order
 * takes, and the board shows the order at the step it has reached.
 *
 * Two rules follow from it, and they are the whole of why this file exists:
 *
 *   - The units are received **once**, at the last operation. Confirming ten
 *     covers sewn is not ten covers finished; it is ten covers ready to be
 *     stapled.
 *   - The standard hours are **partitioned** across the operations, never
 *     added to. Sewing's four and a half hours were always inside the order's
 *     twenty-six; splitting the route does not create work.
 */

import { JobId } from './ids';
import type { LineKey, ProductionStep } from './assembly';

/**
 * How an operation row is keyed: the order number, then the sequence.
 *
 * A key, not a job number. `ASM8001#20` is operation 20 of order ASM8001 —
 * what the board files the row, its crew and its bookings under. Everything
 * anyone reads or writes outside the board says `ASM8001`, which is the only
 * number the plant has: see `jobNumOf`.
 */
export const OP_MARK = '#';

/** One step of a route, as the routing rules define it. */
export interface Operation {
  /** 10, 20, 30 — the ERP convention, leaving room to insert. */
  seq: number;
  step: ProductionStep;
  /** The bench that works it. */
  line: LineKey;
  /** This operation's share of the order's standard hours. */
  stdHours: number;
  /** Operations that must be finished first. Empty means it can start now. */
  after: readonly number[];
}

/** The operation a board row *is*, carried on the row's job. */
export interface JobOperation {
  /** The order number — the real one, the only one. */
  jobNum: JobId;
  seq: number;
  step: ProductionStep;
  /** 1-based position in the route, and how many operations there are. */
  index: number;
  of: number;
  /**
   * The receiving operation. Units enter stock here and nowhere else, so this
   * is the one row whose quantities are the order's quantities.
   */
  last: boolean;
  /**
   * The benches still in front of the order once this operation is finished,
   * and the hours each is owed.
   *
   * Counted over the operations that genuinely follow this one, so a parallel
   * sibling — Gluing's foaming and sewing — is not counted by both of them.
   * Two things read it: the order's expected finish, because an order that has
   * sewn everything is not an order that is finished, and the bench it is
   * heading for, whose queue is real long before the order arrives on it.
   */
  tail: readonly TailStep[];
  /** `tail` added up. */
  tailHours: number;
  /**
   * The whole order's standard hours — what the operations divide between
   * them. Carried because everything written back reports the order, and the
   * order's content is not the bench's.
   */
  orderHours: number;
}

/** The row key for one operation of one order. */
export const opRowId = (jobNum: string, seq: number): JobId =>
  JobId(`${jobNum}${OP_MARK}${seq}`);

/** The order number behind a row key — itself, for a row with no route. */
export const jobNumOf = (rowId: string): string =>
  rowId.includes(OP_MARK) ? rowId.slice(0, rowId.indexOf(OP_MARK)) : rowId;

/** The sequences that transitively depend on `seq`. */
export function afterOf(
  ops: readonly Operation[],
  seq: number,
): Set<number> {
  const out = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const op of ops) {
      if (out.has(op.seq) || op.seq === seq) continue;
      if (op.after.some((s) => s === seq || out.has(s))) {
        out.add(op.seq);
        grew = true;
      }
    }
  }
  return out;
}

/** A bench still to come, and the hours it is owed. */
export interface TailStep {
  line: LineKey;
  step: ProductionStep;
  hours: number;
}

/**
 * The work left on the route once `seq` is finished, bench by bench.
 *
 * Counted over the operations that genuinely follow — a parallel sibling is
 * nobody's tail — so adding every row's tail to the benches it names counts
 * each operation exactly once.
 */
export function tailOf(
  ops: readonly Operation[],
  seq: number,
): TailStep[] {
  const after = afterOf(ops, seq);
  return ops
    .filter((op) => after.has(op.seq))
    .map((op) => ({ line: op.line, step: op.step, hours: Math.max(0, op.stdHours) }));
}

/** Those hours added up. */
export const tailHoursOf = (ops: readonly Operation[], seq: number): number =>
  tailOf(ops, seq).reduce((sum, step) => sum + step.hours, 0);

/**
 * The operations that can be worked right now: not finished, and with nothing
 * unfinished in front of them.
 *
 * Usually one. Two only where the route says two branches start together,
 * which on this floor is Gluing's foaming and sewing — two benches, two
 * crews, one order.
 */
export function workableOps(
  ops: readonly Operation[],
  done: ReadonlySet<number>,
): Operation[] {
  return ops.filter(
    (op) => !done.has(op.seq) && op.after.every((s) => done.has(s)),
  );
}
