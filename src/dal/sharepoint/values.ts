// SharePoint data layer — reading a cell: text, numbers, yes/no, dates in the
// site's own time zone, and the ids SharePoint hands back.
import { csvDateToIso } from './csv';
import type { MachineMasterField } from './schema';
import { TOOL_STATUS_META, parseDieCondition } from '../../core/die';
import type { ToolStatus, DieComponentCondition } from '../../types';

export function getId(r: Record<string, unknown>): number {
  const v = (r as { ID?: number; Id?: number }).ID ?? (r as { Id?: number }).Id;
  return typeof v === 'number' ? v : 0;
}

/** Escape a value inside an OData single-quoted string literal. URL
 * encoding happens afterwards and does not escape apostrophes by itself. */
export function odataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function sharePointItemId(r: Record<string, unknown>): number | null {
  const id = (r as { ID?: unknown; Id?: unknown }).ID ?? (r as { Id?: unknown }).Id;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function responseItemId(response: Response | undefined): Promise<number | null> {
  if (!response) return null;
  try {
    const payload = (await response.json()) as {
      ID?: unknown;
      Id?: unknown;
      d?: { ID?: unknown; Id?: unknown };
    };
    const id = payload.d?.ID ?? payload.d?.Id ?? payload.ID ?? payload.Id;
    const n = Number(id);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // Some proxies return an empty 201 body. Fall through to Location.
  }
  const location = response.headers?.get('Location') ?? '';
  const match = /items\((\d+)\)/i.exec(location);
  return match ? Number(match[1]) : null;
}

export function str(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Coerce a SP "HexColor" cell into a CSS-ready string. Accepts
 *  "#1e3a8a", "1e3a8a", "1E3A8A"; rejects anything that doesn't look
 *  like a 6-digit (or 3-digit) hex so a typo can't pollute inline
 *  styles. Returns '' when invalid. */
export function normaliseHex(raw: string): string {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return '';
}

/**
 * Best-effort resolver for the PMD_ProductDieColor.DieNumber column's
 * SharePoint internal name. SP frequently differs from the display name:
 * a column added as "Die Number" lands as `Die_x0020_Number`; "Die#"
 * becomes `Die_x0023_`. Probe the configured default first, then a small
 * set of common variants, then a regex sweep over the actual row keys.
 * Returns the first key on `row` that resolves to anything (truthy
 * preferred, but null/empty is acceptable to lock in the column choice).
 */
export function resolveDieNumberKey(
  row: Record<string, unknown>,
  configured: string | undefined,
): string | null {
  const candidates = [
    configured,
    'DieNumber',
    'Die_x0020_Number',
    'Die_Number',
    'DieNo',
    'DieNum',
    'Die_x0023_',
  ].filter((s): s is string => !!s);
  // First pass: prefer a candidate whose row value is non-empty.
  for (const k of candidates) {
    if (k in row && str(row[k]).trim()) return k;
  }
  // Second pass: configured key exists at all (even if blank on this row).
  for (const k of candidates) {
    if (k in row) return k;
  }
  // Third pass: scan ALL row keys for any "die*num" pattern. Skips
  // anything starting with FieldValuesAsText / OData metadata.
  const fallback = Object.keys(row).find((k) => /^die.*num/i.test(k));
  return fallback ?? null;
}

/** Same variant-tolerant resolution for the `Die` DESCRIPTION column
 *  (the tool's human name). Kept separate from resolveDieNumberKey so a
 *  "Die Number" column can never be mistaken for the description. */
export function resolveDieDescKey(
  row: Record<string, unknown>,
  configured: string | undefined,
): string | null {
  const candidates = [
    configured,
    'Die',
    'DieName',
    'Die_x0020_Name',
    'DieDescription',
    'Die_x0020_Description',
  ].filter((s): s is string => !!s);
  for (const k of candidates) {
    if (k in row && str(row[k]).trim()) return k;
  }
  for (const k of candidates) {
    if (k in row) return k;
  }
  return null;
}

/** Resolve PMD_BreakdownMaster columns across the current BDCODE/Cause
 * schema and the legacy Code/Title schema. Prefer a candidate that carries
 * at least one value, then accept an empty-but-present column. */
export function resolveBreakdownMasterKey(
  rows: ReadonlyArray<Record<string, unknown>>,
  names: ReadonlyArray<string | undefined>,
): string | null {
  const candidates = Array.from(new Set(names.filter((name): name is string => !!name)));
  for (const name of candidates) {
    if (rows.some((row) => name in row && str(row[name]).trim())) return name;
  }
  for (const name of candidates) {
    if (rows.some((row) => name in row)) return name;
  }
  return null;
}

export function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A number from a Number cell or from text someone typed ("98.7 %", "1,234"). */
export function looseNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = str(v).replace(/[^0-9.-]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The calendar day of a SharePoint date cell. A date-only column comes back
 * as the UTC instant of the site's local midnight (Sydney: the 12th is
 * "…-11T13:00:00Z"), one the app wrote as that day's UTC midnight — the
 * nearest UTC midnight is the day in both cases. Text cells take an ISO or
 * d/m/yyyy date.
 */
export function spDay(v: unknown): string {
  const s = str(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return '';
    return new Date(Math.round(t / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return csvDateToIso(s).slice(0, 10);
}

/** A PMD_Machine value as its column's type takes it. */
export function machineCell(
  k: MachineMasterField,
  v: unknown,
  type: string,
  availableAsFraction: boolean,
): string | number | null {
  if (v == null || v === '') return null;
  const numeric = ['Number', 'Currency', 'Integer'].includes(type);
  if (k === 'status') return TOOL_STATUS_META[v as ToolStatus]?.label ?? null;
  if (k === 'lastService' || k === 'availableDate') {
    return type === 'DateTime' ? `${String(v).slice(0, 10)}T00:00:00Z` : String(v).slice(0, 10);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (k === 'available') {
    if (numeric) return availableAsFraction ? Math.round(n * 10) / 1000 : n;
    return `${n}%`;
  }
  return numeric ? n : String(n);
}

export function nullOrNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DAY_MS = 86_400_000;

/** The SharePoint site's time zone: minutes east of UTC, in standard and in
 *  daylight time. The zone the FactoryCalendar list is typed in and shown in. */
export interface SiteZone {
  standardMin: number;
  daylightMin: number;
}

/**
 * The site's zone out of `_api/web/RegionalSettings/TimeZone`. SharePoint
 * gives biases — minutes to ADD to local time to reach UTC — so Sydney is
 * Bias −600 with DaylightBias −60, Auckland −720 with −60. Null when the
 * answer is not that shape.
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

/**
 * A FactoryCalendar Date cell as a day — the Assembly board's
 * readCalendarDay, kept the same. SharePoint answers a date-only column as
 * the UTC instant of the SITE's midnight (`2026-12-24T13:00:00Z` is
 * 25 December in Sydney). With the site's zone the instant is moved into it
 * and the day is that midnight's. Without it the instant is taken to the
 * nearest UTC midnight — right for a site within eleven hours of UTC, one day
 * early in summer for a site further east (Auckland), which is how
 * New Year's Day came out on 31 December. Never the browser's own zone. A
 * bare `YYYY-MM-DD`, a d/m/yyyy, or a time with no zone, is taken as written.
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
  const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
  if (zone) {
    for (const offset of [zone.daylightMin, zone.standardMin]) {
      const local = ms + offset * 60_000;
      if (local % DAY_MS === 0) return utcDay(local);
    }
    return utcDay(Math.floor((ms + zone.standardMin * 60_000) / DAY_MS) * DAY_MS);
  }
  return utcDay(Math.round(ms / DAY_MS) * DAY_MS);
}

/** "280" → 280 for SP Number columns; null for blank / non-numeric. */
export function numOrNull(s: string): number | null {
  const n = Number(s.trim());
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

export function parseDieComponentsJson(raw: string): Record<string, DieComponentCondition> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, DieComponentCondition> = {};
    // Every check the row was saved with, the toolroom's added ones too.
    for (const [key, value] of Object.entries(parsed ?? {})) {
      const cond = parseDieCondition(str(value));
      if (cond) out[key] = cond;
    }
    return out;
  } catch {
    return {};
  }
}

/** SP MultiChoice read: verbose {results:[…]} or a plain array. */
export function multiChoice(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  if (v && typeof v === 'object' && Array.isArray((v as { results?: unknown[] }).results))
    return (v as { results: unknown[] }).results.map((x) => str(x)).filter(Boolean);
  return [];
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|y|1)$/i.test(v);
  return undefined;
}

export function dateOnly(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  // SP DateTime is stored UTC. A Sydney Day shift starts 07:00 AEST =
  // 21:00 UTC previous calendar day, so slicing the first 10 chars of
  // the ISO string would shift the shiftId back one day and break every
  // downstream match (KPI shiftIds set, operator sid() comparison,
  // rejects-by-key lookup). Convert UTC back to local, then format the
  // local calendar date — Afternoon and Night sit safely within a single
  // UTC day so this also makes the three shifts symmetric.
  const d = new Date(v);
  if (isNaN(d.getTime())) return v.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isoDate(v: unknown): string {
  if (typeof v === 'string' && v) return new Date(v).toISOString();
  return '';
}

/** Normalise SharePoint's built-in Created timestamp. Modern REST returns
 * ISO-8601; older OData payloads may use /Date(…)/. Invalid/missing values
 * stay blank so the Operator dropdown can safely hide un-ageable manual
 * rows rather than retaining them forever. */
export function sharePointDateTimeIso(v: unknown): string {
  if (typeof v !== 'string') return '';
  const raw = v.trim();
  if (!raw) return '';
  const legacy = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(raw);
  const parsed = legacy ? new Date(Number(legacy[1])) : new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}
