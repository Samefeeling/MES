/**
 * Find an order on the board by its number.
 *
 * A board of a hundred orders across eight lines, most of them folded, is not
 * a board anybody finds ASM80412 on by looking. The supervisor knows the
 * number — off the traveller, the phone, the ERP screen — and needs the row.
 *
 * One entry per order number, not per row: a routed order is one order at one
 * or two benches (`domain/routing`), and the reader asked for the order. The
 * entry says where it is, because "found" is not always "on screen": it may be
 * on no line yet, or kept off the board by Released Only.
 *
 * Pure. No React, no store.
 */

import type { AssemblyGanttView } from '@/engine/assembly/board';
import { STEP_NAME, type LineKey } from '@/domain/assembly';
import { jobNumOf } from '@/domain/routing';

export type FindStatus =
  /** Drawn on a line of the board on screen. */
  | 'board'
  /** On no line: in the Unassigned strip. */
  | 'pool'
  /** Kept off the board on screen by Released Only. */
  | 'unreleased';

export interface FindEntry {
  /** The order number — the only number the plant has. */
  order: string;
  description: string;
  /** Where it is, in words: "Upholstery › Foaming, Sewing", "Unassigned". */
  where: string;
  status: FindStatus;
  /** Its rows on the board (`ASM8001#20`), in the board's order. */
  rowIds: string[];
  /** The lines those rows are on, and the lanes those lines sit under. */
  lines: LineKey[];
}

/** An order number as typed or scanned: trimmed, upper case, no inner spaces. */
export const normalOrder = (text: string): string =>
  text.trim().replace(/\s+/g, '').toUpperCase();

/** "Upholstery › Foaming, Sewing" — benches listed under their lane once. */
function placesText(places: readonly { lane: string | null; name: string }[]): string {
  const parts: string[] = [];
  const lanes = new Map<string, string[]>();
  for (const place of places) {
    if (!place.lane) {
      if (!parts.includes(place.name)) parts.push(place.name);
      continue;
    }
    const benches = lanes.get(place.lane);
    if (benches) {
      if (!benches.includes(place.name)) benches.push(place.name);
    } else {
      lanes.set(place.lane, [place.name]);
      parts.push(place.lane);
    }
  }
  return parts.map((part) => (lanes.has(part) ? `${part} › ${lanes.get(part)!.join(', ')}` : part)).join(' · ');
}

function boardEntries(board: AssemblyGanttView, status: FindStatus): Map<string, FindEntry> {
  const out = new Map<string, FindEntry>();
  const places = new Map<string, { lane: string | null; name: string }[]>();
  const names = new Map(board.groups.map((group) => [group.line.key, group.line.name]));
  for (const group of board.groups) {
    const line = group.line;
    for (const row of group.rows) {
      // A press changeover is a row between orders, not an order.
      if (row.job.press?.change) continue;
      const id = String(row.job.id);
      const order = jobNumOf(id);
      let entry = out.get(order);
      if (!entry) {
        entry = { order, description: row.job.description, where: '', status, rowIds: [], lines: [] };
        out.set(order, entry);
        places.set(order, []);
      }
      entry.rowIds.push(id);
      for (const key of [line.parent, line.key]) {
        if (key && !entry.lines.includes(key)) entry.lines.push(key);
      }
      places.get(order)!.push({
        lane: line.parent ? names.get(line.parent) ?? String(line.parent) : null,
        name: row.job.operation ? STEP_NAME[row.job.operation.step] : line.name,
      });
    }
  }
  for (const [order, entry] of out) entry.where = placesText(places.get(order)!);
  for (const job of board.pool) {
    const order = jobNumOf(String(job.id));
    if (out.has(order)) continue;
    out.set(order, {
      order,
      description: job.description,
      where: 'Unassigned',
      status: status === 'board' ? 'pool' : status,
      rowIds: [],
      lines: [],
    });
  }
  return out;
}

/**
 * Every order the reader can be taken to, by number.
 *
 * `shown` is the board on screen. `plan` is the board over every order in the
 * export (see `useAssemblyBoards`); what it has and `shown` does not is what
 * Released Only is keeping off the screen, and it is listed rather than left
 * out — "not found" for an order that is in the export would be a lie.
 */
export function findEntries(
  shown: AssemblyGanttView,
  plan: AssemblyGanttView | null = null,
): FindEntry[] {
  const entries = boardEntries(shown, 'board');
  if (plan && plan !== shown) {
    for (const [order, entry] of boardEntries(plan, 'unreleased')) {
      if (!entries.has(order)) entries.set(order, entry);
    }
  }
  return [...entries.values()].sort((a, b) => a.order.localeCompare(b.order));
}

/**
 * The entries a query matches, best first.
 *
 * The number first — exact, then starting with it, then holding it anywhere —
 * and the description last, so typing "8041" finds ASM80412 before an order
 * whose description happens to mention 8041. An empty query matches every
 * entry, in number order: that is the list to pick from.
 */
export function matchEntries(entries: readonly FindEntry[], query: string): FindEntry[] {
  const q = normalOrder(query);
  if (!q) return [...entries];
  const words = query.trim().toUpperCase();
  const rank = (entry: FindEntry): number => {
    const order = entry.order.toUpperCase();
    if (order === q) return 0;
    if (order.startsWith(q)) return 1;
    if (order.includes(q)) return 2;
    if (entry.description.toUpperCase().includes(words)) return 3;
    return -1;
  };
  return entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter((held) => held.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entry.order.localeCompare(b.entry.order))
    .map((held) => held.entry);
}

/**
 * The one entry Enter means: the order typed in full, or the only match.
 * Null when the text names no order or several.
 */
export function pickedEntry(entries: readonly FindEntry[], query: string): FindEntry | null {
  const q = normalOrder(query);
  if (!q) return null;
  const exact = entries.find((entry) => entry.order.toUpperCase() === q);
  if (exact) return exact;
  const matches = matchEntries(entries, query);
  return matches.length === 1 ? matches[0] : null;
}
