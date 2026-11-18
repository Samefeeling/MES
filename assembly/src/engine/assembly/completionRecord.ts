/**
 * Where a confirmed completion is written: the order's own row for that day
 * in `ASSY_Production`, in columns of its own.
 *
 * ## Why columns of its own
 *
 * The row's existing columns already have an owner. The board rewrites
 * `Operators`, `Complete` and `JobCompleted` from its shift entry every time
 * it syncs, so a name written there would be put back the next five-minute
 * refresh, and Epicor's quantity in `Complete` would count the same pieces a
 * second time in every figure the KPI page already shows. The columns below
 * are written by this confirmation and by nothing else — the board's sync
 * names its columns and never touches one it does not name.
 *
 * ## Which row
 *
 * The one the order already holds for that day; on a routed order, the
 * operation that receives (not a `WIP` bench), the latest of them. When the
 * order has no row that day — finished in Epicor on a day nobody booked it on
 * the board — a row is opened under the key the board would have used, so a
 * booking made later lands in the same row rather than beside it.
 */

import type { NewColumn } from '@/engine/dispatch/waybillList';
import type { Completion } from './completedJobs';

/** The columns, named as they are created in the list. */
export const COMPLETION_COLUMNS = {
  epicorQty: 'EpicorQty',
  epicorHours: 'EpicorHours',
  epicorPartNum: 'EpicorPartNum',
  epicorCompletedAt: 'EpicorCompletedAt',
  completedBy: 'CompletedBy',
  completedByIds: 'CompletedByIds',
  confirmedBy: 'CompletionConfirmedBy',
  confirmedAt: 'CompletionConfirmedAt',
} as const;

/** The same columns as `createfieldasxml` makes them. */
export const COMPLETION_COLUMN_SPEC: readonly NewColumn[] = [
  { name: COMPLETION_COLUMNS.epicorQty, type: 'number', decimals: 0, inView: true },
  { name: COMPLETION_COLUMNS.epicorHours, type: 'number', decimals: 2, inView: true },
  { name: COMPLETION_COLUMNS.epicorPartNum, type: 'text' },
  { name: COMPLETION_COLUMNS.epicorCompletedAt, type: 'instant' },
  { name: COMPLETION_COLUMNS.completedBy, type: 'text', inView: true },
  { name: COMPLETION_COLUMNS.completedByIds, type: 'text' },
  { name: COMPLETION_COLUMNS.confirmedBy, type: 'text', inView: true },
  { name: COMPLETION_COLUMNS.confirmedAt, type: 'instant', inView: true },
];

/** One `ASSY_Production` row, as far as a completion cares. */
export interface StoredDay {
  id: string;
  etag?: string;
  day: string;
  /** The operation number from `Op 30 stapling`, '' when the row names none. */
  op: string;
  wip: boolean;
  line: string;
  operators: string[];
  operatorIds: string[];
  completedBy: string[];
  completedByIds: string[];
  confirmedBy: string;
  confirmedAt: string;
  epicorQty: number | null;
}

const names = (raw: unknown, sep: RegExp): string[] =>
  String(raw ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a stored Date cell, read the way the board's own sync reads it. */
export function storedDay(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return text;
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A list row, read. `fields` is keyed by column name. */
export function readStoredDay(item: { id: string; etag?: string; fields: Record<string, unknown> }): StoredDay {
  const f = item.fields;
  const c = COMPLETION_COLUMNS;
  const qty = f[c.epicorQty];
  return {
    id: item.id,
    etag: item.etag,
    day: storedDay(f.Date),
    op: /^Op\s+(\d+)\b/i.exec(String(f.WorkDescription ?? '').trim())?.[1] ?? '',
    wip: String(f.WorkType ?? '').trim().toUpperCase() === 'WIP',
    line: String(f.Line ?? '').trim(),
    operators: names(f.Operators, /,/),
    operatorIds: names(f.OperatorIds, /,/),
    completedBy: names(f[c.completedBy], /,/),
    completedByIds: names(f[c.completedByIds], /,/),
    confirmedBy: String(f[c.confirmedBy] ?? '').trim(),
    confirmedAt: String(f[c.confirmedAt] ?? '').trim(),
    epicorQty: qty === null || qty === undefined || qty === '' ? null : Number(qty),
  };
}

/** The row a completion on `day` belongs in, or null when the order has none that day. */
export function rowForCompletion(rows: readonly StoredDay[], day: string): StoredDay | null {
  const onDay = rows.filter((r) => r.day === day);
  if (onDay.length === 0) return null;
  const receiving = onDay.filter((r) => !r.wip);
  const pool = receiving.length ? receiving : onDay;
  return [...pool].sort((a, b) => Number(b.op || 0) - Number(a.op || 0) || Number(a.id) - Number(b.id))[0];
}

/** Has somebody already said who finished it? */
export const isConfirmed = (row: StoredDay | null): boolean => Boolean(row?.confirmedAt);

/**
 * Who to offer before anybody has said: the people already named against the
 * order — on that day's row, else on the latest row before it that names
 * anyone. The board's own crew for the day, when it still has the order, is
 * offered ahead of both by the caller.
 */
export function suggestedCrew(rows: readonly StoredDay[], day: string): { ids: string[]; names: string[] } {
  const named = rows
    .filter((r) => r.day <= day && r.operators.length > 0)
    .sort((a, b) => b.day.localeCompare(a.day) || Number(!a.wip) - Number(!b.wip));
  const hit = named.find((r) => r.day === day && !r.wip) ?? named[0];
  return hit ? { ids: hit.operatorIds, names: hit.operators } : { ids: [], names: [] };
}

/** The columns a confirmation writes. */
export function completionFields(
  completion: Completion,
  people: ReadonlyArray<{ id: string; name: string }>,
  confirmedBy: string,
  at: Date,
): Record<string, unknown> {
  const c = COMPLETION_COLUMNS;
  const [day, time] = completion.lastAt.split('T');
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  return {
    [c.epicorQty]: completion.qty,
    [c.epicorHours]: completion.hours,
    [c.epicorPartNum]: completion.partNum,
    // Entered at a local wall-clock time; sent as the instant it was.
    [c.epicorCompletedAt]: new Date(y, m - 1, d, hh || 0, mm || 0).toISOString(),
    [c.completedBy]: people.map((p) => p.name).join(', '),
    [c.completedByIds]: people.map((p) => p.id).join(','),
    [c.confirmedBy]: confirmedBy,
    [c.confirmedAt]: at.toISOString(),
  };
}

/**
 * The row to open for an order finished on a day it has none: the board's
 * key for that day (`Job|YYYY-MM-DD`), its line, and the completion — no
 * crew, quantities or flags of the board's, which stay the board's to write.
 */
export function newCompletionRow(
  completion: Completion,
  line: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    Title: completion.jobNum,
    Date: completion.day,
    RecordKey: completion.key,
    Line: line,
    ...fields,
  };
}
