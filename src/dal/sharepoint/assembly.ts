// SharePoint data layer — KPIs · Assembly reads `ASSY_CompletedJobs`: one row
// per order finished on a day, confirmed on the Assembly board. `ASSY_Planning`
// (the board's planning list, once `ASSY_Production`) is not read here: an
// order leaves it once it is finished.
import type { AssemblyDataLayer, AssemblyResult, AssemblyRosterPerson, EpicorCompletion } from '../../types/assembly';
import { fetchThroughThrottle } from './http';
import { readCalendarDay, readSiteZone, type SiteZone } from './values';
import { type ListField, resolveField } from '../../../assembly/src/data/sharepoint/fieldMap';
import { readPlanText } from '../../../assembly/src/persistence/planCodec';

export const DEFAULT_ASSEMBLY_FIELDS = {
  workType: "WorkType", laborHours: "LaborHours", description: "WorkDescription", supportDepartment: "SupportDepartment",
  // The order's standard labour content and the quantity it covers. Together
  // they turn a day's finished units back into earned hours, which is what the
  // KPI page measures Efficiency on.
  plannedHours: "PlannedHours", orderQty: "OrderQty",
  // Measured labour hours, written by the Assembly board when a shift saves
  // its entry. Absent on rows written before it existed; see `bookedHours`.
  bookedHours: "BookedHour",
  "job": "Title",
  "date": "Date",
  // `Job|YYYY-MM-DD`, written with the row: the day the completion is for,
  // exactly as the board meant it, whatever the Date column's time zone does.
  recordKey: "RecordKey",
  "line": "Line",
  "operators": "Operators",
  "output": "ShiftOutput",
  "complete": "Complete",
  "reject": "Reject",
  "rework": "Rework",
  "completed": "JobCompleted",
  "due": "DueDate",
  "completedAt": "CompletedAt",
  // A confirmed Epicor completion — see `EpicorCompletion`. Optional: a list
  // the board has not yet added them to simply has no completions to show.
  epicorQty: "EpicorQty", epicorHours: "EpicorHours", epicorPartNum: "EpicorPartNum", epicorCompletedAt: "EpicorCompletedAt",
  completedBy: "CompletedBy", confirmedBy: "CompletionConfirmedBy", confirmedAt: "CompletionConfirmedAt",
};

/** The completion columns are read only when the list has them. */
const OPTIONAL_COMPLETION = ['epicorQty', 'epicorHours', 'epicorPartNum', 'epicorCompletedAt', 'completedBy', 'confirmedBy', 'confirmedAt'] as const;

/** Separate adapter: no PMD column mapping or machine/shift assumptions. */
export function createAssemblyDataLayer(env: Record<string, string | undefined>, overrides: Partial<typeof DEFAULT_ASSEMBLY_FIELDS> = {}): AssemblyDataLayer {
  const requestedFields = { ...DEFAULT_ASSEMBLY_FIELDS, ...overrides };
  return {
    async results(from, to) {
      if (env.VITE_BACKEND !== 'sharepoint') return [];
      const site = (env.VITE_SHAREPOINT_SITE_URL || env.VITE_SITE_URL || '').replace(/\/$/, '');
      if (!site) throw new Error('Assembly SharePoint site is not configured.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('Choose a valid date range.');
      const list = encodeURIComponent((env.VITE_COMPLETED_JOBS_LIST || 'ASSY_CompletedJobs').replace(/'/g, "''")).replace(/'/g, '%27');
      if (new URL(site).origin !== window.location.origin) throw new Error('Open MES on the configured SharePoint site.');
      const [schemaResponse, zone] = await Promise.all([
        fetchThroughThrottle(`${site}/_api/web/lists/getbytitle('${list}')/fields?$select=Title,InternalName,ReadOnlyField`, {
          credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json;odata=nometadata' },
        }),
        siteZone(site),
      ]);
      if (!schemaResponse.ok) throw new Error('Assembly column definitions could not be loaded.');
      const schema = (await schemaResponse.json()).value as ListField[];
      if (!Array.isArray(schema)) throw new Error('Assembly column definitions are invalid.');
      const fields = { ...requestedFields };
      const absent = new Set<string>();
      for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
        const found = resolveField(schema, fields[key]);
        if (found) fields[key] = found.InternalName;
        else if (key === 'date' || key === 'job') throw new Error('Missing Assembly column: ' + fields[key]);
        else absent.add(key);
      }
      const hasCompletions = OPTIONAL_COMPLETION.every((key) => !absent.has(key));
      /*
       * A Date cell is the UTC instant of the SITE's midnight: on this tenant
       * (Auckland, UTC+13 in summer) 19 November is 2026-11-18T11:00:00Z. A
       * filter on the UTC day missed every row, so the window asked for is a
       * day wider each side, and each row's own day decides whether it is in.
       */
      const filter = `${fields.date} ge datetime'${shiftDay(from, -1)}T00:00:00Z' and ${fields.date} lt datetime'${shiftDay(to, 2)}T00:00:00Z'`;
      let url = `${site}/_api/web/lists/getbytitle('${list}')/items?$top=500&$filter=${encodeURIComponent(filter)}`;
      const output: AssemblyResult[] = [];
      const keys = new Map<string, number>();
      for (let page = 0; url && page < 100; page++) {
        if (new URL(url).origin !== window.location.origin) throw new Error('Open MES on the configured SharePoint site.');
        const res = await fetchThroughThrottle(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json;odata=nometadata' } });
        if (!res.ok) throw new Error(`Assembly results could not be loaded (${res.status}).`);
        const body = await res.json() as { value?: Record<string, unknown>[]; 'odata.nextLink'?: string; '@odata.nextLink'?: string };
        for (const row of body.value ?? []) {
          const job = String(row[fields.job] ?? '').trim();
          const day = rowDay(row, fields, zone);
          /*
           * An order finished over several days has a row for each — a big
           * order never comes off in one — and those are its record, not
           * duplicates. Two rows for the same order on the same day are one
           * completion written twice (two screens confirming it at once): the
           * newer one stands, so the day is counted once.
           */
          const operation = String(row[fields.description] ?? '').trim();
          const key = `${job}|${day}|${operation}`;
          if (!job || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Assembly results contain an invalid job/date.');
          if (day < from || day > to) continue;
          const held = keys.get(key);
          if (held !== undefined && Number(output[held].id) > Number(row.Id)) continue;
          const number = (field: string): number => {
            const n = Number(row[field] ?? 0);
            if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${field} for ${key}.`);
            return n;
          };
          const result: AssemblyResult = { workType: String(row[fields.workType] ?? ""), laborHours: number(fields.laborHours), description: operation, supportDepartment: String(row[fields.supportDepartment] ?? ""), id: String(row.Id), job, day, line: String(row[fields.line] ?? ''), operators: String(row[fields.operators] ?? ''),
            plannedHours: number(fields.plannedHours), orderQty: number(fields.orderQty),
            // Read apart from `number()`: a missing column and a booked zero
            // must not read alike, or every unmeasured day would be counted as
            // a day that took no labour at all.
            bookedHours: row[fields.bookedHours] == null ? null : number(fields.bookedHours),
            output: number(fields.output), complete: number(fields.complete), reject: number(fields.reject), rework: number(fields.rework),
            completed: row[fields.completed] === true, due: row[fields.due] ? readCalendarDay(row[fields.due], zone) : null,
            completedAt: row[fields.completedAt] ? String(row[fields.completedAt]) : null,
            epicor: hasCompletions ? epicorOf(row, fields) : null };
          if (held !== undefined) output[held] = result;
          else keys.set(key, output.push(result) - 1);
        }
        url = body['odata.nextLink'] ?? body['@odata.nextLink'] ?? '';
      }
      if (url) throw new Error('Assembly results exceed the page limit. Select a shorter date range.');
      return output.sort((a, b) => b.day.localeCompare(a.day) || a.job.localeCompare(b.job));
    },
    async roster() {
      if (env.VITE_BACKEND !== 'sharepoint') return { people: [], warning: null };
      const site = (env.VITE_SHAREPOINT_SITE_URL || env.VITE_SITE_URL || '').replace(/\/$/, '');
      if (!site) return { people: [], warning: null };
      // The board reads the same list under the same fixed name.
      const url = `${site}/_api/web/lists/getbytitle('ASSY_Operator')/items?$top=500`;
      if (new URL(url).origin !== window.location.origin) throw new Error('Open MES on the configured SharePoint site.');
      const res = await fetchThroughThrottle(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json;odata=nometadata' } });
      if (!res.ok) throw new Error(`Assembly roster could not be loaded (${res.status}).`);
      const body = await res.json() as { value?: Record<string, unknown>[] };
      // Days marked off on the board live in its saved plan, read the way the
      // board reads it. Without them the booked leave on the roster still counts.
      let marked: Record<string, string[]> = {};
      let warning: string | null = null;
      try {
        marked = await boardLeave(site, env.VITE_ASSEMBLY_PLAN_LIST || 'ASSY_Plans');
      } catch (e) {
        warning = `Leave marked on the board not read (${e instanceof Error ? e.message : String(e)}): only booked annual leave is counted.`;
      }
      return { people: rosterFrom(body.value ?? [], marked), warning };
    },
  };
}

/**
 * The days marked off on the board, by operator id: `workerOnLeave` in the
 * board's working plan (the `current` row of ASSY_Plans), unpacked the way the
 * board packs it (`planCodec`) — a large plan is split across part rows.
 */
async function boardLeave(site: string, listName: string): Promise<Record<string, string[]>> {
  const list = encodeURIComponent(listName.replace(/'/g, "''")).replace(/'/g, '%27');
  const byTitle = async (title: string): Promise<string | null> => {
    const filter = encodeURIComponent(`Title eq '${title.replace(/'/g, "''")}'`);
    const res = await fetchThroughThrottle(`${site}/_api/web/lists/getbytitle('${list}')/items?$select=Title,PlanJson&$filter=${filter}`, {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (!res.ok) throw new Error(`${listName} (${res.status})`);
    const rows = ((await res.json()) as { value?: Record<string, unknown>[] }).value ?? [];
    const hit = rows.filter((r) => r.Title === title);
    return hit.length === 1 ? String(hit[0].PlanJson ?? '') : null;
  };
  const head = await byTitle('current');
  if (!head) return {};
  const plan = JSON.parse(await readPlanText(head, byTitle, 'current')) as { assembly?: { workerOnLeave?: Record<string, unknown> } };
  const out: Record<string, string[]> = {};
  for (const [id, days] of Object.entries(plan.assembly?.workerOnLeave ?? {})) {
    if (Array.isArray(days)) out[id] = days.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }
  return out;
}

/** The name columns, in the order the board's own roster reader prefers them. */
const NAME_COLUMNS = ['PreferName', 'PreferredName', 'Operator', 'OperatorName', 'FullName', 'Name', 'Title'];
const norm = (s: string): string => s.replace(/[\s_.-]+/g, '').toLowerCase();

/** `PlannedAnnualLeave`, read the way the board reads it: ISO days, comma-separated. */
function leaveDaysOf(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[,;|]+/);
  return parts.map((p) => p.trim().slice(0, 10)).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
}

/**
 * Roster rows → people, named the way the board names them (so the names are
 * the ones completions carry), each once, with every day the board has them
 * on leave: booked (`PlannedAnnualLeave`) and marked off on the board
 * (`marked`, by operator id — the list item id, as the board keys it).
 */
export function rosterFrom(
  rows: readonly Record<string, unknown>[],
  marked: Readonly<Record<string, readonly string[]>> = {},
): AssemblyRosterPerson[] {
  const out: AssemblyRosterPerson[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const byName = new Map<string, unknown>();
    for (const [k, v] of Object.entries(row)) if (!byName.has(norm(k))) byName.set(norm(k), v);
    const pick = (names: string[]): unknown => {
      for (const n of names) {
        const v = byName.get(norm(n));
        if (v !== undefined && v !== null && String(v).trim()) return v;
      }
      return undefined;
    };
    const name = String(pick(NAME_COLUMNS) ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const id = String(row.Id ?? row.ID ?? row.id ?? name);
    const booked = leaveDaysOf(pick(['PlannedAnnualLeave', 'AnnualLeave', 'PlannedLeave', 'LeaveDates']));
    out.push({
      id,
      name,
      position: String(pick(['Position', 'Role', 'JobTitle']) ?? '').trim(),
      leaveDays: [...new Set([...booked, ...(marked[id] ?? [])])].sort(),
    });
  }
  return out;
}

/** `YYYY-MM-DD` moved by whole days. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The site's time zone, which is the zone its Date cells mean. Null when the
 * site will not say: the row's RecordKey still gives its day, and a row
 * without one is read the way the FactoryCalendar is (`readCalendarDay`).
 */
async function siteZone(site: string): Promise<SiteZone | null> {
  try {
    const res = await fetchThroughThrottle(`${site}/_api/web/RegionalSettings/TimeZone`, {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json;odata=nometadata' },
    });
    return res.ok ? readSiteZone(await res.json()) : null;
  } catch {
    return null;
  }
}

/**
 * The day a row is for: its RecordKey's (`Job|YYYY-MM-DD`, the board's own
 * day), else its Date cell read in the site's zone. Never the first ten
 * characters of the Date cell — that is the UTC day, one early for a site
 * east of UTC.
 */
export function rowDay(row: Record<string, unknown>, fields: { date: string; recordKey: string }, zone: SiteZone | null): string {
  // `Job|YYYY-MM-DD`, or `Job#Op|YYYY-MM-DD` on a row copied from ASSY_Planning.
  const keyed = /\|(\d{4}-\d{2}-\d{2})$/.exec(String(row[fields.recordKey] ?? '').trim())?.[1];
  return keyed ?? readCalendarDay(row[fields.date], zone) ?? '';
}

/** A row's confirmed Epicor completion, or null when it has none. */
export function epicorOf(row: Record<string, unknown>, fields: Record<(typeof OPTIONAL_COMPLETION)[number], string>): EpicorCompletion | null {
  const confirmedAt = String(row[fields.confirmedAt] ?? '').trim();
  const qty = Number(row[fields.epicorQty]);
  if (!confirmedAt || row[fields.epicorQty] == null || !Number.isFinite(qty)) return null;
  const hours = Number(row[fields.epicorHours] ?? 0);
  return {
    qty,
    hours: Number.isFinite(hours) ? hours : 0,
    partNum: String(row[fields.epicorPartNum] ?? '').trim(),
    at: row[fields.epicorCompletedAt] ? String(row[fields.epicorCompletedAt]) : null,
    people: String(row[fields.completedBy] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    confirmedBy: String(row[fields.confirmedBy] ?? '').trim(),
    confirmedAt,
  };
}
