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
import type { SharePointConfig } from '@/data/sharepoint/site';
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
   * A bench is a step of the order, not an order: one number, one set of
   * quantities, received once at the last operation. What a booking on an
   * earlier bench reports is hours — sewing nine covers is nine covers ready
   * to be stapled, not nine chairs made — and writing a quantity there would
   * count the same nine twice. That is the one mistake the route could
   * introduce, and `ShiftFacts.receives` is what prevents it.
   */
  operation?: {
    seq: number;
    step: string;
    index: number;
    of: number;
    last: boolean;
  };
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
  shifts: ShiftFacts[];
}

/**
 * A booked shift, and which operation booked it.
 *
 * `receives` is the whole of what the record needs to know: the last operation
 * puts units into stock, every earlier one puts hours against the order and
 * nothing else.
 */
export interface ShiftFacts extends ProductionEntry {
  opSeq?: number;
  /** The bench, for the record to be readable without a join. */
  step?: string;
  receives: boolean;
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
        const op = row.job.operation;
        return {
          manual: row.job.manual,
          operation: op
            ? {
                seq: op.seq,
                step: op.step,
                index: op.index,
                of: op.of,
                last: op.last,
              }
            : undefined,
          // The order's own number, always. `ASM8001#20` is how the board
          // files the row; it is not a job number and never leaves the board.
          jobNum: String(op?.jobNum ?? row.job.id),
          line: group.line.name,
          operatorIds: anchorCrew.map((worker) => String(worker.id)),
          operatorNames: anchorCrew.map((worker) => worker.name),
          hasSyntheticCrew: anchorCrew.some((worker) => worker.synthetic),
          // The order's standard content, not this bench's share of it: the
          // record is of the order, and the KPI divides output by it.
          stdHours: row.job.manual
            ? row.job.manual.plannedHours
            : Math.max(0, op?.orderHours ?? row.job.laborHrs),
          startDate: iso(row.plannedStart),
          actualStartAt: row.actualStart?.startedAt ?? null,
          startOverrideReason: row.actualStart?.overrideReason ?? null,
          dueDate: iso(row.job.dueDate),
          expectDate: iso(row.expectDate),
          orderQty: row.job.remainingQty + row.job.completedQty,
          /*
           * Only the last operation receives, so only there has the order's
           * remaining quantity moved. A row sewing its way through the order
           * has made nothing yet as far as stock is concerned.
           */
          remainingQty:
            op && !op.last
              ? row.job.remainingQty + row.job.completedQty
              : row.job.remainingQty,
          // The day the order opens its record on. Falls back to the horizon so
          // an order with no crew — and so no start — still gets its one row.
          anchorDay,
          shifts: (production[String(row.job.id)] ?? []).map((shift) => ({
            ...shift,
            opSeq: op?.seq,
            step: op?.step,
            receives: !op || op.last,
          })),
        };
      }),
    );
}

function orderFields(facts: OrderFacts): ListItemFields {
  const c = PRODUCTION_COLUMNS;
  const noQty = Boolean(facts.manual);
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
  };
}

/**
 * A row's key: `Job|YYYY-MM-DD`, or `Job#Op|YYYY-MM-DD` for one operation of a
 * routed order. One order, one operation, one day — one row.
 *
 * Worked out from what the booking itself holds — the order, the operation and
 * the day as the board wrote it, never the Date column read back — so every
 * board holding a booking for that day arrives at the same key. That is what
 * lets the list's unique index on `RecordKey` refuse a second row outright.
 *
 * For a while each booking carried a random key of its own
 * (`ProductionEntry.recordKey`). Two boards booking the same order on the same
 * day then held two different keys, the unique index had nothing to refuse,
 * and both opened a row: the duplicate the sync kept reporting. Rows written
 * under those keys are still found — by that key, and by their day — and take
 * this key the first time they are written again.
 */
const legacyKey = (jobNum: string, date: string, opSeq?: number): string =>
  opSeq === undefined ? `${jobNum}|${date}` : `${jobNum}#${opSeq}|${date}`;

/** The key this shift's row is written under. */
const keyFor = (jobNum: string, shift: ShiftFacts): string =>
  legacyKey(jobNum, shift.date, shift.opSeq);

/** The operation a stored row belongs to, from its `Op 10 foaming`
 *  description; '' for a row that names none (an order with no route, a
 *  support order, a row written before operations were recorded). */
const rowOp = (fields: ListItemFields): string =>
  /^Op\s+(\d+)\b/i.exec(String(fields[PRODUCTION_COLUMNS.description] ?? '').trim())?.[1] ?? '';

/** One order's place in the record: a day and an operation. */
const slotOf = (day: string, op: string): string => `${day}|${op}`;
const shiftOp = (shift: ShiftFacts): string =>
  shift.opSeq === undefined ? '' : String(shift.opSeq);

/**
 * An empty shift — the row an order opens with before anything is booked.
 *
 * It carries no `recordKey`, because no booking made it: the sync opens it
 * from the board, so `legacyKey` below gives it the one key both sides can
 * work out for themselves. The first real entry for that day then claims the
 * row and writes its own key over it.
 */
function blankShift(date: string, facts: OrderFacts): ShiftFacts {
  return {
    date,
    opSeq: facts.operation?.seq,
    step: facts.operation?.step,
    receives: !facts.operation || facts.operation.last,
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

function rowFields(facts: OrderFacts, shift: ShiftFacts): ListItemFields {
  const c = PRODUCTION_COLUMNS;
  const operatorIds = shift.operatorIds ?? facts.operatorIds;
  const operatorNames = shift.operatorNames ?? facts.operatorNames;
  /*
   * A bench that does not receive reports hours and nothing else. The units it
   * handed on are the same units the last bench will finish, and counting them
   * at both is how one order becomes two in every figure that matters.
   */
  const inTransit = !shift.receives;
  return {
    [c.jobNum]: facts.jobNum,
    [c.date]: shift.date,
    [c.recordKey]: keyFor(facts.jobNum, shift),
    [c.bookedHour]: shift.bookedHours ?? 0,
    ...orderFields(facts),
    /*
     * An operation that does not receive is marked as such, because the KPI
     * has to be able to tell a bench that made nothing from a bench that made
     * nothing *yet*. The hours are held as work in progress and charged
     * against the order when the last operation reports it finished.
     */
    ...(shift.step
      ? { [c.description]: `Op ${shift.opSeq} ${shift.step}` }
      : {}),
    ...(inTransit ? { [c.workType]: 'WIP' } : {}),
    [c.operators]: operatorNames.join(', '),
    [c.operatorIds]: operatorIds.join(','),
    [c.shiftOutput]: inTransit ? 0 : shift.shiftOutput,
    [c.complete]: facts.manual || inTransit ? 0 : shift.complete,
    ...(facts.manual || inTransit ? { [c.laborHours]: shift.laborHours ?? 0 } : {}),
    [c.reject]: inTransit ? 0 : shift.reject,
    [c.rework]: inTransit ? 0 : shift.rework,
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

/**
 * The columns that are this shift's own, out of a whole row's worth.
 *
 * Order-level columns follow the plan and are rewritten on every row of a job
 * all the time, so a difference in one of them says nothing about whose
 * booking a row holds. These are the figures somebody entered.
 */
const ROW_LEVEL = [
  PRODUCTION_COLUMNS.shiftOutput,
  PRODUCTION_COLUMNS.complete,
  PRODUCTION_COLUMNS.reject,
  PRODUCTION_COLUMNS.rework,
  PRODUCTION_COLUMNS.jobCompleted,
  PRODUCTION_COLUMNS.paused,
  PRODUCTION_COLUMNS.pauseReason,
  PRODUCTION_COLUMNS.notes,
] as const;

const rowLevel = (fields: ListItemFields): ListItemFields =>
  Object.fromEntries(
    ROW_LEVEL.filter((key) => key in fields).map((key) => [key, fields[key]]),
  );

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
  /** Day + operation → the row holding it (see `slotOf`). */
  bySlot: Map<string, ListItem>;
  /** Rows beyond the first for one key or one day and operation — the
   *  duplicates somebody has to clear. */
  extras: ListItem[];
  all: ListItem[];
}

/** Item ids are numeric strings; oldest first, so the first row written wins. */
const oldestFirst = (a: ListItem, b: ListItem): number =>
  (Number(a.id) || 0) - (Number(b.id) || 0);

/**
 * One row per order, per operation, per day.
 *
 * The operation is part of it always. It used to count only while two of an
 * order's benches were both on the board: once the first bench finished and
 * left it, the two rows it and the next bench had written on a shared day
 * read as a duplicate — and the next booking that day could be written into
 * the other bench's row.
 */
function indexRows(jobNum: string, rows: ListItem[]): StoredRows {
  const byKey = new Map<string, ListItem>();
  const bySlot = new Map<string, ListItem>();
  const extras: ListItem[] = [];
  for (const row of [...rows].sort(oldestFirst)) {
    const rawKey = String(row.fields[PRODUCTION_COLUMNS.recordKey] ?? '').trim();
    const day = rowDay(row.fields);
    const op = rowOp(row.fields);
    const key = rawKey || legacyKey(jobNum, day, op ? Number(op) : undefined);
    const slot = slotOf(day, op);
    if (byKey.has(key) || bySlot.has(slot)) {
      extras.push(row);
      continue;
    }
    byKey.set(key, row);
    bySlot.set(slot, row);
  }
  return { byKey, bySlot, extras, all: rows };
}

/**
 * The row this shift owns, claimed so nothing else can take it.
 *
 * Narrowest first: the shift's key; the random key an older booking gave the
 * row; the row this order holds for the shift's day and operation; and last,
 * for an operation, a row on that day naming no operation at all — one
 * written before operations were recorded. A row so recognised is rewritten
 * under the shift's key, so it is asked the older questions once in its life.
 *
 * Claiming matters: a row whose key and Date disagree would otherwise answer
 * two different shifts, and the pass would write one day into it and then the
 * other.
 */
function claimRow(
  index: StoredRows,
  jobNum: string,
  shift: ShiftFacts,
): ListItem | null {
  const op = shiftOp(shift);
  const found =
    index.byKey.get(keyFor(jobNum, shift)) ??
    (shift.recordKey ? index.byKey.get(shift.recordKey) : undefined) ??
    index.bySlot.get(slotOf(shift.date, op)) ??
    (op ? index.bySlot.get(slotOf(shift.date, '')) : undefined) ??
    null;
  if (!found) return null;
  for (const [key, row] of index.byKey) if (row === found) index.byKey.delete(key);
  for (const [slot, row] of index.bySlot) if (row === found) index.bySlot.delete(slot);
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
    /*
     * A shift is its day and its operation. Two benches of one order book the
     * same day whenever they run side by side, and keying on the day alone
     * quietly threw one of the two bookings away.
     */
    const keyOf = (shift: ShiftFacts): string => `${shift.date}#${shift.opSeq ?? ''}`;
    const shifts = new Map(held.shifts.map((shift) => [keyOf(shift), shift]));
    for (const shift of facts.shifts) shifts.set(keyOf(shift), shift);
    /*
     * The order's own figures come from the operation nearest the receipt —
     * it is the one whose quantities are the order's — while the hours and
     * everything else agree on every row.
     */
    const base =
      (facts.operation?.index ?? 0) > (held.operation?.index ?? 0)
        ? facts
        : held;
    byJob.set(facts.jobNum, { ...base, shifts: [...shifts.values()] });
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
 * ## Two boards, two keys, one day
 *
 * The key check only catches two boards holding the *same* key. Two boards
 * that each booked the day themselves hold different ones — a key is minted
 * per booking — so each asked for its own key, each was told nothing was
 * there, and each opened a row. That is the duplicate the floor actually
 * meets: two rows for one order and one day, different figures in each,
 * neither of them wrong. It cannot be left to be cleared by hand, because the
 * KPI page refuses to report any range holding one.
 *
 * So the day is asked for as well, and a booking whose day is already on the
 * list is written into the row that is there. Last save wins, which is what
 * saving twice on one board has always done; it is said out loud when the two
 * disagree, because the figures being replaced are somebody's.
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

  /** The rows this job holds under one column's value, if it can be asked. */
  const ask = async (column: string, value: string): Promise<ListItem[] | null> => {
    const found = await fetchRowsWhere(cfg, list, column, value);
    if (!found) return null;
    if (!found.ok) {
      note(found.error);
      return null;
    }
    return found.value;
  };

  /** The row the list holds under this key right now, if it can be asked. */
  const lookup = async (): Promise<ListItem | null> => {
    const rows = await ask(PRODUCTION_COLUMNS.recordKey, key);
    return rows?.sort(oldestFirst)[0] ?? null;
  };

  /*
   * The row this job already has for this day and operation, under whatever
   * key — the same rule `claimRow` applies to the snapshot. Two benches of one
   * order on one day are two records rather than a duplicate.
   */
  const lookupDay = async (): Promise<ListItem | null> => {
    const wantedDay = String(wanted[PRODUCTION_COLUMNS.date] ?? '');
    const job = String(wanted[PRODUCTION_COLUMNS.jobNum] ?? '');
    if (!wantedDay || !job) return null;
    const rows = await ask(PRODUCTION_COLUMNS.jobNum, job);
    if (!rows) return null;
    const wantedOp = rowOp(wanted);
    const onDay = rows.filter((row) => rowDay(row.fields) === wantedDay).sort(oldestFirst);
    return (
      onDay.find((row) => rowOp(row.fields) === wantedOp) ??
      (wantedOp ? onDay.find((row) => rowOp(row.fields) === '') : undefined) ??
      null
    );
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

  const sameDay = await lookupDay();
  if (sameDay) {
    /*
     * Somebody else's booking for this day. Say so where the figures differ:
     * one row per order per day is the record's shape, so this is the right
     * place for the booking to go, but what it replaces was a real shift
     * entry and the supervisor is the one who has to know it changed.
     */
    if (!same(sameDay.fields, rowLevel(wanted))) {
      out.errors.push(
        `${String(wanted[PRODUCTION_COLUMNS.jobNum] ?? '')} ` +
          `${String(wanted[PRODUCTION_COLUMNS.date] ?? '')}: this day was already ` +
          `booked on another board (item ${sameDay.id}) — this entry has replaced ` +
          'it rather than opening a second row.',
      );
    }
    return write(sameDay);
  }

  const res = await createListItem(cfg, list, wanted);
  if (res.ok) {
    out.created++;
    return res.value || null;
  }
  // A unique index on RecordKey answers the losing writer with a 400. That is
  // the index doing its job, not a fault, so take the row that won and write
  // this shift into it rather than reporting a failure nobody can act on.
  const won = (await lookup()) ?? (await lookupDay());
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
          ? [blankShift(facts.anchorDay, facts)]
          : [];

    /** Rows this pass has written in full — their day belongs to a shift. */
    const written = new Set<string>();

    for (const shift of shifts) {
      const wanted = rowFields(facts, shift);
      const found = claimRow(index, facts.jobNum, shift);

      if (!found) {
        const opened = await openRow(
          cfg,
          list,
          keyFor(facts.jobNum, shift),
          wanted,
          out,
          note,
        );
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
