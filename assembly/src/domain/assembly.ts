/**
 * Assembly department domain: lines, work-order types and the shift roster.
 *
 * Deliberately small. ~15 people on one white shift, the supervisor dispatches
 * on the floor, and nobody reports by the hour — completed quantity is entered
 * once at the end of the shift. So there is no operation routing and no event
 * stream: an order belongs to a line, carries a type, and has up to four people
 * on it.
 */

import { WorkCenterId, type WorkerId } from './ids';

/**
 * A physical assembly line — the swimlanes on the board.
 *
 * Eight, and the plant names them TBP, PMD, UPL-CUT, UPL-Gluing, UPL-SSS,
 * ASM, Table and General (see `LINES` for the display names). The keys keep
 * their older spellings on purpose: they are written into saved plans, into
 * `ASSY_Operator` skills and into the SharePoint containers, and renaming
 * them would orphan every plan already on the tenant for no gain the floor
 * would ever see.
 *
 * `UPL` (the catch-all upholstery lane) and `ASSY_STOOL` are gone — the BOM
 * rules now say which upholstery bench a part belongs on, and stools are
 * ordinary ASM work. `LEGACY_LINE_KEYS` maps both onto their successors so a
 * plan saved before this change still opens.
 */
export type BuiltInLineKey = 'TBP' | 'PMD' | 'UPL_CUT_SEW' | 'UPL_GLUING' | 'UPL_SOFTIE' | 'ASSY' | 'TABLE' | 'FACTORY_GENERAL';

/**
 * A line the supervisor added on the floor.
 *
 * Eight lines are what the plant is built as; what it is *running* on a given
 * week is a different question — a second table bench for a rush, a bay set up
 * for one big order, a crew split off to clear a backlog. Those have nowhere
 * to go on a fixed list, so the work lands on a line that is not where it is
 * happening and the people on it read as booked somewhere else.
 *
 * Kept as a prefixed key rather than a free string so it is still a `LineKey`
 * everywhere — the roster, the containers, the placements — and so a stored
 * plan can always be told apart from a built-in line by looking at it.
 */
export type VirtualLineKey = `VL_${string}`;
export const VIRTUAL_LINE_PREFIX = 'VL_';

export type LineKey = BuiltInLineKey | VirtualLineKey;

export const isVirtualLine = (key: string): key is VirtualLineKey =>
  key.startsWith(VIRTUAL_LINE_PREFIX);

/** The only three kinds of assembly work order. */
export type OrderType = 'cutting-sewing' | 'upholstery' | 'final-assembly';

/**
 * A kind of work within a line, finer than the line itself.
 *
 * UPL is not one bench: cutting and sewing, building the softies, and
 * upholstering the frame are different trades, and the people are not
 * interchangeable between them. The kind is read off the part description —
 * that is where the floor reads it too, and it is the one field every export
 * carries.
 *
 * `general` is every other line, where the line *is* the qualification.
 */
export type WorkKind = 'general' | 'cut-sew' | 'smart-softie' | 'upholstery';

/**
 * Work nobody may take without being named for it. Everything else is open to
 * anyone on the line who is not restricted to something narrower.
 */
const RESTRICTED_KINDS: WorkKind[] = ['smart-softie'];

/**
 * The trade an order calls for.
 *
 * Now purely a property of the line. It used to fall back to reading keywords
 * out of the part description, because `UPL` was one lane holding three
 * different benches and the description was the only hint available. The BOM
 * rules split that lane into UPL-CUT / UPL-Gluing / UPL-SSS, so the line
 * already *is* the answer, and guessing from a description that happens to
 * contain "cut" can only disagree with it.
 */
export function workKind(line: LineKey): WorkKind {
  if (line === 'UPL_CUT_SEW') return 'cut-sew';
  if (line === 'UPL_SOFTIE') return 'smart-softie';
  // Gluing is upholstery, and now says so. It read as `general` only because
  // the catch-all `UPL` lane beside it was where upholstery work actually
  // landed; with that lane gone, a cutter is no longer implicitly qualified
  // to glue — which is what `trades` was always for.
  if (line === 'UPL_GLUING') return 'upholstery';
  return 'general';
}

/**
 * May this person take that kind of work?
 *
 * Someone with trades listed does those and nothing else — that is what makes
 * a cutter a cutter. Someone with none listed does anything on their line that
 * is not restricted, so a roster that says nothing about trades behaves
 * exactly as it did before there were any.
 */
export function canWorkKind(worker: Worker, kind: WorkKind): boolean {
  // A trade list says which bench on a line that has benches. Every other line
  // is qualified by the line itself, so a cutter is still a whole ASSY hand.
  if (kind === 'general') return true;
  const trades = worker.trades ?? [];
  if (trades.length > 0) return trades.includes(kind);
  return !RESTRICTED_KINDS.includes(kind);
}

/** Physical prep state of the material kit, set by the material handler. */
export type MaterialPrepStatus =
  | 'unknown'
  | 'not-prepared'
  | 'preparing'
  | 'ready'
  | 'shortage';

export interface LineDef {
  key: LineKey;
  id: WorkCenterId;
  name: string;
  /**
   * PMD is shown for context only — it mirrors the moulding plan so the
   * supervisor can see what is feeding assembly. It is not scheduled here.
   */
  schedulable: boolean;
  /** Work-order types this line runs. */
  types: OrderType[];
  /**
   * How many orders the line can have in progress side by side. A line is a
   * length of floor with several build positions on it, not a single station,
   * so three teams work three orders at once; the fourth waits for whichever
   * position frees up first.
   */
  parallelOrders: number;
  sortIndex: number;
}

/** Build positions on a line — how many orders it runs at the same time. */
export const PARALLEL_ORDERS_PER_LINE = 3;

export const LINE_TBP = WorkCenterId('TBP');
export const LINE_PMD = WorkCenterId('PMD');
export const LINE_ASSY = WorkCenterId('ASSY');
export const LINE_TABLE = WorkCenterId('TABLE');

/**
 * The eight lines, in the order the floor lists them.
 *
 * TBP, PMD, Table and General are named by ERP itself (`JobHead_PersonID`);
 * UPL-CUT, UPL-Gluing, UPL-SSS and ASM are decided from the BOM — see
 * `domain/lineRules`. PMD is shown for context only: it mirrors moulding's
 * plan so the supervisor can see what is feeding assembly, and is scheduled
 * on the PMD dashboard, not here.
 */
export const LINES: LineDef[] = [
  { key: 'TBP', id: LINE_TBP, name: 'TBP', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 0 },
  { key: 'PMD', id: LINE_PMD, name: 'PMD', schedulable: false, types: [], parallelOrders: 0, sortIndex: 1 },
  { key: 'UPL_CUT_SEW', id: WorkCenterId('UPL_CUT_SEW'), name: 'UPL-CUT', schedulable: true, types: ['cutting-sewing'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 2 },
  { key: 'UPL_GLUING', id: WorkCenterId('UPL_GLUING'), name: 'UPL-Gluing', schedulable: true, types: ['upholstery'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 3 },
  { key: 'UPL_SOFTIE', id: WorkCenterId('UPL_SOFTIE'), name: 'UPL-SSS', schedulable: true, types: ['upholstery'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 4 },
  { key: 'ASSY', id: LINE_ASSY, name: 'ASM', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 5 },
  { key: 'TABLE', id: LINE_TABLE, name: 'Table', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 6 },
  { key: 'FACTORY_GENERAL', id: WorkCenterId('FACTORY_GENERAL'), name: 'General', schedulable: true, types: ['final-assembly'], parallelOrders: 15, sortIndex: 7 },
];

/**
 * Lines that no longer exist, and where their work goes.
 *
 * `UPL` was one lane covering three benches; anything still filed against it
 * lands on Gluing, which is where the bulk of it was. `ASSY_STOOL` was a
 * split of ASM that the plant does not run separately any more. Applied when
 * reading saved plans, rosters and exports — never when writing.
 */
const LEGACY_LINE_KEYS: Record<string, LineKey> = {
  UPL: 'UPL_GLUING',
  UPL_ASSY: 'UPL_GLUING',
  ASSY_STOOL: 'ASSY',
};

const LINE_KEYS = new Set<string>(LINES.map((l) => l.key));

/** Display names, normalised the same way: "UPL-CUT" is what people write in
 *  a roster's Skills cell and in `product-lines.v3.json`, and it has to mean
 *  the same line as the stored key `UPL_CUT_SEW`. */
const LINE_NAMES = new Map<string, LineKey>(
  LINES.map((l) => [l.name.toUpperCase().replace(/[\s/-]+/g, '_'), l.key]),
);

/** A line key out of anything stored, exported or typed — null if it is none. */
export function readLineKey(raw: string): LineKey | null {
  const key = raw.trim().toUpperCase().replace(/[\s/-]+/g, '_');
  if (LINE_KEYS.has(key)) return key as LineKey;
  // A line the supervisor added. There is no list of these to check against
  // here — the plan holds them — so the prefix is what identifies one, and a
  // key naming a line this plan no longer has is handled where the containers
  // are, not by pretending it was never a line.
  if (isVirtualLine(key)) return key;
  return LINE_NAMES.get(key) ?? LEGACY_LINE_KEYS[key] ?? null;
}

/** A line the supervisor set up, as the plan stores it. */
export interface VirtualLine {
  key: VirtualLineKey;
  name: string;
}

/** The key a new line gets from its name. Stable, and readable in a saved plan. */
export function virtualLineKey(name: string): VirtualLineKey {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `${VIRTUAL_LINE_PREFIX}${slug || 'LINE'}`;
}

/**
 * An added line as the board understands one: schedulable, running the same
 * number of build positions as a real one, and sorted after the eight.
 *
 * It runs every order type. A line somebody set up this morning has no routing
 * behind it to say what belongs there — that is exactly why they set it up —
 * so nothing is refused from it.
 */
export function virtualLineDef(line: VirtualLine, index: number): LineDef {
  return {
    key: line.key,
    id: WorkCenterId(line.key),
    name: line.name,
    schedulable: true,
    types: ['cutting-sewing', 'upholstery', 'final-assembly'],
    parallelOrders: PARALLEL_ORDERS_PER_LINE,
    sortIndex: LINES.length + index,
  };
}

/**
 * Words ERP writes that name a DEPARTMENT, not a line.
 *
 * `UPL` covers cutting, gluing and the softies; `ASSY` covers everything
 * assembled. Which line inside them is what the BOM rules answer, so these
 * are the values that must fall through to `engine/assembly/lineRouter`
 * rather than being taken at face value.
 */
const ERP_DEPARTMENT_WORDS = new Set(['UPL', 'UPL_ASSY', 'ASSY', 'ASSY_STOOL']);

/**
 * The line ERP itself named — TBP, PMD, Table or General — or null when it
 * only named a department and the BOM has to decide.
 *
 * This is all that is left of the old `initialLine`. Everything it used to
 * infer from the part description — "contains cut", "contains softie",
 * "contains stool" — is gone: a description is what somebody typed, and the
 * BOM is what the part is actually made of.
 */
export function erpNamedLine(resource: string): LineKey | null {
  const raw = resource.trim().toUpperCase().replace(/[\s/-]+/g, '_');
  if (ERP_DEPARTMENT_WORDS.has(raw)) return null;
  // Anything else that names a real line is honoured: a saved plan can carry
  // one of the BOM-decided lines, and that is a placement someone made.
  return readLineKey(raw);
}

export const LINE_BY_ID = new Map(LINES.map((l) => [String(l.id), l]));

/** Short label for the tight left-hand table. */
export const ORDER_TYPE_SHORT: Record<OrderType, string> = {
  'cutting-sewing': 'C/S',
  upholstery: 'UPH',
  'final-assembly': 'F/A',
};

/**
 * The badge on a row. On UPL it names the bench rather than the order type,
 * because Epicor calls both the softies and the upholstering "upholstery" and
 * the whole point of the row is which of the three steps it is.
 */
export const WORK_KIND_SHORT: Record<WorkKind, string> = {
  general: '',
  'cut-sew': 'C/S',
  'smart-softie': 'SOFTIE',
  upholstery: 'UPH',
};

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** One row of the `ASSY_Operator` SharePoint list. */
export interface Worker {
  id: WorkerId;
  name: string;
  /** Lines this person is qualified to work — drives who can be allocated. */
  skills: LineKey[];
  /**
   * Trades within those lines, when the roster names any. A cutter listed as
   * `cut-sew` does cutting and sewing and nothing else; someone listed for no
   * trade does whatever their line runs that is not restricted. See
   * `canWorkKind`.
   */
  trades?: WorkKind[];
  /** On shift today. Attendance is confirmed by the supervisor each morning. */
  onShift: boolean;
  /** Job title from the roster, e.g. "Upholsterer". */
  position?: string;
  /** Who they report to; shown so the supervisor picks from their own people. */
  supervisor?: string;
  /** ISO days the worker is unavailable; supplied by the future attendance API. */
  plannedLeave?: string[];
  /** True only for the built-in fallback roster; never written to SharePoint. */
  synthetic?: boolean;
}

/**
 * One person's planned time on an order.
 *
 * Null boundaries follow the order: a null `fromDay` means its scheduled
 * start, and a null `toDayExclusive` means until the order is complete. Date
 * boundaries are local `YYYY-MM-DD`; the end is exclusive, so a person can
 * finish one order and begin the next on that day without an overlap.
 */
export interface CrewAssignment {
  workerId: string;
  fromDay: string | null;
  toDayExclusive: string | null;
}

/** The most people that may be on one order at the same time. */
export const MAX_WORKERS_PER_ORDER = 4;

// ---------------------------------------------------------------------------
// Shift / calendar
// ---------------------------------------------------------------------------

/**
 * Clock time assembly is on the floor, in hours past midnight: 07:00 to 15:30.
 * The board's "now" marker reads these directly; everything below is derived
 * from them, so the clock and the capacity can never drift apart again.
 */
export const SHIFT_START_HOUR = 7;
export const SHIFT_END_HOUR = 15.5;

/** Single white shift, 07:00 to 15:30 — 8.5 hours on the floor. */
export const SHIFT_HOURS = SHIFT_END_HOUR - SHIFT_START_HOUR;

/** Morning tea and lunch, half an hour each. */
export const MORNING_TEA_HOURS = 0.5;
export const LUNCH_HOURS = 0.5;
/** Non-productive break time per person per day. */
export const BREAK_HOURS = MORNING_TEA_HOURS + LUNCH_HOURS;

/**
 * Productive hours one person contributes in a day: **7.5**.
 *
 * 07:00 to 15:30 is 8.5 hours on the floor, less half an hour of morning tea
 * and half an hour of lunch. Every duration on the board divides the order's
 * remaining standard hours by this, so it is also the rate Epicor's own Start
 * Date was worked back from — see `latestStart`.
 */
export const PRODUCTIVE_HOURS_PER_PERSON = SHIFT_HOURS - BREAK_HOURS;

/** How many days the timeline shows by default. */
export const DEFAULT_HORIZON_DAYS = 14;
