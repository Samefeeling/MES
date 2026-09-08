/**
 * Reads a SharePoint list through Microsoft Graph.
 *
 * The operator roster lives in the `ASSY_Operator` list rather than the
 * workbook, so this is separate from `data/excel/sharepoint.client.ts` (which
 * fetches file bytes).
 *
 * The paging itself lives in `lists.write`, which needs the item id to address
 * an update. This is that same read with the ids dropped — it used to be a
 * second copy of the loop, and only one of them ever learned anything.
 */

import { ok, err, type Result } from '@/lib/result';
import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import { fetchListRows, type ListItemFields } from './lists.write';

export type { ListItemFields };

/**
 * Fetch every row of a list by display name or id. Returns an error result
 * rather than throwing, so a roster outage degrades to "no crew available"
 * instead of an empty board.
 */
export async function fetchListItems(
  cfg: SharePointConfig,
  listName: string,
): Promise<Result<ListItemFields[], string>> {
  // Values only: the roster's own durable key is a column, not the item id.
  const res = await fetchListRows(cfg, listName);
  return res.ok
    ? ok(res.value.map((item) => item.fields))
    : err(res.error.message);
}
