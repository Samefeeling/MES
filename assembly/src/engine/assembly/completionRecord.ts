/**
 * Where a confirmed completion is written: a row of its own in
 * `ASSY_CompletedJobs`, the list KPIs · Assembly reads.
 *
 * ## One row per order per day
 *
 * `ASSY_CompletedJobs` has the columns of `ASSY_Planning`, so the row is a
 * whole record on its own — the order, the day, the people who finished it,
 * the quantity Epicor shows finished that day and the order's standard —
 * rather than a few columns added to the planning row. An order finished over
 * several days (a big order never comes off in one) has a row for each day;
 * that is the record's shape, not a duplicate.
 *
 * The row's key is `Job|YYYY-MM-DD`, written into `RecordKey`. It is looked
 * up by that key first and by its Date only after: a Date column comes back
 * shaped by the site's timezone, and matching on it alone is how a row that
 * was already there was missed and a second one refused by the list's unique
 * index ("duplicate").
 *
 * ## The figures
 *
 * Complete and ShiftOutput are Epicor's quantity for the day. PlannedHours and
 * OrderQty are written so that Complete × PlannedHours ÷ OrderQty is exactly
 * Epicor's standard hours for it — Epicor's rate per piece, over the order's
 * quantity when that is known — so every figure the KPI page draws from the
 * row agrees with the hours Epicor reported. JobCompleted is set on the day
 * the export's running total reaches the order's quantity.
 */

import type { NewColumn } from '@/engine/dispatch/waybillList';
import type { Completion } from './completedJobs';

/** The completion's own columns, named as they are created in the list. */
export const COMPLETION_COLUMNS = {
  epicorQty: 'EpicorQty',
  epicorHours: 'EpicorHours',
  epicorPartNum: 'EpicorPartNum',
  epicorDescription: 'EpicorPartDescription',
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
  { name: COMPLETION_COLUMNS.epicorDescription, type: 'text' },
  { name: COMPLETION_COLUMNS.epicorCompletedAt, type: 'instant' },
  { name: COMPLETION_COLUMNS.completedBy, type: 'text', inView: true },
  { name: COMPLETION_COLUMNS.completedByIds, type: 'text' },
  { name: COMPLETION_COLUMNS.confirmedBy, type: 'text', inView: true },
  { name: COMPLETION_COLUMNS.confirmedAt, type: 'instant', inView: true },
];

/** Columns a completion row cannot go without; everything else is written only where the list has it. */
export const ESSENTIAL_COLUMNS = ['Title', 'Date', 'RecordKey'] as const;

/** One row of `ASSY_Planning` or `ASSY_CompletedJobs`, as far as a completion cares. */
export interface StoredDay {
  id: string;
  etag?: string;
  recordKey: string;
  day: string;
  /** The operation number from `Op 30 stapling`, '' when the row names none. */
  op: string;
  wip: boolean;
  line: string;
  operators: string[];
  operatorIds: string[];
  dueDate: string | null;
  orderQty: number | null;
  plannedHours: number | null;
  completedBy: string[];
  completedByIds: string[];
  confirmedBy: string;
  confirmedAt: string;
  epicorQty: number | null;
}

/** What is known of the order a completion belongs to. */
export interface CompletionOrder {
  line: string;
  dueDate: string | null;
  /** The order's whole quantity; null when nothing still holds the order. */
  orderQty: number | null;
}

const names = (raw: unknown, sep: RegExp): string[] =>
  String(raw ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

const numberOrNull = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const pad = (n: number): string => String(n).padStart(2, '0');
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** `YYYY-MM-DD` of a stored Date cell, read the way the board's own sync reads it. */
export function storedDay(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return text;
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The day a RecordKey names — `Job|YYYY-MM-DD` or `Job#Op|YYYY-MM-DD` — or
 * null for a key that names none (the random keys of older bookings).
 *
 * The key is plain text and is the day the board meant. The Date column is a
 * SharePoint date, read back in the browser's zone: the site is on Auckland
 * time and the floor on Sydney's, so the site's midnight of the 19th
 * (2026-11-18T11:00:00Z) reads as 22:00 on the 18th in Sydney.
 */
export function recordKeyDay(raw: unknown): string | null {
  return /\|(\d{4}-\d{2}-\d{2})$/.exec(String(raw ?? '').trim())?.[1] ?? null;
}

/** A list row, read. `fields` is keyed by column name. */
export function readStoredDay(item: { id: string; etag?: string; fields: Record<string, unknown> }): StoredDay {
  const f = item.fields;
  const c = COMPLETION_COLUMNS;
  return {
    id: item.id,
    etag: item.etag,
    recordKey: String(f.RecordKey ?? '').trim(),
    day: recordKeyDay(f.RecordKey) ?? storedDay(f.Date),
    op: /^Op\s+(\d+)\b/i.exec(String(f.WorkDescription ?? '').trim())?.[1] ?? '',
    wip: String(f.WorkType ?? '').trim().toUpperCase() === 'WIP',
    line: String(f.Line ?? '').trim(),
    operators: names(f.Operators, /,/),
    operatorIds: names(f.OperatorIds, /,/),
    dueDate: f.DueDate ? String(f.DueDate) : null,
    orderQty: numberOrNull(f.OrderQty),
    plannedHours: numberOrNull(f.PlannedHours),
    completedBy: names(f[c.completedBy], /,/),
    completedByIds: names(f[c.completedByIds], /,/),
    confirmedBy: String(f[c.confirmedBy] ?? '').trim(),
    confirmedAt: String(f[c.confirmedAt] ?? '').trim(),
    epicorQty: numberOrNull(f[c.epicorQty]),
  };
}

/**
 * The `ASSY_CompletedJobs` row already holding this completion: by its key,
 * else by the order's row on that day (the newest, should there be two).
 */
export function recordFor(rows: readonly StoredDay[], completion: Completion): StoredDay | null {
  const byKey = rows.filter((r) => r.recordKey === completion.key);
  const pool = byKey.length ? byKey : rows.filter((r) => r.day === completion.day);
  return [...pool].sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

/** Has somebody already said who finished it? */
export const isConfirmed = (row: StoredDay | null): boolean => Boolean(row?.confirmedAt);

/**
 * Who to offer before anybody has said: the people `ASSY_Planning` names
 * against the order — on that day's row, else on the latest row before it
 * that names anyone. The board's own crew for the day, when it still has the
 * order, is offered ahead of both by the caller.
 */
export function suggestedCrew(rows: readonly StoredDay[], day: string): { ids: string[]; names: string[] } {
  const named = rows
    .filter((r) => r.day <= day && r.operators.length > 0)
    .sort((a, b) => b.day.localeCompare(a.day) || Number(!a.wip) - Number(!b.wip));
  const hit = named.find((r) => r.day === day && !r.wip) ?? named[0];
  return hit ? { ids: hit.operatorIds, names: hit.operators } : { ids: [], names: [] };
}

/** The order's facts, from the first of `ASSY_Planning`'s rows that holds each. */
export function orderFromRows(rows: readonly StoredDay[]): CompletionOrder {
  const receiving = [...rows].sort((a, b) => Number(a.wip) - Number(b.wip));
  return {
    line: receiving.find((r) => r.line)?.line ?? '',
    dueDate: receiving.find((r) => r.dueDate)?.dueDate ?? null,
    orderQty: receiving.find((r) => (r.orderQty ?? 0) > 0)?.orderQty ?? null,
  };
}

/**
 * The whole `ASSY_CompletedJobs` row for one confirmed completion.
 *
 * `doneToDate` is the export's running total for the order through the
 * completion's day, which is what says whether this day finished it.
 */
export function completionRow(
  completion: Completion,
  people: ReadonlyArray<{ id: string; name: string }>,
  confirmedBy: string,
  at: Date,
  order: CompletionOrder,
  doneToDate: number,
): Record<string, unknown> {
  const c = COMPLETION_COLUMNS;
  const [day, time] = completion.lastAt.split('T');
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  // Entered at a local wall-clock time; sent as the instant it was.
  const enteredAt = new Date(y, m - 1, d, hh || 0, mm || 0).toISOString();
  const orderQty = order.orderQty && order.orderQty > 0 ? order.orderQty : null;
  const base = orderQty ?? completion.qty;
  const rate = completion.qty > 0 ? completion.hours / completion.qty : 0;
  const finished = orderQty !== null && doneToDate >= orderQty;
  return {
    Title: completion.jobNum,
    Date: completion.day,
    RecordKey: completion.key,
    Line: order.line,
    Operators: people.map((p) => p.name).join(', '),
    OperatorIds: people.map((p) => p.id).join(','),
    ShiftOutput: completion.qty,
    Complete: completion.qty,
    Reject: 0,
    Rework: 0,
    OrderQty: base,
    PlannedHours: round2(rate * base),
    ...(orderQty !== null ? { RemainingQty: Math.max(0, orderQty - doneToDate) } : {}),
    ...(order.dueDate ? { DueDate: order.dueDate } : {}),
    JobCompleted: finished,
    CompletedAt: finished ? enteredAt : null,
    [c.epicorQty]: completion.qty,
    [c.epicorHours]: completion.hours,
    [c.epicorPartNum]: completion.partNum,
    // The part's description (first line), for KPIs · Assembly's Material column.
    [c.epicorDescription]: completion.description.slice(0, 255),
    [c.epicorCompletedAt]: enteredAt,
    [c.completedBy]: people.map((p) => p.name).join(', '),
    [c.completedByIds]: people.map((p) => p.id).join(','),
    [c.confirmedBy]: confirmedBy,
    [c.confirmedAt]: at.toISOString(),
  };
}

/** The row as it now stands in the list, for the dialog to hold after a write. */
export function storedFromRow(id: string, fields: Record<string, unknown>): StoredDay {
  return readStoredDay({ id, fields });
}
