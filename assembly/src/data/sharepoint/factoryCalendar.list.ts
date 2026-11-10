/**
 * The `FactoryCalendar` SharePoint list: every day the factory is shut —
 * the public holidays and the RDOs. Once read, it is the whole calendar.
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
  /**
   * The rows are the SharePoint list, which holds the public holidays as well
   * as the RDOs. Once it has been read it is the whole calendar; the holidays
   * the board works out for itself only stand in where there is no list (the
   * mock board) or it has not been read.
   */
  readonly isList: boolean;
  load(): Promise<Result<CalendarRow[], string>>;
  add(day: string, name: string): Promise<Result<CalendarRow, string>>;
  remove(id: string): Promise<Result<void, string>>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const DAY_MS = 86_400_000;

/**
 * The SharePoint site's own time zone, as minutes east of UTC in standard
 * time and in daylight time. It is the zone the list is typed in and shown
 * in, so it is the zone a Date cell means.
 */
export interface SiteZone {
  standardMin: number;
  daylightMin: number;
}

/**
 * The site's zone out of `_api/web/RegionalSettings/TimeZone`. SharePoint
 * gives it as biases — the minutes to ADD to local time to reach UTC — so
 * Sydney is Bias −600 with DaylightBias −60, and Auckland −720 with −60.
 * Null when the answer is not that shape.
 */
export function readSiteZone(body: unknown): SiteZone | null {
  const root = (body ?? {}) as Record<string, unknown>;
  const info = ((root.d as Record<string, unknown> | undefined) ?? root).Information as
    | Record<string, unknown>
    | undefined;
  const bias = Number(info?.Bias);
  if (!info || !Number.isFinite(bias)) return null;
  const standard = Number(info.StandardBias);
  const daylight = Number(info.DaylightBias);
  return {
    standardMin: -(bias + (Number.isFinite(standard) ? standard : 0)),
    daylightMin: -(bias + (Number.isFinite(daylight) ? daylight : 0)),
  };
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * A Date cell as a day. SharePoint answers a date-only column as the UTC
 * instant of the site's midnight — `2026-12-24T13:00:00Z` is 25 December in
 * Sydney — so the day it means can only be read in the SITE's time zone:
 *
 *   - With the site's zone (`readSiteZone`), the instant is moved into it. A
 *     date-only cell is exactly midnight there, in standard or in daylight
 *     time, and the day is that midnight's. A cell that carries a time of day
 *     is read in the site's standard time.
 *   - Without it, the instant is taken to the nearest UTC midnight, which is
 *     the same day for any site between UTC−11 and UTC+11. It is NOT for a
 *     site further east: Auckland's summer midnight is 11:00 UTC the day
 *     before, and every summer day of a list kept on such a site came out one
 *     early — Christmas on the 24th, New Year's Day on 31 December and
 *     1 January a working day.
 *
 * Never the browser's own zone: in China or on UTC, Sydney's 25 December is
 * still the 24th. A bare `YYYY-MM-DD`, or a time with no zone, is taken as it
 * is written.
 */
export function readCalendarDay(value: unknown, zone?: SiteZone | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (au) return `${au[3]}-${au[2].padStart(2, '0')}-${au[1].padStart(2, '0')}`;
  const unzoned = /^(\d{4}-\d{2}-\d{2})T[\d:.]+$/.exec(v);
  if (unzoned) return unzoned[1];
  const ms = new Date(v).getTime();
  if (Number.isNaN(ms)) return null;
  if (zone) {
    for (const offset of [zone.daylightMin, zone.standardMin]) {
      const local = ms + offset * 60_000;
      if (local % DAY_MS === 0) return utcDay(local);
    }
    return utcDay(Math.floor((ms + zone.standardMin * 60_000) / DAY_MS) * DAY_MS);
  }
  return utcDay(Math.round(ms / DAY_MS) * DAY_MS);
}

/**
 * The rows of the list, cleaned: a row with no readable date is dropped, a row
 * with no name is an RDO, and two rows on one day are one (the later id wins,
 * which is the one somebody typed most recently).
 */
export function readCalendarRows(
  items: readonly { id: string; fields: Record<string, unknown> }[],
  zone?: SiteZone | null,
): CalendarRow[] {
  const byDay = new Map<string, CalendarRow>();
  const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
  for (const item of sorted) {
    const f = item.fields;
    const day = readCalendarDay(f.Date ?? f.date ?? f.Date0, zone);
    if (!day) continue;
    const raw = f.Name ?? f.Name0 ?? f.Title;
    const name = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 60) : 'RDO';
    byDay.set(day, { id: String(item.id), day, name });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The instant written for a day.
 *
 * With the site's zone: the site's midnight on that day in standard time —
 * midnight or 01:00 on the day whatever the season, so SharePoint shows the
 * day meant and `readCalendarDay` reads it back, whether SharePoint keeps the
 * instant or cuts it to the site's own midnight.
 *
 * Without it: 11:00 UTC on the day, which is still that day in every zone
 * from UTC−11 to UTC+11. The browser's own midnight was the day before in UTC
 * for a browser east of the site.
 */
export const dayInstant = (day: string, zone?: SiteZone | null): string =>
  zone
    ? new Date(Date.parse(`${day}T00:00:00Z`) - zone.standardMin * 60_000).toISOString()
    : `${day}T11:00:00Z`;

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
  readonly isList = true;
  constructor(private readonly cfg: SharePointConfig, private readonly list = FACTORY_CALENDAR_LIST) {}

  private zoneRead: Promise<SiteZone | null> | null = null;

  /**
   * The site's time zone, asked once. A site that will not say (or answers
   * something else) leaves the days read the old way, right for any site
   * within eleven hours of UTC — the calendar must still load.
   */
  private zone(): Promise<SiteZone | null> {
    this.zoneRead ??= sessionRequest(
      this.cfg,
      `${this.cfg.siteUrl.replace(/\/$/, '')}/_api/web/RegionalSettings/TimeZone`,
    )
      .then(async (res) => {
        const zone = readSiteZone(await res.json());
        if (!zone) console.warn(`[assembly] ${this.list}: the site's time zone was not understood.`);
        return zone;
      })
      .catch((e) => {
        console.warn(`[assembly] ${this.list}: the site's time zone was not read — ${message(e)}`);
        this.zoneRead = null;
        return null;
      });
    return this.zoneRead;
  }

  async load(): Promise<Result<CalendarRow[], string>> {
    try {
      const [cols, zone] = await Promise.all([sessionColumns(this.cfg, this.list), this.zone()]);
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
      return ok(readCalendarRows(items, zone));
    } catch (e) {
      return err(`${this.list} not read: ${message(e)}`);
    }
  }

  async add(day: string, name: string): Promise<Result<CalendarRow, string>> {
    try {
      const [cols, zone] = await Promise.all([sessionColumns(this.cfg, this.list), this.zone()]);
      const body: Record<string, unknown> = { Title: name, [cols.date]: dayInstant(day, zone) };
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
  readonly isList = true;
  constructor(private readonly cfg: SharePointConfig, private readonly list = FACTORY_CALENDAR_LIST) {}

  async load(): Promise<Result<CalendarRow[], string>> {
    const res = await fetchListRows(this.cfg, this.list);
    return res.ok ? ok(readCalendarRows(res.value)) : err(`${this.list} not read: ${res.error.message}`);
  }

  async add(day: string, name: string): Promise<Result<CalendarRow, string>> {
    const res = await createListItem(this.cfg, this.list, { Title: name, Date: dayInstant(day), Name: name });
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
  readonly isList = false;

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
