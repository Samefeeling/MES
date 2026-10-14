/**
 * The one join between the two pages: an Assembly job is built for a sales
 * order, and its job number says which.
 *
 * Epicor names a make-to-order job after the order release it fills — the
 * order number with a leading `0`, then the order line and the release:
 * `018140-1-1` builds order `18140`, line 1, release 1, the same `Order`,
 * `Line` and `Rel` the waybill carries. Stock jobs (`SFM…`, `ASM…`) are built
 * for no order and map to nothing.
 */

export interface SalesOrderRef {
  /** The order number as the waybill writes it, leading zeros dropped. */
  order: string;
  /** Order line, when the job number carries one. */
  line: string | null;
  /** Release, when the job number carries one. */
  rel: string | null;
}

/** An order number in one spelling, so `018140` and `18140` compare equal. */
export const orderKey = (order: string): string => order.trim().replace(/^0+(?=\d)/, '');

/** Order line or release number in one spelling (`01` is line 1). */
export const lineKey = (line: string): string => line.trim().replace(/^0+(?=\d)/, '');

const JOB = /^(0*)(\d+)(?:-(\d+)(?:-(\d+))?)?(?:[-/.][A-Za-z0-9]+)*$/;

/**
 * The sales order an Assembly job is built for, or null for a stock job. A
 * job counts as built to order when it has the leading `0` or the
 * order-line-release dashes; a bare number with neither could be anything.
 */
export function salesOrderOfJob(jobNum: string): SalesOrderRef | null {
  const m = JOB.exec(jobNum.trim());
  if (!m) return null;
  const [, zeros, order, line, rel] = m;
  if (!zeros && !line) return null;
  return { order: orderKey(order), line: line ? lineKey(line) : null, rel: rel ? lineKey(rel) : null };
}
