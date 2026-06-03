import type { ProductionRecord } from '../types';
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
  runHrs: number;
  dieChanges: number; // D event count
  colorChanges: number; // C event count
  insertChanges: number; // I event count
  filledSlots: number;
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

  for (const r of records) {
    if (!r.statusCode) continue;
    filled++;
    const def = STATUS_MAP[r.statusCode];
    if (!def) continue;
    if (def.kind === 'production') run++;
    else if (def.kind === 'downtime') downSlots++;
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
    let g = 0;
    if (canonical && canonical.countStart != null && canonical.countEnd != null) {
      g = Math.max(0, canonical.countEnd - canonical.countStart);
    }
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
    runHrs: +(run * SLOT_HOURS).toFixed(1),
    ...countSetupEvents(records),
    filledSlots: filled,
  };
}

/**
 * Count D/C/I as "events" = consecutive runs of the same status along the
 * machine timeline (ShiftId then SlotIndex), mirroring the demo's logic so
 * the Setup Plan-vs-Actual chart counts changeovers, not slots.
 */
export function countSetupEvents(records: ProductionRecord[]): {
  dieChanges: number;
  colorChanges: number;
  insertChanges: number;
} {
  const sorted = [...records]
    .filter((r) => r.statusCode)
    .sort((a, b) => {
      const ka = `${a.shiftId}#${String(a.slotIndex).padStart(3, '0')}`;
      const kb = `${b.shiftId}#${String(b.slotIndex).padStart(3, '0')}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  let d = 0;
  let c = 0;
  let i = 0;
  let prev = '';
  for (const r of sorted) {
    if (r.statusCode === 'D' && prev !== 'D') d++;
    else if (r.statusCode === 'C' && prev !== 'C') c++;
    else if (r.statusCode === 'I' && prev !== 'I') i++;
    prev = r.statusCode;
  }
  return { dieChanges: d, colorChanges: c, insertChanges: i };
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
