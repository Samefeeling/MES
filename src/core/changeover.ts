import type { ProductionRecord, StatusCode } from '../types';
import { boxStats } from './boxplot';
import { SLOT_MINUTES, slotTimeRange } from './shifts';

/**
 * Changeover and breakdown *events* — the unit a supervisor thinks in.
 *
 * The floor counts these two ways, and the difference is not a detail:
 *
 * - A die / colour / insert change belongs to an ORDER. It is one job of
 *   work that the sheet may record in scattered pieces — three D slots
 *   before smoko, two after — so every D slot under one order on one
 *   press is ONE die change whose duration is their sum. Counting
 *   contiguous runs instead would report that same changeover twice and
 *   halve each one's apparent duration.
 *
 * - A breakdown has no such anchor. Each unbroken run of B slots is its
 *   own event: a press that stops twice in a shift broke down twice, and
 *   rolling both into one would hide the frequency that matters as much
 *   as the hours.
 *
 * Adjacency is judged on wall-clock time, not on ShiftId text or slot
 * index: a breakdown that starts at 14:30 in Day and is still down at
 * 15:00 in Afternoon is one breakdown, while a B at 10:00 and another at
 * 11:00 with the press running in between is two.
 */

const SLOT_HOURS = SLOT_MINUTES / 60;
const ADJACENT_MS = SLOT_MINUTES * 60_000;

export type ChangeoverKind = 'die' | 'color' | 'insert' | 'down';

const KIND_OF: Partial<Record<StatusCode, ChangeoverKind>> = {
  D: 'die',
  C: 'color',
  I: 'insert',
  B: 'down',
};

export const CHANGEOVER_LABELS: Record<ChangeoverKind, string> = {
  die: 'Die Change',
  color: 'Colour Change',
  insert: 'Insert Change',
  down: 'Breakdown',
};

export interface ChangeoverEvent {
  kind: ChangeoverKind;
  machineCode: string;
  /** '' for a breakdown run that spans orders, or a slot logged without
   *  an order number. */
  jobNumber: string;
  /** Slots × 0.5 h. For a D/C/I this is the whole changeover for that
   *  order, even where the sheet recorded it in pieces. */
  hours: number;
  slots: number;
  /** Wall-clock start of the event's earliest slot, for sorting and for
   *  telling the supervisor which one an outlier was. */
  startedAt: number;
  shiftId: string;
  slotIndex: number;
}

interface Slot {
  rec: ProductionRecord;
  at: number;
}

function eventFrom(
  kind: ChangeoverKind,
  machineCode: string,
  jobNumber: string,
  slots: Slot[],
): ChangeoverEvent {
  const first = slots[0];
  return {
    kind,
    machineCode,
    jobNumber,
    hours: +(slots.length * SLOT_HOURS).toFixed(2),
    slots: slots.length,
    startedAt: first.at,
    shiftId: first.rec.shiftId,
    slotIndex: first.rec.slotIndex,
  };
}

/**
 * Every changeover and breakdown in the slice, oldest first.
 *
 * D/C/I slots that carry no order number fall back to the breakdown rule
 * (contiguous runs). Without an order there is nothing to group them by,
 * and lumping a week of orphan D slots on one press into a single
 * 40-hour "die change" would wreck the distribution it feeds.
 */
export function collectChangeoverEvents(records: ProductionRecord[]): ChangeoverEvent[] {
  const byMachine = new Map<string, Slot[]>();
  for (const rec of records) {
    if (!rec.statusCode || !KIND_OF[rec.statusCode]) continue;
    const at = slotTimeRange(rec.shiftId, rec.slotIndex)?.start.getTime();
    // An unparseable ShiftId can't be placed on the timeline, so it can
    // neither extend a run nor be trusted to end one.
    if (at == null) continue;
    const arr = byMachine.get(rec.machineCode) ?? [];
    arr.push({ rec, at });
    byMachine.set(rec.machineCode, arr);
  }

  const out: ChangeoverEvent[] = [];
  for (const [machineCode, slots] of byMachine) {
    slots.sort((a, b) => a.at - b.at);

    // Order-anchored changeovers, gathered across the whole slice.
    const byOrder = new Map<string, { kind: ChangeoverKind; job: string; slots: Slot[] }>();
    // The contiguous-run state for breakdowns (and orphan D/C/I).
    let run: { kind: ChangeoverKind; code: StatusCode; slots: Slot[]; endsAt: number } | null =
      null;
    const closeRun = (): void => {
      if (run) out.push(eventFrom(run.kind, machineCode, run.slots[0].rec.jobNumber, run.slots));
      run = null;
    };

    for (const s of slots) {
      const code = s.rec.statusCode as StatusCode;
      const kind = KIND_OF[code]!;
      const job = s.rec.jobNumber;
      if (kind !== 'down' && job) {
        // This slot is part of its order's changeover — and it also
        // interrupts whatever run was open, since the press was doing
        // something else in this half-hour.
        closeRun();
        const key = `${code}|${job}`;
        const g = byOrder.get(key) ?? { kind, job, slots: [] };
        g.slots.push(s);
        byOrder.set(key, g);
        continue;
      }
      if (run && run.code === code && s.at === run.endsAt) {
        run.slots.push(s);
        run.endsAt = s.at + ADJACENT_MS;
        continue;
      }
      closeRun();
      run = { kind, code, slots: [s], endsAt: s.at + ADJACENT_MS };
    }
    closeRun();

    for (const g of byOrder.values()) out.push(eventFrom(g.kind, machineCode, g.job, g.slots));
  }

  return out.sort((a, b) => a.startedAt - b.startedAt || (a.machineCode < b.machineCode ? -1 : 1));
}

/** One die's observed changeover time, ready to write to
 *  PMD_DieMaster.ChangeOverMedian beside the toolroom's nominal
 *  ChangeOverIn / ChangeOverOut. */
export interface DieChangeoverMedian {
  dieNumber: string;
  /** Median hours across `events` die changes, 2 dp. */
  medianHrs: number;
  events: number;
}

/**
 * Median die-change duration per die.
 *
 * Median rather than mean: one nine-hour changeover where the tool
 * fought back would drag a mean up for months and misrepresent what the
 * die normally costs to fit. The median is what "this tool takes about
 * an hour and a half" means.
 *
 * Only D counts — this is the die's own changeover, the figure that sits
 * next to the toolroom's nominal ChangeOverIn/Out. Colour and insert
 * changes happen with the die already in the press.
 *
 * `dieByJob` maps an order to the die it ran on; orders that resolve to
 * no die are skipped rather than pooled under a blank key, and a die is
 * reported only if at least one of its changeovers was observed.
 */
export function dieChangeoverMedians(
  events: ChangeoverEvent[],
  dieByJob: Map<string, string>,
): DieChangeoverMedian[] {
  const hoursByDie = new Map<string, number[]>();
  for (const e of events) {
    if (e.kind !== 'die' || !e.jobNumber) continue;
    const die = dieByJob.get(e.jobNumber)?.trim();
    if (!die) continue;
    hoursByDie.set(die, [...(hoursByDie.get(die) ?? []), e.hours]);
  }
  const out: DieChangeoverMedian[] = [];
  for (const [dieNumber, hours] of hoursByDie) {
    const st = boxStats(hours);
    if (!st) continue;
    out.push({ dieNumber, medianHrs: +st.median.toFixed(2), events: st.n });
  }
  return out.sort((a, b) => (a.dieNumber < b.dieNumber ? -1 : a.dieNumber > b.dieNumber ? 1 : 0));
}
