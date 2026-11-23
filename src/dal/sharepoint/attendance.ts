// SharePoint data layer — the two files KPIs · Assembly reads beside its
// list: payroll's weekly timesheets (`Attendance/TimesheetReport-PayRun….xlsx`,
// sheet `Export`) and Epicor's `CompletedJobs.csv`. Both sit in the folder of
// the PMD Planning.csv, the timesheets in its `Attendance` subfolder.
import { mergeAttendance, parseTimesheet, type AttendanceParse } from '../../core/attendance';
import { parseHistoryTable, type HistoryRow } from '../../core/assembly-history';
import { readXlsxSheet } from '../../core/xlsx';
import { parseCsv } from './csv';
import { fetchThroughThrottle, toServerRelativePath } from './http';

/** The sheet of the timesheet export that holds its lines. */
export const TIMESHEET_SHEET = 'Export';
/** At most this many exports are read, newest first: a year of weekly pay runs is plenty for any chart. */
const MAX_FILES = 60;

export interface AttendanceRecord extends AttendanceParse {
  folder: string;
  /** The files read, by name. */
  files: string[];
}

/** The folder a path is in, without its trailing slash. */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Where the timesheets are: `VITE_ATTENDANCE_FOLDER`, else `Attendance` beside the Planning CSV. */
export function attendanceFolder(env: Record<string, string | undefined>): string {
  if (env.VITE_ATTENDANCE_FOLDER) return env.VITE_ATTENDANCE_FOLDER.replace(/\/+$/, '');
  const planning = env.VITE_PLANNING_CSV_PATH ?? '';
  return planning ? `${folderOf(planning)}/Attendance` : '';
}

/** `CompletedJobs.csv`: `VITE_COMPLETED_JOBS_CSV_PATH`, else beside the Planning CSV — where the board reads it. */
export function completedJobsCsvPath(env: Record<string, string | undefined>): string {
  if (env.VITE_COMPLETED_JOBS_CSV_PATH) return env.VITE_COMPLETED_JOBS_CSV_PATH;
  const planning = env.VITE_PLANNING_CSV_PATH ?? '';
  return planning ? `${folderOf(planning)}/CompletedJobs.csv` : '';
}

/** A server-relative path ready for `('…')` in a REST URL. */
const restPath = (raw: string): string =>
  toServerRelativePath(raw)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
    .replace(/'/g, "''");

const JSON_HEADERS = { Accept: 'application/json;odata=nometadata' };

async function fileBytes(site: string, path: string, what: string): Promise<Uint8Array> {
  const res = await fetchThroughThrottle(`${site}/_api/web/getFileByServerRelativeUrl('${restPath(path)}')/$value?_t=${Date.now()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${what} could not be read (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Text however Excel saved it: UTF-8, UTF-16, or Windows-1252. */
export function decodeBytes(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** A delimited file as cells: tab-separated when the header plainly is (a paste from Excel), else CSV. */
export function splitDelimited(text: string): string[][] {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (first.includes('\t') && !first.includes(',')) {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
  }
  return parseCsv(text);
}

/** One export's lines: the `Export` sheet of a workbook, or a CSV saved from it. */
export async function readTimesheetFile(name: string, bytes: Uint8Array): Promise<ReturnType<typeof parseTimesheet>> {
  try {
    const rows = /\.csv$/i.test(name) ? splitDelimited(decodeBytes(bytes)) : await readXlsxSheet(bytes, TIMESHEET_SHEET);
    return parseTimesheet(rows, name);
  } catch (e) {
    return { entries: [], keys: [], errors: [`${name}: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/** Every timesheet export in the folder, as one record. */
export async function readAttendance(site: string, folder: string): Promise<AttendanceRecord> {
  const res = await fetchThroughThrottle(
    `${site}/_api/web/GetFolderByServerRelativeUrl('${restPath(folder)}')/Files?$select=Name,ServerRelativeUrl,TimeLastModified&_t=${Date.now()}`,
    { credentials: 'same-origin', cache: 'no-store', headers: JSON_HEADERS },
  );
  if (res.status === 404) throw new Error(`no ${folder} folder`);
  if (!res.ok) throw new Error(`${folder} could not be listed (${res.status})`);
  const body = (await res.json()) as { value?: Array<{ Name?: string; ServerRelativeUrl?: string; TimeLastModified?: string }> };
  const files = (body.value ?? [])
    .filter((f) => f.Name && f.ServerRelativeUrl && /\.(xlsx|csv)$/i.test(f.Name) && !f.Name.startsWith('~$'))
    .sort((a, b) => String(b.TimeLastModified ?? '').localeCompare(String(a.TimeLastModified ?? '')))
    .slice(0, MAX_FILES);
  const parts = await Promise.all(
    files.map(async (f) => {
      try {
        return await readTimesheetFile(f.Name!, await fileBytes(site, f.ServerRelativeUrl!, f.Name!));
      } catch (e) {
        return { entries: [], keys: [], errors: [`${f.Name}: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }),
  );
  return { ...mergeAttendance(parts), folder, files: files.map((f) => f.Name!) };
}

/** `CompletedJobs.csv`'s entries, every day it holds. */
export async function readCompletedJobsHistory(site: string, path: string): Promise<{ rows: HistoryRow[]; errors: string[] }> {
  return parseHistoryTable(splitDelimited(decodeBytes(await fileBytes(site, path, 'CompletedJobs.csv'))));
}
