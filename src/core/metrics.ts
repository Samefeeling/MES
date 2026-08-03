import type { ProductionRecord } from '../types';
import { collectChangeoverEvents, type ChangeoverKind } from './changeover';
import { SLOT_MINUTES } from './shifts';
import { STATUS_MAP } from './status';

const SLOT_HOURS = SLOT_MINUTES / 60; // 0.5h per slot

export interface Kpi {
  oee: number | null; // %
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
   *  being invisible: they count against Efficiency (filled slots) while
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
 * - OEE is the run-slot ratio (Availability-style; matches the seeded demo
 *   rates in Appendix A — full Availability×Performance×Quality is future).
 * - Output/scrap are read per canonical (job,shift) at SlotIndex 0 where the
 *   per-job counters live (§3.6); rejects summed across that job's records.
 */
export function aggregate(records: ProductionRecord[]): Kpi {
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
  for (const grp of groups.values()) {
    const canonical = grp.find((r) => r.slotIndex === 0) ?? grp[0];
    const g = canonical
      ? cavityGross(canonical.countStart, canonical.countEnd, canonical.cavities)
      : 0;
    const rej = grp.reduce((a, r) => a + sumRejects(r), 0);
    gross += g;
    scrap += rej;
    output += Math.max(0, g - rej);
  }

  return {
    oee: filled > 0 ? Math.round((run / filled) * 100) : null,
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
export function oeeColor(oee: number | null): 'green' | 'amber' | 'red' | 'gray' {
  if (oee == null) return 'gray';
  if (oee >= 85) return 'green';
  if (oee >= 70) return 'amber';
  return 'red';
}

export function scrapColor(pct: number): 'green' | 'amber' | 'red' {
  if (pct < 2) return 'green';
  if (pct <= 5) return 'amber';
  return 'red';
}
