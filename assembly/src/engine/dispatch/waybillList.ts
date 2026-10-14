/**
 * The `Waybill` SharePoint list: the waybill export as rows, kept up to date
 * from `Waybill.csv`, with the dispatch planner's decisions beside it.
 *
 * One row per order release (`Order`, `Line`, `Rel`). Its columns are of two
 * kinds:
 *
 * - **The export's own**, named exactly as `Waybill.csv` names them. Each sync
 *   writes only the cells that differ from the export, so the list's version
 *   history is the record of every change Epicor made — a Need By moved three
 *   times reads as three versions of that one row. A line new to the export
 *   is added; a line gone from it is not deleted but stamped `ClosedAt`.
 * - **The planner's** (`DECISION_COLUMNS`), which the sync never touches: the
 *   day an order is pinned to, a hold, a corrected volume, the loads it is on
 *   (`LoadId`, and the load itself as JSON in `LoadDetail`) and when it left.
 *   They are per order, so every open line of an order carries the same values.
 *
 * Pure: the SharePoint calls are in `data/sharepoint/waybill.list`.
 */

import { parseCsv, toCsv } from '@/lib/csv';
import { parseAuDate, parseWaybillCsv } from '@/data/csv/waybill.parser';
import { readCalendarDay } from '@/data/sharepoint/factoryCalendar.list';
import { resolveField, type ListField } from '@/data/sharepoint/fieldMap';
import type { DayKey, DispatchDecisions, DispatchMode, FirmLoad } from '@/domain/dispatch';
import { lineKey, orderKey } from '@/domain/orderLink';
import type { ShipmentRecord, ShippedOrder } from './shipments';

/** The planner's columns, as they must be named on the list. */
export const DECISION_COLUMNS = {
  plannedDay: 'PlannedDay',
  holdReason: 'HoldReason',
  volume: 'VolumeM3',
  loadId: 'LoadId',
  loadDetail: 'LoadDetail',
  dispatchedAt: 'DispatchedAt',
  closedAt: 'ClosedAt',
} as const;

export type DecisionColumn = keyof typeof DECISION_COLUMNS;

/** How a column's values are written and compared. */
export type ColumnKind = 'date' | 'number' | 'boolean' | 'text' | 'note';

export interface ListColumn {
  /** The display name — what the export calls it. */
  name: string;
  internal: string;
  kind: ColumnKind;
  readOnly: boolean;
  /** One of SharePoint's own (Title, Created, …) rather than one added. */
  fromBase: boolean;
}

/** A list row: its id and its values by internal column name. */
export interface ListRow {
  id: string;
  values: Record<string, unknown>;
}

/** A SharePoint column type, as `TypeAsString` names it, to how it is written. */
export function columnKind(typeAsString: string | undefined): ColumnKind {
  switch (typeAsString) {
    case 'DateTime':
      return 'date';
    case 'Number':
    case 'Currency':
    case 'Integer':
    case 'Counter':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Note':
      return 'note';
    default:
      return 'text';
  }
}

/** A single line of text holds 255 characters. */
const TEXT_MAX = 255;

const toNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const toBool = (raw: unknown): boolean =>
  typeof raw === 'boolean' ? raw : /^(true|yes|y|1)$/i.test(String(raw ?? '').trim());

/** A value from the export, as the column is written. */
export function cellFromCsv(kind: ColumnKind, raw: string | undefined): unknown {
  const s = (raw ?? '').trim();
  switch (kind) {
    case 'date':
      return parseAuDate(s);
    case 'number':
      return toNumber(s);
    case 'boolean':
      return toBool(s);
    case 'text':
      return s.slice(0, TEXT_MAX);
    default:
      return s;
  }
}

/** A value read off the list, in the same form `cellFromCsv` writes it. */
export function cellFromList(kind: ColumnKind, raw: unknown): unknown {
  switch (kind) {
    case 'date':
      return raw === null || raw === undefined || raw === '' ? null : readCalendarDay(raw);
    case 'number':
      return toNumber(raw);
    case 'boolean':
      return toBool(raw);
    default:
      return raw === null || raw === undefined ? '' : String(raw).trim();
  }
}

const sameCell = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return (a ?? null) === (b ?? null);
};

/** A list value written back as the export would write it, for the parser. */
function csvText(kind: ColumnKind, raw: unknown): string {
  const v = cellFromList(kind, raw);
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Order, line and release as one key: `18532-5-1`. */
export const releaseKey = (order: string, line: string, rel: string): string =>
  `${orderKey(String(order))}-${lineKey(String(line))}-${lineKey(String(rel))}`;

const letterIndex = (letters: string): number =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/**
 * `Waybill.csv` as a table: one value per header. Where the export names a
 * column twice (a part `Description` beside the zone one, two `City`), the one
 * the waybill parser reads is the one kept.
 */
export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  /** Which headers hold the order, line and release. */
  order: string;
  line: string;
  rel: string;
}

export function csvTable(text: string): CsvTable | { error: string } {
  const parsed = parseWaybillCsv(text);
  if (parsed.error) return { error: parsed.error };
  const { order, line, rel } = parsed.columns;
  if (!order || !line || !rel) return { error: 'Not a waybill export: no Order, Line and Rel columns.' };
  const all = parseCsv(text);
  const header = all[0].map((h) => h.trim());
  const at = new Map<string, number>();
  header.forEach((h, i) => {
    if (h && !at.has(h)) at.set(h, i);
  });
  for (const used of Object.values(parsed.columns)) {
    if (used) at.set(used.header.trim(), letterIndex(used.column));
  }
  const headers = [...at.keys()];
  const rows = all
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h) => [h, r[at.get(h)!] ?? ''])));
  return { headers, rows, order: order.header.trim(), line: line.header.trim(), rel: rel.header.trim() };
}

const asField = (c: ListColumn): ListField => ({ InternalName: c.internal, Title: c.name, ReadOnlyField: c.readOnly });

/** The list column a header or a decision column name is, if there is one. */
export function findColumn(columns: readonly ListColumn[], name: string): ListColumn | null {
  try {
    const field = resolveField(columns.map(asField), name);
    return field ? columns.find((c) => c.internal === field.InternalName) ?? null : null;
  } catch {
    // Two columns answering to one name: neither can be trusted.
    return null;
  }
}

const DECISION_NAMES = new Set<string>(Object.values(DECISION_COLUMNS).map((n) => n.toLowerCase()));

/** The export's headers, each with the list column holding it. */
export function mirrored(
  headers: readonly string[],
  columns: readonly ListColumn[],
): { pairs: { header: string; column: ListColumn }[]; missing: string[] } {
  const pairs: { header: string; column: ListColumn }[] = [];
  const missing: string[] = [];
  for (const header of headers) {
    const column = findColumn(columns, header);
    if (!column || column.readOnly || DECISION_NAMES.has(column.name.toLowerCase())) missing.push(header);
    else pairs.push({ header, column });
  }
  return { pairs, missing };
}

/** The decision columns the list has, and the ones it is missing. */
export function decisionColumns(columns: readonly ListColumn[]): {
  found: Partial<Record<DecisionColumn, ListColumn>>;
  missing: string[];
} {
  const found: Partial<Record<DecisionColumn, ListColumn>> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(DECISION_COLUMNS) as [DecisionColumn, string][]) {
    const column = findColumn(columns, name);
    if (column && !column.readOnly) found[key] = column;
    else missing.push(name);
  }
  return { found, missing };
}

// ---- Columns the list lacks ----------------------------------------------------

/** How a column is made. A day and an instant are both SharePoint DateTime. */
export type NewColumnType = 'day' | 'instant' | 'number' | 'boolean' | 'text' | 'note';

/** A column to add to the list. */
export interface NewColumn {
  name: string;
  type: NewColumnType;
  /** Filtered on, so indexed: the filter keeps working past 5,000 rows. */
  indexed?: boolean;
  /** Shown in the list's default view. */
  inView?: boolean;
  /** Decimal places, for a number. */
  decimals?: number;
}

/** The planner's columns, as they are made. */
export const DECISION_COLUMN_SPEC: Record<DecisionColumn, Omit<NewColumn, 'name'>> = {
  plannedDay: { type: 'day', inView: true },
  holdReason: { type: 'text', inView: true },
  volume: { type: 'number', decimals: 2, inView: true },
  loadId: { type: 'text', inView: true },
  // JSON, for MES to read back: not for the view.
  loadDetail: { type: 'note' },
  dispatchedAt: { type: 'instant', indexed: true, inView: true },
  closedAt: { type: 'instant', indexed: true, inView: true },
};

/** A decision column's name as a column to add. */
export function decisionColumnSpec(name: string): NewColumn | null {
  const key = (Object.keys(DECISION_COLUMNS) as DecisionColumn[]).find(
    (k) => DECISION_COLUMNS[k].toLowerCase() === name.toLowerCase(),
  );
  return key ? { name: DECISION_COLUMNS[key], ...DECISION_COLUMN_SPEC[key] } : null;
}

export const isDecisionName = (name: string): boolean => DECISION_NAMES.has(name.toLowerCase());

const nameKey = (value: string): string => value.replace(/[\s_-]+/g, '').toLowerCase();

/**
 * No column on the list answers to this name — not even a read-only one or
 * two at once, which would only be made worse by adding a third.
 */
export function lacksColumn(columns: readonly ListColumn[], name: string): boolean {
  const k = nameKey(name);
  return !columns.some((c) => nameKey(c.name) === k || nameKey(c.internal) === k);
}

/** Order numbers, job numbers, codes: digits, but not quantities. */
const ID_LIKE = /(num|nbr|no|id|code|ref|zip|postcode)$/i;
const LONG_TEXT = /comment|note|memo|instruction/i;

/**
 * The column an export header would be added as, from what the export holds
 * under it: dates as a day, TRUE/FALSE as yes/no, quantities as a number,
 * comments (or anything past 255 characters) as multiple lines; the rest —
 * identifiers among them, however numeric — as a line of text, kept exactly
 * as the export writes it.
 */
export function inferColumn(header: string, values: readonly (string | undefined)[]): NewColumn {
  const filled = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  const every = (test: (v: string) => boolean) => filled.length > 0 && filled.every(test);
  let type: NewColumnType = 'text';
  if (LONG_TEXT.test(header) || filled.some((v) => v.length > TEXT_MAX || /[\r\n]/.test(v))) type = 'note';
  else if (every((v) => parseAuDate(v) !== null)) type = 'day';
  else if (every((v) => /^(true|false)$/i.test(v))) type = 'boolean';
  else if (!ID_LIKE.test(header.trim()) && every((v) => /\d/.test(v) && /^-?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(v) && !/^-?0\d/.test(v))) {
    type = 'number';
  }
  return { name: header, type, inView: true };
}

// ---- The export into the list ------------------------------------------------

export interface SyncPlan {
  creates: Record<string, unknown>[];
  updates: { id: string; fields: Record<string, unknown> }[];
  /** Open rows whose release has left the export. */
  closes: string[];
  /** Headers in the export with no column on the list: not kept. */
  missing: string[];
  /** Rows sharing one release with another: closed, the first kept. */
  duplicates: number;
  unchanged: number;
}

export interface SyncInput {
  table: CsvTable;
  columns: readonly ListColumn[];
  /** Rows with no `ClosedAt`. */
  open: readonly ListRow[];
  /** Closed rows already read (dispatched history): reopened if back. */
  closed?: readonly ListRow[];
}

/** The release a row is, from the columns holding order, line and release. */
function rowKey(row: ListRow, cols: { order: ListColumn; line: ListColumn; rel: ListColumn }): string | null {
  const v = (c: ListColumn) => csvText(c.kind, row.values[c.internal]);
  const order = v(cols.order);
  if (!order) return null;
  return releaseKey(order, v(cols.line), v(cols.rel));
}

/**
 * What to write to bring the list into line with the export: the cells that
 * differ, the releases it does not have yet, and the open rows it no longer
 * lists. Nothing is ever deleted.
 */
export function planSync(input: SyncInput): SyncPlan | { error: string } {
  const { table, columns } = input;
  const { pairs, missing } = mirrored(table.headers, columns);
  const pair = (h: string) => pairs.find((p) => p.header === h)?.column;
  const keyCols = { order: pair(table.order), line: pair(table.line), rel: pair(table.rel) };
  if (!keyCols.order || !keyCols.line || !keyCols.rel) {
    return { error: `The list has no ${[table.order, table.line, table.rel].join(', ')} columns to match rows on.` };
  }
  const keys = { order: keyCols.order, line: keyCols.line, rel: keyCols.rel };
  const closedAt = decisionColumns(columns).found.closedAt;
  const title = findColumn(columns, 'Title');
  const titleFree = title && title.fromBase && !pairs.some((p) => p.column.internal === title.internal);

  const byKey = new Map<string, ListRow>();
  const extra: string[] = [];
  for (const row of input.open) {
    const key = rowKey(row, keys);
    if (!key) continue;
    if (byKey.has(key)) extra.push(row.id);
    else byKey.set(key, row);
  }
  const closedByKey = new Map<string, ListRow>();
  for (const row of input.closed ?? []) {
    const key = rowKey(row, keys);
    if (key && !byKey.has(key) && !closedByKey.has(key)) closedByKey.set(key, row);
  }

  const plan: SyncPlan = { creates: [], updates: [], closes: [], missing, duplicates: extra.length, unchanged: 0 };
  const seen = new Set<string>();
  for (const rec of table.rows) {
    const key = releaseKey(rec[table.order], rec[table.line], rec[table.rel]);
    if (!rec[table.order]?.trim() || seen.has(key)) continue;
    seen.add(key);
    const row = byKey.get(key) ?? closedByKey.get(key);
    const fields: Record<string, unknown> = {};
    for (const { header, column } of pairs) {
      const next = cellFromCsv(column.kind, rec[header]);
      if (!row || !sameCell(cellFromList(column.kind, row.values[column.internal]), next)) {
        fields[column.internal] = next;
      }
    }
    if (!row) {
      if (titleFree) fields[title!.internal] = key;
      plan.creates.push(fields);
      continue;
    }
    // A release back on the export after it was closed is open again.
    if (!byKey.has(key) && closedAt) fields[closedAt.internal] = null;
    if (Object.keys(fields).length > 0) plan.updates.push({ id: row.id, fields });
    else plan.unchanged++;
  }
  if (closedAt) {
    for (const [key, row] of byKey) if (!seen.has(key)) plan.closes.push(row.id);
    plan.closes.push(...extra);
  }
  return plan;
}

/** The list's open rows as the export would write them, for the waybill parser. */
export function rowsToCsv(rows: readonly ListRow[], columns: readonly ListColumn[]): string {
  const own = columns.filter(
    (c) => !DECISION_NAMES.has(c.name.toLowerCase()) && (!c.fromBase || c.internal === 'Title'),
  );
  return toCsv([own.map((c) => c.name), ...rows.map((r) => own.map((c) => csvText(c.kind, r.values[c.internal])))]);
}

// ---- The planner's decisions ---------------------------------------------------

/** One load an order is on, as `LoadDetail` keeps it. */
export interface StoredLoad {
  id: string;
  group: string;
  mode: DispatchMode;
  label: string;
  day: DayKey;
  equipment: string;
  capacityM3: number | null;
  status: FirmLoad['status'];
  confirmedAt: string;
  dispatchedAt?: string;
  sizeLocked?: boolean;
  /** Where the order is among the load's drops. */
  at: number;
  /** The order's volume on the load, and the piece of it when split. */
  volume: number;
  piece?: number;
  /** What left, when the load has. */
  shipped?: { day: DayKey; loadVolumeM3: number; order: ShippedOrder };
}

/** What the planner's columns should say for one order. */
export interface OrderDecision {
  plannedDay: DayKey | null;
  holdReason: string | null;
  volume: number | null;
  loadId: string | null;
  loadDetail: string | null;
  dispatchedAt: string | null;
}

/** A hold with no reason still has to read as a hold. */
const HELD = 'Held';

const EMPTY: OrderDecision = {
  plannedDay: null,
  holdReason: null,
  volume: null,
  loadId: null,
  loadDetail: null,
  dispatchedAt: null,
};

/** The decisions and the shipment log, per order, as the columns hold them. */
export function decisionsByOrder(
  decisions: DispatchDecisions,
  shipments: readonly ShipmentRecord[],
): Map<string, OrderDecision> {
  const out = new Map<string, OrderDecision>();
  const of = (id: string): OrderDecision => {
    const key = orderKey(id);
    const held = out.get(key);
    if (held) return held;
    const fresh = { ...EMPTY };
    out.set(key, fresh);
    return fresh;
  };
  for (const [id, day] of Object.entries(decisions.pins)) of(id).plannedDay = day;
  for (const [id, reason] of Object.entries(decisions.holds)) of(id).holdReason = reason.trim() || HELD;
  for (const [id, m3] of Object.entries(decisions.volumeOverrides)) of(id).volume = m3;

  const shipped = new Map<string, ShipmentRecord>(shipments.map((s) => [s.loadId, s]));
  const loads = new Map<string, StoredLoad[]>();
  for (const f of decisions.firmLoads) {
    const record = f.status === 'dispatched' ? shipped.get(f.id) : undefined;
    f.orderIds.forEach((id, at) => {
      const entry: StoredLoad = {
        id: f.id,
        group: f.group,
        mode: f.mode,
        label: f.label,
        day: f.day,
        equipment: f.equipment,
        capacityM3: f.capacityM3,
        status: f.status,
        confirmedAt: f.confirmedAt,
        ...(f.dispatchedAt ? { dispatchedAt: f.dispatchedAt } : {}),
        ...(f.sizeLocked ? { sizeLocked: true } : {}),
        at,
        volume: f.volumes[id] ?? 0,
        ...(f.pieces?.[id] !== undefined ? { piece: f.pieces[id] } : {}),
      };
      const sent = record?.orders.find((o) => o.orderId === id);
      if (record && sent) entry.shipped = { day: record.day, loadVolumeM3: record.volumeM3, order: sent };
      const list = loads.get(orderKey(id)) ?? [];
      list.push(entry);
      loads.set(orderKey(id), list);
    });
  }
  for (const [key, list] of loads) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    const d = of(key);
    d.loadId = list.map((l) => l.id).join(', ');
    d.loadDetail = JSON.stringify(list);
    const gone = list.map((l) => l.dispatchedAt).filter((t): t is string => Boolean(t)).sort();
    d.dispatchedAt = gone.at(-1) ?? null;
  }
  return out;
}

const instant = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : Math.round(t / 1000);
};

/** What the planner's columns of a row say, in the form `decisionsByOrder` gives. */
function rowDecision(row: ListRow, cols: Partial<Record<DecisionColumn, ListColumn>>): OrderDecision {
  const get = (k: DecisionColumn) => (cols[k] ? row.values[cols[k]!.internal] : null);
  const text = (k: DecisionColumn) => {
    const v = get(k);
    return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
  };
  const day = get('plannedDay');
  const vol = get('volume');
  const sent = get('dispatchedAt');
  return {
    plannedDay: day === null || day === undefined || day === '' ? null : readCalendarDay(day),
    holdReason: text('holdReason'),
    volume: toNumber(vol),
    loadId: text('loadId'),
    loadDetail: text('loadDetail'),
    dispatchedAt: sent === null || sent === undefined || sent === '' ? null : String(sent),
  };
}

const sameDecision = (a: OrderDecision, b: OrderDecision): boolean =>
  a.plannedDay === b.plannedDay &&
  a.holdReason === b.holdReason &&
  sameCell(a.volume, b.volume) &&
  a.loadId === b.loadId &&
  a.loadDetail === b.loadDetail &&
  instant(a.dispatchedAt) === instant(b.dispatchedAt);

/**
 * The orders whose decisions differ between two sets (`decisionsByOrder`):
 * what this screen changed since it last read or wrote the list, so only those
 * are written — another screen's changes to other orders are left as they are.
 */
export function changedOrders(
  before: ReadonlyMap<string, OrderDecision>,
  after: ReadonlyMap<string, OrderDecision>,
): Set<string> {
  const out = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (!sameDecision(before.get(key) ?? EMPTY, after.get(key) ?? EMPTY)) out.add(key);
  }
  return out;
}

/** One row's planner cells to write, and the order it is a line of. */
export interface DecisionWrite {
  id: string;
  order: string;
  fields: Record<string, unknown>;
}

/**
 * The cells to write so every open row says what the planner decided for its
 * order — and says nothing where nothing was decided. Only the columns the
 * list has are written; with `only`, only the rows of those orders.
 */
export function decisionWrites(
  desired: ReadonlyMap<string, OrderDecision>,
  open: readonly ListRow[],
  columns: readonly ListColumn[],
  only?: ReadonlySet<string>,
): DecisionWrite[] {
  const { found } = decisionColumns(columns);
  const orderCol = findColumn(columns, 'Order');
  if (!orderCol) return [];
  const writes: DecisionWrite[] = [];
  for (const row of open) {
    const order = csvText(orderCol.kind, row.values[orderCol.internal]);
    if (!order) continue;
    const key = orderKey(order);
    if (only && !only.has(key)) continue;
    const want = desired.get(key) ?? EMPTY;
    const has = rowDecision(row, found);
    const fields: Record<string, unknown> = {};
    const put = (k: DecisionColumn, value: unknown) => {
      if (found[k]) fields[found[k]!.internal] = value;
    };
    if (has.plannedDay !== want.plannedDay) put('plannedDay', want.plannedDay);
    if (has.holdReason !== want.holdReason) put('holdReason', want.holdReason ?? '');
    if (!sameCell(has.volume, want.volume)) put('volume', want.volume);
    if (has.loadId !== want.loadId) put('loadId', want.loadId ?? '');
    if (has.loadDetail !== want.loadDetail) put('loadDetail', want.loadDetail ?? '');
    if (instant(has.dispatchedAt) !== instant(want.dispatchedAt)) put('dispatchedAt', want.dispatchedAt);
    if (Object.keys(fields).length > 0) writes.push({ id: row.id, order: key, fields });
  }
  return writes;
}

const parseLoads = (text: string | null): StoredLoad[] => {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? (v as StoredLoad[]).filter((l) => l && typeof l.id === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * The planner's decisions and the shipment log, read back off the list: the
 * open rows for what is still to ship, and the dispatched rows — open or
 * closed — for what has left. Orders are keyed by `orderKey`.
 */
export function decisionsFromRows(
  open: readonly ListRow[],
  history: readonly ListRow[],
  columns: readonly ListColumn[],
): { decisions: DispatchDecisions; shipments: ShipmentRecord[] } {
  const { found } = decisionColumns(columns);
  const orderCol = findColumn(columns, 'Order');
  const decisions: DispatchDecisions = { pins: {}, holds: {}, volumeOverrides: {}, firmLoads: [] };
  if (!orderCol) return { decisions, shipments: [] };
  const orderOf = (row: ListRow) => orderKey(csvText(orderCol.kind, row.values[orderCol.internal]));

  // Each order's loads once, the open rows' copy first: a closed line can hold
  // what was true when it left the export.
  const entries = new Map<string, Map<string, StoredLoad>>();
  const take = (row: ListRow) => {
    const order = orderOf(row);
    if (!order) return;
    const d = rowDecision(row, found);
    const mine = entries.get(order) ?? new Map<string, StoredLoad>();
    for (const l of parseLoads(d.loadDetail)) if (!mine.has(l.id)) mine.set(l.id, l);
    entries.set(order, mine);
  };

  for (const row of open) {
    const order = orderOf(row);
    if (!order) continue;
    const d = rowDecision(row, found);
    if (d.plannedDay && !(order in decisions.pins)) decisions.pins[order] = d.plannedDay;
    if (d.holdReason && !(order in decisions.holds)) decisions.holds[order] = d.holdReason === HELD ? '' : d.holdReason;
    if (d.volume !== null && !(order in decisions.volumeOverrides)) decisions.volumeOverrides[order] = d.volume;
    take(row);
  }
  for (const row of history) take(row);

  const loads = new Map<string, { head: StoredLoad; orders: { id: string; entry: StoredLoad }[] }>();
  for (const [order, mine] of entries) {
    for (const entry of mine.values()) {
      const held = loads.get(entry.id);
      if (!held) loads.set(entry.id, { head: entry, orders: [{ id: order, entry }] });
      else {
        held.orders.push({ id: order, entry });
        if (entry.confirmedAt > held.head.confirmedAt) held.head = entry;
      }
    }
  }

  const shipments: ShipmentRecord[] = [];
  for (const [id, { head, orders }] of loads) {
    orders.sort((a, b) => a.entry.at - b.entry.at);
    const firm: FirmLoad = {
      id,
      group: head.group,
      mode: head.mode,
      label: head.label,
      day: head.day,
      equipment: head.equipment,
      capacityM3: head.capacityM3,
      orderIds: orders.map((o) => o.id),
      volumes: Object.fromEntries(orders.map((o) => [o.id, o.entry.volume])),
      status: head.status,
      confirmedAt: head.confirmedAt,
      ...(head.dispatchedAt ? { dispatchedAt: head.dispatchedAt } : {}),
      ...(head.sizeLocked ? { sizeLocked: true } : {}),
    };
    const pieces = orders.filter((o) => o.entry.piece !== undefined);
    if (pieces.length > 0) firm.pieces = Object.fromEntries(pieces.map((o) => [o.id, o.entry.piece!]));
    // Every load, however long ago it left: written back, a load missing here
    // would be wiped off the rows that carry it. The plan keeps the recent ones.
    decisions.firmLoads.push(firm);

    const sent = orders.filter((o) => o.entry.shipped);
    if (firm.status === 'dispatched' && sent.length > 0) {
      const first = sent[0].entry.shipped!;
      shipments.push({
        loadId: id,
        day: first.day,
        dispatchedAt: head.dispatchedAt ?? head.confirmedAt,
        mode: head.mode,
        label: head.label,
        equipment: head.equipment,
        capacityM3: head.capacityM3,
        volumeM3: first.loadVolumeM3,
        orders: sent.map((o) => o.entry.shipped!.order),
      });
    }
  }
  decisions.firmLoads.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  shipments.sort((a, b) => a.day.localeCompare(b.day) || a.loadId.localeCompare(b.loadId));
  return { decisions, shipments };
}
