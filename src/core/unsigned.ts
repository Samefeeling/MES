/**
 * Work booked and not signed off, as KPIs see it: every (press, shift,
 * order) with production on its sheet and no signed record.
 *
 * KPIs credit signed work only. What it cannot credit it must still name,
 * or a sign-off somebody forgot reads as a press that never ran. This list
 * is that naming, and it does not depend on a plan: an order that ran on a
 * press nobody planned, or beside an order of the same shift that was
 * signed, is unsigned all the same. (The page used to mark a shift
 * "unsigned" only when every order of it was, and only where it was
 * planned.)
 */

import type { ProductionRecord } from '../types';

export interface UnsignedTuple {
  machineCode: string;
  shiftId: string;
  jobNumber: string;
}

/** A row that records production: a machine status, a counter or a reject. */
function recordsWork(r: ProductionRecord): boolean {
  return !!r.statusCode || r.countStart != null || r.countEnd != null || r.rejectCount > 0;
}

const tupleKey = (machineCode: string, shiftId: string, jobNumber: string): string =>
  `${machineCode.trim().toUpperCase()}|${shiftId}|${jobNumber.trim().toUpperCase()}`;

/**
 * The tuples among `records` (signed and unsigned rows, as `listProduction`
 * returns them) that carry work and have no signed row, sorted by shift,
 * press and order. `keep` narrows the shifts (the finished ones of the
 * period, on the KPI page).
 */
export function unsignedTuples(
  records: ReadonlyArray<ProductionRecord>,
  keep: (shiftId: string) => boolean = () => true,
): UnsignedTuple[] {
  const signed = new Set<string>();
  for (const r of records) if (r.locked) signed.add(tupleKey(r.machineCode, r.shiftId, r.jobNumber));
  const found = new Map<string, UnsignedTuple>();
  for (const r of records) {
    if (r.locked || !r.jobNumber.trim() || !recordsWork(r) || !keep(r.shiftId)) continue;
    const key = tupleKey(r.machineCode, r.shiftId, r.jobNumber);
    if (signed.has(key) || found.has(key)) continue;
    found.set(key, { machineCode: r.machineCode.trim(), shiftId: r.shiftId, jobNumber: r.jobNumber.trim() });
  }
  return [...found.values()].sort(
    (a, b) => a.shiftId.localeCompare(b.shiftId) || a.machineCode.localeCompare(b.machineCode) || a.jobNumber.localeCompare(b.jobNumber),
  );
}

/** The shifts of a press with unsigned work and no signed record at all — waiting on their supervisor as a whole. */
export function shiftsAwaitingSignOff(
  records: ReadonlyArray<ProductionRecord>,
  unsigned: ReadonlyArray<UnsignedTuple>,
): Set<string> {
  const signedShifts = new Set(records.filter((r) => r.locked).map((r) => r.shiftId));
  return new Set(unsigned.map((t) => t.shiftId).filter((sid) => !signedShifts.has(sid)));
}

/**
 * Mark the plan lines of orders that are not signed off. A shift waiting as
 * a whole has every line marked already; this reaches the order left
 * unsigned beside another that was signed.
 */
export function markUnsignedLines<T extends { machineCode: string; shiftId: string; jobNumber: string; unsigned?: boolean }>(
  lines: ReadonlyArray<T>,
  unsigned: ReadonlyArray<UnsignedTuple>,
): T[] {
  if (!unsigned.length) return [...lines];
  const keys = new Set(unsigned.map((t) => tupleKey(t.machineCode, t.shiftId, t.jobNumber)));
  return lines.map((line) =>
    !line.unsigned && line.jobNumber && keys.has(tupleKey(line.machineCode, line.shiftId, line.jobNumber))
      ? { ...line, unsigned: true }
      : line,
  );
}

/** "24/11 Day · 1600T · SFM507147" — one tuple, for a tooltip. */
export function unsignedLabel(t: UnsignedTuple, withPress = true): string {
  const day = `${t.shiftId.slice(8, 10)}/${t.shiftId.slice(5, 7)}`;
  const shift = t.shiftId.slice(11);
  return [`${day} ${shift}`, ...(withPress ? [t.machineCode] : []), t.jobNumber].join(' · ');
}
