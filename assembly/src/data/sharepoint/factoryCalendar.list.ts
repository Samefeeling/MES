/**
 * The `FactoryCalendar` SharePoint list: the days the factory is shut that no
 * rule works out — the RDOs, and any holiday somebody types in by hand.
 *
 *   Date   the day (a Date column; the time of day is ignored)
 *   Name   "RDO", or the holiday's name
 *
 * The list, not the plan, is where these live. They used to ride in the saved
 * plan, so a day entered and not published with Save was gone on the next
 * reload — and a new build reloads every screen. A list row is written the
 * moment it is added, read by every screen on every refresh, and can be kept
 * by hand in SharePoint as well as from the board.
 *
 * Three ways to reach it, chosen the way the rest of the data layer chooses:
 * the signed-in SharePoint session in production, Graph with a token in
 * development, and this browser's own storage when neither is configured (the
 * mock board), so the panel still works on a laptop.
 */

import { ok, err, type Result } from '@/lib/result';
import { toDayKey } from '@/lib/time';
import { readConfigFromEnv, graphSite, type SharePointConfig } from './site';
import { restList, sessionRequest } from './session';
import { createListItem, fetchListRows } from './lists.write';

export const FACTORY_CALENDAR_LIST: string =
  import.meta.env.VITE_FACTORY_CALENDAR_LIST || 'FactoryCalendar';

/** One row of the list. */
export interface CalendarRow {
  /** The list item id; `local-…` for a row kept in this browser. */
  id: string;
  /** `YYYY-MM-DD`. */
  day: string;
  name: string;
}

export interface CalendarBackend {
  /** Where the rows are kept, for the panel to say. */
  readonly where: string;
  load(): Promise<Result<CalendarRow[], string>>;
  add(day: string, name: string): Promise<Result<CalendarRow, string>>;
  remove(id: string): Promise<Result<void, string>>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A Date cell as a day. SharePoint answers a date-only column as the UTC
 * instant of the site's midnight — `2026-12-24T13:00:00Z` is 25 December in
 * Sydney — so a value with a time is read in local time, which on the floor is
 * the site's. A bare `YYYY-MM-DD` is taken as it is written.
 */
export function readCalendarDay(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (au) return `${au[3]}-${au[2].padStart(2, '0')}-${au[1].padStart(2, '0')}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : toDayKey(d);
}

/**
 * The rows of the list, cleaned: a row with no readable date is dropped, a row
 * with no name is an RDO, and two rows on one day are one (the later id wins,
 * which is the one somebody typed most recently).
 */
export function readCalendarRows(
  items: readonly { id: string; fields: Record<string, unknown> }[],
): CalendarRow[] {
  const byDay = new Map<string, CalendarRow>();
  const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
  for (const item of sorted) {
    const f = item.fields;
    const day = readCalendarDay(f.Date ?? f.date ?? f.Date0);
    if (!day) continue;
    const raw = f.Name ?? f.Name0 ?? f.Title;
    const name = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 60) : 'RDO';
    byDay.set(day, { id: String(item.id), day, name });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The local midnight of a day, as the instant SharePoint stores for a Date. */
const midnightIso = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
};

// --- the signed-in session (production) ------------------------------------

interface Column {
  InternalName: string;
  Title: string;
  TypeAsString?: string;
}

/**
 * The Date and Name columns by what they are, not by guesswork about their
 * internal names. A list column made as "Name" can come out as `Name0` or
 * `_x004e_ame`, and SharePoint has hidden built-in columns titled "Name" too,
 * so only visible columns count and the Date one must be a date.
 */
async function sessionColumns(cfg: SharePointConfig, list: string) {
  const res = await sessionRequest(
    cfg,
    `${restList(cfg, list)}/fields?$select=InternalName,Title,TypeAsString&$filter=Hidden eq false and ReadOnlyField eq false`,
  );
  const fields = ((await res.json()).value ?? []) as Column[];
  const titled = (title: string) =>
    fields.filter((f) => f.Title.trim().toLowerCase() === title || f.InternalName.toLowerCase() === title);
  const date = titled('date').find((f) => /DateTime/i.test(f.TypeAsString ?? 'DateTime'));
  const name = titled('name').find((f) => f.InternalName !== 'Title');
  if (!date) throw new Error(`${list}: no Date column — add a Date column named "Date".`);
  return { date: date.InternalName, name: name?.InternalName ?? null };
}

class SessionCalendar implements CalendarBackend {
  readonly where = `SharePoint list ${FACTORY_CALENDAR_LIST}`;
  constructor(private readonly cfg: SharePointConfig, private readonly list = FACTORY_CALENDAR_LIST) {}

  async load(): Promise<Result<CalendarRow[], string>> {
    try {
      const cols = await sessionColumns(this.cfg, this.list);
      const select = ['Id', 'Title', cols.date, cols.name].filter(Boolean).join(',');
      let url = `${restList(this.cfg, this.list)}/items?$select=${select}&$top=500`;
      const items: { id: string; fields: Record<string, unknown> }[] = [];
      for (let page = 0; url && page < 20; page++) {
        const body = await (await sessionRequest(this.cfg, url)).json();
        for (const row of body.value ?? []) {
          items.push({
            id: String(row.Id),
            fields: { Date: row[cols.date], Name: cols.name ? row[cols.name] : undefined, Title: row.Title },
          });
        }
        url = body['odata.nextLink'] ?? body['@odata.nextLink'] ?? '';
      }
      return ok(readCalendarRows(items));
    } catch (e) {
      return err(`${this.list} not read: ${message(e)}`);
    }
  }

  async add(day: string, name: string): Promise<Result<CalendarRow, string>> {
    try {
      const cols = await sessionColumns(this.cfg, this.list);
      const body: Record<string, unknown> = { Title: name, [cols.date]: midnightIso(day) };
      if (cols.name) body[cols.name] = name;
      const res = await sessionRequest(this.cfg, `${restList(this.cfg, this.list)}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const row = await res.json();
      return ok({ id: String(row.Id ?? ''), day, name });
    } catch (e) {
      return err(`${this.list}: ${day} not saved — ${message(e)}`);
    }
  }

  async remove(id: string): Promise<Result<void, string>> {
    if (!/^\d+$/.test(id)) return err(`${this.list}: no list item ${id}.`);
    try {
      await sessionRequest(this.cfg, `${restList(this.cfg, this.list)}/items(${id})`, {
        method: 'POST',
        headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
      });
      return ok(undefined);
    } catch (e) {
      return err(`${this.list}: row not removed — ${message(e)}`);
    }
  }
}

// --- Graph with a token (development) --------------------------------------

class GraphCalendar implements CalendarBackend {
  readonly where = `SharePoint list ${FACTORY_CALENDAR_LIST}`;
  constructor(private readonly cfg: SharePointConfig, private readonly list = FACTORY_CALENDAR_LIST) {}

  async load(): Promise<Result<CalendarRow[], string>> {
    const res = await fetchListRows(this.cfg, this.list);
    return res.ok ? ok(readCalendarRows(res.value)) : err(`${this.list} not read: ${res.error.message}`);
  }

  async add(day: string, name: string): Promise<Result<CalendarRow, string>> {
    const res = await createListItem(this.cfg, this.list, { Title: name, Date: midnightIso(day), Name: name });
    return res.ok ? ok({ id: res.value, day, name }) : err(`${this.list}: ${day} not saved — ${res.error.message}`);
  }

  async remove(id: string): Promise<Result<void, string>> {
    try {
      const res = await fetch(
        `${graphSite(this.cfg)}/lists/${encodeURIComponent(this.list)}/items/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${this.cfg.token}` } },
      );
      return res.ok ? ok(undefined) : err(`${this.list}: row not removed — ${res.status} ${res.statusText}`);
    } catch (e) {
      return err(`${this.list}: row not removed — ${message(e)}`);
    }
  }
}

// --- this browser (the mock board) -----------------------------------------

const LOCAL_KEY = 'assembly.factoryCalendar.v1';

export class LocalCalendar implements CalendarBackend {
  readonly where = 'this browser (no SharePoint configured)';

  private read(): CalendarRow[] {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const rows = raw ? (JSON.parse(raw) as CalendarRow[]) : [];
      return Array.isArray(rows) ? rows.filter((r) => r && readCalendarDay(r.day) === r.day) : [];
    } catch {
      return [];
    }
  }

  private write(rows: CalendarRow[]): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
    } catch {
      // Private window or blocked storage: the day holds for this session only.
    }
  }

  async load(): Promise<Result<CalendarRow[], string>> {
    return ok(this.read().sort((a, b) => a.day.localeCompare(b.day)));
  }

  async add(day: string, name: string): Promise<Result<CalendarRow, string>> {
    const row = { id: `local-${Date.now()}`, day, name };
    this.write([...this.read().filter((r) => r.day !== day), row]);
    return ok(row);
  }

  async remove(id: string): Promise<Result<void, string>> {
    this.write(this.read().filter((r) => r.id !== id));
    return ok(undefined);
  }
}

/** The backend this build talks to. */
export function createCalendarBackend(cfg: SharePointConfig = readConfigFromEnv()): CalendarBackend {
  if (cfg.siteUrl && cfg.authMode === 'session') return new SessionCalendar(cfg);
  if (cfg.siteUrl && cfg.token) return new GraphCalendar(cfg);
  return new LocalCalendar();
}
