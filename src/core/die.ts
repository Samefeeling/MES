// Die (tool) usage & health — pure aggregation logic for the Trace page's
// 🛠 Die Management tab. No DOM: everything here is unit-testable.
//
// The die master lives in PMD_ProductDieColor (Die/DieNumber per Part #).
// Production usage is derived by joining PMD_Production records to that
// master via the denormalised partNumber each record carries. Maintenance
// requests live in PMD_DieMaintenance (see dal/sharepoint.ts) and will be
// mirrored into Mango later — MangoTicket on the request is the link slot.

import type {
  DieChangeLog,
  DieComponentCondition,
  DieMaintenanceRequest,
  PlanningOrder,
  ProductDieColor,
  ProductionCounterRecord,
  ProductionRecord,
  ToolMaintenanceLevel,
  ToolStatus,
} from '../types';
import { cavityGross } from './metrics';

// ---------------------------------------------------------------------
// Die-change condition report (PMD_DieChangeLog). The component keys ARE
// the SharePoint column names; labels are what the operator sees.

export const DIE_COMPONENTS: Array<{ key: string; label: string }> = [
  { key: 'Bolts', label: 'Bolts' },
  { key: 'Cores', label: 'Cores' },
  { key: 'EjectorPins', label: 'Ejector Pins' },
  { key: 'ElectricalIssues', label: 'Electrical Issues' },
  { key: 'GasNeedle', label: 'Gas Needle' },
  { key: 'GuidePins', label: 'Guide Pins' },
  { key: 'HotRunners', label: 'Hot Runners' },
  { key: 'MouldingSurfaces', label: 'Moulding Surfaces' },
  { key: 'Nozzle', label: 'Nozzle' },
  { key: 'NozzleTip', label: 'Nozzle Tip' },
  { key: 'OilLeaks', label: 'Oil Leaks' },
  { key: 'Venting', label: 'Venting' },
  { key: 'WaterLeaks', label: 'Water Leaks' },
];

/** Natural key for one continuous D/I block. The start slot is what makes
 *  two separate changes on the same machine/shift/job independent. */
export function dieChangeEventKey(
  machineCode: string,
  date: string,
  shift: string,
  jobNumber: string,
  eventStartSlot: number,
): string {
  const norm = (s: string): string => s.trim().toUpperCase();
  return `${norm(machineCode)}|${date}|${norm(shift)}|${norm(jobNumber)}|${Math.max(0, Math.floor(eventStartSlot))}`;
}

/** The EXACT choice strings on the list (note the curly apostrophe in
 *  "can’t" — SharePoint choice validation is literal). */
export const DIE_CONDITION_META: Record<
  Exclude<DieComponentCondition, ''>,
  { label: string; short: string; cls: string }
> = {
  good: { label: '1. Good work order', short: '1', cls: 'green' },
  worn: { label: '2. Operational but worn', short: '2', cls: 'amber' },
  damaged: { label: '3. Damaged or can’t be used', short: '3', cls: 'red' },
};

/** One component the setter rated worse than "1. Good work order". */
export interface DieConditionFlag {
  key: string;
  label: string;
  condition: 'worn' | 'damaged';
}

/** Toolroom summary of the LATEST die-change condition report filed
 *  against a die. The source can be either side of the event row: the die
 *  coming OUT or the die going IN. */
export interface DieConditionSummary {
  date: string;
  shift: string;
  machineCode: string;
  dieSetter: string;
  jobNumber: string;
  problemDescription: string;
  /** Components rated 2 (worn) / 3 (damaged), damaged first — anything
   *  here queues the die for priority service. Empty = all 13 good. */
  flags: DieConditionFlag[];
  /** Any component rated 3 — the die must surface as Problems. */
  hasDamaged: boolean;
}

/**
 * Latest condition report per die (from either the OUT or IN inspection,
 * key trimmed + uppercased). "Latest" is by report date, then createdAt — a newer
 * all-good report clears an older worn flag (the die was fixed or the
 * wear was re-judged), which is exactly how the toolroom reads it.
 */
export function latestConditionByDie(logs: DieChangeLog[]): Map<string, DieConditionSummary> {
  const sorted = [...logs].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  const out = new Map<string, DieConditionSummary>();
  const rank = (c: DieComponentCondition): number =>
    c === 'damaged' ? 3 : c === 'worn' ? 2 : c === 'good' ? 1 : 0;
  for (const l of sorted) {
    const reports = [
      {
        die: (l.dieNumberOut ?? '').trim().toUpperCase(),
        components: { ...(l.components ?? {}) },
        problem: l.problemDescription ?? '',
      },
      {
        die: (l.dieNumberIn ?? '').trim().toUpperCase(),
        components: { ...(l.componentsIn ?? {}) },
        problem: l.problemDescriptionIn ?? '',
      },
    ];
    // Insert changes can inspect the same physical die on both sides. Merge
    // those two inspections onto one worst-condition report instead of the
    // second side being discarded by the newest-first de-duplication.
    if (reports[0].die && reports[0].die === reports[1].die) {
      for (const c of DIE_COMPONENTS) {
        if (rank(reports[1].components[c.key]) > rank(reports[0].components[c.key]))
          reports[0].components[c.key] = reports[1].components[c.key];
      }
      if (reports[1].problem) {
        reports[0].problem = [reports[0].problem, reports[1].problem]
          .filter(Boolean)
          .join('\n');
      }
      reports.pop();
    }
    for (const report of reports) {
      const die = report.die;
      // An unfilled side is not an inspection and must not clear an older
      // real report. An explicit all-good assessment still counts because
      // its component values are non-empty and intentionally clear flags.
      const assessed =
        Object.values(report.components).some(Boolean) || report.problem.trim().length > 0;
      if (!die || !assessed || out.has(die)) continue; // first real hit = latest
      const flags: DieConditionFlag[] = [];
      for (const c of DIE_COMPONENTS) {
        const cond = report.components[c.key];
        if (cond === 'worn' || cond === 'damaged')
          flags.push({ key: c.key, label: c.label, condition: cond });
      }
      flags.sort((a, b) =>
        a.condition === b.condition ? 0 : a.condition === 'damaged' ? -1 : 1,
      );
      out.set(die, {
        date: l.date,
        shift: l.shift,
        machineCode: l.machineCode,
        dieSetter: l.dieSetter,
        jobNumber: l.jobNumber,
        problemDescription: report.problem,
        flags,
        hasDamaged: flags.some((f) => f.condition === 'damaged'),
      });
    }
  }
  return out;
}

/** Free text ("2. Operational but worn", "worn", "3") → condition. */
export function parseDieCondition(raw: string): DieComponentCondition {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('1') || s.includes('good')) return 'good';
  if (s.startsWith('2') || s.includes('worn')) return 'worn';
  if (s.startsWith('3') || s.includes('damag') || s.includes('cant') || s.includes('can’t') || s.includes("can't"))
    return 'damaged';
  return '';
}

/** Display metadata per ToolStatus. `rank` orders the Status column
 *  worst-first (Problems → To be Serviced → In service → Serviced) so a
 *  single click surfaces the tools that need eyes. `cls` is the CSS
 *  colour class (ts-red / ts-orange / ts-blue / ts-green). */
export const TOOL_STATUS_META: Record<ToolStatus, { label: string; cls: string; rank: number }> = {
  problems: { label: 'Problems', cls: 'ts-red', rank: 0 },
  'to-be-serviced': { label: 'To be Serviced', cls: 'ts-orange', rank: 1 },
  'in-service': { label: 'In service', cls: 'ts-blue', rank: 2 },
  serviced: { label: 'Serviced', cls: 'ts-green', rank: 3 },
};

/** Normalise a free-text PMD_DieMaster.ToolStatus cell onto the closed
 *  union — the list is edited by hand in SharePoint, so tolerate case,
 *  spaces, hyphens and a few synonyms. '' when empty / unrecognised. */
export function parseToolStatus(raw: string): ToolStatus | '' {
  const s = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  if (s.includes('problem') || s === 'issue' || s === 'issues' || s === 'broken') return 'problems';
  if (s.startsWith('tobe') || s.includes('needsservice') || s === 'due') return 'to-be-serviced';
  if (s.startsWith('inservice') || s === 'inuse' || s === 'running' || s === 'active') return 'in-service';
  if (s.startsWith('serviced') || s === 'ok' || s === 'good') return 'serviced';
  return '';
}

/** Aggregated usage + quality picture for one physical die. */
export interface DieAgg {
  dieNumber: string;
  /** Human name of the tool (PMD_ProductDieColor's `Die` column). */
  description: string;
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
  /** Reject quantity per defect code, value-descending. byStatus splits
   *  each code's quantity by the MACHINE STATUS letter of the slot that
   *  logged it (S = startup scrap, R = steady-state, …) so the code
   *  Pareto can show WHERE in the run each defect bites. */
  rejByCode: Array<{ code: string; qty: number; byStatus: Record<string, number> }>;
  /** Date (YYYY-MM-DD) of the most recent run in the window, '' if none. */
  lastRun: string;
  /** Open / in-progress maintenance requests against this die. */
  openRequests: number;
  /** Median shots per run (tuple) inside the window — the typical
   *  campaign size, for planning when a service window opens up. Null
   *  when the die never ran. */
  medianRunShots: number | null;
  /** Per-day usage inside the window, day-ascending — the raw series the
   *  defect-trend sparkline buckets (see buildDieTrend) and the service
   *  counter read. Days with no production simply don't appear here.
   *  rejByStatus splits the day's rejects by the MACHINE STATUS of the
   *  slot that logged them (S = startup scrap, R = steady-state, …). */
  daily: Array<{
    day: string;
    rejects: number;
    pieces: number;
    shots: number;
    rejByStatus: Record<string, number>;
  }>;
  /** Most recent die-change event charged to this die inside the window:
   *  slots with status 'D' on a run of one of the die's parts. `slots` ×
   *  30 min = how long the change took. Null = none in the window. */
  lastDieChange: {
    day: string;
    shift: string;
    machine: string;
    jobNumber: string;
    slots: number;
  } | null;
}

// ---------------------------------------------------------------------
// Moulding-tool preventive maintenance. This is a dual-trigger policy:
// calendar age catches low-use tools whose seals/lubrication still age,
// while press-cycle count catches high-use tools early. Whichever limit
// is reached first governs. Level B is the site default for legacy rows;
// a latest Die Change Log rating of 2/3 forces the effective rule to C.

export interface ToolMaintenanceRule {
  level: ToolMaintenanceLevel;
  label: string;
  months: number;
  shots: number;
}

export const TOOL_MAINTENANCE_RULES: Record<ToolMaintenanceLevel, ToolMaintenanceRule> = {
  A: { level: 'A', label: 'Annual / 50,000 shots', months: 12, shots: 50_000 },
  B: { level: 'B', label: 'Quarterly / 15,000 shots', months: 3, shots: 15_000 },
  C: { level: 'C', label: 'Monthly / 5,000 shots', months: 1, shots: 5_000 },
};

export const DEFAULT_TOOL_MAINTENANCE_LEVEL: ToolMaintenanceLevel = 'B';

/** Free text ("Level B", "b", "Quarterly") → the closed A/B/C union. */
export function parseToolMaintenanceLevel(raw: string): ToolMaintenanceLevel | '' {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  if (/^(?:level\s*)?a$/.test(s) || s.includes('annual')) return 'A';
  if (/^(?:level\s*)?b$/.test(s) || s.includes('quarter')) return 'B';
  if (/^(?:level\s*)?c$/.test(s) || s.includes('month')) return 'C';
  return '';
}

/** Minimal per-die shot ledger used by the service counter. */
export interface DieServiceUsage {
  dieNumber: string;
  daily: Array<{ day: string; shots: number }>;
}

/** Join canonical production counters to Part → Die and collapse them to
 *  one daily shot total per physical tool. Tuple de-duplication prevents
 *  a signed header plus a live mirror from double-counting wear. */
export function aggregateDieServiceUsage(
  dieColors: ProductDieColor[],
  records: ProductionCounterRecord[],
): Map<string, DieServiceUsage> {
  const partToDie = new Map<string, { key: string; display: string }>();
  for (const c of dieColors) {
    const display = c.dieNumber.trim();
    if (!display || !c.partNumber.trim()) continue;
    partToDie.set(c.partNumber.trim().toUpperCase(), {
      key: display.toUpperCase(),
      display,
    });
  }
  const tuples = new Map<string, { dieKey: string; display: string; day: string; shots: number }>();
  for (const r of records) {
    const die = partToDie.get(r.partNumber.trim().toUpperCase());
    const day = r.shiftId.slice(0, 10);
    if (!die || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const shots =
      r.countStart == null || r.countEnd == null
        ? 0
        : Math.max(0, r.countEnd - r.countStart);
    const tupleKey = `${die.key}|${r.machineCode.trim().toUpperCase()}|${r.shiftId}|${r.jobNumber.trim().toUpperCase()}`;
    // A tuple should be canonical already; max is a defensive choice for
    // duplicate snapshots of the same growing counter, never a sum.
    const prev = tuples.get(tupleKey);
    if (!prev || shots >= prev.shots)
      tuples.set(tupleKey, { dieKey: die.key, display: die.display, day, shots });
  }
  const dailyByDie = new Map<string, Map<string, number>>();
  const displayByDie = new Map<string, string>();
  for (const t of tuples.values()) {
    displayByDie.set(t.dieKey, t.display);
    const days = dailyByDie.get(t.dieKey) ?? new Map<string, number>();
    days.set(t.day, (days.get(t.day) ?? 0) + t.shots);
    dailyByDie.set(t.dieKey, days);
  }
  return new Map(
    [...dailyByDie.entries()].map(([key, days]) => [
      key,
      {
        dieNumber: displayByDie.get(key) ?? key,
        daily: [...days.entries()]
          .map(([day, shots]) => ({ day, shots }))
          .sort((a, b) => (a.day < b.day ? -1 : 1)),
      },
    ]),
  );
}

export interface DieServiceStatus {
  /** Shots accumulated since the last COMPLETED maintenance (or since
   *  the first available ledger day when never serviced). */
  shotsSince: number;
  /** Day the counter starts from (YYYY-MM-DD) and why. */
  since: string;
  sinceIsService: boolean;
  /** Level saved on PMD_DieMaster (or B for a legacy blank). */
  configuredLevel: ToolMaintenanceLevel;
  /** Effective policy. A worn/damaged latest inspection forces C. */
  maintenanceLevel: ToolMaintenanceLevel;
  conditionTriggered: boolean;
  intervalShots: number;
  intervalMonths: number;
  dueDate: string;
  /** Independent progress against the two OR limits. */
  shotPct: number;
  timePct: number;
  /** max(shotPct, timePct): whichever trigger is closest governs. */
  pct: number;
  level: 'ok' | 'soon' | 'due';
}

function localIsoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Calendar-month addition with month-end clamping (31 Jan + 1 month =
 *  28/29 Feb), evaluated in UTC so DST cannot move the due date. */
function addCalendarMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return target.toISOString().slice(0, 10);
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Where a die sits against its dual-trigger preventive-maintenance rule.
 * The counter resets at the most recent SERVICE EVENT — the newer of the
 * last DONE work order's closed date and PMD_DieMaster.LastServiceDate.
 * Date-only production on that SAME day is deliberately included: PMD has
 * no service timestamp, so excluding the whole day silently lost valid
 * post-service production (the Die #280 case). Dies with no service on
 * record count from the first ledger day and are labelled "at least".
 */
export function dieServiceStatus(
  agg: { dieNumber: string; daily: Array<{ day: string; shots: number }> },
  requests: DieMaintenanceRequest[],
  lastServiceDate?: string,
  configuredLevel: ToolMaintenanceLevel | '' = DEFAULT_TOOL_MAINTENANCE_LEVEL,
  conditionTriggered = false,
  today = localIsoDay(new Date()),
): DieServiceStatus | null {
  const dieKey = agg.dieNumber.trim().toUpperCase();
  const lastDone = requests
    .filter((r) => r.dieNumber.trim().toUpperCase() === dieKey && r.status === 'done' && r.closedAt)
    .map((r) => r.closedAt.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .pop();
  const masterDay = lastServiceDate?.slice(0, 10) || '';
  const master = /^\d{4}-\d{2}-\d{2}$/.test(masterDay) ? masterDay : undefined;
  const lastService =
    lastDone && master ? (lastDone > master ? lastDone : master) : lastDone ?? master;
  const firstProduction = [...agg.daily]
    .map((d) => d.day)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()[0];
  const since = lastService ?? firstProduction;
  if (!since) return null;
  const shotsSince = agg.daily
    // Include the service calendar day conservatively because the source
    // stores only a date, not the time the tool returned to production.
    .filter((d) => !lastService || d.day >= lastService)
    .reduce((a, d) => a + d.shots, 0);
  const savedLevel = configuredLevel || DEFAULT_TOOL_MAINTENANCE_LEVEL;
  const maintenanceLevel: ToolMaintenanceLevel = conditionTriggered ? 'C' : savedLevel;
  const rule = TOOL_MAINTENANCE_RULES[maintenanceLevel];
  const dueDate = addCalendarMonths(since, rule.months);
  const shotPct = shotsSince / rule.shots;
  const startMs = dayMs(since);
  const dueMs = dayMs(dueDate);
  const nowMs = dayMs(today);
  const timePct =
    Number.isFinite(startMs) && Number.isFinite(dueMs) && dueMs > startMs
      ? Math.max(0, (nowMs - startMs) / (dueMs - startMs))
      : 0;
  const pct = Math.max(shotPct, timePct);
  return {
    shotsSince,
    since,
    sinceIsService: !!lastService,
    configuredLevel: savedLevel,
    maintenanceLevel,
    conditionTriggered,
    intervalShots: rule.shots,
    intervalMonths: rule.months,
    dueDate,
    shotPct,
    timePct,
    pct,
    level: pct >= 1 ? 'due' : pct >= 0.8 ? 'soon' : 'ok',
  };
}

/** One bar of the defect-trend sparkline. */
export interface DieTrendBucket {
  /** First day of the bucket (YYYY-MM-DD). Daily buckets = the day. */
  day: string;
  /** Days the bucket spans (1 = daily, 7 = weekly). */
  span: number;
  rejects: number;
  pieces: number;
  /** Rejects split by the machine status of the slot that logged them
   *  (letter → qty). Distinguishes startup scrap (S/D) from steady-state
   *  (R) rejects at a glance. */
  rejByStatus: Record<string, number>;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Expand a die's sparse per-day series into a CONTINUOUS bucket series
 * across [from, to] — gaps become zero buckets so the sparkline's x-axis
 * is real time and a worsening defect trend reads left-to-right at a
 * glance. Windows ≤ 35 days bucket daily; longer windows bucket weekly
 * so 90 days still fits in a table cell.
 */
export function buildDieTrend(
  daily: Array<{ day: string; rejects: number; pieces: number; rejByStatus?: Record<string, number> }>,
  from: string,
  to: string,
): DieTrendBucket[] {
  if (!from || !to || from > to) return [];
  const days =
    Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000) + 1;
  const span = days <= 35 ? 1 : 7;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: DieTrendBucket[] = [];
  for (let start = from; start <= to; start = addDays(start, span)) {
    const b: DieTrendBucket = { day: start, span, rejects: 0, pieces: 0, rejByStatus: {} };
    for (let i = 0; i < span; i++) {
      const d = byDay.get(addDays(start, i));
      if (d) {
        b.rejects += d.rejects;
        b.pieces += d.pieces;
        for (const [st, q] of Object.entries(d.rejByStatus ?? {}))
          b.rejByStatus[st] = (b.rejByStatus[st] ?? 0) + q;
      }
    }
    out.push(b);
  }
  return out;
}

/** The die's place in the production schedule. */
export interface DiePlanned {
  /** Planned start (JobHead_StartDate + StartHour, local ISO). */
  start: string;
  jobNumber: string;
  machineCode: string;
  /** True when the order's planned window covers `now` — the die is
   *  scheduled to be IN the press right now. */
  running: boolean;
}

/**
 * Good pieces produced per job number, from production records — slot-0
 * canonical counts × cavities, minus rejects charged across the shift.
 * Used to tell whether a planned order is already FINISHED (good ≥ order
 * qty) so the Scheduled column doesn't keep showing a completed order as
 * "running now". Pure + testable.
 */
export function goodByJob(records: ProductionRecord[]): Map<string, number> {
  const pieces = new Map<string, number>();
  const rejects = new Map<string, number>();
  for (const r of records) {
    const job = (r.jobNumber ?? '').trim();
    if (!job) continue;
    if (r.slotIndex === 0 && r.countStart != null && r.countEnd != null) {
      pieces.set(job, (pieces.get(job) ?? 0) + cavityGross(r.countStart, r.countEnd, r.cavities));
    }
    let slotRej = 0;
    try {
      const obj = r.rejects ? (JSON.parse(r.rejects) as Record<string, number>) : {};
      for (const v of Object.values(obj)) slotRej += Number(v) || 0;
    } catch {
      /* pre-JSON row — fall back to rejectCount below */
    }
    if (slotRej === 0 && Number(r.rejectCount) > 0) slotRej = Number(r.rejectCount);
    if (slotRej > 0) rejects.set(job, (rejects.get(job) ?? 0) + slotRej);
  }
  const good = new Map<string, number>();
  for (const [job, p] of pieces) good.set(job, Math.max(0, p - (rejects.get(job) ?? 0)));
  return good;
}

/**
 * Is this die scheduled for production? Finds the die's parts in
 * PMD_Planning (which only carries in-progress / upcoming Epicor orders)
 * and returns the order that matters for maintenance planning: the one
 * running now, else the next one to start. Null = not on the schedule —
 * a safe window to pull the die for service.
 *
 * `isComplete` (optional) lets the caller drop orders that PMD shows as
 * already finished (good ≥ qty) even though Epicor hasn't yet removed
 * them from the plan — so a completed order stops reading "▶ Now" and
 * the die correctly shows the next order, or Free.
 */
export function nextPlannedFor(
  dieParts: string[],
  orders: PlanningOrder[],
  now: Date,
  isComplete?: (o: PlanningOrder) => boolean,
): DiePlanned | null {
  const parts = new Set(dieParts.map((p) => p.trim().toUpperCase()));
  const nowMs = now.getTime();
  const mine = orders.filter(
    (o) =>
      !o.isDieChange &&
      o.plannedStart &&
      parts.has(o.partNumber.trim().toUpperCase()) &&
      // Skip orders whose planned window is fully behind us; keep ones
      // still running (end in the future) or not started yet.
      (!o.plannedEnd || new Date(o.plannedEnd).getTime() >= nowMs) &&
      // Skip orders PMD already reports as fully produced.
      !(isComplete?.(o) ?? false),
  );
  if (mine.length === 0) return null;
  mine.sort(
    (a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime(),
  );
  // Prefer an order actually covering `now`; otherwise the soonest start.
  const running = mine.find((o) => new Date(o.plannedStart).getTime() <= nowMs);
  const pick = running ?? mine[0];
  return {
    start: pick.plannedStart,
    jobNumber: pick.jobNumber,
    machineCode: pick.machineCode,
    running: !!running,
  };
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
        description: c.die,
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
        medianRunShots: null,
        daily: [],
        lastDieChange: null,
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
    if (!agg.description && c.die) agg.description = c.die;
  }

  // Usage: group records into (machine|shift|job) tuples first — counts
  // are canonical on slot 0, rejects sum across every slot — then charge
  // each tuple to its part's die.
  interface Tuple {
    die: string;
    machine: string;
    shiftId: string;
    jobNumber: string;
    shots: number;
    pieces: number;
    rejects: number;
    /** code → status letter → qty (the slot's status when it was logged). */
    rejByCode: Map<string, Map<string, number>>;
    /** Reject qty per machine-status letter of the slot that logged it. */
    rejByStatus: Map<string, number>;
    /** Slots this tuple spent on status 'D' (Die Change), 30 min each. */
    dieChangeSlots: number;
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
        jobNumber: r.jobNumber,
        shots: 0,
        pieces: 0,
        rejects: 0,
        rejByCode: new Map(),
        rejByStatus: new Map(),
        dieChangeSlots: 0,
      };
      tuples.set(key, t);
    }
    if (r.statusCode === 'D') t.dieChangeSlots++;
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
    // Charge each code's rejects to the slot's machine status — S(tartup)
    // scrap and R(unning) scrap have very different fixes.
    const st = r.statusCode || '·';
    const charge = (code: string, n: number) => {
      const cm = t!.rejByCode.get(code) ?? new Map<string, number>();
      cm.set(st, (cm.get(st) ?? 0) + n);
      t!.rejByCode.set(code, cm);
    };
    let slotRej = 0;
    for (const [code, v] of Object.entries(obj)) {
      const n = Number(v) || 0;
      if (n <= 0) continue;
      slotRej += n;
      charge(code, n);
    }
    // Rows that predate the per-code JSON only carry rejectCount.
    if (slotRej === 0 && Number(r.rejectCount) > 0) {
      slotRej = Number(r.rejectCount);
      charge('—', slotRej);
    }
    t.rejects += slotRej;
    if (slotRej > 0) t.rejByStatus.set(st, (t.rejByStatus.get(st) ?? 0) + slotRej);
  }

  const rejMaps = new Map<string, Map<string, Map<string, number>>>();
  const dayMaps = new Map<
    string,
    Map<string, { rejects: number; pieces: number; shots: number; rejByStatus: Record<string, number> }>
  >();
  const runShots = new Map<string, number[]>();
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
    if (t.dieChangeSlots > 0 && (!agg.lastDieChange || day > agg.lastDieChange.day)) {
      agg.lastDieChange = {
        day,
        shift: t.shiftId.slice(11),
        machine: t.machine,
        jobNumber: t.jobNumber,
        slots: t.dieChangeSlots,
      };
    }
    const m = rejMaps.get(t.die) ?? new Map<string, Map<string, number>>();
    for (const [code, sm] of t.rejByCode) {
      const cm = m.get(code) ?? new Map<string, number>();
      for (const [st, q] of sm) cm.set(st, (cm.get(st) ?? 0) + q);
      m.set(code, cm);
    }
    rejMaps.set(t.die, m);
    const dm =
      dayMaps.get(t.die) ??
      new Map<string, { rejects: number; pieces: number; shots: number; rejByStatus: Record<string, number> }>();
    const cell = dm.get(day) ?? { rejects: 0, pieces: 0, shots: 0, rejByStatus: {} };
    cell.rejects += t.rejects;
    cell.pieces += t.pieces;
    cell.shots += t.shots;
    for (const [st, q] of t.rejByStatus) cell.rejByStatus[st] = (cell.rejByStatus[st] ?? 0) + q;
    dm.set(day, cell);
    dayMaps.set(t.die, dm);
    if (t.shots > 0) {
      const arr = runShots.get(t.die) ?? [];
      arr.push(t.shots);
      runShots.set(t.die, arr);
    }
  }

  for (const agg of byDie.values()) {
    agg.good = Math.max(0, agg.pieces - agg.rejects);
    agg.rejectPct =
      agg.pieces > 0 ? +((agg.rejects / agg.pieces) * 100).toFixed(1) : null;
    agg.rejByCode = Array.from(rejMaps.get(agg.dieNumber) ?? [])
      .map(([code, sm]) => {
        const byStatus: Record<string, number> = {};
        let qty = 0;
        for (const [st, q] of sm) {
          byStatus[st] = q;
          qty += q;
        }
        return { code, qty, byStatus };
      })
      .sort((a, b) => b.qty - a.qty);
    agg.machines.sort();
    // Normalised match — the Mango mirror carries bare numbers ("280")
    // that must join PMD_ProductDieColor's DieNumber however it's typed.
    agg.openRequests = requests.filter(
      (q) =>
        q.dieNumber.trim().toUpperCase() === agg.dieNumber.trim().toUpperCase() &&
        q.status !== 'done',
    ).length;
    agg.daily = Array.from(dayMaps.get(agg.dieNumber) ?? [])
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    const runs = (runShots.get(agg.dieNumber) ?? []).sort((a, b) => a - b);
    agg.medianRunShots =
      runs.length === 0
        ? null
        : runs.length % 2
          ? runs[(runs.length - 1) / 2]
          : Math.round((runs[runs.length / 2 - 1] + runs[runs.length / 2]) / 2);
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
