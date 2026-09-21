/**
 * Mirrors the board into the `ASSY_Production` SharePoint list.
 *
 * One row per **order per day**, matching the list Resero already designed —
 * independently of PMD machine/shift records. MES uses a dedicated Assembly
 * adapter and metrics, never PMD OEE aggregation.
 *
 * Each row carries two kinds of column, and the split is the whole design:
 *
 *   order-level — Line, Operators, StartDate, DueDate, OrderQty, RemainingQty.
 *     The same on every row of a job, and kept current on all of them, so a
 *     re-exported Due Date reaches rows booked weeks ago.
 *   row-level — ShiftOutput, Complete, Reject, Rework, JobCompleted, Paused,
 *     PauseReason, Notes. What that particular shift did.
 *
 * Which side owns what:
 *
 *   Planning1.csv  →  DueDate, OrderQty, RemainingQty
 *   the supervisor →  Operators, StartDate, Line
 *   the shift      →  everything row-level
 *
 * So dragging a bar to level the load writes **StartDate only**: Epicor owns
 * the Due Date and this board never changes it.
 *
 * Rows are diffed before writing, so the five-minute refresh costs one read and
 * no writes when nothing moved. Orders that leave the export keep their rows —
 * the list is the production record, not a copy of today's CSV.
 */

import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import type { ProductionEntry } from '@/store/planStore';
import type { ListItemFields } from './lists.client';
import {
  createListItem,
  fetchListItemsWithIds,
  fetchRowsWhere,
  isTransient,
  updateListItem,
  type ListItem,
  type WriteError,
} from './lists.write';

/** Default list name; override with `VITE_PRODUCTION_LIST`. */
export const PRODUCTION_LIST = 'ASSY_Production';

/** Internal column names. Create the list with these exact names. */
export const PRODUCTION_COLUMNS = {
  // key
  workType: 'WorkType',
  description: 'WorkDescription',
  supportDepartment: 'SupportDepartment',
  laborHours: 'LaborHours',
  plannedHours: 'PlannedHours',
  jobNum: 'Title',
  date: 'Date',
  recordKey: 'RecordKey',
  bookedHour: 'BookedHour',
  // order-level
  line: 'Line',
  operators: 'Operators',
  operatorIds: 'OperatorIds',
  startDate: 'StartDate',
  actualStartAt: 'ActualStartAt',
  startOverrideReason: 'StartOverrideReason',
  dueDate: 'DueDate',
  expectDate: 'ExpectDate',
  orderQty: 'OrderQty',
  remainingQty: 'RemainingQty',
  // row-level
  shiftOutput: 'ShiftOutput',
  complete: 'Complete',
  reject: 'Reject',
  rework: 'Rework',
  jobCompleted: 'JobCompleted',
  completedAt: 'CompletedAt',
  paused: 'Paused',
  pauseReason: 'PauseReason',
  notes: 'Notes',
} as const;

/** The order-level columns, kept identical across every row of a job. */
const ORDER_LEVEL = [
  PRODUCTION_COLUMNS.line,
  PRODUCTION_COLUMNS.plannedHours,
  PRODUCTION_COLUMNS.startDate,
  PRODUCTION_COLUMNS.actualStartAt,
  PRODUCTION_COLUMNS.startOverrideReason,
  PRODUCTION_COLUMNS.dueDate,
  PRODUCTION_COLUMNS.expectDate,
  PRODUCTION_COLUMNS.orderQty,
  PRODUCTION_COLUMNS.remainingQty,
] as const;

/** What the plan says about an order, regardless of which day's row holds it. */
export interface OrderFacts {
  manual?: { description: string; supportDepartment: string; plannedHours: number };
  /**
   * The bench this row is, when the board split an order across three.
   *
   * A derived bench is a real row — it has people, hours and a day — and it is
   * emphatically not a second receipt. The units exist once and are received
   * once, on the row carrying the job number, so a derived row writes its
   * hours and writes zero for every quantity on it. Booking the same nine
   * chairs on the sewing bench and again on the stapling bench is the one
   * mistake this whole split could introduce.
   */
  step?: { sourceJobId: string; step: string; derived: boolean };
  jobNum: string;
  line: string | null;
  /** Stable worker keys — the SharePoint item ids from `ASSY_Operator`. */
  operatorIds: string[];
  /** The same people by name, so the list is readable without a join. */
  operatorNames: string[];
  /** True when the roster is the built-in fallback; those ids must not sync. */
  hasSyntheticCrew?: boolean;
  /**
   * The order's whole standard labour content, in hours.
   *
   * Written on every row, not just support ones: with OrderQty beside it, the
   * KPI page can turn a day's finished units back into the hours they were
   * worth and report an efficiency. Without it the record says how much came
   * off the line but not what that work was supposed to take, and no honest
   * efficiency can be computed from it at all.
   */
  stdHours: number;
  /** Effective start: the later of the drag, the queue and the predecessor. */
  startDate: string | null;
  actualStartAt?: string | null;
  startOverrideReason?: string | null;
  /** Epicor's date. From the CSV, never written by a drag. */
  dueDate: string | null;
  expectDate: string | null;
  orderQty: number;
  remainingQty: number;
  /** `YYYY-MM-DD` for the row to open the order with when it has none yet. */
  anchorDay: string;
  /** One entry per booked shift. */
  shifts: ProductionEntry[];
}

export interface SyncOutcome {
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
  /**
   * At least one failure was worth trying again — throttled, unanswered, or a
   * bad moment at the far end. Nothing that stays broken sets this, so a bad
   * token stops rather than being retried for as long as the tab is open.
   */
  retryable: boolean;
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

const day = (d: Date | null | undefined): string | null =>
  d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : null;

/**
 * What the list should say about every order on the board.
 *
 * Schedulable lines only: the PMD lane mirrors moulding's own plan, which this
 * page does not own and must not write back.
 */
export function orderFactsFromBoard(
  board: AssemblyGanttView,
  production: Record<string, ProductionEntry[]>,
): OrderFacts[] {
  return board.groups
    .filter((group) => group.line.schedulable)
    .flatMap((group) =>
      group.rows.map((row) => {
        const anchorDay = day(row.start) ?? day(board.horizonStart)!;
        const anchorIds =
          row.crewDays.find((crewDay) => crewDay.day === anchorDay)
            ?.workerIds ??
          row.crewDays[0]?.workerIds ??
          row.workers.map((worker) => String(worker.id));
        const anchorCrew = row.workers.filter((worker) =>
          anchorIds.includes(String(worker.id)),
        );
        return {
          manual: row.job.manual,
          step: row.job.step
            ? {
                sourceJobId: String(row.job.step.sourceJobId),
                step: row.job.step.step,
                derived: row.job.step.derived,
              }
            : undefined,
          jobNum: String(row.job.id),
          line: group.line.name,
          operatorIds: anchorCrew.map((worker) => String(worker.id)),
          operatorNames: anchorCrew.map((worker) => worker.name),
          hasSyntheticCrew: anchorCrew.some((worker) => worker.synthetic),
          stdHours: row.job.manual
            ? row.job.manual.plannedHours
            : Math.max(0, row.job.laborHrs),
          startDate: iso(row.plannedStart),
          actualStartAt: row.actualStart?.startedAt ?? null,
          startOverrideReason: row.actualStart?.overrideReason ?? null,
          dueDate: iso(row.job.dueDate),
          expectDate: iso(row.expectDate),
          orderQty: row.job.remainingQty + row.job.completedQty,
          remainingQty: row.job.remainingQty,
          // The day the order opens its record on. Falls back to the horizon so
          // an order with no crew — and so no start — still gets its one row.
          anchorDay,
          shifts: production[String(row.job.id)] ?? [],
        };
      }),
    );
}

/** A row the board made up for a bench: hours yes, quantities never. */
const isDerived = (facts: OrderFacts): boolean =>
  Boolean(facts.step?.derived);

function orderFields(facts: OrderFacts): ListItemFields {
  const c = PRODUCTION_COLUMNS;
  const noQty = Boolean(facts.manual) || isDerived(facts);
  return {
    [c.line]: facts.line ?? '',
    [c.plannedHours]: facts.stdHours,
    [c.startDate]: facts.startDate,
    [c.actualStartAt]: facts.actualStartAt ?? null,
    [c.startOverrideReason]: facts.startOverrideReason ?? '',
    [c.dueDate]: facts.dueDate,
    [c.expectDate]: facts.expectDate,
    [c.orderQty]: noQty ? 0 : facts.orderQty,
    [c.remainingQty]: noQty ? 0 : facts.remainingQty,
    ...(facts.manual ? { [c.workType]: 'Support', [c.description]: facts.manual.description, [c.supportDepartment]: facts.manual.supportDepartment } : {}),
    ...(isDerived(facts)
      ? { [c.workType]: 'Step', [c.description]: `${facts.step!.step} — ${facts.step!.sourceJobId}` }
      : {}),
  };
}

/**
 * The key a row carries when no booking gave it one: `Job|YYYY-MM-DD`.
 *
 * Every row used to be keyed this way, and the trouble with it is the date —
 * the one part of the record that can be read two ways, because a SharePoint
 * date column answers in the site's timezone rather than the shift's. A
 * booking now brings its own key (`ProductionEntry.recordKey`), generated once
 * and never derived from anything; this is what is left for the two kinds of
 * row that have no booking behind them: the blank row an order opens with, and
 * rows written before keys were part of the plan.
 */
const legacyKey = (jobNum: string, date: string): string =>
  `${jobNum}|${date}`;

/** The key this shift's row is written under, whichever kind it is. */
const keyFor = (jobNum: string, shift: ProductionEntry): string =>
  shift.recordKey ?? legacyKey(jobNum, shift.date);

/**
 * An empty shift — the row an order opens with before anything is booked.
 *
 * It carries no `recordKey`, because no booking made it: the sync opens it
 * from the board, so `legacyKey` below gives it the one key both sides can
 * work out for themselves. The first real entry for that day then claims the
 * row and writes its own key over it.
 */
function blankShift(date: string): ProductionEntry {
  return {
    date,
    complete: 0,
    reject: 0,
    rework: 0,
    shiftOutput: 0,
    paused: false,
    pauseReason: null,
    jobCompleted: false,
    notes: '',
  };
}

function rowFields(facts: OrderFacts, shift: ProductionEntry): ListItemFields {
  const c = PRODUCTION_COLUMNS;
  const operatorIds = shift.operatorIds ?? facts.operatorIds;
  const operatorNames = shift.operatorNames ?? facts.operatorNames;
  // The bench's own output is the order's output counted a second time.
  const derived = isDerived(facts);
  return {
    [c.jobNum]: facts.jobNum,
    [c.date]: shift.date,
    [c.recordKey]: keyFor(facts.jobNum, shift),
    [c.bookedHour]: shift.bookedHours ?? 0,
    ...orderFields(facts),
    [c.operators]: operatorNames.join(', '),
    [c.operatorIds]: operatorIds.join(','),
    [c.shiftOutput]: derived ? 0 : shift.shiftOutput,
    [c.complete]: facts.manual || derived ? 0 : shift.complete,
    ...(facts.manual || derived ? { [c.laborHours]: shift.laborHours ?? 0 } : {}),
    [c.reject]: derived ? 0 : shift.reject,
    [c.rework]: derived ? 0 : shift.rework,
    [c.jobCompleted]: shift.jobCompleted,
    [c.completedAt]: shift.completedAt ?? null,
    [c.paused]: shift.paused,
    [c.pauseReason]: shift.pauseReason ?? '',
    [c.notes]: shift.notes,
  };
}

/**
 * Columns holding an instant, which have to be compared as instants: Graph
 * hands back `2026-09-10T00:00:00Z` for what we sent as
 * `2026-09-10T00:00:00.000Z`, and a string compare would rewrite every row on
 * every refresh. Named rather than guessed — the guess was "the value has a T
 * in it", which a note reading "Tue: waiting on trim" could satisfy.
 */
const INSTANT_COLUMNS = new Set<string>([
  PRODUCTION_COLUMNS.startDate,
  PRODUCTION_COLUMNS.actualStartAt,
  PRODUCTION_COLUMNS.dueDate,
  PRODUCTION_COLUMNS.expectDate,
  PRODUCTION_COLUMNS.completedAt,
]);

/**
 * The local `YYYY-MM-DD` a stored Date value stands for.
 *
 * We write the day as plain text. What comes back depends on how the column
 * was created: a date-only column returns midnight UTC, a datetime column
 * returns the site's own midnight, which is the day before in UTC. Reading it
 * with the UTC getters answered a day early for the second kind, so every
 * refresh opened the row again and then refused to write anything at all,
 * having made the duplicate it was complaining about.
 *
 * Read locally, like every other day on this board, which is right whenever
 * the browser and the SharePoint site agree on a timezone. A value carrying no
 * time at all is taken exactly as it stands.
 */
function dayOf(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  return Number.isNaN(at) ? text : day(new Date(at))!;
}

/** True when the row already says what we would write. */
function same(existing: ListItemFields, next: ListItemFields): boolean {
  return Object.entries(next).every(([key, value]) => {
    const had = existing[key];
    if (value === null || value === '') {
      return had === null || had === undefined || had === '';
    }
    if (typeof value === 'number') return Number(had) === value;
    if (typeof value === 'boolean') return Boolean(had) === value;
    // The Date column names a shift, not a moment — compare the day itself.
    if (key === PRODUCTION_COLUMNS.date) return dayOf(had) === String(value);
    if (INSTANT_COLUMNS.has(key)) {
      const wanted = Date.parse(String(value));
      const found = Date.parse(String(had ?? ''));
      if (!Number.isNaN(wanted)) return !Number.isNaN(found) && found === wanted;
    }
    return String(had ?? '') === String(value);
  });
}

/** The subset of `next` that `existing` disagrees with. */
function drift(
  existing: ListItemFields,
  next: ListItemFields,
  keys: readonly string[],
): ListItemFields {
  const out: ListItemFields = {};
  for (const key of keys) {
    if (!(key in next)) continue;
    if (!same(existing, { [key]: next[key] })) out[key] = next[key];
  }
  return out;
}

/** `YYYY-MM-DD` from whatever the list stores in its Date column. */
const rowDay = (fields: ListItemFields): string =>
  dayOf(fields[PRODUCTION_COLUMNS.date]);

/**
 * An order's stored rows, indexed the two ways a shift's row is found.
 *
 * `RecordKey` first, because it is the column the list is keyed on and the only
 * one that survives the round trip unaltered: the `Date` column is a SharePoint
 * date, and what comes back out of one depends on how the column was created
 * and on which timezone the site and the browser are each in. A shift whose row
 * was not recognised got a *second* row, which is how a job ends up with two
 * rows for one day — and, downstream, why the Assembly KPI page refuses to
 * report a day it cannot read a single figure from.
 *
 * The day index stays as the fallback for rows written before RecordKey
 * existed, and for any a backend opened without one.
 */
interface StoredRows {
  byKey: Map<string, ListItem>;
  byDay: Map<string, ListItem>;
  /** Rows beyond the first for one key — the duplicates somebody has to clear. */
  extras: ListItem[];
  all: ListItem[];
}

/** Item ids are numeric strings; oldest first, so the first row written wins. */
const oldestFirst = (a: ListItem, b: ListItem): number =>
  (Number(a.id) || 0) - (Number(b.id) || 0);

function indexRows(jobNum: string, rows: ListItem[]): StoredRows {
  const byKey = new Map<string, ListItem>();
  const byDay = new Map<string, ListItem>();
  const extras: ListItem[] = [];
  for (const row of [...rows].sort(oldestFirst)) {
    const rawKey = String(row.fields[PRODUCTION_COLUMNS.recordKey] ?? '').trim();
    const day = rowDay(row.fields);
    const key = rawKey || legacyKey(jobNum, day);
    if (byKey.has(key) || byDay.has(day)) {
      extras.push(row);
      continue;
    }
    byKey.set(key, row);
    byDay.set(day, row);
  }
  return { byKey, byDay, extras, all: rows };
}

/**
 * The row this shift owns, claimed so nothing else can take it.
 *
 * Three questions, narrowest first: the key the booking itself carries, then
 * the key rows used to be given, then the day. The last two are what recognise
 * a row written before bookings had keys — and the row so recognised is
 * rewritten under the booking's own key, so each row is asked the older
 * questions exactly once in its life.
 *
 * Claiming matters: a row whose key and Date disagree would otherwise answer
 * two different shifts, and the pass would write one day into it and then the
 * other.
 */
function claimRow(
  index: StoredRows,
  jobNum: string,
  shift: ProductionEntry,
): ListItem | null {
  const found =
    (shift.recordKey ? index.byKey.get(shift.recordKey) : undefined) ??
    index.byKey.get(legacyKey(jobNum, shift.date)) ??
    index.byDay.get(shift.date) ??
    null;
  if (!found) return null;
  if (shift.recordKey) index.byKey.delete(shift.recordKey);
  index.byKey.delete(legacyKey(jobNum, shift.date));
  const storedKey = String(found.fields[PRODUCTION_COLUMNS.recordKey] ?? '').trim();
  if (storedKey) index.byKey.delete(storedKey);
  index.byDay.delete(shift.date);
  index.byDay.delete(rowDay(found.fields));
  return found;
}

/**
 * Two orders' worth of facts for one job number, folded into one.
 *
 * Nothing on the board should produce them, and one that did would write the
 * same row twice in a single pass — the snapshot this sync reads is taken once,
 * so the second write would not see the first. Cheap to rule out here; the cost
 * of not ruling it out is a duplicate nobody can explain.
 */
function oneFactsPerJob(orders: OrderFacts[]): OrderFacts[] {
  const byJob = new Map<string, OrderFacts>();
  for (const facts of orders) {
    const held = byJob.get(facts.jobNum);
    if (!held) {
      byJob.set(facts.jobNum, facts);
      continue;
    }
    const shifts = new Map(held.shifts.map((shift) => [shift.date, shift]));
    for (const shift of facts.shifts) shifts.set(shift.date, shift);
    byJob.set(facts.jobNum, { ...held, shifts: [...shifts.values()] });
  }
  return [...byJob.values()];
}

/**
 * Open the row for one shift, having first made sure it is not already there.
 *
 * The snapshot a sync works from is as old as the sync, and it is not the only
 * board writing. A second tab, a second supervisor's screen, the board left
 * open on the line terminal — each holds the same plan and each reaches the
 * same conclusion that today has no row yet, so each opens one. That is the
 * duplicate: an order closed at the end of a shift appears twice in
 * `ASSY_Production`, identical in every column, because two boards wrote the
 * first row of that day within a second of each other. Updates never did this;
 * only opening a row.
 *
 * So the key is asked for by name immediately before writing, and a row that
 * has appeared since the snapshot is updated instead of duplicated. It narrows
 * the window to the round trip rather than closing it — the list's own unique
 * index on `RecordKey` is what closes it, and this recovers from that index
 * refusing the write as well. Where the transport cannot ask (Graph needs the
 * column indexed and an opt-in header), or the question itself fails, the row
 * is opened anyway and the failure is reported: recording production matters
 * more than a check that protects against a rarity.
 *
 * Returns the item id written, `null` when nothing was, or `'abort'` when the
 * failure is one that will not answer differently on the next row.
 */
async function openRow(
  cfg: SharePointConfig,
  list: string,
  key: string,
  wanted: ListItemFields,
  out: SyncOutcome,
  note: (e: WriteError) => void,
): Promise<string | null | 'abort'> {

  /** The row the list holds under this key right now, if it can be asked. */
  const lookup = async (): Promise<ListItem | null> => {
    const found = await fetchRowsWhere(cfg, list, PRODUCTION_COLUMNS.recordKey, key);
    if (!found) return null;
    if (!found.ok) {
      note(found.error);
      return null;
    }
    return found.value.sort(oldestFirst)[0] ?? null;
  };

  const write = async (row: ListItem): Promise<string | null | 'abort'> => {
    if (same(row.fields, wanted)) {
      out.unchanged++;
      return row.id;
    }
    const res = await updateListItem(cfg, list, row.id, wanted, ...(cfg.authMode === 'session' ? [row.etag] : []));
    if (res.ok) {
      out.updated++;
      return row.id;
    }
    note(res.error);
    return isTransient(res.error) ? null : 'abort';
  };

  const already = await lookup();
  if (already) return write(already);

  const res = await createListItem(cfg, list, wanted);
  if (res.ok) {
    out.created++;
    return res.value || null;
  }
  // A unique index on RecordKey answers the losing writer with a 400. That is
  // the index doing its job, not a fault, so take the row that won and write
  // this shift into it rather than reporting a failure nobody can act on.
  const won = await lookup();
  if (won) return write(won);
  note(res.error);
  return isTransient(res.error) ? null : 'abort';
}

/**
 * Push the board into the list: open a row for any order that has none, upsert
 * each booked shift, and refresh the order-level columns on every other row of
 * that job so a changed Due Date reaches all of them.
 *
 * A read failure aborts before any write, so a transient Graph error cannot
 * half-apply a plan.
 */
export async function syncProduction(
  cfg: SharePointConfig,
  list: string,
  orders: OrderFacts[],
): Promise<SyncOutcome> {
  const out: SyncOutcome = {
    created: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
    retryable: false,
  };
  const note = (e: WriteError): void => {
    out.errors.push(e.message);
    out.retryable ||= isTransient(e);
  };

  const existing = await fetchListItemsWithIds(cfg, list);
  if (!existing.ok) {
    note(existing.error);
    return out;
  }

  const byJob = new Map<string, ListItem[]>();
  for (const item of existing.value) {
    const key = String(item.fields[PRODUCTION_COLUMNS.jobNum] ?? '').trim();
    if (!key) continue;
    const rows = byJob.get(key) ?? [];
    rows.push(item);
    byJob.set(key, rows);
  }

  // Said once at the end. While the roster is the built-in fallback this is
  // true of every order on the board, and eighty copies of it in the banner
  // buried whatever else the sync had to say.
  const withDemoCrew: string[] = [];

  for (const facts of oneFactsPerJob(orders)) {
    if (facts.hasSyntheticCrew) {
      withDemoCrew.push(facts.jobNum);
      continue;
    }
    const index = indexRows(facts.jobNum, byJob.get(facts.jobNum) ?? []);
    /*
     * Duplicates are reported, not obeyed.
     *
     * This used to abandon the whole job on finding a second row for one day,
     * which left the order's real bookings unwritten for as long as the extra
     * row existed — the duplicate stopped the record rather than the record
     * being repaired. The oldest row for each day stays canonical and goes on
     * being kept current; the extras are named here, item id and all, so they
     * can be deleted. Nothing is deleted from here: removing somebody's
     * production row is not a thing a background sync should decide.
     */
    for (const extra of index.extras) {
      out.errors.push(
        `${facts.jobNum} ${rowDay(extra.fields)}: duplicate row (item ${extra.id}) — ` +
          'delete it in SharePoint; the older row is the one being kept current.',
      );
    }

    // Every order holds at least one row: open one when the list has none and
    // no shift has been booked. Once it exists this branch never fires again,
    // so the anchor day cannot drift from one refresh to the next.
    const shifts =
      facts.shifts.length > 0
        ? facts.shifts
        : index.all.length === 0
          ? [blankShift(facts.anchorDay)]
          : [];

    /** Rows this pass has written in full — their day belongs to a shift. */
    const written = new Set<string>();

    for (const shift of shifts) {
      const wanted = rowFields(facts, shift);
      const found = claimRow(index, facts.jobNum, shift);

      if (!found) {
        const opened = await openRow(cfg, list, keyFor(facts.jobNum, shift), wanted, out, note);
        if (opened === 'abort') return out;
        if (opened) written.add(opened);
        continue;
      }
      written.add(found.id);
      if (same(found.fields, wanted)) {
        out.unchanged++;
        continue;
      }
      const res = await updateListItem(cfg, list, found.id, wanted, ...(cfg.authMode === 'session' ? [found.etag] : []));
      if (res.ok) out.updated++;
      else { note(res.error); if (!isTransient(res.error)) return out; }
    }

    // Rows for days this board is not booking — older shifts, or entries the
    // backend added. Their production figures are theirs to keep; only the
    // order-level columns follow the plan.
    const orderWide = orderFields(facts);
    for (const row of index.all) {
      if (written.has(row.id) || index.extras.includes(row)) continue;
      const isOpenPlaceholder =
        facts.shifts.length === 0 && rowDay(row.fields) === facts.anchorDay;
      const wanted = isOpenPlaceholder
        ? {
            ...orderWide,
            [PRODUCTION_COLUMNS.operators]: facts.operatorNames.join(', '),
            [PRODUCTION_COLUMNS.operatorIds]: facts.operatorIds.join(','),
          }
        : orderWide;
      const keys = isOpenPlaceholder
        ? [
            ...ORDER_LEVEL,
            PRODUCTION_COLUMNS.operators,
            PRODUCTION_COLUMNS.operatorIds,
          ]
        : ORDER_LEVEL;
      const stale = drift(row.fields, wanted, keys);
      if (Object.keys(stale).length === 0) {
        out.unchanged++;
        continue;
      }
      const res = await updateListItem(cfg, list, row.id, stale, ...(cfg.authMode === 'session' ? [row.etag] : []));
      if (res.ok) out.updated++;
      else { note(res.error); if (!isTransient(res.error)) return out; }
    }
  }

  if (withDemoCrew.length > 0) {
    const shown = withDemoCrew.slice(0, 3).join(', ');
    out.errors.push(
      `${withDemoCrew.length} order${withDemoCrew.length === 1 ? '' : 's'} ` +
        `(${shown}${withDemoCrew.length > 3 ? ', …' : ''}) not written: they ` +
        'carry fallback demo employees, not the real roster.',
    );
  }

  return out;
}
