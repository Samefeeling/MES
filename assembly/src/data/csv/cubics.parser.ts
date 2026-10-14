/**
 * `Cubics.csv` → cube master. Two layouts are read, told apart by the header:
 *
 * - **The cubics sheet** ("Drews Cubics and Freight Calc"), one row per part
 *   and stack size:
 *
 *     (category), CODE, Name, Quantity, Volume per STACK, Length, Depth,
 *     Height, (blank), Volume, Weight Per Unit, Quantity, (blank), Per 20', Per 40'
 *
 * - **A part list**: a part column (`Part`, `CODE`, `PartNum`) and `Volume`,
 *   the m³ of one piece, with no stack sizes — each piece counts whole, so an
 *   order line of 10 is 10 × its volume. Length, depth and height in mm stand
 *   in for a blank volume; a weight column is read when there is one.
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
  // A figure written with its unit: `0.25 m3`, `12 kg`.
  const withUnit = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:m3|m³|cbm|kg|mm)$/i.exec(s);
  const n = Number(withUnit ? withUnit[1] : s);
  return Number.isFinite(n) ? n : null;
};

/** Excel saves CSV with commas; a pasted or exported sheet may use tabs. */
function delimiterOf(text: string): string {
  const head = text.slice(0, 4096);
  const tabs = (head.match(/\t/g) ?? []).length;
  const commas = (head.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/** The product code's header, as the sheet or a part list may name it. */
const CODE_NAMES = ['code', 'part', 'partnum', 'partnumber', 'partno', 'itemcode', 'productcode'];
/** The stack's volume: `Volume per STACK`, perhaps with its unit after it. */
const isStackVolume = (name: string): boolean => name.startsWith('volumeperstack') || name === 'stackvolume';
/** One piece's volume in m³, in a part list. */
const UNIT_VOLUME_NAMES = [
  'volume',
  'volumem3',
  'unitvolume',
  'volumeperunit',
  'cbm',
  'm3',
  'cube',
  'cubic',
  'cubicmetres',
  'cubicmeters',
];

type Layout = 'sheet' | 'parts';

/** Where the header row is — however far down, below title rows — and which layout it heads. */
function headerRow(rows: readonly string[][]): { at: number; layout: Layout } | null {
  for (let at = 0; at < rows.length; at++) {
    const names = rows[at].map(normalizeHeader);
    if (!names.some((n) => CODE_NAMES.includes(n))) continue;
    if (names.some(isStackVolume)) return { at, layout: 'sheet' };
    if (names.some((n) => UNIT_VOLUME_NAMES.includes(n))) return { at, layout: 'parts' };
  }
  return null;
}

/** Does this text look like a cube master rather than another export? */
export function looksLikeCubics(text: string): boolean {
  return headerRow(parseCsv(text, delimiterOf(text))) !== null;
}

/**
 * Why a file is not the cubics sheet, in words that say what to do: an Excel
 * workbook renamed, or a sheet with other columns — often the workbook's
 * other sheet, since Excel saves only the one that is open as CSV.
 */
export function whyNotCubics(text: string): string {
  if (text.startsWith('PK')) return 'it is an Excel workbook renamed to .csv — open it in Excel and save it as CSV';
  const first = parseCsv(text.slice(0, 8192), delimiterOf(text))
    .map((row) => row.map((c) => c.trim()).filter(Boolean))
    .find((cells) => cells.length > 0);
  if (!first) return 'it is empty';
  const shown = first.slice(0, 6).join(', ') + (first.length > 6 ? ', …' : '');
  return (
    `no header row with a part column (Part or CODE) and a volume (Volume or Volume per STACK); ` +
    `its first row reads "${shown.slice(0, 120)}". Excel saves only the sheet that is open as CSV`
  );
}

export function parseCubicsCsv(text: string): CubicsParseResult {
  const rows = parseCsv(text, delimiterOf(text));
  const found = headerRow(rows);
  if (!found) {
    return {
      items: [],
      withoutCode: [],
      warnings: [],
      error: 'Not a cube master: no header row with a part column (Part or CODE) and a volume (Volume or Volume per STACK).',
    };
  }
  const { at: headerAt, layout } = found;

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
    code: at(...CODE_NAMES),
    name: at('name', 'description', 'partdescription', 'partdesc'),
    qty: at('quantity', 'qty'),
    stack: header.findIndex(isStackVolume),
    length: at('length'),
    depth: at('depth', 'width'),
    height: at('height'),
    unitVolume: at(...UNIT_VOLUME_NAMES),
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
    // A part list has no stack sizes: every piece is a stack of one.
    const qty = layout === 'parts' ? 1 : num(cell(row, col.qty));
    const lengthMm = num(cell(row, col.length));
    const depthMm = num(cell(row, col.depth));
    const heightMm = num(cell(row, col.height));

    if (!code && (layout === 'parts' || qty === null)) {
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

    let volume = num(cell(row, layout === 'parts' ? col.unitVolume : col.stack));
    if ((volume === null || volume <= 0) && lengthMm && depthMm && heightMm) {
      // Millimetres, as the sheet gives them; a product under 1,000 can only be metres.
      const product = lengthMm * depthMm * heightMm;
      volume = product >= 1000 ? product / 1e9 : product;
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
