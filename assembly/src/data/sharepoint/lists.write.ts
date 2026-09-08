/**
 * Writes SharePoint list rows through Microsoft Graph.
 *
 * Separate from `lists.client.ts` (read-only) because writing needs the list
 * *item* id, which the read path throws away — Graph addresses an update as
 * `PATCH /lists/{list}/items/{itemId}/fields`.
 *
 * Every call returns a `Result` rather than throwing: a write that fails must
 * surface as a warning on the board, never take the planner's session down.
 */

import { ok, err, type Result } from '@/lib/result';
import { sessionRows, sessionCreate, sessionUpdate, SharePointHttpError } from './session';

async function sessionResult<T>(run: () => Promise<T>): Promise<Result<T, WriteError>> {
  try { return ok(await run()); } catch (e) { return err({ status: e instanceof SharePointHttpError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }); }
}
import {
  graphSite,
  type SharePointConfig,
} from '@/data/excel/sharepoint.client';

/** One list row: the column values, keyed by internal column name. */
export type ListItemFields = Record<string, unknown>;

/** A list row with the id needed to update it. */
export interface ListItem {
  id: string;
  fields: ListItemFields;
  etag?: string;
}

/**
 * Why a write did not happen, and whether trying again could help.
 *
 * `message` is what the banner shows. `status` is what decides the retry, and
 * it has to be carried rather than read back out of the text: every message
 * here contains the word "fetch", so matching on the words retried a 401
 * every minute for as long as the tab was open.
 */
export interface WriteError {
  /** Graph's status, 0 for a request that never got an answer, null for one
   *  that was never sent because the site or the token is not configured. */
  status: number | null;
  message: string;
}

/**
 * Worth another go: nothing was answered, the caller was throttled, or the
 * far end had a bad moment. A 401, 403 or 404 will say the same thing forever.
 */
export const isTransient = (e: WriteError): boolean =>
  e.status === 0 || e.status === 429 || (e.status ?? 0) >= 500;

const failed = (status: number, message: string): WriteError => ({
  status,
  message,
});
const unreachable = (message: string): WriteError => ({ status: 0, message });
const unconfigured = (message: string): WriteError => ({
  status: null,
  message,
});

const listUrl = (cfg: SharePointConfig, list: string): string =>
  `${graphSite(cfg)}/lists/${encodeURIComponent(list)}`;

function configured(cfg: SharePointConfig): WriteError | null {
  if (!cfg.siteUrl) return unconfigured('SharePoint site URL not configured.');
  if (!cfg.token) {
    return unconfigured('Missing Graph access token (VITE_GRAPH_TOKEN).');
  }
  return null;
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Every row of a list, paged.
 *
 * `expand=fields` on the item is the one shape that returns the values and the
 * item id in a single round trip. The id is what addresses an update; a read
 * that only wants the values does not need it, and this is the loop both of
 * them share — there used to be a second copy in `lists.client`, and only one
 * of the two ever learned to bound its paging.
 */
export async function fetchListRows(
  cfg: SharePointConfig,
  list: string,
): Promise<Result<ListItem[], WriteError>> {
  if (cfg.authMode === 'session') return sessionResult(() => sessionRows(cfg, list));
  const missing = configured(cfg);
  if (missing) return err(missing);

  const items: ListItem[] = [];
  let url = `${listUrl(cfg, list)}/items?expand=fields&$top=200`;

  try {
    // Bounded so a malformed nextLink can never spin forever.
    for (let page = 0; page < 50 && url; page++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) {
        return err(
          failed(
            res.status,
            `Graph list "${list}" read failed: ${res.status} ${res.statusText}`,
          ),
        );
      }
      const body = (await res.json()) as {
        value?: { id?: string; fields?: ListItemFields }[];
        '@odata.nextLink'?: string;
      };
      for (const item of body.value ?? []) {
        items.push({ id: item.id ?? '', fields: item.fields ?? {} });
      }
      url = body['@odata.nextLink'] ?? '';
    }
    if (url) return err(failed(400, 'SharePoint pagination limit reached.'));
    return ok(items);
  } catch (e) {
    return err(unreachable(`Graph list "${list}" read error: ${message(e)}`));
  }
}

/**
 * The rows an update could actually address. Anything Graph handed back
 * without an item id is left out: a write needs somewhere to send the PATCH.
 */
export async function fetchListItemsWithIds(
  cfg: SharePointConfig,
  list: string,
): Promise<Result<ListItem[], WriteError>> {
  const res = await fetchListRows(cfg, list);
  return res.ok ? ok(res.value.filter((item) => item.id)) : res;
}

/** Add a row. Resolves to the new item's id. */
export async function createListItem(
  cfg: SharePointConfig,
  list: string,
  fields: ListItemFields,
): Promise<Result<string, WriteError>> {
  if (cfg.authMode === 'session') return sessionResult(() => sessionCreate(cfg, list, fields));
  const missing = configured(cfg);
  if (missing) return err(missing);

  try {
    const res = await fetch(`${listUrl(cfg, list)}/items`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      return err(
        failed(
          res.status,
          `Graph list "${list}" create failed: ${res.status} ${res.statusText}`,
        ),
      );
    }
    const body = (await res.json()) as { id?: string };
    return ok(body.id ?? '');
  } catch (e) {
    return err(
      unreachable(`Graph list "${list}" create error: ${message(e)}`),
    );
  }
}

/** Update the named columns of one row; columns not named are left alone. */
export async function updateListItem(
  cfg: SharePointConfig,
  list: string,
  itemId: string,
  fields: ListItemFields,
  etag?: string,
): Promise<Result<void, WriteError>> {
  if (cfg.authMode === 'session') return sessionResult(() => sessionUpdate(cfg, list, itemId, fields, etag));
  const missing = configured(cfg);
  if (missing) return err(missing);

  try {
    const res = await fetch(
      `${listUrl(cfg, list)}/items/${encodeURIComponent(itemId)}/fields`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fields),
      },
    );
    if (!res.ok) {
      return err(
        failed(
          res.status,
          `Graph list "${list}" update failed: ${res.status} ${res.statusText}`,
        ),
      );
    }
    return ok(undefined);
  } catch (e) {
    return err(
      unreachable(`Graph list "${list}" update error: ${message(e)}`),
    );
  }
}
