/**
 * Shared helpers for reading raw worksheet cells.
 *
 * Parsers work over array-of-arrays sheets (`XLSX.utils.sheet_to_json` with
 * `header: 1`), addressing columns by index. The master workbook has merged
 * headers, duplicate labels and Excel error strings (`#N/A`, `#DIV/0!`), so
 * every read is defensive.
 */

export type RawCell = string | number | boolean | Date | null | undefined;
export type RawRow = RawCell[];
export type Sheet = RawRow[];

const EXCEL_ERRORS = new Set([
  '#N/A',
  '#VALUE!',
  '#REF!',
  '#DIV/0!',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '??',
]);

/** True for empty / blank / Excel-error cells. */
export function isBlank(v: RawCell): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || EXCEL_ERRORS.has(t);
  }
  return false;
}

/** Coerce to a trimmed string, or null when blank. */
export function asStr(v: RawCell): string | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** Coerce to a finite number, or null. Strips commas and stray text. */
export function asNum(v: RawCell): number | null {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Coerce to a number, defaulting to 0 when blank/invalid. */
export const asNumOr0 = (v: RawCell): number => asNum(v) ?? 0;

/** Coerce to a boolean. Accepts true/false, "TRUE"/"FALSE", 1/0, Y/N. */
export function asBool(v: RawCell): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = asStr(v)?.toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/** Coerce to a Date. Accepts JS Dates and ISO/parseable strings. */
export function asDate(v: RawCell): Date | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Drop the header row(s) and any fully-blank trailing rows. */
export function dataRows(sheet: Sheet, headerRows = 1): Sheet {
  const body = sheet.slice(headerRows);
  // Trim trailing all-blank rows (the `ohb` sheet reports ~1M rows).
  let end = body.length;
  while (end > 0 && body[end - 1].every(isBlank)) end--;
  return body.slice(0, end);
}
