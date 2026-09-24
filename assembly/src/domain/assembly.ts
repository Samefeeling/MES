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
export type BuiltInLineKey =
  | 'TBP'
  | 'PMD'
  | 'UPL_CUT_SEW'
  | 'UPL_GLUING'
  | 'UPL_GLUING_FOAM'
  | 'UPL_GLUING_SEW'
  | 'UPL_GLUING_STAPLE'
  | 'UPL_SOFTIE'
  | 'UPL_SOFTIE_FOAM'
  | 'UPL_SOFTIE_SEW'
  | 'UPL_SOFTIE_STAPLE'
  | 'ASSY'
  | 'TABLE'
  | 'FACTORY_GENERAL';

/**
 * The three benches a UPL line is actually made of.
 *
 * UPL-SSS and UPL-Gluing were each one lane on the board and three benches on
 * the floor, so a supervisor allocating four people to "UPL-SSS" was saying
 * nothing about which of the three they were standing at. The steps run in
 * order — foam, then sew, then staple — except on Gluing, where the first two
 * are worked side by side.
 */
export type ProductionStep = 'foaming' | 'sewing' | 'stapling';

export const STEP_NAME: Record<ProductionStep, string> = {
  foaming: 'Foaming',
  sewing: 'Sewing',
  stapling: 'Stapling',
};

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
export function workKind(key: LineKey): WorkKind {
  // A bench is the same trade as the lane it is on: splitting UPL-SSS into
  // three benches did not make its stapler any less of a softie hand.
  const line = rootLineKey(key);
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
   * The line this one is a bench of, for the two that have benches.
   *
   * A step line is a line in every way that matters — it holds orders, takes
   * people, has build positions — and is drawn indented under its parent,
   * whose header carries the three of them added up. The parent stays
   * schedulable: a plan saved before the split, or an order nobody has routed
   * to a bench, still has somewhere to sit.
   */
  parent?: LineKey;
  /** Which bench, for a step line. */
  step?: ProductionStep;
  /**
   * PMD is shown for context only — it mirrors the moulding plan so the
   * supervisor can see what is feeding assembly. It is not scheduled here.
   */
  schedulable: boolean;
  /**
   * What the abbreviation stands for, where the floor's own shorthand is not
   * obvious to somebody new. Shown beside the name on
   * the line's row, which is a board read across a workshop by people who did
   * not choose the abbreviation.
   */
  fullName?: string;
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
const bench = (
  parent: BuiltInLineKey,
  key: BuiltInLineKey,
  runs: ProductionStep,
  sortIndex: number,
): LineDef => ({
  key,
  id: WorkCenterId(key),
  name: STEP_NAME[runs],
  schedulable: true,
  types: ['upholstery'],
  parallelOrders: PARALLEL_ORDERS_PER_LINE,
  sortIndex,
  parent,
  step: runs,
});

export const LINES: LineDef[] = [
  { key: 'TBP', id: LINE_TBP, name: 'TBP', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 0 },
  { key: 'PMD', id: LINE_PMD, name: 'PMD', schedulable: false, types: [], parallelOrders: 0, sortIndex: 1 },
  { key: 'UPL_CUT_SEW', id: WorkCenterId('UPL_CUT_SEW'), name: 'UPL-CUT', schedulable: true, types: ['cutting-sewing'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 2 },
  { key: 'UPL_GLUING', id: WorkCenterId('UPL_GLUING'), name: 'UPL-Gluing', schedulable: true, types: ['upholstery'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 3 },
  bench('UPL_GLUING', 'UPL_GLUING_FOAM', 'foaming', 4),
  bench('UPL_GLUING', 'UPL_GLUING_SEW', 'sewing', 5),
  bench('UPL_GLUING', 'UPL_GLUING_STAPLE', 'stapling', 6),
  { key: 'UPL_SOFTIE', id: WorkCenterId('UPL_SOFTIE'), name: 'UPL-SSS', schedulable: true, types: ['upholstery'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 7 },
  bench('UPL_SOFTIE', 'UPL_SOFTIE_FOAM', 'foaming', 8),
  bench('UPL_SOFTIE', 'UPL_SOFTIE_SEW', 'sewing', 9),
  bench('UPL_SOFTIE', 'UPL_SOFTIE_STAPLE', 'stapling', 10),
  { key: 'ASSY', id: LINE_ASSY, name: 'Assembly', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 11 },
  { key: 'TABLE', id: LINE_TABLE, name: 'Table', schedulable: true, types: ['final-assembly'], parallelOrders: PARALLEL_ORDERS_PER_LINE, sortIndex: 12 },
  { key: 'FACTORY_GENERAL', id: WorkCenterId('FACTORY_GENERAL'), name: 'General', schedulable: true, types: ['final-assembly'], parallelOrders: 15, sortIndex: 13 },
];

/** Parent line key → its benches, in the order they are worked. */
export const STEP_LINES: ReadonlyMap<LineKey, LineDef[]> = LINES.reduce(
  (out, line) => {
    if (!line.parent) return out;
    const held = out.get(line.parent);
    if (held) held.push(line);
    else out.set(line.parent, [line]);
    return out;
  },
  new Map<LineKey, LineDef[]>(),
);

/** The benches of `key`, or nothing for a line that has none. */
export const stepLinesOf = (key: LineKey): LineDef[] =>
  STEP_LINES.get(key) ?? [];

/** One bench of one line, by the step it runs. */
export function stepLine(
  parent: LineKey,
  runs: ProductionStep,
): LineDef | null {
  return stepLinesOf(parent).find((line) => line.step === runs) ?? null;
}

/**
 * The line a key belongs to — itself, or the parent when it names a bench.
 *
 * Everything written against the lane before it had benches — a roster's
 * Skills cell, a routing rule, `workKind` — is still answered by the lane, so
 * those readings come through here rather than each one learning the benches.
 */
export function rootLineKey(key: LineKey): LineKey {
  return LINES.find((line) => line.key === key)?.parent ?? key;
}

/**
 * Do these two keys name the same place to stand?
 *
 * Somebody the roster puts on UPL-SSS is standing at its benches as far as
 * being offered for an order goes — the supervisor moves them to one of the
 * three, they do not have to be moved before they can be picked.
 */
export const onSameLane = (
  a: LineKey | undefined | null,
  b: LineKey | undefined | null,
): boolean => Boolean(a && b && rootLineKey(a) === rootLineKey(b));

/** Is this person qualified for the line — or for the lane its bench is on? */
export function worksLine(
  worker: { skills: LineKey[] },
  key: LineKey,
): boolean {
  if (worker.skills.includes(key)) return true;
  const root = rootLineKey(key);
  return root !== key && worker.skills.includes(root);
}

/**
 * Lines that no longer exist, and where their work goes.
 *
 * `UPL` was one lane covering three benches; anything still filed against it
 * lands on Gluing, which is where the bulk of it was. `ASSY_STOOL` was a
 * split of ASM that the plant does not run separately any more. `ASM` and
 * `ASSEMBLY_SEATS` are the two names the assembly line has been written under
 * before it was simply Assembly, and every saved plan, roster cell and
 * production row carrying either has to keep landing on it. Applied when
 * reading saved plans, rosters and exports — never when writing.
 */
const LEGACY_LINE_KEYS: Record<string, LineKey> = {
  ASM: 'ASSY',
  ASSEMBLY_SEATS: 'ASSY',
  UPL: 'UPL_GLUING',
  UPL_ASSY: 'UPL_GLUING',
  ASSY_STOOL: 'ASSY',
};

const LINE_KEYS = new Set<string>(LINES.map((l) => l.key));

/** Display names, normalised the same way: "UPL-CUT" is what people write in
 *  a roster's Skills cell and in `product-lines.v3.json`, and it has to mean
 *  the same line as the stored key `UPL_CUT_SEW`. */
const LINE_NAMES = new Map<string, LineKey>(
  // Benches are left out on purpose: "Foaming" names one on UPL-SSS and one on
  // UPL-Gluing, and a roster cell saying only that has not said which.
  LINES.filter((l) => !l.step).map((l) => [
    l.name.toUpperCase().replace(/[\s/-]+/g, '_'),
    l.key,
  ]),
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
 * The lines in the sequence somebody arranged them in.
 *
 * `LINES` is the order the plant lists its lines in, which is not the order any
 * particular floor runs them: cutting feeds gluing feeds the softies on one
 * shift and the other way round on the next, and reading a board against the
 * bench order is most of what makes it quick to read. So the arrangement is the
 * supervisor's, and this is where it is applied.
 *
 * `arranged` need not be complete, and usually is not. Anything it does not
 * name — a line opened after the arrangement was made, one of the eight in a
 * plan saved before there was an arrangement at all — keeps its built-in place
 * at the end, in the built-in order. That is what lets a plan stored last month
 * and a bench opened this morning both land somewhere sensible without anybody
 * having to keep this list exhaustive.
 */
export function arrangeLines<T extends { key: string }>(
  lines: readonly T[],
  arranged: readonly string[],
): T[] {
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const placed = new Set<string>();
  const named: T[] = [];
  for (const key of arranged) {
    const line = byKey.get(key);
    // A key naming no line is a bench that has since closed; a key named twice
    // is a plan somebody merged by hand. Neither may put a line on the board
    // twice — two rows for one line means two drop targets with one id.
    if (line === undefined || placed.has(key)) continue;
    placed.add(key);
    named.push(line);
  }
  const order = [...named, ...lines.filter((line) => !placed.has(line.key))];
  return keepBenchesWithLanes(order);
}

/**
 * Put every bench back under its lane, wherever the lane ended up.
 *
 * A bench is not a line the supervisor arranges: it is one of the three the
 * lane is made of, and a board with Sewing between Table and General would be
 * saying something about the floor that is not true. So the arrangement is
 * over lanes, and the benches follow — including an arrangement saved before
 * the lanes had benches at all, which names none of them.
 */
function keepBenchesWithLanes<T extends { key: string }>(lines: readonly T[]): T[] {
  const benches = new Map<string, T[]>();
  for (const line of lines) {
    const parent = LINES.find((def) => def.key === line.key)?.parent;
    if (!parent) continue;
    const held = benches.get(parent);
    if (held) held.push(line);
    else benches.set(parent, [line]);
  }
  if (benches.size === 0) return [...lines];

  const moved = new Set(
    [...benches.values()].flat().map((line) => line.key),
  );
  const out: T[] = [];
  for (const line of lines) {
    if (moved.has(line.key)) continue;
    out.push(line);
    // In the order the plant lists them, not the order they were found in:
    // foam, then sew, then staple is how the work runs.
    const held = benches.get(line.key);
    if (held) {
      out.push(
        ...stepLinesOf(line.key as LineKey)
          .map((def) => held.find((line) => line.key === def.key))
          .filter((line): line is T => Boolean(line)),
      );
    }
  }
  // A bench whose lane is not on this board keeps its place rather than
  // vanishing — the board draws what it was given.
  const drawn = new Set(out.map((line) => line.key));
  return [...out, ...lines.filter((line) => !drawn.has(line.key))];
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

/**
 * People the supervisor counts as one crew, and the lines they share.
 *
 * A line has no capacity of its own: whoever cuts on UPL-CUT also works Smart
 * Soft Seating and Upholstery, and the assembly crew helps out on Upholstery.
 * So capacity is set per group, and a line that appears in two groups draws on
 * both — its own group first, the next one for whatever that cannot cover.
 */
export interface CrewPool {
  id: string;
  name: string;
  /** The lanes this crew works, first-listed taking precedence for sharing. */
  lines: LineKey[];
  /** Head count on a normal working day. */
  people: number;
}

/** The floor as the supervisor described it; editable on the board. */
export const DEFAULT_CREW_POOLS: CrewPool[] = [
  { id: 'upholstery', name: 'Upholstery crew', lines: ['UPL_CUT_SEW', 'UPL_SOFTIE', 'UPL_GLUING'], people: 4 },
  { id: 'assembly', name: 'Assembly crew', lines: ['ASSY', 'UPL_GLUING'], people: 4 },
  { id: 'table', name: 'Table crew', lines: ['TABLE'], people: 3 },
];
