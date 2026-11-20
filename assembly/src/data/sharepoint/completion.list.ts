/**
 * Reading `ASSY_Planning` and `ASSY_CompletedJobs` for the completed-orders
 * dialog, and writing a confirmation into `ASSY_CompletedJobs` — see
 * `engine/assembly/completionRecord` for the row.
 *
 * The completion columns are added to the list the first time a supervisor's
 * screen needs them, the way the Waybill list gains its planner columns:
 * nobody has to edit the list by hand before the dialog works.
 */

import type { Completion } from '@/engine/assembly/completedJobs';
import {
  COMPLETION_COLUMN_SPEC,
  ESSENTIAL_COLUMNS,
  readStoredDay,
  recordFor,
  storedFromRow,
  type StoredDay,
} from '@/engine/assembly/completionRecord';
import { ok, err, type Result } from '@/lib/result';
import type { SharePointConfig } from './site';
import { clearSessionSchemaCache, sessionListFields } from './session';
import { resolveField, type ListField } from './fieldMap';
import { createColumns } from './waybill.list';
import {
  createListItem,
  fetchListItemsWithIds,
  fetchRowsWhere,
  updateListItem,
  type ListItem,
} from './lists.write';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Add whichever completion columns the list lacks, and say which columns it
 * has. Session only; a Graph list is made by hand and answers `null`.
 */
export async function ensureCompletionColumns(
  cfg: SharePointConfig,
  list: string,
): Promise<Result<ListField[] | null, string>> {
  if (cfg.authMode !== 'session') return ok(null);
  try {
    let schema = await sessionListFields(cfg, list);
    const missing = COMPLETION_COLUMN_SPEC.filter((c) => !resolveField(schema, c.name));
    if (missing.length) {
      const added = await createColumns(cfg, list, missing);
      clearSessionSchemaCache();
      if (added.errors.length) return err(`${list}: columns not added — ${added.errors.join('; ')}`);
      schema = await sessionListFields(cfg, list);
    }
    return ok(schema);
  } catch (e) {
    return err(`${list}: columns not read — ${message(e)}`);
  }
}

/**
 * The fields the list can take: everything when its columns are unknown,
 * else the essentials and whatever else it has. A column a copy of the list
 * happens to lack costs that one figure, not the whole confirmation.
 */
export function fieldsFor(fields: Record<string, unknown>, schema: ListField[] | null): Record<string, unknown> {
  if (!schema) return fields;
  const essential = new Set<string>(ESSENTIAL_COLUMNS);
  const writable = (name: string): boolean => {
    try {
      const f = resolveField(schema, name);
      return Boolean(f && !f.ReadOnlyField);
    } catch {
      return false;
    }
  };
  return Object.fromEntries(Object.entries(fields).filter(([k]) => essential.has(k) || writable(k)));
}

/** Each order's rows in one list, asked of the list now. */
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
 * Write one confirmation: over the row already holding it, or a new row. A
 * row that appears between the read and the write (a second screen
 * confirming the same order) is written over, not doubled.
 */
export async function writeCompletion(
  cfg: SharePointConfig,
  list: string,
  completion: Completion,
  row: StoredDay | null,
  fields: Record<string, unknown>,
): Promise<Result<StoredDay, string>> {
  const update = async (target: StoredDay): Promise<Result<StoredDay, string>> => {
    // No version check: this row is the confirmation's alone, and the newest
    // confirmation of it is the one that stands.
    const res = await updateListItem(cfg, list, target.id, fields);
    return res.ok ? ok(storedFromRow(target.id, fields)) : err(`${completion.jobNum}: ${res.error.message}`);
  };
  if (row) return update(row);
  const created = await createListItem(cfg, list, fields);
  if (created.ok) return ok(storedFromRow(created.value, fields));
  const again = await storedDaysFor(cfg, list, [completion.jobNum]);
  const appeared = again.ok ? recordFor(again.value.get(completion.jobNum) ?? [], completion) : null;
  if (appeared) return update(appeared);
  return err(`${completion.jobNum}: ${created.error.message}`);
}
