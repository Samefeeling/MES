/**
 * Epicor's completed orders, as the Assembly supervisor confirmed them — the
 * figures behind the "Completed in Epicor" section of KPIs · Assembly.
 *
 * Kept apart from `assembly-metrics` on purpose: those figures are the board's
 * own shift entries, these are Epicor's labour records with names put to them
 * the next morning. Folding one into the other would count the same pieces
 * twice wherever both recorded them.
 *
 * ## Per person
 *
 * An order finished by three people credits each with a third of its standard
 * hours (and counts as one order for each of them). A person's **Std h / day**
 * is their credited hours over the days they are named on a completion, and
 * **Efficiency** is that over the 7.5 productive hours of a day. A day spent
 * on an order that was not finished that day earns nothing here, so this
 * reads low for anyone on long orders: it is what was *finished* per day.
 */

import type { AssemblyResult } from '../types/assembly';
import { PRODUCTIVE_HOURS_PER_PERSON } from './assembly-metrics';

/**
 * A row the board never booked: opened by the completed-orders dialog for an
 * order finished on a day it had no shift entry. It carries nothing of the
 * board's own, so the board's figures leave it out — it would be an order
 * with a crew and no output.
 */
export function isCompletionOnly(row: AssemblyResult): boolean {
  return (
    Boolean(row.epicor) &&
    !row.output && !row.complete && !row.reject && !row.rework &&
    !row.bookedHours && !row.laborHours && !row.operators.trim()
  );
}

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

const day10 = (s: string | null): string | null => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

/** Every confirmed completion in the rows, newest first. */
export function completedOrderDays(rows: readonly AssemblyResult[]): CompletedOrderDay[] {
  return rows
    .filter((row) => row.epicor)
    .map((row) => {
      const e = row.epicor!;
      const due = day10(row.due);
      return {
        job: row.job,
        day: row.day,
        line: row.line,
        partNum: e.partNum,
        qty: e.qty,
        stdHours: e.hours,
        due,
        onTime: due ? row.day <= due : null,
        people: e.people,
        confirmedBy: e.confirmedBy,
      };
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
  return {
    orders: last.size,
    qty: done.reduce((s, d) => s + d.qty, 0),
    stdHours: round(done.reduce((s, d) => s + d.stdHours, 0)),
    people: new Set(done.flatMap((d) => d.people.map((p) => p.toLowerCase()))).size,
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
