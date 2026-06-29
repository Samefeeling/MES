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
