/**
 * Reading and writing the `Waybill` SharePoint list (see
 * `engine/dispatch/waybillList` for what it holds and why).
 *
 * Through the signed-in SharePoint session only — the transport MES runs on.
 * Rows are read by what they are needed for, so a list that keeps every line
 * ever shipped is never read whole:
 *
 * - the **open** rows, `ClosedAt` empty: the waybill as it stands;
 * - the **dispatched** rows since a day, open or closed: the shipment log.
 *
 * SharePoint refuses a filter on a column that is not indexed once a list
 * passes 5,000 rows. Index `ClosedAt` and `DispatchedAt` (List settings →
 * Indexed columns); until then the rows are read whole and filtered here, and
 * the result says so.
 */

import type { SharePointConfig } from '@/data/sharepoint/site';
import { restList, sessionRequest, SharePointHttpError } from './session';
import {
  columnKind,
  decisionColumns,
  type ListColumn,
  type ListRow,
  type NewColumn,
} from '@/engine/dispatch/waybillList';

/** The list's own columns, with how each is written. Hidden ones are left out. */
export async function waybillColumns(cfg: SharePointConfig, list: string): Promise<ListColumn[]> {
  const url =
    `${restList(cfg, list)}/fields?$select=Title,InternalName,ReadOnlyField,TypeAsString,FromBaseType` +
    `&$filter=${encodeURIComponent('Hidden eq false')}`;
  const res = await sessionRequest(cfg, url);
  const body = await res.json();
  if (!Array.isArray(body.value)) throw new SharePointHttpError(500, `SharePoint did not describe the ${list} list.`);
  return (body.value as Record<string, unknown>[]).map((f) => ({
    name: String(f.Title ?? ''),
    internal: String(f.InternalName ?? ''),
    kind: columnKind(f.TypeAsString as string | undefined),
    readOnly: Boolean(f.ReadOnlyField),
    fromBase: Boolean(f.FromBaseType),
  }));
}

const PAGE = 2000;
/** 60 pages of 2,000: far past any waybill, short of a runaway loop. */
const MAX_PAGES = 60;

async function pages(cfg: SharePointConfig, first: string): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  let url = first;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await sessionRequest(cfg, url);
    const body = await res.json();
    for (const row of (body.value ?? []) as Record<string, unknown>[]) {
      rows.push({ id: String(row.Id ?? row.ID), values: row });
    }
    url = body['odata.nextLink'] ?? body['@odata.nextLink'] ?? '';
  }
  if (url) throw new SharePointHttpError(400, 'The Waybill list is past what MES reads in one go; nothing partial was loaded.');
  return rows;
}

/** The list view threshold, as SharePoint words its refusal. */
const overThreshold = (e: unknown): boolean =>
  e instanceof SharePointHttpError && /threshold|SPQueryThrottledException/i.test(e.message);

const empty = (v: unknown): boolean => v === null || v === undefined || v === '';

export interface RowsRead {
  open: ListRow[];
  dispatched: ListRow[];
  /** Read whole because a filter was refused: index the columns named. */
  unindexed: string[];
}

/** The open rows, and the rows dispatched since `since` (an ISO instant). */
export async function waybillRows(
  cfg: SharePointConfig,
  list: string,
  columns: readonly ListColumn[],
  since: string,
): Promise<RowsRead> {
  const { found } = decisionColumns(columns);
  const items = `${restList(cfg, list)}/items?$top=${PAGE}`;
  const where = (filter: string) => `${items}&$filter=${encodeURIComponent(filter)}`;
  const closedAt = found.closedAt?.internal;
  const sent = found.dispatchedAt?.internal;
  const unindexed: string[] = [];
  let all: ListRow[] | null = null;
  const whole = async () => (all ??= await pages(cfg, items));

  let open: ListRow[];
  if (!closedAt) open = await whole();
  else {
    try {
      open = await pages(cfg, where(`${closedAt} eq null`));
    } catch (e) {
      if (!overThreshold(e)) throw e;
      unindexed.push('ClosedAt');
      open = (await whole()).filter((r) => empty(r.values[closedAt]));
    }
  }

  let dispatched: ListRow[] = [];
  if (sent) {
    try {
      dispatched = await pages(cfg, where(`${sent} ge datetime'${since}'`));
    } catch (e) {
      if (!overThreshold(e)) throw e;
      unindexed.push('DispatchedAt');
      const from = Date.parse(since);
      dispatched = (await whole()).filter((r) => !empty(r.values[sent]) && Date.parse(String(r.values[sent])) >= from);
    }
  }
  return { open, dispatched, unindexed };
}

export interface WriteOutcome {
  done: number;
  errors: string[];
  /** Which of the writes went through, in the order they were given. */
  ok: boolean[];
}

/**
 * A day as SharePoint is sent it: 11:00 UTC on it, which is the same day in
 * every zone from UTC−11 to UTC+11 (see `factoryCalendar.list`). Instants —
 * `ClosedAt`, `DispatchedAt` — go as they are.
 */
function wire(fields: Record<string, unknown>, columns: readonly ListColumn[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    const kind = columns.find((c) => c.internal === name)?.kind;
    out[name] = kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T11:00:00Z` : value;
  }
  return out;
}

/** One row added. */
async function create(cfg: SharePointConfig, list: string, fields: Record<string, unknown>): Promise<void> {
  await sessionRequest(cfg, `${restList(cfg, list)}/items`, { method: 'POST', body: JSON.stringify(fields) });
}

/**
 * The named cells of one row. Last writer wins: the sync and the planner write
 * different columns, and a merge only touches the ones it names.
 */
async function update(cfg: SharePointConfig, list: string, id: string, fields: Record<string, unknown>): Promise<void> {
  if (!/^\d+$/.test(id)) throw new SharePointHttpError(400, `Invalid SharePoint item ID ${id}.`);
  await sessionRequest(cfg, `${restList(cfg, list)}/items(${id})`, {
    method: 'POST',
    headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    body: JSON.stringify(fields),
  });
}

/** A few at a time; a permission refusal stops the rest rather than repeating. */
async function run(jobs: (() => Promise<void>)[]): Promise<WriteOutcome> {
  const errors: string[] = [];
  const ok = jobs.map(() => false);
  let done = 0;
  let stop = false;
  let next = 0;
  const worker = async () => {
    while (!stop && next < jobs.length) {
      const at = next++;
      try {
        await jobs[at]();
        ok[at] = true;
        done++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        if (e instanceof SharePointHttpError && (e.status === 401 || e.status === 403)) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return { done, errors, ok };
}

/** Add, change and close rows, as a sync plan says. */
export function writeSync(
  cfg: SharePointConfig,
  list: string,
  columns: readonly ListColumn[],
  plan: {
    creates: Record<string, unknown>[];
    updates: { id: string; fields: Record<string, unknown> }[];
    closes: string[];
  },
  closedAtInternal: string | null,
  now: string,
): Promise<WriteOutcome> {
  return run([
    ...plan.updates.map((u) => () => update(cfg, list, u.id, wire(u.fields, columns))),
    ...plan.creates.map((fields) => () => create(cfg, list, wire(fields, columns))),
    ...(closedAtInternal ? plan.closes.map((id) => () => update(cfg, list, id, { [closedAtInternal]: now })) : []),
  ]);
}

/** The planner's cells, as `decisionWrites` gives them. */
export function writeDecisions(
  cfg: SharePointConfig,
  list: string,
  columns: readonly ListColumn[],
  writes: { id: string; fields: Record<string, unknown> }[],
): Promise<WriteOutcome> {
  return run(writes.map((w) => () => update(cfg, list, w.id, wire(w.fields, columns))));
}

// ---- Adding columns -------------------------------------------------------------

const attr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SharePoint's internal name for a new column: letters, digits and underscores, at most 32. */
export function internalNameFor(name: string): string {
  const plain = name.replace(/[^A-Za-z0-9_]/g, '');
  return (/^[A-Za-z]/.test(plain) ? plain : `C${plain}`).slice(0, 32);
}

/** The column as SharePoint's field schema, for `createfieldasxml`. */
export function fieldSchema(c: NewColumn, indexed = Boolean(c.indexed)): string {
  const id = internalNameFor(c.name);
  const head = `DisplayName="${attr(c.name)}" Name="${id}" StaticName="${id}"${indexed ? ' Indexed="TRUE"' : ''}`;
  switch (c.type) {
    case 'day':
      return `<Field Type="DateTime" ${head} Format="DateOnly" FriendlyDisplayFormat="Disabled" />`;
    case 'instant':
      return `<Field Type="DateTime" ${head} Format="DateTime" FriendlyDisplayFormat="Disabled" />`;
    case 'number':
      return `<Field Type="Number" ${head}${c.decimals !== undefined ? ` Decimals="${c.decimals}"` : ''} />`;
    case 'boolean':
      return `<Field Type="Boolean" ${head}><Default>0</Default></Field>`;
    case 'note':
      return `<Field Type="Note" ${head} NumLines="6" RichText="FALSE" AppendOnly="FALSE" />`;
    default:
      return `<Field Type="Text" ${head} MaxLength="255" />`;
  }
}

/**
 * SP.AddFieldOptions: to the default content type (1), named as the schema
 * names it (8), and in the default view (16) when the column is to be seen.
 */
const optionsFor = (c: NewColumn): number => 1 | 8 | (c.inView ? 16 : 0);

export interface ColumnsAdded {
  added: string[];
  /** Added, but SharePoint would not index them: index by hand. */
  unindexed: string[];
  errors: string[];
}

/**
 * Add columns to the list, one at a time so they land in the view in order.
 * An index SharePoint refuses (a list past its threshold) does not stop the
 * column: it is added without, and named. A permission refusal stops the rest.
 */
export async function createColumns(
  cfg: SharePointConfig,
  list: string,
  columns: readonly NewColumn[],
): Promise<ColumnsAdded> {
  const out: ColumnsAdded = { added: [], unindexed: [], errors: [] };
  const create = (c: NewColumn, indexed: boolean) =>
    sessionRequest(cfg, `${restList(cfg, list)}/fields/createfieldasxml`, {
      method: 'POST',
      body: JSON.stringify({ parameters: { SchemaXml: fieldSchema(c, indexed), Options: optionsFor(c) } }),
    });
  for (const c of columns) {
    try {
      try {
        await create(c, Boolean(c.indexed));
      } catch (e) {
        if (!c.indexed || (e instanceof SharePointHttpError && (e.status === 401 || e.status === 403))) throw e;
        await create(c, false);
        out.unindexed.push(c.name);
      }
      out.added.push(c.name);
    } catch (e) {
      out.errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof SharePointHttpError && (e.status === 401 || e.status === 403)) break;
    }
  }
  return out;
}
