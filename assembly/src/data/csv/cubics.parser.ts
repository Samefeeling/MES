/**
 * The cubics sheet (saved from Excel as CSV) → cube master.
 *
 *   (category), CODE, Name, Quantity, Volume per STACK, Length, Depth,
 *   Height, (blank), Volume, Weight Per Unit, Quantity, (blank), Per 20', Per 40'
 *
 * The header row is found by its names, so title rows above it are skipped.
 * Rows with nothing but a heading (`SOFT SEATING`) start a section. The
 * calculator columns on the right (the second `Quantity`, `Per 20'`,
 * `Per 40'`) are inputs for the sheet's own use and are ignored.
 *
 * A row with no code is kept out of the master and counted: the waybill only
 * carries part numbers, so a product without one cannot be matched.
 */

import { normalizeHeader, parseCsv } from '@/lib/csv';
import { cubicKey, type CubicItem, type CubicStack } from '@/domain/cubics';

export interface CubicsParseResult {
  items: CubicItem[];
  /** Rows that describe a product but carry no code. */
  withoutCode: string[];
  warnings: string[];
  error: string | null;
}

const num = (raw: string | undefined): number | null => {
  const s = (raw ?? '').replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Excel saves CSV with commas; a pasted or exported sheet may use tabs. */
function delimiterOf(text: string): string {
  const head = text.slice(0, 4096);
  const tabs = (head.match(/\t/g) ?? []).length;
  const commas = (head.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/** Does this text look like the cubics sheet rather than another export? */
export function looksLikeCubics(text: string): boolean {
  const rows = parseCsv(text.slice(0, 8192), delimiterOf(text));
  return rows.slice(0, 20).some((row) => {
    const names = new Set(row.map(normalizeHeader));
    return names.has('code') && names.has('volumeperstack');
  });
}

export function parseCubicsCsv(text: string): CubicsParseResult {
  const rows = parseCsv(text, delimiterOf(text));
  const headerAt = rows.findIndex((row) => {
    const names = row.map(normalizeHeader);
    return names.includes('code') && names.includes('volumeperstack');
  });
  if (headerAt < 0) {
    return {
      items: [],
      withoutCode: [],
      warnings: [],
      error: 'Not a cubics sheet: no "CODE" and "Volume per STACK" header row.',
    };
  }

  // First occurrence wins: the sheet has a second `Quantity` (calculator input).
  const header = rows[headerAt].map(normalizeHeader);
  const at = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    code: at('code', 'partnum'),
    name: at('name', 'description'),
    qty: at('quantity', 'qty'),
    stack: at('volumeperstack'),
    length: at('length'),
    depth: at('depth', 'width'),
    height: at('height'),
    unitVolume: at('volume'),
    weight: at('weightperunit', 'weight'),
  };
  // The category sits in an unnamed first column.
  const categoryCol = header[0] === '' && col.code !== 0 ? 0 : -1;

  const cell = (row: string[], i: number): string => (i < 0 ? '' : (row[i] ?? '').trim());
  const items = new Map<string, CubicItem>();
  const withoutCode: string[] = [];
  const warnings: string[] = [];
  let section = '';

  rows.slice(headerAt + 1).forEach((row, i) => {
    const line = headerAt + i + 2;
    const code = cell(row, col.code);
    const name = cell(row, col.name);
    const qty = num(cell(row, col.qty));
    const lengthMm = num(cell(row, col.length));
    const depthMm = num(cell(row, col.depth));
    const heightMm = num(cell(row, col.height));

    if (!code && qty === null) {
      // A heading row: the only text is the section name.
      const text = row.map((c) => c.trim()).filter((c) => c && Number.isNaN(Number(c)));
      if (text.length === 1) section = text[0];
      return;
    }
    if (!code) {
      if (name) withoutCode.push(name);
      return;
    }
    if (qty === null || qty <= 0) {
      warnings.push(`Row ${line}: ${code} has no stack quantity, skipped`);
      return;
    }

    let volume = num(cell(row, col.stack));
    if ((volume === null || volume <= 0) && lengthMm && depthMm && heightMm) {
      volume = (lengthMm * depthMm * heightMm) / 1e9;
    }
    if ((volume === null || volume <= 0) && qty > 0) {
      const unit = num(cell(row, col.unitVolume));
      if (unit) volume = unit * qty;
    }
    if (volume === null || volume <= 0) {
      warnings.push(`Row ${line}: ${code} has no volume, skipped`);
      return;
    }

    const stack: CubicStack = { qty, volumeM3: volume, lengthMm, depthMm, heightMm };
    const key = cubicKey(code);
    const weight = num(cell(row, col.weight));
    const existing = items.get(key);
    if (existing) {
      // The same stack size twice keeps the first; it is the sheet's own order.
      if (!existing.stacks.some((s) => s.qty === qty)) existing.stacks.push(stack);
      if (existing.weightKg === null && weight !== null) existing.weightKg = weight;
      return;
    }
    items.set(key, {
      code,
      name,
      category: cell(row, categoryCol),
      section,
      stacks: [stack],
      weightKg: weight,
    });
  });

  for (const item of items.values()) item.stacks.sort((a, b) => a.qty - b.qty);
  return { items: [...items.values()], withoutCode, warnings, error: null };
}
