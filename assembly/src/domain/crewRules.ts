/**
 * The rules Crew orders works by — the supervisor's, not the code's.
 *
 * Crewing used to run on numbers written into the engine: two weeks, four,
 * eight; one person up to a day's work, two past it, three past fifty hours;
 * three on a table. Right for most of the floor most of the time, and nobody
 * on the floor could change any of it. A supervisor who is on the floor all
 * day needs the one click to come back right, so what decides it is set here
 * once, shared with every screen through the plan (published by Save like the
 * crews and the line layout), and read by `engine/assembly/crew`.
 *
 * Pure. No React, no store.
 */

import { rootLineKey, type LineKey } from './assembly';

/** One step of team size by the order's remaining standard hours. */
export interface CrewSizeBand {
  /** Up to and including this many hours; null for anything more. */
  upToHours: number | null;
  crew: number;
}

/** What Crew orders does on one line. */
export interface LineCrewRule {
  /** False: orders on this line are left for the supervisor to crew by hand. */
  auto: boolean;
  /** A fixed team size here, over the hour bands; null to go by the bands. */
  crew: number | null;
}

export interface CrewRules {
  /** Order numbers starting with any of these are never crewed by the button. */
  skipPrefixes: string[];
  /** Only orders Epicor has released (JobHead_JobReleased). */
  releasedOnly: boolean;
  /** Only orders due within this many days, late ones included; null for any. */
  horizonDays: number | null;
  /** Due-date bands crewed in turn, in days from today. */
  dueTiersDays: number[];
  /** Team size by remaining hours, smallest band first. */
  sizeBands: CrewSizeBand[];
  /** Per line (a bench falls back to its lane). Lines not named crew by the bands. */
  lines: Record<string, LineCrewRule>;
  /** Only people whose trade matches the bench — a cutter is not put on gluing. */
  requireTrade: boolean;
}

/** Most people the rules may put on one order; the board's own cap. */
export const MAX_RULE_CREW = 4;

/**
 * What the board did before the rules existed, plus the two it was asked for:
 * unfirm orders (SUNF…) are never crewed, and nobody is put on a bench whose
 * trade they do not have.
 */
export const DEFAULT_CREW_RULES: CrewRules = {
  skipPrefixes: ['SUNF'],
  releasedOnly: true,
  horizonDays: null,
  dueTiersDays: [14, 28, 56],
  sizeBands: [
    { upToHours: 7.5, crew: 1 },
    { upToHours: 50, crew: 2 },
    { upToHours: null, crew: 3 },
  ],
  lines: { TABLE: { auto: true, crew: 3 } },
  requireTrade: true,
};

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const crewSize = (value: unknown): number | null => {
  const n = num(value);
  return n == null ? null : Math.min(MAX_RULE_CREW, Math.max(1, Math.round(n)));
};

/** Upper-case, trimmed, no blanks or repeats. */
export function cleanPrefixes(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const prefix = String(item ?? '').trim().toUpperCase();
    if (prefix && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/** Bands sorted by their hours, one open-ended band last; never empty. */
export function cleanBands(list: readonly unknown[]): CrewSizeBand[] {
  const bands: CrewSizeBand[] = [];
  let open: number | null = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const band = item as { upToHours?: unknown; crew?: unknown };
    const crew = crewSize(band.crew);
    if (crew == null) continue;
    const upTo = num(band.upToHours);
    if (upTo == null) open = crew;
    else if (upTo > 0 && !bands.some((b) => b.upToHours === upTo)) bands.push({ upToHours: upTo, crew });
  }
  bands.sort((a, b) => a.upToHours! - b.upToHours!);
  bands.push({ upToHours: null, crew: open ?? bands[bands.length - 1]?.crew ?? 1 });
  return bands;
}

/**
 * Rules out of whatever a stored plan holds. Anything missing or unreadable
 * takes its default, so a plan saved before there were rules crews exactly
 * as it always did.
 */
export function readCrewRules(raw: unknown): CrewRules {
  const d = DEFAULT_CREW_RULES;
  if (!raw || typeof raw !== 'object') return structuredClone(d);
  const r = raw as Partial<Record<keyof CrewRules, unknown>>;
  const tiers = Array.isArray(r.dueTiersDays)
    ? [...new Set(r.dueTiersDays.map(num).filter((n): n is number => n != null && n > 0).map(Math.round))].sort((a, b) => a - b)
    : d.dueTiersDays;
  const lines: Record<string, LineCrewRule> = {};
  if (r.lines && typeof r.lines === 'object') {
    for (const [key, value] of Object.entries(r.lines as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rule = value as { auto?: unknown; crew?: unknown };
      lines[key] = { auto: rule.auto !== false, crew: crewSize(rule.crew) };
    }
  }
  const horizon = num(r.horizonDays);
  return {
    skipPrefixes: Array.isArray(r.skipPrefixes) ? cleanPrefixes(r.skipPrefixes) : [...d.skipPrefixes],
    releasedOnly: typeof r.releasedOnly === 'boolean' ? r.releasedOnly : d.releasedOnly,
    // Absent takes the default; anything present but not a positive number is "no horizon".
    horizonDays: r.horizonDays === undefined ? d.horizonDays : horizon != null && horizon > 0 ? Math.round(horizon) : null,
    dueTiersDays: tiers.length ? tiers : [...d.dueTiersDays],
    sizeBands: Array.isArray(r.sizeBands) ? cleanBands(r.sizeBands) : structuredClone(d.sizeBands),
    lines: r.lines && typeof r.lines === 'object' ? lines : structuredClone(d.lines),
    requireTrade: typeof r.requireTrade === 'boolean' ? r.requireTrade : d.requireTrade,
  };
}

/** The rule for a line: its own, else its lane's, else crew by the bands. */
export function lineRule(rules: CrewRules, key: LineKey): LineCrewRule {
  return rules.lines[key] ?? rules.lines[rootLineKey(key)] ?? { auto: true, crew: null };
}

/** The prefix an order number is skipped for, or null. */
export function skippedPrefix(rules: CrewRules, orderNumber: string): string | null {
  const id = orderNumber.trim().toUpperCase();
  return rules.skipPrefixes.find((prefix) => id.startsWith(prefix)) ?? null;
}

/** The team the rules give an order with this many hours on this line. */
export function crewSizeFor(rules: CrewRules, line: LineKey, hours: number): number {
  if (hours <= 0) return 0;
  const fixed = lineRule(rules, line).crew;
  if (fixed != null) return fixed;
  const band = rules.sizeBands.find((b) => b.upToHours == null || hours <= b.upToHours);
  return band?.crew ?? 1;
}
