/**
 * Reading and writing confirmed completions in `ASSY_Production` — see
 * `engine/assembly/completionRecord` for which row and which columns.
 *
 * The columns are added to the list the first time a supervisor's screen
 * needs them, the way the Waybill list gains its planner columns: nobody has
 * to edit the list by hand before the dialog works.
 */

import type { Completion } from '@/engine/assembly/completedJobs';
import {
  COMPLETION_COLUMN_SPEC,
  newCompletionRow,
  readStoredDay,
  rowForCompletion,
  type StoredDay,
} from '@/engine/assembly/completionRecord';
import { ok, err, type Result } from '@/lib/result';
import type { SharePointConfig } from './site';
import { clearSessionSchemaCache, sessionListFields } from './session';
import { resolveField } from './fieldMap';
import { createColumns } from './waybill.list';
import {
  createListItem,
  fetchListItemsWithIds,
  fetchRowsWhere,
  updateListItem,
  type ListItem,
} from './lists.write';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Add whichever completion columns the list lacks. Session only; Graph lists are made by hand. */
export async function ensureCompletionColumns(
  cfg: SharePointConfig,
  list: string,
): Promise<Result<string[], string>> {
  if (cfg.authMode !== 'session') return ok([]);
  try {
    const schema = await sessionListFields(cfg, list);
    const missing = COMPLETION_COLUMN_SPEC.filter((c) => !resolveField(schema, c.name));
    if (missing.length === 0) return ok([]);
    const added = await createColumns(cfg, list, missing);
    clearSessionSchemaCache();
    if (added.errors.length) return err(`${list}: columns not added — ${added.errors.join('; ')}`);
    return ok(added.added);
  } catch (e) {
    return err(`${list}: columns not read — ${message(e)}`);
  }
}

/** Each order's rows, asked of the list now. */
export async function storedDaysFor(
  cfg: SharePointConfig,
  list: string,
  jobs: readonly string[],
): Promise<Result<Map<string, StoredDay[]>, string>> {
  const out = new Map<string, StoredDay[]>();
  const wanted = new Set(jobs);
  const keep = (items: readonly ListItem[]) => {
    for (const item of items) {
      const job = String(item.fields.Title ?? '').trim();
      if (!wanted.has(job)) continue;
      const rows = out.get(job) ?? [];
      rows.push(readStoredDay(item));
      out.set(job, rows);
    }
  };
  for (const job of wanted) {
    const asked = await fetchRowsWhere(cfg, list, 'Title', job);
    if (asked === null) {
      // This transport cannot ask by column: read the list once instead.
      const all = await fetchListItemsWithIds(cfg, list);
      if (!all.ok) return err(all.error.message);
      out.clear();
      keep(all.value);
      return ok(out);
    }
    if (!asked.ok) return err(asked.error.message);
    keep(asked.value);
  }
  return ok(out);
}

/**
 * Write one confirmation: into the order's row for the day, or a new row when
 * it has none. A row that appears between the read and the write (the board
 * opening the day at the same moment) is written into, not doubled.
 */
export async function writeCompletion(
  cfg: SharePointConfig,
  list: string,
  completion: Completion,
  row: StoredDay | null,
  line: string,
  fields: Record<string, unknown>,
): Promise<Result<StoredDay, string>> {
  const update = async (target: StoredDay): Promise<Result<StoredDay, string>> => {
    // No version check: a MERGE of these columns alone cannot undo anything
    // the board wrote to the row's other columns meanwhile, and the board
    // touches the row on every refresh, so its version is always about to move.
    const res = await updateListItem(cfg, list, target.id, fields);
    return res.ok ? ok(target) : err(`${completion.jobNum}: ${res.error.message}`);
  };
  if (row) return update(row);
  const created = await createListItem(cfg, list, newCompletionRow(completion, line, fields));
  if (created.ok) {
    return ok({
      id: created.value,
      day: completion.day,
      op: '',
      wip: false,
      line,
      operators: [],
      operatorIds: [],
      completedBy: [],
      completedByIds: [],
      confirmedBy: '',
      confirmedAt: '',
      epicorQty: null,
    });
  }
  const again = await storedDaysFor(cfg, list, [completion.jobNum]);
  const appeared = again.ok ? rowForCompletion(again.value.get(completion.jobNum) ?? [], completion.day) : null;
  if (appeared) return update(appeared);
  return err(`${completion.jobNum}: ${created.error.message}`);
}
