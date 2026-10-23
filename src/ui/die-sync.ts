// New parts onto their dies, once per page load.
//
// Planning.csv brings a part PMD_ProductDieColor has no row for — a new
// colour, usually, of a tool already on the list — and without the row the
// operator sheet cannot say which die to fit and the KPI page cannot
// colour or categorise it. core/die-match places it by its description;
// this reads what that needs, writes each placement as a new row, and
// keeps what it could not place for the supervisor's panel on the Tool
// page.

import type { PmdDataLayer } from '../dal';
import { matchNewParts, type DieMatch, type DieMiss, type NewPart } from '../core/die-match';

export interface DieSyncResult {
  checkedAt: Date;
  /** Placed and written to PMD_ProductDieColor. */
  added: DieMatch[];
  /** Placed, but not written — this device does not write (see `write`). */
  pending: DieMatch[];
  /** Placed, and the write failed. */
  failed: Array<{ match: DieMatch; error: string }>;
  /** Not placed: no description, nothing alike, or alike on several dies. */
  misses: DieMiss[];
}

let current: Promise<DieSyncResult> | null = null;
const listeners = new Set<(r: DieSyncResult) => void>();

/** The latest check of this page load, if one has run. */
export function lastDieSync(): Promise<DieSyncResult> | null {
  return current;
}

/** Be told when a check finishes (the Tool page re-renders its panel). */
export function onDieSync(fn: (r: DieSyncResult) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Check Planning.csv's parts against PMD_ProductDieColor and add the ones
 * that can be placed. `write` false only lists them — a read-only device
 * leaves the writing to one that may.
 */
export function syncNewPartDies(dal: PmdDataLayer, opts: { write: boolean }): Promise<DieSyncResult> {
  current = run(dal, opts).then((r) => {
    for (const fn of listeners) fn(r);
    return r;
  });
  return current;
}

async function run(dal: PmdDataLayer, opts: { write: boolean }): Promise<DieSyncResult> {
  const empty: DieSyncResult = { checkedAt: new Date(), added: [], pending: [], failed: [], misses: [] };
  if (!dal.listProductDieColors) return empty;
  const [planning, known, history] = await Promise.all([
    dal.listPlanning({}),
    dal.listProductDieColors({ fresh: true }),
    dal.listPartDescriptions ? dal.listPartDescriptions() : Promise.resolve(new Map<string, string>()),
  ]);
  // Descriptions: history first, Planning.csv over it (the newer wording).
  const descByPart = new Map(history);
  for (const o of planning) {
    const part = o.partNumber.trim().toUpperCase();
    if (part && o.partDescription.trim()) descByPart.set(part, o.partDescription.trim());
  }
  const registered = new Set(known.map((k) => k.partNumber.trim().toUpperCase()));
  const seen = new Set<string>();
  const newParts: NewPart[] = [];
  for (const o of planning) {
    const part = o.partNumber.trim();
    const key = part.toUpperCase();
    // ERP orders only: a die change is not a part, and a supervisor's
    // manual order is typed by hand.
    if (!part || o.isDieChange || o.source !== 'ERP' || registered.has(key) || seen.has(key)) continue;
    seen.add(key);
    newParts.push({ partNumber: part, description: o.partDescription });
  }
  const { matches, misses } = matchNewParts(newParts, known, descByPart);
  const result: DieSyncResult = { ...empty, checkedAt: new Date(), misses };
  for (const m of matches) {
    if (!opts.write || !dal.createProductDieColor) {
      result.pending.push(m);
      continue;
    }
    try {
      await dal.createProductDieColor(m);
      result.added.push(m);
      console.info(`[pmd] PMD_ProductDieColor: added ${m.partNumber} on die ${m.dieNumber} (like ${m.siblings.join(', ')})`);
    } catch (e) {
      result.failed.push({ match: m, error: (e as Error).message || String(e) });
    }
  }
  return result;
}
