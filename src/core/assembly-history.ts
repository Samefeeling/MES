/**
 * Assembly's efficiency by week from the two records that go back: Epicor's
 * `CompletedJobs.csv` (what was finished, in standard hours) and payroll's
 * timesheets (who was at work, and for how long).
 *
 *   Efficiency = Σ standard hours finished ÷ Σ direct hours attended
 *
 * — earned hours over attended direct hours. Unlike the person-day measure
 * on the rest of the page it needs no supervisor to have confirmed who
 * finished what, so it reaches back as far as the files do; and its
 * denominator is the hours actually worked, overtime and short days included.
 *
 * ## Lines
 *
 * The export's planner is the line it can name: TBP, UPL, ASSY, TABLE,
 * GENERAL (PMD is moulding's and left out). The board's upholstery benches
 * (UPL-CUT, UPL-Gluing, UPL-SSS) are one UPL here, because the export does
 * not tell them apart. A person's hours go to their line on the board
 * (`workerLines`), else to the first line their Skills name; hours of
 * somebody with no line count towards the whole floor only.
 */

import { mondayOf } from './assembly-completions';
import type { AttendanceEntry } from './attendance';

/** The lines the history can tell apart, in the board's order. */
export const HISTORY_GROUPS = ['TBP', 'UPL', 'Assembly', 'Table', 'General'] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number] | 'PMD';

/** A planner, a board line key or name, or a Skills entry → the history line it belongs to; null when none. */
export function historyGroup(raw: string): HistoryGroup | null {
  const s = raw.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  if (!s) return null;
  if (/^(pmd|mould|mold)/.test(s)) return 'PMD';
  if (/^tbp/.test(s)) return 'TBP';
  if (/^(upl|uph|cut|sew|glu|soft|smartsoft|sss)/.test(s)) return 'UPL';
  if (/^(table|tbl)/.test(s)) return 'Table';
  if (/^(assy|asm|assembl|finalassembl|sofa|chair|stool|seat)/.test(s)) return 'Assembly';
  if (/^(general|factory)/.test(s)) return 'General';
  return null;
}

/** One labour entry of `CompletedJobs.csv`, as far as the history needs it. */
export interface HistoryRow {
  day: string;
  stdHours: number;
  group: HistoryGroup | null;
  planner: string;
}

const ALIASES = {
  createDate: ['LaborDtl_CreateDate', 'CreateDate'],
  createDateTime: ['Calculated_CreateDateTime', 'CreateDateTime'],
  hours: ['LaborDtl_LaborHrs', 'LaborHrs'],
  planner: ['Calculated_PlannerID', 'PlannerID', 'PersonID'],
} as const;

const norm = (s: string): string => s.replace(/[\s_.-]+/g, '').toLowerCase();
const pad = (n: number): string => String(n).padStart(2, '0');

/** The day of an entry, as the board reads it: ISO `LaborDtl_CreateDate`, else Australian D/M/Y. */
function entryDay(iso: string, dmy: string): string | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (a) return `${a[1]}-${a[2]}-${a[3]}`;
  const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dmy.trim() || iso.trim());
  return b ? `${b[3]}-${pad(+b[2])}-${pad(+b[1])}` : null;
}

/** `CompletedJobs.csv`, already split into cells, → its entries with a day and standard hours. */
export function parseHistoryTable(table: readonly (readonly string[])[]): { rows: HistoryRow[]; errors: string[] } {
  if (!table.length) return { rows: [], errors: ['CompletedJobs.csv is empty.'] };
  const head = new Map(table[0].map((h, i) => [norm(String(h ?? '')), i] as const));
  const col = (names: readonly string[]): number | undefined => names.map((n) => head.get(norm(n))).find((i) => i !== undefined);
  const at = {
    createDate: col(ALIASES.createDate),
    createDateTime: col(ALIASES.createDateTime),
    hours: col(ALIASES.hours),
    planner: col(ALIASES.planner),
  };
  if (at.hours === undefined || (at.createDate === undefined && at.createDateTime === undefined)) {
    return { rows: [], errors: ['CompletedJobs.csv has no LaborDtl_CreateDate or LaborDtl_LaborHrs column.'] };
  }
  const cell = (row: readonly string[], i: number | undefined): string => (i === undefined ? '' : String(row[i] ?? '').trim());
  const rows: HistoryRow[] = [];
  let unreadable = 0;
  for (const row of table.slice(1)) {
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    const day = entryDay(cell(row, at.createDate), cell(row, at.createDateTime));
    const stdHours = Number(cell(row, at.hours).replace(/,/g, '') || '0');
    if (!day || !Number.isFinite(stdHours)) {
      unreadable++;
      continue;
    }
    const planner = cell(row, at.planner).toUpperCase();
    rows.push({ day, stdHours, planner, group: historyGroup(planner) });
  }
  return { rows, errors: unreadable ? [`CompletedJobs.csv: ${unreadable} rows with no readable day or hours were skipped.`] : [] };
}

/** One week of one line (or of the floor). */
export interface HistoryPoint {
  stdHours: number;
  /** Direct hours attended; null for a week no timesheet covers. */
  directHours: number | null;
  /** Std h ÷ direct hours, as a percentage; null without both. */
  efficiency: number | null;
}

export interface HistorySeries {
  name: string;
  points: HistoryPoint[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function point(std: number, hours: number | null): HistoryPoint {
  return {
    stdHours: round1(std),
    directHours: hours === null ? null : round1(hours),
    efficiency: hours && hours > 0 ? Math.round((std / hours) * 100) : null,
  };
}

/**
 * Each history line's weeks, and the whole floor's. `groupOf` is an
 * employee's line (by payroll Employee Id); `covered` the weeks a timesheet
 * covers. A week without a timesheet keeps its standard hours and has no
 * efficiency.
 */
export function weeklyHistory(
  rows: readonly HistoryRow[],
  attendance: readonly AttendanceEntry[],
  groupOf: (employeeId: string) => HistoryGroup | null,
  weeks: readonly string[],
  covered: ReadonlySet<string>,
): { lines: HistorySeries[]; floor: HistoryPoint[] } {
  const wanted = new Set(weeks);
  const std = new Map<string, number>(); // `week|group`
  const hours = new Map<string, number>();
  const add = (m: Map<string, number>, key: string, v: number): void => {
    m.set(key, (m.get(key) ?? 0) + v);
  };
  for (const r of rows) {
    if (r.group === 'PMD' || !r.planner) continue;
    const w = mondayOf(r.day);
    if (!wanted.has(w)) continue;
    add(std, `${w}|${r.group ?? ''}`, r.stdHours);
    add(std, `${w}|*`, r.stdHours);
  }
  for (const e of attendance) {
    if (e.kind !== 'direct') continue;
    const w = mondayOf(e.day);
    if (!wanted.has(w)) continue;
    const g = groupOf(e.employeeId);
    if (g === 'PMD') continue;
    if (g) add(hours, `${w}|${g}`, e.hours);
    add(hours, `${w}|*`, e.hours);
  }
  const at = (w: string, g: string): HistoryPoint =>
    point(std.get(`${w}|${g}`) ?? 0, covered.has(w) ? hours.get(`${w}|${g}`) ?? 0 : null);
  const lines = HISTORY_GROUPS.map((g) => ({ name: g, points: weeks.map((w) => at(w, g)) })).filter((s) =>
    s.points.some((p) => p.stdHours > 0 || (p.directHours ?? 0) > 0),
  );
  return { lines, floor: weeks.map((w) => at(w, '*')) };
}
