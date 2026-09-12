import type { ProductionRecord } from '../types';
import { collectChangeoverEvents, type ChangeoverKind } from './changeover';
import { SLOT_MINUTES } from './shifts';
import { STATUS_MAP } from './status';

const SLOT_HOURS = SLOT_MINUTES / 60; // 0.5h per slot

export interface Kpi {
  /**
   * Efficiency %: the standard hours the shift earned over the hours it
   * actually ran them in — `output × cycle time ÷ run hours`.
   *
   * It used to be run slots ÷ all filled slots, which is a *utilisation*
   * figure: it said how much of the shift the press was running and nothing
   * at all about how fast. A press running flat out at half rate scored the
   * same as one making its numbers, and a press that finished its order early
   * and stood idle scored worse than one that never got going.
   */
  efficiency: number | null;
  /** Standard hours earned — Σ good × cycle time, over jobs that have one. */
  stdHours: number;
  /** Run hours on those same jobs: Efficiency's denominator, the "R" slots. */
  effRunHrs: number;
  output: number; // good qty
  scrap: number; // total reject pieces
  scrapPct: number; // %
  downtimeHrs: number; // B + M
  setupHrs: number; // D + C + I (§4.1)
  /** Slots × 0.5h, broken out so the KPI grid can show the changeover
   *  mix instead of a single Setup H roll-up. Sum of the three equals
   *  setupHrs by construction. */
  dieHrs: number;
  colorHrs: number;
  insertHrs: number;
  /** S slots × 0.5h. Startup is a setup-kind status but deliberately NOT
   *  part of setupHrs (which is the D/C/I changeover trio §4.1) — it is
   *  warm-up on a die that is already in, not a changeover. Reported on
   *  its own so the hours a shift spends coming up to temperature stop
   *  appearing in no hours column at all. */
  startupHrs: number;
  runHrs: number;
  /** Distinct ShiftIds the slice covers. Lets a caller judge a rolled-up
   *  figure per shift (e.g. "≤5 rejects a shift") instead of against a
   *  raw total whose size depends on how many shifts got summed. */
  shifts: number;
  dieChanges: number; // D event count
  colorChanges: number; // C event count
  insertChanges: number; // I event count
  filledSlots: number;
}

/**
 * Gross pieces from a tuple's counters, accounting for a multi-cavity
 * die. The press counter ticks once per cycle; a die with N identical
 * cavities yields N pieces per cycle, so actual pieces = cycles × N.
 * cavities defaults to 1 (single cavity) — the overwhelming majority of
 * presses — so legacy rows with no Cavities value are unchanged.
 */
export function cavityGross(
  countStart: number | null,
  countEnd: number | null,
  cavities?: number | null,
): number {
  if (countStart == null || countEnd == null) return 0;
  const c = cavities && cavities > 0 ? cavities : 1;
  return Math.max(0, countEnd - countStart) * c;
}

function sumRejects(r: ProductionRecord): number {
  if (r.rejects && r.rejects !== '{}') {
    try {
      const parsed = JSON.parse(r.rejects) as Record<string, number>;
      return Object.values(parsed).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      /* fall through to rejectCount */
    }
  }
  return Number(r.rejectCount) || 0;
}

/**
 * Roll a flat list of production records into headline KPIs (§4.1).
 *
 * - Efficiency is standard hours earned ÷ run hours used, per job.
 * - Output/scrap are read per canonical (job,shift) at SlotIndex 0 where the
 *   per-job counters live (§3.6); rejects summed across that job's records.
 */
export function aggregate(
  records: ProductionRecord[],
  /**
   * Job → cycle time (hours per piece), for rows that do not carry their own.
   *
   * `CycleTime` is stamped onto the canonical slot at sign-off, so a shift
   * still running has none and its Efficiency would read "—" all day. The KPI
   * page builds this from the planning list, which is where the rate came
   * from in the first place.
   */
  ctByJob?: ReadonlyMap<string, number>,
): Kpi {
  let filled = 0;
  let run = 0;
  let downSlots = 0;
  let setupSlots = 0;
  let dieSlots = 0;
  let colorSlots = 0;
  let insertSlots = 0;
  let startupSlots = 0;
  const shiftIds = new Set<string>();

  for (const r of records) {
    if (r.shiftId) shiftIds.add(r.shiftId);
    if (!r.statusCode) continue;
    filled++;
    const def = STATUS_MAP[r.statusCode];
    if (!def) continue;
    if (def.kind === 'production') run++;
    else if (def.kind === 'downtime') downSlots++;
    if (r.statusCode === 'S') startupSlots++;
    if (r.statusCode === 'D') {
      setupSlots++;
      dieSlots++;
    } else if (r.statusCode === 'C') {
      setupSlots++;
      colorSlots++;
    } else if (r.statusCode === 'I') {
      setupSlots++;
      insertSlots++;
    }
  }

  // Output / scrap grouped by (jobNumber, shiftId).
  const groups = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const key = `${r.jobNumber}|${r.shiftId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  let gross = 0;
  let scrap = 0;
  let output = 0;
  let stdHours = 0;
  let effRunSlots = 0;
  for (const grp of groups.values()) {
    const canonical = grp.find((r) => r.slotIndex === 0) ?? grp[0];
    const g = canonical
      ? cavityGross(canonical.countStart, canonical.countEnd, canonical.cavities)
      : 0;
    const rej = grp.reduce((a, r) => a + sumRejects(r), 0);
    const good = Math.max(0, g - rej);
    gross += g;
    scrap += rej;
    output += good;

    /*
     * Efficiency, per job: the standard hours those pieces were worth against
     * the hours the press actually spent running them.
     *
     * A job with no cycle time is out of BOTH sides, not scored zero. Nobody
     * gave that order a rate, which is not the same as the press having run it
     * badly — and leaving its run hours in the denominator would quietly drag
     * the whole shift down for a missing planning field.
     */
    const ct =
      canonical?.cycleTime && canonical.cycleTime > 0
        ? canonical.cycleTime
        : (ctByJob?.get(canonical?.jobNumber ?? '') ?? 0);
    if (ct > 0) {
      stdHours += good * ct;
      for (const r of grp) {
        if (r.statusCode && STATUS_MAP[r.statusCode]?.kind === 'production') {
          effRunSlots++;
        }
      }
    }
  }
  const effRunHrs = effRunSlots * SLOT_HOURS;

  return {
    // Standard hours earned ÷ hours used. It was run slots ÷ filled slots,
    // which said how much of the shift the press was running and nothing at
    // all about how fast it ran.
    efficiency: effRunHrs > 0 ? Math.round((stdHours / effRunHrs) * 100) : null,
    stdHours: +stdHours.toFixed(2),
    effRunHrs: +effRunHrs.toFixed(2),
    output,
    scrap,
    scrapPct: gross > 0 ? +((scrap / gross) * 100).toFixed(1) : 0,
    downtimeHrs: +(downSlots * SLOT_HOURS).toFixed(1),
    setupHrs: +(setupSlots * SLOT_HOURS).toFixed(1),
    dieHrs: +(dieSlots * SLOT_HOURS).toFixed(1),
    colorHrs: +(colorSlots * SLOT_HOURS).toFixed(1),
    insertHrs: +(insertSlots * SLOT_HOURS).toFixed(1),
    startupHrs: +(startupSlots * SLOT_HOURS).toFixed(1),
    runHrs: +(run * SLOT_HOURS).toFixed(1),
    shifts: shiftIds.size,
    ...countSetupEvents(records),
    filledSlots: filled,
  };
}

/**
 * How many D/C/I *changeovers* the slice contains — one per order, not
 * one per contiguous run of slots.
 *
 * A changeover belongs to the order it sets the press up for. The sheet
 * may record it in pieces (three D slots before smoko, two after), and
 * counting runs would call that two die changes: it doubles the standard
 * allowance (2 × 4 h) and lets an 8-hour changeover pass as "within
 * standard". collectChangeoverEvents owns the rule, so the KPI table's
 * Die / Colour / Insert judgement and the supervisor's duration box plot
 * can never disagree about what a changeover is.
 */
export function countSetupEvents(records: ProductionRecord[]): {
  dieChanges: number;
  colorChanges: number;
  insertChanges: number;
} {
  const events = collectChangeoverEvents(records);
  const of = (kind: ChangeoverKind): number => events.filter((e) => e.kind === kind).length;
  return { dieChanges: of('die'), colorChanges: of('color'), insertChanges: of('insert') };
}

// §4.2 KPI color thresholds.
export function efficiencyColor(
  efficiency: number | null,
): 'green' | 'amber' | 'red' | 'gray' {
  if (efficiency == null) return 'gray';
  if (efficiency >= 85) return 'green';
  if (efficiency >= 70) return 'amber';
  return 'red';
}

export function scrapColor(pct: number): 'green' | 'amber' | 'red' {
  if (pct < 2) return 'green';
  if (pct <= 5) return 'amber';
  return 'red';
}
