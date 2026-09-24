/**
 * Start production, or close, several orders at once.
 *
 * Each order is held to exactly the rules its own detail panel applies — the
 * start gate, "started before it is completed", a completion that books the
 * rest of the order — so a batch can do nothing one order at a time could not.
 * What a rule stops is left out and said why, rather than the whole batch
 * being refused for one order in it.
 *
 * Support orders are left out of both: their hours are typed in on their own
 * form, and a clock started here would book them as timed work.
 *
 * Pure. No React, no store.
 */

import type { OrderRow } from '@/engine/assembly/board';
import { remainingQty } from '@/engine/assembly/duration';
import { startEligibility } from '@/engine/assembly/release';
import type { ActualStartRecord, ProductionEntry } from '@/store/planStore';

export type BulkAction = 'start' | 'complete';

export interface Skipped {
  row: OrderRow;
  reason: string;
}

/**
 * Who a booking made today is made against: the crew the day plan has on the
 * order today, else the order's own people — an order planned to begin later
 * in the week has nobody on it today and is still fully crewed.
 */
export function activeCrewOf(row: OrderRow, today: string): OrderRow['workers'] {
  const onToday = row.crewDays.find((day) => day.day === today)?.workerIds ?? [];
  const todayCrew = row.workers.filter((w) => onToday.includes(String(w.id)));
  return todayCrew.length > 0 ? todayCrew : row.workers;
}

const closedOn = (row: OrderRow, production: Record<string, ProductionEntry[]>) =>
  row.completedToday || (production[String(row.job.id)] ?? []).some((e) => e.jobCompleted);

/** Why an order cannot take part in either action, or null. */
function ineligible(
  row: OrderRow,
  production: Record<string, ProductionEntry[]>,
): string | null {
  if (!row.line.schedulable) return 'not planned on this board';
  if (row.job.manual) return 'support order — book it from its own form';
  if (closedOn(row, production)) return 'already completed';
  return null;
}

export interface StartPlan {
  /** Clear to start. */
  ready: OrderRow[];
  /** Held by the start gate, but a signed-in supervisor may override it. */
  override: { row: OrderRow; reasons: string[] }[];
  skipped: Skipped[];
}

export function planStart(
  rows: readonly OrderRow[],
  production: Record<string, ProductionEntry[]>,
): StartPlan {
  const plan: StartPlan = { ready: [], override: [], skipped: [] };
  for (const row of rows) {
    const no = ineligible(row, production);
    if (no) {
      plan.skipped.push({ row, reason: no });
      continue;
    }
    if (row.actualStart) {
      plan.skipped.push({ row, reason: 'already started' });
      continue;
    }
    const gate = startEligibility(row.job.released, row.release, row.workers.length);
    if (gate.allowed) plan.ready.push(row);
    else if (gate.canOverride) plan.override.push({ row, reasons: gate.reasons });
    else plan.skipped.push({ row, reason: gate.reasons.join(' · ') });
  }
  return plan;
}

export function startRecord(
  row: OrderRow,
  today: string,
  startedAt: string,
  overrideReason: string | null,
): ActualStartRecord {
  const crew = activeCrewOf(row, today);
  return {
    startedAt,
    overrideReason,
    operatorIds: crew.map((w) => String(w.id)),
    operatorNames: crew.map((w) => w.name),
  };
}

export interface CompletePlan {
  ready: {
    row: OrderRow;
    entry: ProductionEntry;
    /** Today already had an entry; its figures are kept and it is closed. */
    rebooks: boolean;
  }[];
  skipped: Skipped[];
}

/**
 * Close each order the way ticking "Job completed" in its panel does: today's
 * Complete becomes everything still owed plus whatever today already booked,
 * and anything else today's entry held — reject, rework, output, notes — is
 * kept as it was. A paused entry is un-paused; an order cannot be both.
 */
export function planComplete(
  rows: readonly OrderRow[],
  production: Record<string, ProductionEntry[]>,
  today: string,
  savedAt: string,
): CompletePlan {
  const plan: CompletePlan = { ready: [], skipped: [] };
  for (const row of rows) {
    const no = ineligible(row, production);
    if (no) {
      plan.skipped.push({ row, reason: no });
      continue;
    }
    if (!row.actualStart) {
      plan.skipped.push({ row, reason: 'not started — start production first' });
      continue;
    }
    const existing = (production[String(row.job.id)] ?? []).find((e) => e.date === today);
    const crew = activeCrewOf(row, today);
    plan.ready.push({
      row,
      rebooks: Boolean(existing),
      entry: {
        date: today,
        savedAt,
        complete: remainingQty(row.job) + (existing?.complete ?? 0),
        reject: existing?.reject ?? 0,
        rework: existing?.rework ?? 0,
        shiftOutput: existing?.shiftOutput ?? 0,
        paused: false,
        pauseReason: null,
        jobCompleted: true,
        operatorIds: crew.map((w) => String(w.id)),
        operatorNames: crew.map((w) => w.name),
        completedAt: savedAt,
        notes: existing?.notes ?? '',
      },
    });
  }
  return plan;
}

/** Marked orders if the one pressed is among them, else just that one. */
export function bulkTargets(pressed: string, marked: readonly string[]): string[] {
  return marked.includes(pressed) ? [...marked] : [pressed];
}
