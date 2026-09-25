/**
 * The timeline a week to a column — the last step of the zoom out.
 *
 * Past the narrowest day a day column cannot carry its date, so the next step
 * out is a week: one column carrying the week's total load.
 *
 * A folded week's days are not removed. They share its width, so every bar,
 * arrow and drag keeps working through it, just at a coarser scale.
 *
 * Pure. No React, no store.
 */

import { startOfDay } from '@/engine/assembly/dates';
import { loadBand, type LoadBand } from '@/engine/assembly/workload';
import { toDayKey } from '@/lib/time';

/** How wide a folded week is, whatever days it has on screen. */
export const FOLDED_WEEK_PX = 56;
/** Weeks the timeline reaches at least. */
export const TIMELINE_MIN_WEEKS = 8;

/** The Monday of a date's week, as a day key — the week's identity. */
export function weekKeyOf(date: Date): string {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDayKey(d);
}

/** ISO 8601 week number. */
export function isoWeek(date: Date): number {
  const d = startOfDay(date);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // that week's Thursday
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

export interface WeekSpan {
  /** `weekKeyOf` its days. */
  key: string;
  /** "W40". */
  label: string;
  /** Index of its first day on the axis, and one past its last. */
  from: number;
  to: number;
  folded: boolean;
  /** Its first and last day on screen. */
  first: Date;
  last: Date;
}

/**
 * The weeks the drawn days fall into, in order, and whether each is folded:
 * what its own heading was set to, else what the zoom says — every week
 * folded in week view, every week open otherwise.
 */
export function weekSpans(
  days: readonly Date[],
  weekView: boolean,
  choices: Readonly<Record<string, boolean>> = {},
): WeekSpan[] {
  const spans: WeekSpan[] = [];
  days.forEach((day, i) => {
    const key = weekKeyOf(day);
    const open = spans[spans.length - 1];
    if (open && open.key === key) {
      open.to = i + 1;
      open.last = day;
      return;
    }
    spans.push({
      key,
      label: `W${isoWeek(day)}`,
      from: i,
      to: i + 1,
      folded: choices[key] ?? weekView,
      first: day,
      last: day,
    });
  });
  return spans;
}

/**
 * Every day's column width: an open week's days as wide as they otherwise
 * are, a folded week's days sharing `FOLDED_WEEK_PX` between them.
 */
export function foldedWidths(
  spans: readonly WeekSpan[],
  openWidth: (index: number) => number,
): number[] {
  const widths: number[] = [];
  for (const span of spans) {
    const n = span.to - span.from;
    for (let i = span.from; i < span.to; i += 1) {
      widths.push(span.folded ? FOLDED_WEEK_PX / n : openWidth(i));
    }
  }
  return widths;
}

/** A week's load, from its days' — summed, then banded like a day is. */
export interface WeekLoad {
  crewed: number;
  waiting: number;
  capacity: number;
  pct: number;
  band: LoadBand;
}

export function weekLoad(
  days: readonly { crewed: number; waiting: number; capacity: number }[],
): WeekLoad {
  const crewed = days.reduce((s, d) => s + d.crewed, 0);
  const waiting = days.reduce((s, d) => s + d.waiting, 0);
  const capacity = days.reduce((s, d) => s + d.capacity, 0);
  const pct = capacity > 0 ? ((crewed + waiting) / capacity) * 100 : 0;
  return { crewed, waiting, capacity, pct, band: loadBand(pct) };
}

/**
 * One list of a week's orders from its days' lists: an order worked on three
 * of its days is one entry with the three days' hours, not three entries.
 */
export function mergeEntries<T extends { jobId: string; kind: string; hours: number }>(
  days: readonly (readonly T[])[],
): T[] {
  const byKey = new Map<string, T>();
  for (const entries of days) {
    for (const e of entries) {
      const key = `${e.jobId}|${e.kind}`;
      const held = byKey.get(key);
      if (held) byKey.set(key, { ...held, hours: held.hours + e.hours });
      else byKey.set(key, { ...e });
    }
  }
  return [...byKey.values()].sort((a, b) => b.hours - a.hours);
}
