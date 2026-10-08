/**
 * Where the Cavities number comes from.
 *
 * Cavities is not an opinion — it is a physical fact about the tool in the
 * press, and the toolroom already records it on PMD_DieMaster.Cavities.
 * The operator sheet used to ask the worker to pick it from a dropdown,
 * and only on four presses named in the source. That was wrong in both
 * directions: a new multi-cavity die fitted to any other press had no way
 * to be entered at all, and where the dropdown did appear the number was
 * one more thing to forget — one that multiplies every output figure
 * downstream, because Total Good = (Count End − Count Start) × cavities −
 * Reject.
 *
 * So it is looked up rather than chosen. Picking the order fixes the
 * Part #, the part fixes the Die # (PMD_ProductDieColor), and the die
 * fixes the cavity count (PMD_DieMaster) — the count the row starts with.
 * It can still be lowered on the sheet afterwards: a cavity blocked off
 * runs the tool on fewer than it has (`runningCavities`).
 *
 * When the chain cannot answer, the count is 1 — the only safe assumption,
 * since it leaves the arithmetic exactly as it was before cavities
 * existed — and `reason` records where it broke. That distinction has to
 * survive to the screen: a genuine single-cavity die and a die whose
 * Cavities cell nobody ever filled in both read "×1", and only one of them
 * is worth chasing the toolroom about.
 */

export type CavityReason =
  /** PMD_DieMaster gave a real count. */
  | 'die'
  /** The die is in the register, but its Cavities cell is empty or 0. */
  | 'die-blank'
  /** The part resolves to a Die # that isn't in the register at all. */
  | 'no-die-row'
  /** PMD_ProductDieColor has no Die # for this part. */
  | 'no-die';

export interface CavitySource {
  /** Pieces per press cycle. Always ≥ 1: everything downstream multiplies
   *  by this, so a 0 would silently zero a shift's output. */
  count: number;
  /** The die the count came from, trimmed; '' when the chain broke before
   *  a die was known. */
  dieNumber: string;
  reason: CavityReason;
  /** True only when `count` is a real lookup rather than the fallback.
   *  Callers use it to decide whether the number is authoritative enough
   *  to overwrite what an operator entered by hand. */
  known: boolean;
}

/** Normalised key into the die register. The two SharePoint lists drift in
 *  case and padding, and a Die # differing only by a trailing space must
 *  not read as a missing tool. */
export const dieKey = (dieNumber: string): string => dieNumber.trim().toUpperCase();

export function resolveCavities(
  dieNumber: string,
  cavitiesByDie: ReadonlyMap<string, number | null>,
): CavitySource {
  const key = dieKey(dieNumber);
  if (!key) return { count: 1, dieNumber: '', reason: 'no-die', known: false };
  const die = dieNumber.trim();
  if (!cavitiesByDie.has(key)) {
    return { count: 1, dieNumber: die, reason: 'no-die-row', known: false };
  }
  const n = cavitiesByDie.get(key);
  // A blank cell arrives as null; a 0 or a negative is data entry gone
  // wrong. Both mean "nobody has told us", not "this tool makes no parts".
  if (n == null || !Number.isFinite(n) || n < 1) {
    return { count: 1, dieNumber: die, reason: 'die-blank', known: false };
  }
  // Half a cavity is not a thing — a fractional cell is rounded down
  // rather than inflating every count that comes off this tool.
  return { count: Math.floor(n), dieNumber: die, reason: 'die', known: true };
}

/** The one-line explanation the operator sheet puts on the Cavities field.
 *  Says where the number came from, or what is missing and who fixes it —
 *  the sheet owes them the reason. */
export function cavityNote(src: CavitySource): string {
  switch (src.reason) {
    case 'die':
      return `Die ${src.dieNumber} makes ${src.count} piece${
        src.count === 1 ? '' : 's'
      } per press cycle (PMD_DieMaster.Cavities). Total Good = (Count End − Count Start) × ${
        src.count
      } − Reject.`;
    case 'die-blank':
      return `Die ${src.dieNumber} has no Cavities recorded in PMD_DieMaster — counting 1 piece per cycle. Ask the toolroom to fill it in.`;
    case 'no-die-row':
      return `Die ${src.dieNumber} is not in the PMD_DieMaster register — counting 1 piece per cycle.`;
    default:
      return 'This part has no Die # in PMD_ProductDieColor, so the cavity count cannot be looked up — counting 1 piece per cycle.';
  }
}

/**
 * Cavities this shift actually runs on.
 *
 * The register says how many cavities the tool HAS; the press does not
 * always run them all. A damaged cavity is blocked off and the die keeps
 * running on the rest — a 4-cavity tool making 3 a cycle — so counting it
 * at the register's 4 would book a quarter of the shift's Good that was
 * never made. The number the row carries is therefore the one that counts:
 * the register's count, stamped on the row when it is born, or whatever the
 * operator or supervisor set it to since.
 *
 * Only a row with no number at all — written before the register knew the
 * tool — takes the register's answer, and failing that 1.
 */
export function runningCavities(stored: number | null | undefined, src: CavitySource): number {
  if (stored != null && Number.isFinite(stored) && stored >= 1) return Math.floor(stored);
  return src.count;
}

/** Cavities blocked off: how far the running count is below the register's. 0 when the register has no answer. */
export function blockedCavities(running: number, src: CavitySource): number {
  return src.known ? Math.max(0, src.count - running) : 0;
}

/**
 * The counts the sheet offers. Up to the register's count when it has one —
 * a tool cannot run more cavities than it has — else up to 8, and always
 * including the number the row already carries, so a value set before the
 * register was corrected still shows rather than silently changing.
 */
export function cavityChoices(running: number, src: CavitySource): number[] {
  const top = Math.max(src.known ? src.count : 8, running);
  return Array.from({ length: top }, (_, i) => i + 1);
}
