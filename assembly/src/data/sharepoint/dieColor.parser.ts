/**
 * `PMD_ProductDieColor` — the PMD dashboard's list of which die and which
 * colour each moulded part runs in, keyed on PartNum. The press plan reads it
 * to tell a die change from an insert or colour change (`pressPlan`).
 *
 * Read only. Every column but PartNum is optional on the list, and a part it
 * does not name simply has no die — which the press plan treats as a die
 * change, the safe answer.
 */

import type { Job } from '@/domain/types';
import type { ListItemFields } from './lists.client';

export const PRODUCT_DIE_COLOR_LIST: string =
  import.meta.env.VITE_PRODUCT_DIE_COLOR_LIST || 'PMD_ProductDieColor';

export interface PartDie {
  die: string | null;
  dieName: string | null;
  color: string | null;
}

const text = (row: ListItemFields, ...names: string[]): string | null => {
  for (const name of names) {
    const v = row[name];
    if (v === null || v === undefined) continue;
    const s = String(v).replace(/ /g, ' ').trim();
    if (s !== '') return s;
  }
  return null;
};

/** Part number → its die and colour. */
export function parseDieColors(rows: readonly ListItemFields[]): Map<string, PartDie> {
  const out = new Map<string, PartDie>();
  for (const row of rows) {
    const part = text(row, 'PartNum', 'Part_x0020_Num', 'Title');
    if (!part) continue;
    const die = text(row, 'DieNumber', 'Die_x0020_Number');
    const dieName = text(row, 'Die', 'DieDescription');
    out.set(part, {
      die: die ?? dieName,
      dieName,
      color: text(row, 'ActualColor', 'Actual_x0020_Color', 'ColorHex'),
    });
  }
  return out;
}

/** The press orders, each told its die and colour where the list knows them. */
export function withDieColors(jobs: readonly Job[], dies: ReadonlyMap<string, PartDie>): Job[] {
  return jobs.map((job) => {
    const known = job.press ? dies.get(String(job.partNum)) : undefined;
    if (!job.press || !known) return job;
    return {
      ...job,
      press: {
        ...job.press,
        die: job.press.die ?? known.die,
        dieName: job.press.dieName ?? known.dieName,
        color: job.press.color ?? known.color,
      },
    };
  });
}
