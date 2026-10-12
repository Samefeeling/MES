import type { ProductionRecord, StatusCode } from '../types';
import { collectChangeoverEvents } from './changeover';
import { aggregate, type Kpi } from './metrics';
import { SLOT_MINUTES, slotTimeRange } from './shifts';

/**
 * The KPI page's two supervisor-only operator views: what each operator
 * made, and the stoppages on their watch that ran past the floor's limits.
 *
 * The sheet records the operator once per order per shift, on the order's
 * canonical row (slot 0), so every slot of that (press, shift, order) is
 * theirs. A stoppage is one event however many slots it spans — the same
 * events the duration box plot draws — and goes to the operator who logged
 * most of it; the hours columns still count each slot under whoever logged
 * it, so they add up across operators.
 */

const SLOT_HOURS = SLOT_MINUTES / 60;
/** A startup with no production for this long is a new startup. */
const STARTUP_GAP_MS = 8 * 3_600_000;

export type StopKind = 'startup' | 'die' | 'change' | 'breakdown';
export const STOP_KINDS: readonly StopKind[] = ['startup', 'die', 'change', 'breakdown'];

/** Hours a stoppage may take before it counts against the operator. Over
 *  means strictly over: a 4 h die change is within its 4 h. Every
 *  breakdown counts. */
export const STOP_LIMIT_HRS: Record<Exclude<StopKind, 'breakdown'>, number> = {
  startup: 1,
  die: 4,
  change: 0.5,
};

export const STOP_LABELS: Record<StopKind, string> = {
  startup: 'Startup > 1 h',
  die: 'Die setup > 4 h',
  change: 'Insert / colour change > 0.5 h',
  breakdown: 'Breakdown',
};

export interface OperatorStop {
  kind: StopKind;
  /** The status keyed for it — tells an insert change from a colour change. */
  code: StatusCode;
  machineCode: string;
  jobNumber: string;
  shiftId: string;
  startedAt: number;
  /** The whole event, whoever logged it. */
  hours: number;
  /** Over its limit; every breakdown is. */
  flagged: boolean;
}

export interface StopTally {
  events: number;
  flagged: number;
  hours: number;
}

export interface OperatorPerf {
  /** '' where the order's sheet named nobody. */
  operator: string;
  machines: string[];
  /** Every slot of their orders' shifts. */
  records: ProductionRecord[];
  kpi: Kpi;
  /** Stoppages put to this operator, oldest first. */
  stops: OperatorStop[];
  tally: Record<StopKind, StopTally>;
  /** Hours past the limits on the flagged startups and changeovers, plus
   *  every breakdown hour. */
  hoursOver: number;
}

const tupleKey = (r: ProductionRecord): string =>
  `${r.machineCode.trim().toUpperCase()}|${r.shiftId}|${r.jobNumber.trim().toUpperCase()}`;

const cleanName = (s: string | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** Operator per (press, shift, order), read off its canonical row. */
export function operatorByTuple(records: readonly ProductionRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    const name = cleanName(r.operator);
    if (!name) continue;
    const k = tupleKey(r);
    if (r.slotIndex === 0 || !out.has(k)) out.set(k, name);
  }
  return out;
}

interface StartupEvent {
  machineCode: string;
  jobNumber: string;
  records: ProductionRecord[];
  startedAt: number;
  endsAt: number;
}

/**
 * Every startup in the slice, oldest first. A startup runs from its first S
 * until the press runs (R) or stands with no plan (O), so smoko or a
 * breakdown in the middle does not split it; an S that comes more than a
 * shift after the last one starts a new startup.
 */
export function collectStartups(records: readonly ProductionRecord[]): StartupEvent[] {
  const byMachine = new Map<string, Array<{ rec: ProductionRecord; at: number }>>();
  for (const rec of records) {
    if (!rec.statusCode) continue;
    const at = slotTimeRange(rec.shiftId, rec.slotIndex)?.start.getTime();
    if (at == null) continue;
    const arr = byMachine.get(rec.machineCode) ?? [];
    arr.push({ rec, at });
    byMachine.set(rec.machineCode, arr);
  }
  const out: StartupEvent[] = [];
  for (const [machineCode, slots] of byMachine) {
    slots.sort((a, b) => a.at - b.at);
    const open = new Map<string, StartupEvent>();
    for (const { rec, at } of slots) {
      if (rec.statusCode === 'R' || rec.statusCode === 'O') {
        open.clear();
        continue;
      }
      if (rec.statusCode !== 'S') continue;
      const key = rec.jobNumber.trim().toUpperCase();
      const e = open.get(key);
      if (e && at - e.endsAt <= STARTUP_GAP_MS) {
        e.records.push(rec);
        e.endsAt = at + SLOT_MINUTES * 60_000;
        continue;
      }
      const next: StartupEvent = {
        machineCode,
        jobNumber: rec.jobNumber,
        records: [rec],
        startedAt: at,
        endsAt: at + SLOT_MINUTES * 60_000,
      };
      open.set(key, next);
      out.push(next);
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const emptyTally = (): Record<StopKind, StopTally> => ({
  startup: { events: 0, flagged: 0, hours: 0 },
  die: { events: 0, flagged: 0, hours: 0 },
  change: { events: 0, flagged: 0, hours: 0 },
  breakdown: { events: 0, flagged: 0, hours: 0 },
});

/**
 * One row per operator over the slice. `stopsOn` picks the presses whose
 * stoppages are judged against the limits — the hot-stamp press keys its
 * setups differently and is left out by the caller; its output still counts.
 */
export function operatorPerformance(
  records: readonly ProductionRecord[],
  ctByJob?: ReadonlyMap<string, number>,
  stopsOn: (machineCode: string) => boolean = () => true,
): OperatorPerf[] {
  const who = operatorByTuple(records);
  const nameOf = (r: ProductionRecord): string => who.get(tupleKey(r)) ?? '';

  const recsBy = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const name = nameOf(r);
    const arr = recsBy.get(name) ?? [];
    arr.push(r);
    recsBy.set(name, arr);
  }

  // The stoppage goes to whoever logged most of it; on a tie, to whoever
  // logged its first slot.
  const ownerOf = (recs: readonly ProductionRecord[]): string => {
    const n = new Map<string, number>();
    for (const r of recs) n.set(nameOf(r), (n.get(nameOf(r)) ?? 0) + 1);
    let best = nameOf(recs[0]);
    for (const [name, c] of n) if (c > (n.get(best) ?? 0)) best = name;
    return best;
  };

  const stopsBy = new Map<string, OperatorStop[]>();
  const add = (owner: string, s: OperatorStop): void => {
    const arr = stopsBy.get(owner) ?? [];
    arr.push(s);
    stopsBy.set(owner, arr);
  };
  const judged = records.filter((r) => stopsOn(r.machineCode));
  for (const e of collectChangeoverEvents(judged)) {
    const kind: StopKind = e.kind === 'down' ? 'breakdown' : e.kind === 'die' ? 'die' : 'change';
    add(ownerOf(e.records), {
      kind,
      code: e.records[0].statusCode as StatusCode,
      machineCode: e.machineCode,
      jobNumber: e.jobNumber,
      shiftId: e.shiftId,
      startedAt: e.startedAt,
      hours: e.hours,
      flagged: kind === 'breakdown' || e.hours > STOP_LIMIT_HRS[kind],
    });
  }
  for (const e of collectStartups(judged)) {
    const hours = +(e.records.length * SLOT_HOURS).toFixed(2);
    add(ownerOf(e.records), {
      kind: 'startup',
      code: 'S',
      machineCode: e.machineCode,
      jobNumber: e.jobNumber,
      shiftId: e.records[0].shiftId,
      startedAt: e.startedAt,
      hours,
      flagged: hours > STOP_LIMIT_HRS.startup,
    });
  }

  return [...recsBy].map(([operator, recs]) => {
    const stops = (stopsBy.get(operator) ?? []).sort((a, b) => a.startedAt - b.startedAt);
    const tally = emptyTally();
    let hoursOver = 0;
    for (const s of stops) {
      const t = tally[s.kind];
      t.events += 1;
      t.hours += s.hours;
      if (!s.flagged) continue;
      t.flagged += 1;
      hoursOver += s.kind === 'breakdown' ? s.hours : s.hours - STOP_LIMIT_HRS[s.kind];
    }
    for (const k of STOP_KINDS) tally[k].hours = +tally[k].hours.toFixed(2);
    return {
      operator,
      machines: [...new Set(recs.map((r) => r.machineCode))].sort(),
      records: recs,
      kpi: aggregate(recs, ctByJob),
      stops,
      tally,
      hoursOver: +hoursOver.toFixed(2),
    };
  });
}

export interface OutputBucket {
  /** YYYY-MM-DD: the day, or the Monday of the week. */
  key: string;
  byMachine: Map<string, { good: number; reject: number }>;
}

const mondayOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** Good and reject per press, per day (or per week), for the records of one
 *  operator. Days they did not work are not there. */
export function outputByTime(records: readonly ProductionRecord[], weekly = false): OutputBucket[] {
  const tuples = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    if (!r.jobNumber.trim()) continue;
    const k = tupleKey(r);
    const arr = tuples.get(k) ?? [];
    arr.push(r);
    tuples.set(k, arr);
  }
  const buckets = new Map<string, OutputBucket>();
  for (const recs of tuples.values()) {
    const { output, scrap } = aggregate(recs);
    if (output === 0 && scrap === 0) continue;
    const day = recs[0].shiftId.slice(0, 10);
    const key = weekly ? mondayOf(day) : day;
    const b = buckets.get(key) ?? { key, byMachine: new Map() };
    const m = b.byMachine.get(recs[0].machineCode) ?? { good: 0, reject: 0 };
    m.good += output;
    m.reject += scrap;
    b.byMachine.set(recs[0].machineCode, m);
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
