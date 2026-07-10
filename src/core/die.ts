// Die (tool) usage & health — pure aggregation logic for the Trace page's
// 🛠 Die Management tab. No DOM: everything here is unit-testable.
//
// The die master lives in PMD_ProductDieColor (Die/DieNumber per Part #).
// Production usage is derived by joining PMD_Production records to that
// master via the denormalised partNumber each record carries. Maintenance
// requests live in PMD_DieMaintenance (see dal/sharepoint.ts) and will be
// mirrored into Mango later — MangoTicket on the request is the link slot.

import type {
  DieMaintenanceRequest,
  ProductDieColor,
  ProductionRecord,
} from '../types';
import { cavityGross } from './metrics';

/** Built-in maintenance contacts for die repair / cleaning requests.
 *  Edit this list to match the real toolroom roster — phone / email are
 *  optional and render as tap-to-call / mail links when present. When the
 *  Mango integration lands, contact routing moves to Mango's assignment
 *  rules and this list becomes the offline fallback. */
export interface MaintContact {
  /** What they're contacted FOR (shown as the group label). */
  role: string;
  name: string;
  phone?: string;
  email?: string;
}

export const MAINTENANCE_CONTACTS: MaintContact[] = [
  { role: 'Toolroom — die repair', name: 'Toolroom Team' },
  { role: 'Maintenance — cleaning / service', name: 'Maintenance Team' },
  { role: 'PMD Supervisor', name: 'Shift Supervisor' },
];

/** Aggregated usage + quality picture for one physical die. */
export interface DieAgg {
  dieNumber: string;
  /** Every Part # that runs on this die (from PMD_ProductDieColor). */
  parts: Array<{ partNumber: string; name: string; category: string; coRun: boolean }>;
  category: string;
  /** Presses this die ran on inside the window. */
  machines: string[];
  /** (machine, shift, job) tuples the die ran in the window. */
  runs: number;
  /** Press cycles (Σ CountEnd − CountStart) — the die-wear number. */
  shots: number;
  /** Pieces produced (shots × cavities). */
  pieces: number;
  good: number;
  rejects: number;
  /** rejects ÷ pieces × 100, null when the die made nothing. */
  rejectPct: number | null;
  /** Reject quantity per defect code, value-descending. */
  rejByCode: Array<{ code: string; qty: number }>;
  /** Date (YYYY-MM-DD) of the most recent run in the window, '' if none. */
  lastRun: string;
  /** Open / in-progress maintenance requests against this die. */
  openRequests: number;
}

/** Reject-% traffic light for a die (same green/amber/red language as the
 *  KPI page): <2% healthy, 2-5% watch, >5% needs attention. */
export function dieHealth(rejectPct: number | null): 'green' | 'amber' | 'red' | '' {
  if (rejectPct == null) return '';
  if (rejectPct < 2) return 'green';
  if (rejectPct <= 5) return 'amber';
  return 'red';
}

/**
 * Join the die master to a window of production records and the
 * maintenance request list. Every die in the master is returned (a die
 * with zero runs still shows on the dashboard — that's the one someone
 * forgot about), sorted: open requests first, then reject-% desc, then
 * shots desc, so the dies needing attention float to the top.
 */
export function aggregateDies(
  dieColors: ProductDieColor[],
  records: ProductionRecord[],
  requests: DieMaintenanceRequest[],
): DieAgg[] {
  // Die master: die → parts. Rows without a DieNumber can't be tracked.
  const byDie = new Map<string, DieAgg>();
  const partToDie = new Map<string, string>();
  for (const c of dieColors) {
    const die = c.dieNumber.trim();
    if (!die) continue;
    partToDie.set(c.partNumber.trim().toUpperCase(), die);
    let agg = byDie.get(die);
    if (!agg) {
      agg = {
        dieNumber: die,
        parts: [],
        category: c.category,
        machines: [],
        runs: 0,
        shots: 0,
        pieces: 0,
        good: 0,
        rejects: 0,
        rejectPct: null,
        rejByCode: [],
        lastRun: '',
        openRequests: 0,
      };
      byDie.set(die, agg);
    }
    agg.parts.push({
      partNumber: c.partNumber,
      name: c.name,
      category: c.category,
      coRun: c.coRun,
    });
    if (!agg.category && c.category) agg.category = c.category;
  }

  // Usage: group records into (machine|shift|job) tuples first — counts
  // are canonical on slot 0, rejects sum across every slot — then charge
  // each tuple to its part's die.
  interface Tuple {
    die: string;
    machine: string;
    shiftId: string;
    shots: number;
    pieces: number;
    rejects: number;
    rejByCode: Map<string, number>;
  }
  const tuples = new Map<string, Tuple>();
  for (const r of records) {
    const die = partToDie.get((r.partNumber ?? '').trim().toUpperCase());
    if (!die) continue;
    const key = `${r.machineCode}|${r.shiftId}|${r.jobNumber}`;
    let t = tuples.get(key);
    if (!t) {
      t = {
        die,
        machine: r.machineCode,
        shiftId: r.shiftId,
        shots: 0,
        pieces: 0,
        rejects: 0,
        rejByCode: new Map(),
      };
      tuples.set(key, t);
    }
    if (r.slotIndex === 0 && r.countStart != null && r.countEnd != null) {
      t.shots = Math.max(0, r.countEnd - r.countStart);
      t.pieces = cavityGross(r.countStart, r.countEnd, r.cavities);
    }
    let obj: Record<string, number> = {};
    try {
      obj = r.rejects ? (JSON.parse(r.rejects) as Record<string, number>) : {};
    } catch {
      obj = {};
    }
    let slotRej = 0;
    for (const [code, v] of Object.entries(obj)) {
      const n = Number(v) || 0;
      if (n <= 0) continue;
      slotRej += n;
      t.rejByCode.set(code, (t.rejByCode.get(code) ?? 0) + n);
    }
    // Rows that predate the per-code JSON only carry rejectCount.
    if (slotRej === 0 && Number(r.rejectCount) > 0) {
      slotRej = Number(r.rejectCount);
      t.rejByCode.set('—', (t.rejByCode.get('—') ?? 0) + slotRej);
    }
    t.rejects += slotRej;
  }

  const rejMaps = new Map<string, Map<string, number>>();
  for (const t of tuples.values()) {
    const agg = byDie.get(t.die);
    if (!agg) continue;
    agg.runs++;
    agg.shots += t.shots;
    agg.pieces += t.pieces;
    agg.rejects += t.rejects;
    if (!agg.machines.includes(t.machine)) agg.machines.push(t.machine);
    const day = t.shiftId.slice(0, 10);
    if (day > agg.lastRun) agg.lastRun = day;
    const m = rejMaps.get(t.die) ?? new Map<string, number>();
    for (const [code, qty] of t.rejByCode) m.set(code, (m.get(code) ?? 0) + qty);
    rejMaps.set(t.die, m);
  }

  for (const agg of byDie.values()) {
    agg.good = Math.max(0, agg.pieces - agg.rejects);
    agg.rejectPct =
      agg.pieces > 0 ? +((agg.rejects / agg.pieces) * 100).toFixed(1) : null;
    agg.rejByCode = Array.from(rejMaps.get(agg.dieNumber) ?? [])
      .map(([code, qty]) => ({ code, qty }))
      .sort((a, b) => b.qty - a.qty);
    agg.machines.sort();
    agg.openRequests = requests.filter(
      (q) => q.dieNumber === agg.dieNumber && q.status !== 'done',
    ).length;
  }

  return Array.from(byDie.values()).sort((a, b) => {
    if ((a.openRequests > 0) !== (b.openRequests > 0))
      return a.openRequests > 0 ? -1 : 1;
    const ap = a.rejectPct ?? -1;
    const bp = b.rejectPct ?? -1;
    if (ap !== bp) return bp - ap;
    return b.shots - a.shots;
  });
}
