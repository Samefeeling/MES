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

/** A physical assembly line — the swimlanes on the board. */
export type LineKey = 'PMD' | 'UPL' | 'ASSY' | 'TABLE' | 'UPL_CUT_SEW' | 'UPL_GLUING' | 'UPL_SOFTIE' | 'ASSY_STOOL' | 'FACTORY_GENERAL';

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

/** Cutting is the first process and always takes precedence over Softie. */
const KIND_PATTERNS: [RegExp, WorkKind][] = [
  [/cut/i, 'cut-sew'],
  [/smart\s*softie|ottoman/i, 'smart-softie'],
  [/\bcut\b|cut\s*&\s*sew|cut\s*and\s*sew|sewing/i, 'cut-sew'],
  [/upholster/i, 'upholstery'],
];

/** The trade an order calls for, from its part description. */
export function workKind(description: string, line: LineKey): WorkKind {
  if (line === 'UPL_CUT_SEW') return 'cut-sew';
  if (line === 'UPL_SOFTIE') return 'smart-softie';
  if (line === 'UPL_GLUING' || line === 'FACTORY_GENERAL') return 'general';
  if (/cut/i.test(description)) return 'cut-sew';
  if (line !== 'UPL') return 'general';
  return KIND_PATTERNS.find(([re]) => re.test(description))?.[1] ?? 'upholstery';
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

export const LINE_PMD = WorkCenterId('PMD');
export const LINE_UPL = WorkCenterId('UPL');
export const LINE_ASSY = WorkCenterId('ASSY');
export const LINE_TABLE = WorkCenterId('TABLE');

export const LINES: LineDef[] = [
  {
    key: 'PMD',
    id: LINE_PMD,
    name: 'PMD',
    schedulable: false,
    types: [],
    parallelOrders: 0,
    sortIndex: 0,
  },
  {
    key: 'UPL',
    id: LINE_UPL,
    name: 'UPL - ASSY',
    schedulable: true,
    types: ['cutting-sewing', 'upholstery'],
    parallelOrders: PARALLEL_ORDERS_PER_LINE,
    sortIndex: 1,
  },
  {
    key: 'ASSY',
    id: LINE_ASSY,
    name: 'ASSY - Seats',
    schedulable: true,
    types: ['final-assembly'],
    parallelOrders: PARALLEL_ORDERS_PER_LINE,
    sortIndex: 2,
  },
  {
    key: 'TABLE',
    id: LINE_TABLE,
    name: 'Table',
    schedulable: true,
    types: ['final-assembly'],
    parallelOrders: PARALLEL_ORDERS_PER_LINE,
    sortIndex: 3,
  },
];

LINES.splice(1, 0,
  { key: 'UPL_CUT_SEW', id: WorkCenterId('UPL_CUT_SEW'), name: 'UPL - Cut/Sewing', schedulable: true, types: ['cutting-sewing'], parallelOrders: 3, sortIndex: 1 },
  { key: 'UPL_GLUING', id: WorkCenterId('UPL_GLUING'), name: 'UPL - Gluing', schedulable: true, types: ['upholstery'], parallelOrders: 3, sortIndex: 2 },
);
LINES.splice(4, 0,
  { key: 'UPL_SOFTIE', id: WorkCenterId('UPL_SOFTIE'), name: 'UPL - Softie (SSS)', schedulable: true, types: ['upholstery'], parallelOrders: 3, sortIndex: 4 },
  { key: 'ASSY_STOOL', id: WorkCenterId('ASSY_STOOL'), name: 'ASSY - Stool', schedulable: true, types: ['final-assembly'], parallelOrders: 3, sortIndex: 5 },
);
LINES.push({ key: 'FACTORY_GENERAL', id: WorkCenterId('FACTORY_GENERAL'), name: 'Factory General', schedulable: true, types: ['final-assembly'], parallelOrders: 15, sortIndex: 8 });
LINES.forEach((line, index) => { line.sortIndex = index; });

/** ERP centres remain coarse; only initial placement is inferred. */
export function initialLine(description: string, resource: string): LineKey | null {
  if (/cut/i.test(description)) return 'UPL_CUT_SEW';
  const key = resource.trim().toUpperCase();
  if (key === 'UPL') {
    if (/sew/i.test(description)) return 'UPL_CUT_SEW';
    if (/glue|gluing|foamed\s*up/i.test(description)) return 'UPL_GLUING';
    if (/smart\s*soft|softie|\bsss\b|ottoman/i.test(description)) return 'UPL_SOFTIE';
    return 'UPL';
  }
  if (key === 'ASSY') return /stool/i.test(description) ? 'ASSY_STOOL' : 'ASSY';
  return LINES.find(line => line.key === key)?.key ?? null;
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
