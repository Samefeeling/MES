/**
 * Assembly's efficiency over the From–To range, in buckets that suit its
 * length — days for a fortnight or less, weeks up to half a year, months
 * beyond — by line and for the whole floor.
 *
 *   Efficiency = Σ standard hours finished ÷ Σ hours available
 *
 * Standard hours are Epicor's (`CompletedJobs.csv`; without it, those of the
 * confirmed completions). The hours available are decided **day by day**:
 *
 * - a day a payroll timesheet covers (its week is in a pay run): the direct
 *   hours attended (see `core/attendance`);
 * - any other day: the people the supervisor confirmed as finishing orders
 *   that day × 7.5 h — the estimate the page used before there were
 *   timesheets.
 *
 * A bucket can mix the two; each point says which it rests on (`basis`).
 */

import { mondayOf, type CompletedOrderDay } from './assembly-completions';
import { HISTORY_GROUPS, historyGroup, isAssessedGroup, type HistoryGroup, type HistoryRow } from './assembly-history';
import type { AttendanceEntry } from './attendance';
import { PRODUCTIVE_HOURS_PER_PERSON } from './assembly-metrics';

export type Grain = 'day' | 'week' | 'month';

export interface Bucket {
  /** First day of the bucket (a day, a Monday, the 1st). */
  key: string;
  label: string;
  /** The part of the bucket inside From–To. */
  from: string;
  to: string;
  /** The range holds only part of the bucket. */
  partial: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayOf = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const addDay = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
};
const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();
const dm = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days in a range, both ends included. */
const daysIn = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5) + 1;

/**
 * The buckets of a range. Days for up to 14 days (a weekend day only when
 * something happened on it — `hasData`), weeks up to 26 weeks, months beyond.
 */
export function chartBuckets(from: string, to: string, hasData: (day: string) => boolean = () => false): { grain: Grain; buckets: Bucket[] } {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(from) || !ok.test(to) || from > to) return { grain: 'week', buckets: [] };
  const span = daysIn(from, to);
  const buckets: Bucket[] = [];
  if (span <= 14) {
    for (let d = from; d <= to; d = addDay(d, 1)) {
      const wd = weekday(d);
      if ((wd === 0 || wd === 6) && !hasData(d)) continue;
      buckets.push({ key: d, label: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ${dm(d)}`, from: d, to: d, partial: false });
    }
    return { grain: 'day', buckets };
  }
  if (span <= 182) {
    for (let w = mondayOf(from); w <= to; w = addDay(w, 7)) {
      const end = addDay(w, 6);
      buckets.push({ key: w, label: `w/c ${dm(w)}`, from: w < from ? from : w, to: end > to ? to : end, partial: w < from || end > to });
    }
    return { grain: 'week', buckets };
  }
  for (let m = `${from.slice(0, 7)}-01`; m <= to; ) {
    const next = m.slice(5, 7) === '12' ? `${Number(m.slice(0, 4)) + 1}-01-01` : `${m.slice(0, 5)}${pad(Number(m.slice(5, 7)) + 1)}-01`;
    const end = addDay(next, -1);
    buckets.push({
      key: m,
      label: `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`,
      from: m < from ? from : m,
      to: end > to ? to : end,
      partial: m < from || end > to,
    });
    m = next;
  }
  return { grain: 'month', buckets };
}

export type Basis = 'timesheet' | 'estimate' | 'mixed';

export interface EffPoint {
  stdHours: number;
  /** Direct hours attended, on the days a timesheet covers. */
  timesheetHours: number;
  /** People confirmed × 7.5 h, on the days none does. */
  estimatedHours: number;
  efficiency: number | null;
  /** What the hours rest on; null with no hours at all. */
  basis: Basis | null;
}

export interface EfficiencyInputs {
  /** `CompletedJobs.csv`; null to take the standard hours of the confirmed completions instead. */
  rows: readonly HistoryRow[] | null;
  /** Confirmed completions: who finished what, each day. */
  done: readonly CompletedOrderDay[];
  /** Timesheet lines (Assembly's). */
  attendance: readonly AttendanceEntry[];
  /** Weeks (Mondays) a timesheet covers. */
  covered: ReadonlySet<string>;
  /** An employee's line, by payroll id. */
  groupOf: (employeeId: string) => string | null;
  /**
   * The lines to draw, in order, by key and name: the board's layout on the
   * page. Without it, the export's planner lines (`HISTORY_GROUPS`).
   */
  lines?: ReadonlyArray<{ key: string; name: string }>;
  /** The line an export row counts towards; by default its planner's. */
  lineOfRow?: (row: HistoryRow) => string | null;
  /** The line a confirmed completion counts towards; by default its own. */
  lineOfDone?: (done: CompletedOrderDay) => string | null;
  /** A line not measured (its Std h and hours left out of everything); by default PMD and TBP. */
  excluded?: (line: string) => boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function point(std: number, sheet: number, estimate: number, coveredDays: number, otherDays: number): EffPoint {
  const hours = sheet + estimate;
  const basis: Basis | null = !hours ? null : sheet && estimate ? 'mixed' : sheet || (coveredDays && !otherDays) ? 'timesheet' : 'estimate';
  return {
    stdHours: round1(std),
    timesheetHours: round1(sheet),
    estimatedHours: round1(estimate),
    efficiency: hours > 0 ? Math.round((std / hours) * 100) : null,
    basis,
  };
}

/** Each line's points and the whole floor's, one per bucket. */
export function efficiencySeries(
  input: EfficiencyInputs,
  buckets: readonly Bucket[],
): { lines: Array<{ key: string; name: string; points: EffPoint[] }>; floor: EffPoint[] } {
  const lineOfRow = input.lineOfRow ?? ((r: HistoryRow) => r.group);
  const lineOfDone = input.lineOfDone ?? ((d: CompletedOrderDay) => historyGroup(d.line));
  const excluded = input.excluded ?? ((g: string) => !isAssessedGroup(g as HistoryGroup));
  const drawn = input.lines ?? HISTORY_GROUPS.map((g) => ({ key: g as string, name: g as string }));
  const first = buckets[0]?.from ?? '';
  const last = buckets[buckets.length - 1]?.to ?? '';
  const inRange = (day: string): boolean => day >= first && day <= last;
  // Per `day|group` (group '*' = the floor).
  const std = new Map<string, number>();
  const direct = new Map<string, number>();
  const people = new Map<string, Set<string>>();
  const add = (m: Map<string, number>, key: string, v: number): void => {
    m.set(key, (m.get(key) ?? 0) + v);
  };
  if (input.rows) {
    for (const r of input.rows) {
      if (!r.planner || !inRange(r.day)) continue;
      const g = lineOfRow(r);
      if ((g && excluded(g)) || r.group === 'PMD' || r.group === 'TBP') continue;
      if (g) add(std, `${r.day}|${g}`, r.stdHours);
      add(std, `${r.day}|*`, r.stdHours);
    }
  }
  for (const d of input.done) {
    if (!inRange(d.day)) continue;
    const g = lineOfDone(d);
    if (g && excluded(g)) continue;
    if (!input.rows) {
      if (g) add(std, `${d.day}|${g}`, d.stdHours);
      add(std, `${d.day}|*`, d.stdHours);
    }
    for (const name of d.people) {
      for (const key of [...(g ? [`${d.day}|${g}`] : []), `${d.day}|*`]) {
        const held = people.get(key) ?? new Set<string>();
        held.add(name.toLowerCase());
        people.set(key, held);
      }
    }
  }
  for (const e of input.attendance) {
    if (e.kind !== 'direct' || !inRange(e.day)) continue;
    const g = input.groupOf(e.employeeId);
    if (g && excluded(g)) continue;
    if (g) add(direct, `${e.day}|${g}`, e.hours);
    add(direct, `${e.day}|*`, e.hours);
  }
  const at = (b: Bucket, g: string): EffPoint => {
    let s = 0;
    let sheet = 0;
    let estimate = 0;
    let coveredDays = 0;
    let otherDays = 0;
    for (let day = b.from; day <= b.to; day = addDay(day, 1)) {
      const key = `${day}|${g}`;
      s += std.get(key) ?? 0;
      if (input.covered.has(mondayOf(day))) {
        sheet += direct.get(key) ?? 0;
        coveredDays++;
      } else {
        estimate += (people.get(key)?.size ?? 0) * PRODUCTIVE_HOURS_PER_PERSON;
        otherDays++;
      }
    }
    return point(s, sheet, estimate, coveredDays, otherDays);
  };
  const lines = drawn.filter((l) => !excluded(l.key)).map((l) => ({ key: l.key, name: l.name, points: buckets.map((b) => at(b, l.key)) })).filter((l) =>
    l.points.some((p) => p.stdHours > 0 || p.timesheetHours > 0 || p.estimatedHours > 0),
  );
  return { lines, floor: buckets.map((b) => at(b, '*')) };
}

/**
 * One person's points: their share of the confirmed completions over their
 * direct hours on the days a timesheet covers (when their payroll id is
 * known), and 7.5 h for each day they are named on a completion otherwise.
 */
export function personEfficiency(
  input: Pick<EfficiencyInputs, 'done' | 'attendance' | 'covered'>,
  buckets: readonly Bucket[],
  name: string,
  employeeId: string,
): EffPoint[] {
  const key = name.toLowerCase();
  const share = new Map<string, number>();
  const named = new Set<string>();
  for (const d of input.done) {
    if (!d.people.some((p) => p.toLowerCase() === key)) continue;
    share.set(d.day, (share.get(d.day) ?? 0) + d.stdHours / d.people.length);
    named.add(d.day);
  }
  const direct = new Map<string, number>();
  if (employeeId) {
    for (const e of input.attendance) if (e.kind === 'direct' && e.employeeId === employeeId) direct.set(e.day, (direct.get(e.day) ?? 0) + e.hours);
  }
  return buckets.map((b) => {
    let s = 0;
    let sheet = 0;
    let estimate = 0;
    let coveredDays = 0;
    let otherDays = 0;
    for (let day = b.from; day <= b.to; day = addDay(day, 1)) {
      s += share.get(day) ?? 0;
      if (employeeId && input.covered.has(mondayOf(day))) {
        sheet += direct.get(day) ?? 0;
        coveredDays++;
      } else {
        if (named.has(day)) estimate += PRODUCTIVE_HOURS_PER_PERSON;
        otherDays++;
      }
    }
    return point(s, sheet, estimate, coveredDays, otherDays);
  });
}
