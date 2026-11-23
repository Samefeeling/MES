/**
 * The payroll timesheet export (`TimesheetReport-PayRun….xlsx`, sheet
 * `Export`): who was at work, for how long, and who was on leave — the
 * denominator Assembly's efficiency was missing.
 *
 * One row per timesheet line: an employee, a day, a Work Type and a Duration.
 * Read by header, not by position:
 *
 *   Employee Id | First Name | Surname | Timesheet Id | Status | Location |
 *   Start Date | Start Time | End Date | End Time | Duration | Total Duration |
 *   Units | Unit Type | Work Type | …
 *
 * ## What counts
 *
 * - **Hours** are `Total Duration` (else `Duration`): the paid time, the fixed
 *   54-minute break already out of it (07:00–15:30 is 7:36 h).
 *   `Unpaid Break Duration` is not taken off again.
 * - **Leave** is any Work Type naming leave or a holiday (Annual Leave,
 *   Personal Leave, Long Service Leave Taken, Public Holiday…). Its hours are
 *   not worked hours; its days are leave days.
 * - **Worked** is every other Work Type — blank, Ordinary, Overtime and the
 *   like. Worked hours are **direct** when the Location's last level is a
 *   Direct one (`… / Assembly / Assembly Direct`) and **indirect** when it is
 *   an Indirect one. Only direct hours are the efficiency's denominator.
 * - A rejected or deleted line counts for nothing.
 */

import { mondayOf } from './assembly-completions';

/** The paid day, 07:00–15:30 less the 54-minute break. */
export const PAID_DAY_HOURS = 7.6;

export type AttendanceKind = 'direct' | 'indirect' | 'leave';

export interface AttendanceEntry {
  /** Payroll's Employee Id, as text. */
  employeeId: string;
  name: string;
  /** `YYYY-MM-DD`, the Start Date. */
  day: string;
  hours: number;
  kind: AttendanceKind;
  workType: string;
  location: string;
}

export interface AttendanceParse {
  entries: AttendanceEntry[];
  errors: string[];
}

type Field =
  | 'employeeId' | 'firstName' | 'surname' | 'timesheetId' | 'status' | 'location' | 'startDate' | 'startTime'
  | 'endDate' | 'endTime' | 'duration' | 'totalDuration' | 'units' | 'unitType' | 'workType';

const ALIASES: Record<Field, readonly string[]> = {
  employeeId: ['Employee Id', 'EmployeeId', 'Employee ID', 'Employee No', 'Employee Number'],
  firstName: ['First Name', 'FirstName', 'Given Name'],
  surname: ['Surname', 'Last Name', 'LastName', 'Family Name'],
  timesheetId: ['Timesheet Id', 'TimesheetId', 'Timesheet Line Id'],
  status: ['Status'],
  location: ['Location'],
  startDate: ['Start Date', 'StartDate', 'Date'],
  startTime: ['Start Time', 'StartTime'],
  endDate: ['End Date', 'EndDate'],
  endTime: ['End Time', 'EndTime'],
  duration: ['Duration'],
  totalDuration: ['Total Duration', 'TotalDuration'],
  units: ['Units'],
  unitType: ['Unit Type', 'UnitType'],
  workType: ['Work Type', 'WorkType'],
};

const norm = (s: string): string => s.replace(/[\s_.-]+/g, '').toLowerCase();

/** Header row → column index of each field it has. */
function headerMap(row: readonly string[]): Partial<Record<Field, number>> {
  const at = new Map(row.map((h, i) => [norm(String(h ?? '')), i] as const));
  const out: Partial<Record<Field, number>> = {};
  for (const [field, names] of Object.entries(ALIASES) as [Field, readonly string[]][]) {
    for (const name of names) {
      const i = at.get(norm(name));
      if (i !== undefined) {
        out[field] = i;
        break;
      }
    }
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a Start Date: ISO (an Excel date, as `readXlsxSheet` writes it) or Australian D/M/Y. */
export function timesheetDay(raw: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : dmy ? [+dmy[3], +dmy[2], +dmy[1]] : [0, 0, 0];
  if (!y) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCDate() === d && at.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Hours of a duration: `7h 36m` (the export's own form), `7:36:00`, `7:36`, or plain decimal hours. NaN when unreadable. */
export function durationHours(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  const hm = /^(-?)\s*(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?$/i.exec(s);
  if (hm && (hm[2] || hm[3] || hm[4])) return (hm[1] ? -1 : 1) * (Number(hm[2] ?? 0) + Number(hm[3] ?? 0) / 60 + Number(hm[4] ?? 0) / 3600);
  const hms = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (hms) return (hms[1] ? -1 : 1) * (+hms[2] + +hms[3] / 60 + (hms[4] ? +hms[4] / 3600 : 0));
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Minutes past midnight of a time cell (`7:00:00`, `07:00`, `2:30 PM`, or a `YYYY-MM-DD HH:MM` date-time). */
function clockMinutes(raw: string): number | null {
  const hit = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*$/i.exec(raw.trim());
  if (!hit) return null;
  let hh = +hit[1];
  if (hit[3]) hh = (hh % 12) + (hit[3].toLowerCase() === 'pm' ? 12 : 0);
  return hh * 60 + +hit[2];
}

/** A Work Type that is time off: leave of any kind, or a public holiday. */
export const isLeaveType = (workType: string): boolean => /leave|holiday/i.test(workType);

/** Direct, indirect, or neither, from the Location's last level. */
function locationKind(location: string): 'direct' | 'indirect' | null {
  const last = location.split('/').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  if (/indirect/i.test(last)) return 'indirect';
  if (/direct/i.test(last)) return 'direct';
  return null;
}

/**
 * The header row: the first of the opening rows that names Employee Id and
 * Work Type. A report may carry a title or a run date above it.
 */
function findHeader(rows: readonly (readonly string[])[]): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const at = headerMap(rows[i] ?? []);
    if (at.employeeId !== undefined && at.workType !== undefined && at.startDate !== undefined) return i;
  }
  return -1;
}

/**
 * Every countable line of one export. `source` names the file in errors.
 * The same line appearing in two exports (overlapping pay runs) is kept once
 * by the caller — see `mergeAttendance`.
 */
export function parseTimesheet(rows: readonly (readonly string[])[], source: string): AttendanceParse & { keys: string[] } {
  const head = findHeader(rows);
  if (head < 0) return { entries: [], keys: [], errors: [`${source}: no header row with Employee Id, Start Date and Work Type.`] };
  const at = headerMap(rows[head]);
  const cell = (row: readonly string[], f: Field): string => (at[f] === undefined ? '' : String(row[at[f]!] ?? '').trim());
  const entries: AttendanceEntry[] = [];
  const keys: string[] = [];
  const errors: string[] = [];
  rows.slice(head + 1).forEach((row, i) => {
    if (!row || row.every((c) => String(c ?? '').trim() === '')) return;
    const employeeId = cell(row, 'employeeId').replace(/\.0+$/, '');
    // The export always ends on a summary row ("Totals" in Employee Id), and
    // a blank line may sit under the table: neither is anybody's time.
    if (!employeeId || !/\d/.test(employeeId) || /^totals?$/i.test(employeeId)) return;
    if (/reject|delet|cancel|void/i.test(cell(row, 'status'))) return;
    const day = timesheetDay(cell(row, 'startDate'));
    let hours = durationHours(cell(row, 'totalDuration'));
    if (!Number.isFinite(hours)) hours = durationHours(cell(row, 'duration'));
    if (!Number.isFinite(hours) && /hour/i.test(cell(row, 'unitType'))) hours = durationHours(cell(row, 'units'));
    // Leave entered in days: a day is the 7:36 paid day.
    if (!Number.isFinite(hours) && /day/i.test(cell(row, 'unitType'))) hours = durationHours(cell(row, 'units')) * PAID_DAY_HOURS;
    if (!Number.isFinite(hours)) {
      const start = clockMinutes(cell(row, 'startTime'));
      const end = clockMinutes(cell(row, 'endTime'));
      if (start !== null && end !== null) hours = ((end - start + 1440) % 1440) / 60;
    }
    if (!day || !Number.isFinite(hours) || hours < 0) {
      const shown = (f: Field, label: string): string => `${label} "${cell(row, f)}"`;
      errors.push(
        `${source} row ${head + i + 2}: no readable Start Date or Duration (${[
          shown('employeeId', 'Employee Id'),
          shown('startDate', 'Start Date'),
          shown('totalDuration', 'Total Duration'),
          shown('units', 'Units'),
          shown('unitType', 'Unit Type'),
          shown('workType', 'Work Type'),
        ].join(', ')}).`,
      );
      return;
    }
    const workType = cell(row, 'workType');
    const location = cell(row, 'location');
    const where = locationKind(location);
    const kind: AttendanceKind | null = isLeaveType(workType) ? 'leave' : where;
    if (!kind) return; // worked somewhere that is neither direct nor indirect
    entries.push({
      employeeId,
      name: [cell(row, 'firstName'), cell(row, 'surname')].filter(Boolean).join(' '),
      day,
      hours: Math.round(hours * 10000) / 10000,
      kind,
      workType,
      location,
    });
    keys.push(
      [employeeId, cell(row, 'timesheetId'), day, cell(row, 'startTime'), cell(row, 'endTime'), workType, hours.toFixed(4)].join('|'),
    );
  });
  return { entries, keys, errors };
}

/** Several exports as one record: a line in two of them is counted once. */
export function mergeAttendance(parts: ReadonlyArray<AttendanceParse & { keys: string[] }>): AttendanceParse {
  const seen = new Set<string>();
  const entries: AttendanceEntry[] = [];
  const errors: string[] = [];
  for (const part of parts) {
    errors.push(...part.errors);
    part.entries.forEach((e, i) => {
      const key = part.keys[i] ?? '';
      if (key && seen.has(key)) return;
      seen.add(key);
      entries.push(e);
    });
  }
  return { entries: entries.sort((a, b) => a.day.localeCompare(b.day) || a.employeeId.localeCompare(b.employeeId)), errors };
}

/** The weeks (their Mondays) the record covers: a pay run is a whole week, so any line in a week means the week is in. */
export function attendanceWeeks(entries: readonly AttendanceEntry[]): Set<string> {
  return new Set(entries.map((e) => mondayOf(e.day)));
}

/** Does the record cover every week from `from` to `to`? */
export function attendanceCovers(weeks: ReadonlySet<string>, from: string, to: string): boolean {
  if (!weeks.size || from > to) return false;
  const last = mondayOf(to);
  for (let w = mondayOf(from); w <= last; w = addDays(w, 7)) if (!weeks.has(w)) return false;
  return true;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** One employee's time in a window. */
export interface PersonAttendance {
  direct: number;
  indirect: number;
  leave: number;
  /** Days with a leave line. */
  leaveDays: string[];
}

/** Each employee's direct, indirect and leave hours from `from` to `to`. */
export function attendanceByEmployee(
  entries: readonly AttendanceEntry[],
  from: string,
  to: string,
): Map<string, PersonAttendance> {
  const out = new Map<string, PersonAttendance>();
  for (const e of entries) {
    if (e.day < from || e.day > to) continue;
    const held = out.get(e.employeeId) ?? { direct: 0, indirect: 0, leave: 0, leaveDays: [] };
    held[e.kind] += e.hours;
    if (e.kind === 'leave' && !held.leaveDays.includes(e.day)) held.leaveDays.push(e.day);
    out.set(e.employeeId, held);
  }
  for (const p of out.values()) p.leaveDays.sort();
  return out;
}

/** Worked Work Types other than the plain ones, so the page can say what it counted as work. */
export function unusualWorkTypes(entries: readonly AttendanceEntry[]): string[] {
  const plain = /^(|ordinary.*|overtime.*|normal.*)$/i;
  return [...new Set(entries.filter((e) => e.kind !== 'leave' && !plain.test(e.workType.trim())).map((e) => e.workType.trim()))].sort();
}
