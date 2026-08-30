// Co-running orders: a single die can run 2-3 different parts at the same
// time on one press. The floor marks which parts genuinely run together
// with a Yes/No CoRun flag on PMD_ProductDieColor (sharing a die alone is
// not enough — different colours share a die and often run sequentially).
// This pure rule is shared by the operator sheet (status mirror, switch
// exemption) and the Trace board (showing every co-runner, not just one).

export interface DieCoRun {
  /** PMD_ProductDieColor.DieNumber for the part. */
  dieNumber: string;
  /** PMD_ProductDieColor.CoRun (Yes/No). */
  coRun: boolean;
}

/**
 * Two parts co-run — produced simultaneously on one die — only when BOTH
 * carry CoRun = Yes AND share the same non-empty die number. Either side
 * missing its die mapping, or either flag off, means they do not co-run.
 */
export function partsCoRun(a: DieCoRun | undefined, b: DieCoRun | undefined): boolean {
  if (!a || !b) return false;
  if (!a.coRun || !b.coRun) return false;
  const da = a.dieNumber.trim();
  return da !== '' && da === b.dieNumber.trim();
}

/**
 * Two ORDERS co-run only when their parts co-run (partsCoRun) AND the two
 * orders carry the SAME Order Quantity. A multi-cavity die makes one of each
 * part on every press cycle, so genuinely-simultaneous orders are scheduled
 * for equal quantities. A shared die with both parts flagged CoRun but with
 * different quantities means the colours are scheduled separately (one after
 * another), not run together — they must NOT mirror status. An unknown
 * quantity on either side can't be confirmed equal, so it does not co-run.
 */
export function ordersCoRun(
  a: DieCoRun | undefined,
  b: DieCoRun | undefined,
  qtyA: number | null | undefined,
  qtyB: number | null | undefined,
): boolean {
  if (!partsCoRun(a, b)) return false;
  if (qtyA == null || qtyB == null) return false;
  if (qtyA <= 0 || qtyB <= 0) return false;
  return qtyA === qtyB;
}
