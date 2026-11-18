/**
 * `CompletedJobs.csv` — Epicor's labour records of what was finished, and the
 * window of them a supervisor is asked to put names to.
 *
 * One row per labour entry (`LaborDtl`): an order, the quantity reported on
 * it, the hours that quantity is worth, and when it was entered. An order
 * reported twice in a day is two rows, so the rows are folded into one
 * completion per order per day before anybody is asked about them.
 *
 * Sample (tab- or comma-separated; matched by header, not by position):
 *
 *   LaborDtl_CreateDate  LaborDtl_LaborQty  LaborDtl_LaborHrs  Calculated_PlannerID  JobAsmbl_PartNum  LaborDtl_JobNum
 *   2026-11-18T00:00:00  100                12.5               TABLE                 PODSE00010        018474-10-1
 *
 * ## Which rows are Assembly's
 *
 * Every planner but PMD. The export holds the whole plant; PMD's orders are
 * on the Assembly board for context only — moulding schedules them on its own
 * dashboard and its operators record who ran them there — so asking an
 * Assembly supervisor who made them would ask the wrong person.
 *
 * ## The hours
 *
 * `LaborDtl_LaborHrs` is read as **standard** hours: in every sample the hours
 * are the quantity times one fixed rate per part (018474-10-1: 100 pieces
 * 12.5 h, 50 pieces 6.25 h), which is how Epicor values a reported quantity,
 * not how long anybody stood at the bench.
 */

import { mapHeaders, parseCsv } from '@/lib/csv';
import { fromDayKey, toDayKey } from '@/lib/time';
import { prevMidnight, prevWorkingDay } from './dates';

/** One labour entry, as the export holds it. */
export interface CompletedLabourRow {
  jobNum: string;
  /** `YYYY-MM-DD`, the day the entry was made. */
  day: string;
  /** `HH:MM` the entry was made, when the export says. */
  time: string;
  qty: number;
  /** Standard hours the quantity is worth (see the file comment). */
  hours: number;
  planner: string;
  partNum: string;
  description: string;
}

/** One order finished on one day: its labour entries of that day, summed. */
export interface Completion {
  /** `Job|YYYY-MM-DD` — also the record key the board files the day under. */
  key: string;
  jobNum: string;
  day: string;
  qty: number;
  hours: number;
  planner: string;
  partNum: string;
  description: string;
  /** `YYYY-MM-DDTHH:MM` of the last entry that day. */
  lastAt: string;
  entries: number;
}

type Field = 'jobNum' | 'createDate' | 'createTime' | 'createDateTime' | 'qty' | 'hours' | 'planner' | 'partNum' | 'description';

const ALIASES: Record<Field, readonly string[]> = {
  jobNum: ['LaborDtl_JobNum', 'JobNum'],
  createDate: ['LaborDtl_CreateDate', 'CreateDate'],
  createTime: ['Calculated_CreateTime', 'CreateTime'],
  createDateTime: ['Calculated_CreateDateTime', 'CreateDateTime'],
  qty: ['LaborDtl_LaborQty', 'LaborQty'],
  hours: ['LaborDtl_LaborHrs', 'LaborHrs'],
  planner: ['Calculated_PlannerID', 'PlannerID', 'PersonID'],
  partNum: ['JobAsmbl_PartNum', 'PartNum'],
  description: ['JobAsmbl_Description', 'Description'],
};

/** Comma unless the header row is plainly tab-separated (a paste from Excel). */
const delimiterOf = (text: string): string => {
  const first = text.slice(0, text.indexOf('\n') >>> 0);
  return first.includes('\t') && !first.includes(',') ? '\t' : ',';
};

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The day an entry was made. `LaborDtl_CreateDate` is ISO
 * (`2026-11-18T00:00:00`); the calculated column beside it is Australian
 * `18/11/2026 15:02`, read day first. Anything else is not a day.
 */
function dayOf(createDate: string, createDateTime: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(createDate.trim());
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(createDateTime.trim() || createDate.trim());
  if (!dmy) return null;
  const [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  const at = new Date(y, m - 1, d);
  return at.getDate() === d && at.getMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function timeOf(createTime: string, createDateTime: string): string {
  const hit = /(\d{1,2}):(\d{2})/.exec(createTime.trim() || createDateTime.trim());
  return hit ? `${pad(Number(hit[1]))}:${hit[2]}` : '';
}

const number = (raw: string | undefined): number => {
  const n = Number(String(raw ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};

/** Every labour entry in the file; rows that cannot be read are named in `errors`. */
export function parseCompletedJobsCsv(text: string): {
  rows: CompletedLabourRow[];
  errors: string[];
} {
  const table = parseCsv(text, delimiterOf(text));
  if (table.length === 0) return { rows: [], errors: ['CompletedJobs.csv is empty.'] };
  const at = mapHeaders(table[0], ALIASES);
  const missing = (['jobNum', 'qty'] as const).filter((f) => at[f] === undefined);
  if (at.createDate === undefined && at.createDateTime === undefined) missing.push('createDate' as never);
  if (missing.length) {
    return {
      rows: [],
      errors: [`CompletedJobs.csv has no ${missing.map((f) => ALIASES[f][0]).join(', ')} column.`],
    };
  }
  const cell = (row: string[], f: Field): string => (at[f] === undefined ? '' : String(row[at[f]!] ?? '').trim());
  const rows: CompletedLabourRow[] = [];
  const errors: string[] = [];
  table.slice(1).forEach((row, i) => {
    if (row.every((c) => c.trim() === '')) return;
    const jobNum = cell(row, 'jobNum');
    const day = dayOf(cell(row, 'createDate'), cell(row, 'createDateTime'));
    const qty = number(cell(row, 'qty'));
    const hours = at.hours === undefined ? 0 : number(cell(row, 'hours') || '0');
    if (!jobNum || !day || !Number.isFinite(qty) || !Number.isFinite(hours)) {
      errors.push(`CompletedJobs.csv row ${i + 2}: no readable order, day or quantity.`);
      return;
    }
    rows.push({
      jobNum,
      day,
      time: timeOf(cell(row, 'createTime'), cell(row, 'createDateTime')),
      qty,
      hours,
      planner: cell(row, 'planner').toUpperCase(),
      partNum: cell(row, 'partNum'),
      // First line only: a configured table's description runs to five lines
      // of colours, which the dialog has no room for and the KPI no use for.
      description: cell(row, 'description').split(/\r?\n/)[0].trim(),
    });
  });
  return { rows, errors };
}

/** Assembly's rows: every planner but PMD (see the file comment). */
export const isAssemblyPlanner = (planner: string): boolean => {
  const p = planner.trim().toUpperCase();
  return p !== '' && p !== 'PMD';
};

/** Assembly's labour entries from `from` to `to` (inclusive), one completion per order per day. */
export function completionsBetween(
  rows: readonly CompletedLabourRow[],
  from: string,
  to: string,
): Completion[] {
  const byKey = new Map<string, Completion>();
  for (const row of rows) {
    if (!isAssemblyPlanner(row.planner) || row.day < from || row.day > to) continue;
    const key = `${row.jobNum}|${row.day}`;
    const stamp = `${row.day}T${row.time || '00:00'}`;
    const held = byKey.get(key);
    if (held) {
      held.qty += row.qty;
      held.hours += row.hours;
      held.entries++;
      if (stamp > held.lastAt) held.lastAt = stamp;
      continue;
    }
    byKey.set(key, {
      key,
      jobNum: row.jobNum,
      day: row.day,
      qty: row.qty,
      hours: row.hours,
      planner: row.planner,
      partNum: row.partNum,
      description: row.description,
      lastAt: stamp,
      entries: 1,
    });
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, hours: Math.round(c.hours * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.jobNum.localeCompare(b.jobNum));
}

/**
 * The days a supervisor is asked about this morning: from the last day the
 * factory ran up to yesterday. A normal morning that is yesterday alone; a
 * Monday, Friday to Sunday; the Tuesday after a public-holiday Monday, Friday
 * to Monday — whatever was entered while nobody was there to confirm it.
 */
export function confirmWindow(today: Date): { from: string; to: string } {
  return {
    from: toDayKey(prevWorkingDay(today)),
    to: toDayKey(prevMidnight(today)),
  };
}

/** `Fri 14/11` — how the dialog names a day. */
export function shortDay(key: string): string {
  const d = fromDayKey(key);
  return `${d.toLocaleDateString('en-AU', { weekday: 'short' })} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
