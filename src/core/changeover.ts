import type { ProductionRecord, ShiftCode, StatusCode } from '../types';
import { boxStats } from './boxplot';
import { parseShiftId, SLOT_MINUTES, slotTimeRange } from './shifts';
import { statusKind } from './status';

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

/**
 * One setup, on a press where the setup codes are not worth telling apart.
 *
 * The hot-stamping line is the case this exists for. An injection press
 * distinguishes a die change from a colour change from an insert change,
 * and the difference is most of what its box plot says. Hot stamp does
 * not: whichever of D / I / S (or C / P) the operator keys, the work is
 * the same job of fitting and warming the tool for the next order, and
 * splitting one setup across three boxes by the code somebody happened to
 * pick reports it as three short setups instead of one real one.
 *
 * "Setup" here is the system's own definition — every status whose kind is
 * `setup` in core/status.ts (C, D, I, P, S) — so this chart and the KPI
 * table's Setup h column always count the same slots. Breakdowns (B) and
 * smoko (M) are downtime and stay out.
 */
export interface SetupEvent {
  machineCode: string;
  /** '' where the slot carried no order number. */
  jobNumber: string;
  shiftId: string;
  shiftCode: ShiftCode;
  /** Slots × 0.5 h. */
  hours: number;
  slots: number;
  startedAt: number;
  /** The distinct codes keyed for this one setup, in the order they were
   *  worked — "D + S" reads as one setup the operators split across two
   *  codes, which is exactly the thing being folded back together. */
  codes: StatusCode[];
}

function setupEventFrom(machineCode: string, jobNumber: string, slots: Slot[]): SetupEvent | null {
  const first = slots[0];
  const p = parseShiftId(first.rec.shiftId);
  // Unreachable in practice: a slot only gets here once slotTimeRange has
  // parsed the same ShiftId. Kept total rather than asserted.
  if (!p) return null;
  const codes: StatusCode[] = [];
  for (const s of slots) {
    const c = s.rec.statusCode as StatusCode;
    if (!codes.includes(c)) codes.push(c);
  }
  return {
    machineCode,
    jobNumber,
    shiftId: first.rec.shiftId,
    shiftCode: p.code,
    hours: +(slots.length * SLOT_HOURS).toFixed(2),
    slots: slots.length,
    startedAt: first.at,
    codes,
  };
}

/**
 * Every setup in the slice, oldest first — one per order per SHIFT.
 *
 * Per shift, not per slice, which is the one place this deliberately
 * differs from collectChangeoverEvents. That function gathers an order's
 * changeover across the whole window, because it is answering "what did
 * this die cost to fit". This one feeds a shift-vs-shift comparison, and
 * merging Monday-Day's setup of an order with Wednesday-Afternoon's would
 * file the pair under Monday Day and destroy exactly the comparison being
 * drawn. Within one shift the pieces still fold together: a setup broken
 * by smoko is one setup, not two.
 *
 * The cost is that a setup running through a shift change counts once on
 * each side of it. That is also the honest answer to "how much of this
 * shift went on setting up", which is the question the chart asks.
 *
 * Slots with no order number fall back to contiguous runs, for the same
 * reason as the breakdown rule: with nothing to group them by, a 07:00
 * setup and a 13:00 setup would otherwise become one invented four-hour
 * outlier.
 */
export function collectSetupEvents(records: ProductionRecord[]): SetupEvent[] {
  const byMachine = new Map<string, Slot[]>();
  for (const rec of records) {
    if (!rec.statusCode || statusKind(rec.statusCode) !== 'setup') continue;
    const at = slotTimeRange(rec.shiftId, rec.slotIndex)?.start.getTime();
    if (at == null) continue;
    const arr = byMachine.get(rec.machineCode) ?? [];
    arr.push({ rec, at });
    byMachine.set(rec.machineCode, arr);
  }

  const out: SetupEvent[] = [];
  const push = (e: SetupEvent | null): void => {
    if (e) out.push(e);
  };
  for (const [machineCode, slots] of byMachine) {
    slots.sort((a, b) => a.at - b.at);
    const byOrder = new Map<string, Slot[]>();
    let run: { slots: Slot[]; endsAt: number } | null = null;
    const closeRun = (): void => {
      if (run) push(setupEventFrom(machineCode, '', run.slots));
      run = null;
    };

    for (const s of slots) {
      if (s.rec.jobNumber) {
        closeRun();
        const key = `${s.rec.shiftId}|${s.rec.jobNumber}`;
        const g = byOrder.get(key) ?? [];
        g.push(s);
        byOrder.set(key, g);
        continue;
      }
      // An orphan run also breaks at the shift change, so every event
      // belongs to exactly one shift and can be counted under it.
      if (run && s.at === run.endsAt && s.rec.shiftId === run.slots[0].rec.shiftId) {
        run.slots.push(s);
        run.endsAt = s.at + ADJACENT_MS;
        continue;
      }
      closeRun();
      run = { slots: [s], endsAt: s.at + ADJACENT_MS };
    }
    closeRun();

    for (const g of byOrder.values()) push(setupEventFrom(machineCode, g[0].rec.jobNumber, g));
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
