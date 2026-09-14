/**
 * `product-lines.v3.json` — the plant's routing table for parts it already
 * makes, sitting beside `JobMaterialReq.csv` in the document library.
 *
 * It is the output of the same `classify-lines.mjs` the rules in
 * `domain/lineRules` are transcribed from, run over the full BOM export and
 * then reviewed by hand. That review is the point: the file is the answer for
 * every part the plant already builds, and the live rules are only there for
 * a part that has never been made before. Re-deriving a reviewed part from
 * its BOM every load would silently throw that correction away.
 *
 * Shape (extra keys ignored; `key` accepted in place of `line`):
 *
 *   {
 *     "generatedAt": "2026-09-01T…",
 *     "rows": [
 *       { "code": "PDSC00747U", "description": "…", "line": "UPL-Gluing",
 *         "key": "UPH", "confidence": "high", "evidence": [ … ] }
 *     ]
 *   }
 */

import { readLineKey, type LineKey } from './assembly';
import type { LineConfidence, LineRuleKey } from './lineRules';

export interface ProductLine {
  code: string;
  description: string;
  line: LineKey;
  confidence: LineConfidence;
  evidence: string[];
}

export interface ProductLineTable {
  /** Uppercased part code → its reviewed line. */
  byCode: Map<string, ProductLine>;
  /** Parts the file lists as never-scheduled (`EXCLUDE`), uppercased. */
  excluded: Set<string>;
  generatedAt: string;
  /** Anything wrong with the file, for the diagnostics banner. */
  errors: string[];
}

export const EMPTY_PRODUCT_LINES: ProductLineTable = {
  byCode: new Map(),
  excluded: new Set(),
  generatedAt: '',
  errors: [],
};

/**
 * The classifier's own verdict keys, and the display names it writes beside
 * them. Both are accepted because the file carries both, and a hand-edited
 * row is far more likely to have the readable one right.
 */
const RULE_KEY_TO_LINE: Record<LineRuleKey, LineKey | null> = {
  PMD: 'PMD',
  CUT: 'UPL_CUT_SEW',
  UPH: 'UPL_GLUING',
  SSU: 'UPL_SOFTIE',
  ASM: 'ASSY',
  EXCLUDE: null,
  UNKNOWN: null,
};

/** The line a row names, from either column. Null for EXCLUDE / UNKNOWN. */
export function lineFromRuleKey(key: LineRuleKey): LineKey | null {
  return RULE_KEY_TO_LINE[key] ?? null;
}

interface RowLine {
  line: LineKey | null;
  /** The file says this part is never scheduled. */
  excluded: boolean;
  /** The file says nobody has decided yet — deliberate, not a bad row. */
  unknown: boolean;
}

function readLine(row: Record<string, unknown>): RowLine {
  const rawLine = typeof row.line === 'string' ? row.line.trim() : '';
  const rawKey = typeof row.key === 'string' ? row.key.trim().toUpperCase() : '';

  // The whole string first. Three of the eight line names contain a hyphen,
  // so splitting before matching would turn "UPL-CUT" into "UPL" and file
  // every cutting part onto the gluing bench.
  const direct = readLineKey(rawLine);
  if (direct) return { line: direct, excluded: false, unknown: false };

  // "EXCLUDE — 配置器占位件" / "UNKNOWN — 需人工判定": the file writes the
  // verdict and its reason in one string. Split on the dashes that separate a
  // sentence, never on the hyphen inside a name.
  const head = rawLine.split(/[—–|:]/)[0].trim().toUpperCase();
  if (head === 'EXCLUDE' || rawKey === 'EXCLUDE') return { line: null, excluded: true, unknown: false };
  if (head === 'UNKNOWN' || rawKey === 'UNKNOWN') return { line: null, excluded: false, unknown: true };

  const named = readLineKey(head);
  if (named) return { line: named, excluded: false, unknown: false };
  if (rawKey && rawKey in RULE_KEY_TO_LINE) {
    return { line: lineFromRuleKey(rawKey as LineRuleKey), excluded: false, unknown: false };
  }
  return { line: null, excluded: false, unknown: false };
}

const CONFIDENCE = new Set<string>(['high', 'ruled', 'none']);

/**
 * Parse the file. A bad file is never fatal: the board falls back to
 * classifying from the BOM, which is worse (it loses the hand review) but
 * still places every order. So problems come back as errors to show, not as
 * a thrown load.
 */
export function parseProductLines(text: string): ProductLineTable {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      ...EMPTY_PRODUCT_LINES,
      byCode: new Map(),
      excluded: new Set(),
      errors: [`product-lines.v3.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Accept both the wrapped shape the script writes and a bare array, so a
  // file someone trimmed by hand still loads.
  const rows = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { rows?: unknown }).rows)
      ? ((doc as { rows: unknown[] }).rows)
      : null;
  if (!rows) {
    return {
      ...EMPTY_PRODUCT_LINES,
      byCode: new Map(),
      excluded: new Set(),
      errors: ['product-lines.v3.json has no "rows" array'],
    };
  }

  const byCode = new Map<string, ProductLine>();
  const excluded = new Set<string>();
  let unreadable = 0;

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    if (!code) continue;
    const { line, excluded: isExcluded, unknown } = readLine(row);
    if (isExcluded) {
      excluded.add(code.toUpperCase());
      continue;
    }
    if (!line) {
      // UNKNOWN is the file doing its job — saying nobody has decided yet, so
      // the live rules should. Only a line this board does not run is a fault.
      if (!unknown) unreadable++;
      continue;
    }
    const confidence = typeof row.confidence === 'string' && CONFIDENCE.has(row.confidence)
      ? (row.confidence as LineConfidence)
      : 'ruled';
    byCode.set(code.toUpperCase(), {
      code,
      description: typeof row.description === 'string' ? row.description : '',
      line,
      confidence,
      evidence: Array.isArray(row.evidence) ? row.evidence.filter((e): e is string => typeof e === 'string') : [],
    });
  }

  if (byCode.size === 0 && excluded.size === 0) {
    errors.push('product-lines.v3.json held no usable rows');
  }
  if (unreadable > 0) {
    // Named rather than counted silently: every one of these is a part that
    // now falls through to the live rules, and the fix is one cell in the file.
    errors.push(
      `product-lines.v3.json: ${unreadable} row${unreadable === 1 ? '' : 's'} name a line this board does not run — those parts will be classified from their BOM instead`,
    );
  }
  const generatedAt = !Array.isArray(doc) && typeof (doc as { generatedAt?: unknown }).generatedAt === 'string'
    ? String((doc as { generatedAt: string }).generatedAt)
    : '';
  return { byCode, excluded, generatedAt, errors };
}
