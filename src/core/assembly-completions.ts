/**
 * What `ASSY_CompletedJobs` adds up to — every figure on KPIs · Assembly.
 *
 * One row of the list is one order finished (in part or in full) on one day,
 * as Epicor reported it in `CompletedJobs.csv` and a supervisor confirmed who
 * finished it on the Assembly board. A big order finished over three days is
 * three rows and one order: orders are always counted distinct.
 *
 * ## People and efficiency
 *
 * An order finished by three people credits each with a third of its standard
 * hours. A **person-day** is one person named on at least one completion on
 * one day; **Std h / person-day** is standard hours over person-days, and
 * **Efficiency** is that over the 7.5 productive hours of a day. A day spent
 * on an order that was not finished that day earns nothing, so this reads low
 * for anyone on long orders: it is what was *finished* per day.
 */

import type { AssemblyResult } from '../types/assembly';
import { NO_LINE, PRODUCTIVE_HOURS_PER_PERSON, hoursPerUnit, lineLabel } from './assembly-metrics';

/** One confirmed completion: an order, a day. */
export interface CompletedOrderDay {
  job: string;
  day: string;
  line: string;
  partNum: string;
  qty: number;
  stdHours: number;
  due: string | null;
  onTime: boolean | null;
  /** The day finished the order in full (JobCompleted). */
  finished: boolean;
  people: string[];
  confirmedBy: string;
}

export interface CompletionSummary {
  /** Distinct orders. */
  orders: number;
  qty: number;
  stdHours: number;
  /** Distinct people named. */
  people: number;
  /** Distinct person × day pairs. */
  personDays: number;
  /** Std h over person-days; null with nobody named. */
  perPersonDay: number | null;
  /** `perPersonDay` over a 7.5 h day, as a percentage. */
  efficiency: number | null;
  /** Orders with a Due Date to judge, and of those the ones finished by it. */
  datedOrders: number;
  onTimeOrders: number;
}

export interface PersonCompletions {
  name: string;
  orders: number;
  /** Their share of the standard hours of what they finished. */
  stdHours: number;
  /** Days they are named on a completion. */
  days: number;
  perDay: number;
  /** `perDay` over a 7.5 h day, as a percentage. */
  efficiency: number;
}

/** One order on one line, across the days of the window. */
export interface OrderCompletions {
  job: string;
  partNum: string;
  days: number;
  lastDay: string;
  due: string | null;
  finished: boolean;
  summary: CompletionSummary;
}

export interface LineCompletions {
  line: string;
  summary: CompletionSummary;
  orders: OrderCompletions[];
}

/**
 * The day a stored Date cell stands for, in this browser's (the site's) time:
 * a plain `YYYY-MM-DD` as it is; an instant by its local date, so the site's
 * midnight (`2026-11-18T13:00:00Z` in Sydney) and UTC midnight both read as
 * the 19th. The board's sync reads the column the same way.
 */
export function localDay(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return text.slice(0, 10);
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const day10 = (s: string | null): string | null => {
  const day = s ? localDay(s) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;
const names = (s: string): string[] => s.split(',').map((p) => p.trim()).filter(Boolean);

/**
 * Every completion in the rows, newest first. Epicor's own figures where the
 * row carries them; a row somebody added by hand without them is read from
 * its Complete, standard and Operators instead.
 */
export function completedOrderDays(rows: readonly AssemblyResult[]): CompletedOrderDay[] {
  return rows
    .flatMap((row): CompletedOrderDay[] => {
      const due = day10(row.due);
      const e = row.epicor;
      const qty = e ? e.qty : row.complete;
      if (!e && !(qty > 0)) return [];
      const perUnit = hoursPerUnit(row);
      return [{
        job: row.job,
        day: row.day,
        line: lineLabel(row.line),
        partNum: e?.partNum ?? '',
        qty,
        stdHours: e ? e.hours : perUnit === null ? 0 : round(qty * perUnit),
        due,
        onTime: due ? row.day <= due : null,
        finished: row.completed,
        people: e?.people.length ? e.people : names(row.operators),
        confirmedBy: e?.confirmedBy ?? '',
      }];
    })
    .sort((a, b) => b.day.localeCompare(a.day) || a.job.localeCompare(b.job));
}

export function completionSummary(done: readonly CompletedOrderDay[]): CompletionSummary {
  // An order finished across two days is judged on the later one.
  const last = new Map<string, CompletedOrderDay>();
  for (const d of done) {
    const held = last.get(d.job);
    if (!held || d.day > held.day) last.set(d.job, d);
  }
  const judged = [...last.values()].filter((d) => d.onTime !== null);
  const personDays = new Set(done.flatMap((d) => d.people.map((p) => `${p.toLowerCase()}|${d.day}`))).size;
  const stdHours = round(done.reduce((s, d) => s + d.stdHours, 0));
  // Only the hours somebody is named against count towards a person-day.
  const namedHours = done.reduce((s, d) => s + (d.people.length ? d.stdHours : 0), 0);
  const perPersonDay = personDays ? namedHours / personDays : null;
  return {
    orders: last.size,
    qty: done.reduce((s, d) => s + d.qty, 0),
    stdHours,
    people: new Set(done.flatMap((d) => d.people.map((p) => p.toLowerCase()))).size,
    personDays,
    perPersonDay: perPersonDay === null ? null : round(perPersonDay),
    efficiency: perPersonDay === null ? null : Math.round((perPersonDay / PRODUCTIVE_HOURS_PER_PERSON) * 100),
    datedOrders: judged.length,
    onTimeOrders: judged.filter((d) => d.onTime).length,
  };
}

/** Each person's finished work, most standard hours first. */
export function completionsByPerson(done: readonly CompletedOrderDay[]): PersonCompletions[] {
  const by = new Map<string, { name: string; orders: Set<string>; hours: number; days: Set<string> }>();
  for (const d of done) {
    if (d.people.length === 0) continue;
    const share = d.stdHours / d.people.length;
    for (const name of d.people) {
      const key = name.toLowerCase();
      const held = by.get(key) ?? { name, orders: new Set<string>(), hours: 0, days: new Set<string>() };
      held.orders.add(d.job);
      held.hours += share;
      held.days.add(d.day);
      by.set(key, held);
    }
  }
  return [...by.values()]
    .map((p) => {
      const perDay = p.hours / p.days.size;
      return {
        name: p.name,
        orders: p.orders.size,
        stdHours: round(p.hours),
        days: p.days.size,
        perDay: round(perDay),
        efficiency: Math.round((perDay / PRODUCTIVE_HOURS_PER_PERSON) * 100),
      };
    })
    .sort((a, b) => b.stdHours - a.stdHours || a.name.localeCompare(b.name));
}

/**
 * The window split by line, and each line by order. Lines come back in the
 * order given — the board's own left-to-right sequence — with anything the
 * caller does not recognise after them.
 */
export function completionsByLine(
  done: readonly CompletedOrderDay[],
  lineOrder: readonly string[] = [],
): LineCompletions[] {
  const byLine = new Map<string, CompletedOrderDay[]>();
  for (const d of done) {
    const key = d.line || NO_LINE;
    byLine.set(key, [...(byLine.get(key) ?? []), d]);
  }
  const rank = new Map(lineOrder.map((name, i) => [lineLabel(name).toUpperCase(), i]));
  const place = (line: string): number => rank.get(line.toUpperCase()) ?? lineOrder.length;
  return [...byLine.entries()]
    .sort(([a], [b]) => place(a) - place(b) || a.localeCompare(b))
    .map(([line, days]) => {
      const byJob = new Map<string, CompletedOrderDay[]>();
      for (const d of days) byJob.set(d.job, [...(byJob.get(d.job) ?? []), d]);
      return {
        line,
        summary: completionSummary(days),
        orders: [...byJob.entries()]
          .map(([job, jobDays]) => ({
            job,
            partNum: jobDays.find((d) => d.partNum)?.partNum ?? '',
            days: new Set(jobDays.map((d) => d.day)).size,
            lastDay: jobDays.reduce((a, d) => (d.day > a ? d.day : a), ''),
            due: jobDays.find((d) => d.due)?.due ?? null,
            finished: jobDays.some((d) => d.finished),
            summary: completionSummary(jobDays),
          }))
          .sort((a, b) => a.job.localeCompare(b.job)),
      };
    });
}
