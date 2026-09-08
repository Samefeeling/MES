/**
 * Shift patterns. The workbook references patterns by name ("3shift") in the
 * planning sheet's `no of shift` column rather than defining them, so the
 * canonical definitions live in `domain/constants`. This parser surfaces which
 * patterns are actually in use (col 27 of `planning`) and falls back to the
 * full catalogue.
 */

import type { ShiftPattern } from '@/domain/types';
import { SHIFT_PATTERNS } from '@/domain/constants';
import { asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const SHIFT_COL = 27;

export function parseShifts(planning: Sheet): ParseOutcome<ShiftPattern> {
  const used = new Set<string>();
  for (const row of dataRows(planning)) {
    const raw = asStr(row[SHIFT_COL]);
    if (raw && SHIFT_PATTERNS[raw]) used.add(raw);
  }
  const values =
    used.size > 0
      ? [...used].map((k) => SHIFT_PATTERNS[k])
      : Object.values(SHIFT_PATTERNS);
  return { values, errors: [] };
}
