/**
 * The other way round: what the order a job is built for needs of it.
 *
 * Dispatch asks of a load whether the factory finishes in time. The board asks
 * the same thing from the job's side: this job is line 5 of order 18532 —
 * when is that order planned to leave, and is this job what it is waiting for?
 *
 * The date is the waybill's `Ship By`: the planned dispatch day. `Need By` is
 * when the customer is to have it (and `ExpDeliveryDt` the same day unless
 * the order is running late), typically 7 days after Ship By in NSW, 14
 * interstate and four weeks overseas; the job's own Due Date
 * (`JobHead_ReqDueDate`) is the manufacturing due date, a week before Ship By.
 * So a job finishing after Ship By is an order that misses its truck, whatever
 * its own Due Date says.
 *
 * An order is only ready when its last line is, so a job finishing late
 * matters most when every other line is ready before it: then it is the one
 * line holding the whole order — `holds`.
 */

import type { DayKey, WaybillLine } from '@/domain/dispatch';
import { lineKey, orderKey } from '@/domain/orderLink';
import { isGoodsLine, isLineReady } from '@/data/csv/waybill.parser';
import { toDayKey } from '@/lib/time';
import type { BuildJob, OrderBuild } from './assemblyLink';
import type { LineSupply } from './lineSupply';

/** Where the job stands against its order's Ship By. */
export type ShipVerdict = 'done' | 'ok' | 'same-day' | 'late' | 'unknown';

export interface ShipInfo {
  order: string;
  line: string;
  rel: string;
  /** The waybill's Ship By for the job's line: the planned dispatch day. */
  shipBy: DayKey;
  needBy: DayKey | null;
  expDelivery: DayKey | null;
  /** Delivery zone, which decides how far ahead of Need By it ships. */
  zone: string;
  /** The day the job comes off the line, as the board plans it. */
  expect: DayKey | null;
  verdict: ShipVerdict;
  /** The order's other goods lines still open on the waybill. */
  others: number;
  /** Of those, how many are ready by Ship By. */
  othersByShip: number;
  /** The latest day one of them is ready; null when none is dated. */
  othersLatest: DayKey | null;
  /** Of those, how many have no date: no job date, no stock or PO. */
  othersUnknown: number;
  /** Every other line is ready before this job: the order waits on it alone. */
  holds: boolean;
}

/** The day a goods line is ready, or null when nothing says. */
function lineReadyDay(
  l: WaybillLine,
  jobs: readonly BuildJob[],
  supply: readonly LineSupply[],
  today: DayKey,
): DayKey | null {
  if (isLineReady(l)) return today;
  const ln = lineKey(l.line);
  const rel = lineKey(l.rel);
  if (l.fulfillment.trim().toLowerCase() === 'job') {
    const job = jobs.find((j) => j.orderLine === ln && (j.rel === null || j.rel === rel));
    if (!job) return null;
    if (job.state === 'done') return today;
    return job.expect ? toDayKey(job.expect) : null;
  }
  return supply.find((s) => s.line === ln && s.rel === rel)?.readyBy ?? null;
}

/**
 * Every job on the board built for a line still open on the waybill, by job
 * number, with its order's Ship By and whether it holds the order.
 */
export function shipByJob(
  lines: readonly WaybillLine[],
  builds: ReadonlyMap<string, OrderBuild>,
  supply: ReadonlyMap<string, LineSupply[]>,
  today: DayKey,
): Map<string, ShipInfo> {
  const byOrder = new Map<string, WaybillLine[]>();
  for (const l of lines) {
    const key = orderKey(l.order);
    const held = byOrder.get(key);
    if (held) held.push(l);
    else byOrder.set(key, [l]);
  }

  const out = new Map<string, ShipInfo>();
  for (const [order, orderLines] of byOrder) {
    const build = builds.get(order);
    if (!build) continue;
    const goods = orderLines.filter((l) => isGoodsLine(l) && l.leftToShip > 0);
    const orderSupply = supply.get(order) ?? [];
    for (const job of build.jobs) {
      if (job.orderLine === null) continue;
      const own = goods.find(
        (l) => lineKey(l.line) === job.orderLine && (job.rel === null || lineKey(l.rel) === job.rel),
      );
      if (!own?.shipBy) continue;
      const others = goods.filter((l) => l !== own);
      const ready = others.map((l) => lineReadyDay(l, build.jobs, orderSupply, today));
      const dated = ready.filter((d): d is DayKey => d !== null);
      const othersLatest = dated.length > 0 ? dated.reduce((a, b) => (a > b ? a : b)) : null;
      const expect = job.state === 'done' ? null : job.expect ? toDayKey(job.expect) : null;
      const verdict: ShipVerdict =
        job.state === 'done'
          ? 'done'
          : !expect
            ? 'unknown'
            : expect > own.shipBy
              ? 'late'
              : expect === own.shipBy
                ? 'same-day'
                : 'ok';
      const othersUnknown = ready.length - dated.length;
      out.set(job.jobId, {
        order,
        line: job.orderLine,
        rel: job.rel ?? lineKey(own.rel),
        shipBy: own.shipBy,
        needBy: own.needBy,
        expDelivery: own.expDelivery,
        zone: own.zone,
        expect,
        verdict,
        others: others.length,
        othersByShip: dated.filter((d) => d <= own.shipBy!).length,
        othersLatest,
        othersUnknown,
        holds:
          expect !== null &&
          others.length > 0 &&
          othersUnknown === 0 &&
          (othersLatest === null || othersLatest <= expect),
      });
    }
  }
  return out;
}
