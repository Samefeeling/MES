/**
 * Hot stamp batches: several orders run together on HS and signed off as one.
 *
 * Hot stamp runs small orders back to back on one set-up, and starting,
 * confirming and signing off each of them was most of the operator's shift.
 * So on HS an order already running can take other orders of HS's own list
 * with it. The sheet keeps ONE timeline — the first order's — while they run,
 * and at sign-off the operator types each order's Good and Reject in a list.
 *
 * The press time is then shared out and recorded the way every other order's
 * is, as half-hours of its own: each order gets a block of the timeline's
 * running (R) half-hours in proportion to what it stamped (Good + Reject),
 * the blocks laid end to end in plan order. Because each order ends up with
 * an ordinary timeline of its own, Efficiency, Utilization, Shift Target,
 * Schedule Adherence and Trace read a batch exactly as they read any shift —
 * nothing downstream knows a batch happened.
 *
 * - Shares are whole half-hours (the record's grain), by largest remainder,
 *   and every order that stamped anything gets at least one: an order with
 *   pieces and no running time would have no rate at all.
 * - A half-hour that is not running (a breakdown, a break, a colour change)
 *   belongs to the block it falls in; one between two blocks belongs to the
 *   next order, one before the first R to the first, one after the last R to
 *   the last — so each order's slots stay one contiguous stretch.
 * - An order that stamped nothing is left out: it did not run, and stays open.
 *
 * Pure. No DOM, no data layer.
 */

import type { StatusCode } from '../types';

/**
 * Presses that run batches: hot stamp only, for now. The machine register
 * calls it `Hstamp` and Planning.csv calls it `HS` (see
 * planningOrderMatchesMachine), so both names are the press.
 */
export const BATCH_MACHINES = ['HSTAMP', 'HS'] as const;

export const canBatch = (machineCode: string): boolean =>
  (BATCH_MACHINES as readonly string[]).includes(machineCode.trim().toUpperCase());

/** One order of a batch, as the sign-off list has it. */
export interface BatchOrder {
  job: string;
  /** Planned start (local ISO); '' or undefined for an order with none. */
  plannedStart?: string;
  good: number;
  reject: number;
}

/** A half-hour of the batch's timeline. */
export interface BatchSlot {
  slotIndex: number;
  statusCode: StatusCode | '';
}

/** The batch's jobs as stored on the first order's record: `A,B,C`. */
export function parseBatchJobs(raw: string | undefined | null): string[] {
  return [...new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}

export const formatBatchJobs = (jobs: readonly string[]): string =>
  parseBatchJobs(jobs.join(',')).join(',');

/**
 * Orders in plan order: by planned start, an order with none after those
 * that have one, and otherwise as given (the list's own order).
 */
export function inPlanOrder<T extends { plannedStart?: string }>(orders: readonly T[]): T[] {
  return orders
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const pa = a.o.plannedStart ?? '';
      const pb = b.o.plannedStart ?? '';
      if (pa && pb && pa !== pb) return pa < pb ? -1 : 1;
      if (!pa !== !pb) return pa ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ o }) => o);
}

/**
 * `slots` whole half-hours shared in proportion to `weights` (all > 0), each
 * getting at least one. Largest remainder; ties go to the earlier order.
 * Needs `slots >= weights.length`.
 */
export function shareSlots(slots: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  if (weights.length === 0 || total <= 0) return weights.map(() => 0);
  const ideal = weights.map((w) => (slots * w) / total);
  const out = ideal.map((x) => Math.max(1, Math.floor(x)));
  let sum = out.reduce((a, n) => a + n, 0);
  while (sum < slots) {
    let best = 0;
    for (let i = 1; i < out.length; i++) if (ideal[i] - out[i] > ideal[best] - out[best]) best = i;
    out[best]++;
    sum++;
  }
  while (sum > slots) {
    // Take from the order furthest over its ideal that can spare one.
    let worst = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] <= 1) continue;
      if (worst < 0 || out[i] - ideal[i] > out[worst] - ideal[worst]) worst = i;
    }
    if (worst < 0) break;
    out[worst]--;
    sum--;
  }
  return out;
}

export interface BatchSplit {
  /** Slot index → the job it is recorded on. Every filled slot has one. */
  owner: Map<number, string>;
  /** The jobs recorded, in plan order — those that stamped anything. */
  jobs: string[];
  /** Running half-hours each job is given. */
  runSlots: Record<string, number>;
  /** Jobs left out because they stamped nothing. */
  skipped: string[];
}

export type BatchSplitResult = { ok: true; split: BatchSplit } | { ok: false; error: string };

/** Share the batch's timeline among its orders — see the file comment. */
export function splitBatchSlots(slots: readonly BatchSlot[], orders: readonly BatchOrder[]): BatchSplitResult {
  const filled = slots.filter((s) => s.statusCode).sort((a, b) => a.slotIndex - b.slotIndex);
  const ordered = inPlanOrder(orders);
  const weight = (o: BatchOrder): number => Math.max(0, o.good || 0) + Math.max(0, o.reject || 0);
  const ran = ordered.filter((o) => weight(o) > 0);
  const skipped = ordered.filter((o) => weight(o) <= 0).map((o) => o.job);
  if (ran.length === 0) return { ok: false, error: 'No order in the batch has any Good or Reject.' };
  const running = filled.filter((s) => s.statusCode === 'R').length;
  if (running < ran.length) {
    return {
      ok: false,
      error: `${ran.length} orders stamped pieces but the timeline has only ${running} running half-hour${
        running === 1 ? '' : 's'
      } — each order needs at least one.`,
    };
  }
  const quota = shareSlots(running, ran.map(weight));
  const runSlots: Record<string, number> = {};
  ran.forEach((o, i) => (runSlots[o.job] = quota[i]));
  const left = [...quota];
  const owner = new Map<number, string>();
  let at = 0;
  for (const s of filled) {
    // Move on once this order's running half-hours are all given out — but
    // never past the last order, which takes whatever trails the last R.
    while (left[at] === 0 && at < ran.length - 1) at++;
    owner.set(s.slotIndex, ran[at].job);
    if (s.statusCode === 'R') left[at]--;
  }
  return { ok: true, split: { owner, jobs: ran.map((o) => o.job), runSlots, skipped } };
}
