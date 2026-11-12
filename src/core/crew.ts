import type { ProductionRecord } from '../types';

/** Who worked a slice of production: the operators named on its sheets and
 *  the supervisors who signed them off. */
export interface Crew {
  /** Full names, A–Z, one per person. */
  operators: string[];
  /** Supervisors who are not also an operator of the slice — a supervisor
   *  who ran a press is one person, counted with the operators. */
  supervisors: string[];
}

const clean = (s: string | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** "Maria De Souza" → "Maria". */
export function firstName(name: string): string {
  return clean(name).split(' ')[0] ?? '';
}

function distinct(names: Iterable<string>): string[] {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const name = clean(raw);
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** The half-hours whose Quality Check is the supervisor's; every other
 *  one is the operator's. */
export const SUPERVISOR_QC_SLOTS: ReadonlySet<number> = new Set([1, 7, 13]);

/** Who one sheet — a press, a shift, an order — says worked it. */
export interface SheetPeople {
  /** The Operator the sheet names, then whoever else signed its operator
   *  Quality Checks (break cover), most checks first. */
  operators: string[];
  supervisors: string[];
  /** The Operator named on the sheet signed none of its operator Quality
   *  Checks while somebody else did: the name is a leftover (the sheet was
   *  confirmed without re-picking it), and the people who signed are taken
   *  as its operators instead. */
  leftover: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Names by how often they appear, most first; ties A–Z. */
function byCount(names: Iterable<string>): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const raw of names) {
    const name = clean(raw);
    if (!name) continue;
    const held = count.get(name.toLowerCase());
    if (held) held.n++;
    else count.set(name.toLowerCase(), { name, n: 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
}

/**
 * The people of ONE sheet (the records of one press, shift and order).
 *
 * The Operator a sheet names is picked once, at its ✅ Confirm; the Quality
 * Checks are signed by name every half-hour, by whoever is running the press
 * — so somebody covering a break signs a check too, and is one of the
 * sheet's operators: the named Operator first, then the others who signed.
 * Where the two disagree outright — the named Operator signed none of the
 * operator checks and somebody else signed them — the checks are the record
 * of who was at the press. (The Operator sheet used to carry the names over
 * from the shift before, and a crew that confirmed without re-picking was
 * recorded as the crew it relieved.)
 *
 * Supervisors are the one the sheet names and whoever signed it off. Nothing
 * on a sheet contradicts them: somebody on overtime is rightly in two
 * shifts, so a name from the shift before is not, by itself, a mistake.
 */
export function sheetPeople(records: ReadonlyArray<ProductionRecord>): SheetPeople {
  const operator = clean(records.find((r) => r.slotIndex === 0 && clean(r.operator))?.operator)
    || clean(records.find((r) => clean(r.operator))?.operator);
  const operatorChecks = byCount(records.filter((r) => !SUPERVISOR_QC_SLOTS.has(r.slotIndex)).map((r) => r.qcBy));
  const leftover = !!operator && operatorChecks.length > 0 && !operatorChecks.some((n) => same(n, operator));
  const operators = leftover || !operator
    ? operatorChecks
    : [operator, ...operatorChecks.filter((n) => !same(n, operator))];
  const supervisors = byCount(records.flatMap((r) => [r.supervisor, r.lockedBy]));
  return { operators, supervisors, leftover };
}

/** The records sheet by sheet: press, shift and order. */
function sheets(records: ReadonlyArray<ProductionRecord>): ProductionRecord[][] {
  const out = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const key = `${r.machineCode.trim().toUpperCase()}|${r.shiftId}|${r.jobNumber.trim().toUpperCase()}`;
    const sheet = out.get(key);
    if (sheet) sheet.push(r);
    else out.set(key, [r]);
  }
  return [...out.values()];
}

/** The operators of these records' sheets, each once (`sheetPeople`). */
export function operatorsOf(records: ReadonlyArray<ProductionRecord>): string[] {
  return distinct(sheets(records).flatMap((sheet) => sheetPeople(sheet).operators));
}

/**
 * Everybody on the records: the operators and supervisors of their sheets
 * (`sheetPeople`). A supervisor signs every press of the shift and runs
 * none, so they belong to the shift and the floor, not to a press.
 */
export function crewOf(records: ReadonlyArray<ProductionRecord>): Crew {
  const people = sheets(records).map(sheetPeople);
  const operators = distinct(people.flatMap((p) => p.operators));
  const taken = new Set(operators.map((n) => n.toLowerCase()));
  const supervisors = distinct(people.flatMap((p) => p.supervisors)).filter((n) => !taken.has(n.toLowerCase()));
  return { operators, supervisors };
}

export function crewSize(crew: Crew): number {
  return crew.operators.length + crew.supervisors.length;
}

/** A roster tag ("Day", "Day Shift", "D") names this shift. An empty tag
 *  names every shift: a missing tag must never hide a needed name. */
export function shiftTagMatches(tag: string | undefined, shiftCode: string): boolean {
  const have = (tag ?? '').trim().toLowerCase();
  const want = shiftCode.trim().toLowerCase();
  return have === '' || have === want || want.startsWith(have) || have.startsWith(want);
}

/** The shifts each person is rostered on (PMD_Operator.Shift), by name. */
export type Roster = ReadonlyMap<string, ReadonlyArray<string>>;

/** The roster of the People lists: every shift tag a name carries, on any
 *  of them (a supervisor is listed once per shift they cover). */
export function rosterOf(...lists: ReadonlyArray<ReadonlyArray<{ operatorName: string; shift?: string }>>): Roster {
  const out = new Map<string, string[]>();
  for (const person of lists.flat()) {
    const key = clean(person.operatorName).toLowerCase();
    if (!key) continue;
    const tags = out.get(key);
    if (tags) tags.push(person.shift ?? '');
    else out.set(key, [person.shift ?? '']);
  }
  return out;
}

/**
 * Overtime: the person is on the roster, and on none of their shifts is
 * this one. Somebody the roster does not know, or knows without a shift,
 * is taken to be on their own shift.
 */
export function onOvertime(roster: Roster, name: string, shiftCode: string): boolean {
  const tags = roster.get(clean(name).toLowerCase());
  return !!tags && !tags.some((tag) => shiftTagMatches(tag, shiftCode));
}

/** What somebody on overtime counts for in the shift they stayed on for
 *  (or came in early for): half a shift, 4 of its 8 hours. The sheets do
 *  not record how long anybody was in, so it is a fixed share. */
export const OVERTIME_SHARE = 0.5;

/** How many people a slice of production had on. */
export interface Staffing {
  /** Everybody seen in the slice, each once. */
  crew: Crew;
  /** Those of them on overtime in at least one of its shifts. */
  overtime: string[];
  /** Shifts (a date and a shift) with somebody on. */
  shifts: number;
  /** People on per shift, on average: 1 for each person on their own
   *  shift, `OVERTIME_SHARE` for each on overtime. */
  people: number;
}

/**
 * The people on ONE kind of shift (the records of Day, of Afternoon or of
 * Night), over however many days the records span.
 *
 * Each shift counts its people once — whoever signed on several presses,
 * or covered a break, is one person — at 1, or at `OVERTIME_SHARE` when the
 * roster has them on another shift. Over several days the figure is the
 * average per shift worked, so a week reads like a day.
 */
export function shiftStaffing(records: ReadonlyArray<ProductionRecord>, roster: Roster): Staffing {
  const byShift = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const shift = byShift.get(r.shiftId);
    if (shift) shift.push(r);
    else byShift.set(r.shiftId, [r]);
  }
  const overtime: string[] = [];
  let shifts = 0;
  let people = 0;
  for (const [shiftId, shift] of byShift) {
    const crew = crewOf(shift);
    const names = [...crew.operators, ...crew.supervisors];
    if (!names.length) continue;
    const code = shiftId.slice(shiftId.lastIndexOf('-') + 1);
    shifts++;
    for (const name of names) {
      const extra = onOvertime(roster, name, code);
      if (extra) overtime.push(name);
      people += extra ? OVERTIME_SHARE : 1;
    }
  }
  return { crew: crewOf(records), overtime: distinct(overtime), shifts, people: shifts ? people / shifts : 0 };
}

/**
 * The floor: the shifts added up. Somebody on overtime is 1 on their own
 * shift and `OVERTIME_SHARE` on the other, so 1.5 here — the hours they
 * put in, in people. The names are each listed once.
 */
export function floorStaffing(records: ReadonlyArray<ProductionRecord>, byShift: ReadonlyArray<Staffing>): Staffing {
  return {
    crew: crewOf(records),
    overtime: distinct(byShift.flatMap((s) => s.overtime)),
    shifts: byShift.reduce((n, s) => n + s.shifts, 0),
    people: byShift.reduce((n, s) => n + s.people, 0),
  };
}

/**
 * The Operator and Supervisor an Operator-page sheet opens with.
 *
 * A sheet that has its names (confirmed, signed) shows those. One not yet
 * confirmed has none recorded, and shows what the worker has picked so far
 * (`picked`) — but only when that was picked on this press in this shift
 * (`pickedFor` = `here`, "machine|shiftId"): the same crew moving on to its
 * next order. A new shift, or another press, starts with nobody named, so
 * that ✅ Confirm cannot record the crew before.
 */
export function namesForSheet(sheet: {
  here: string;
  pickedFor: string;
  /** The sheet awaits its ✅ Confirm and has no names recorded. */
  unconfirmed: boolean;
  picked: { operator: string; supervisor: string };
  recorded?: { operator: string; supervisor: string } | null;
}): { operator: string; supervisor: string } {
  if (sheet.unconfirmed && sheet.pickedFor === sheet.here) return sheet.picked;
  return { operator: sheet.recorded?.operator ?? '', supervisor: sheet.recorded?.supervisor ?? '' };
}

