import type { PmdDataLayer } from '../dal';
import type {
  Machine,
  ParetoSlice,
  PlanningOrder,
  ProductionRecord,
  ShiftCode,
  StatusCode,
} from '../types';
import { aggregate, countSetupEvents, type Kpi } from '../core/metrics';
import {
  COLOR_CHANGE_STD_HRS,
  DIE_CHANGE_STD_HRS,
  INSERT_CHANGE_STD_HRS,
  expectedShiftOutput,
  expectedShiftOutputFromPlanning,
  expectedShiftOutputFromTargets,
  setupJudgement,
  setupStandardHours,
} from '../core/standards';
import {
  currentShift,
  dateKey,
  parseShiftId,
  previousShift,
  shiftBounds,
  slotTimeRange,
  SHIFTS,
} from '../core/shifts';
import { closeModal, escapeHtml, openModal } from './modal';
import { toast } from './toast';
import {
  renderBoxPlotChart,
  renderHoursOeeChart,
  renderOutputByShiftChart,
  renderParetoByShiftChart,
  renderParetoChart,
  type BoxSeries,
} from './charts';
import {
  collectChangeoverEvents,
  dieChangeoverMedians,
  CHANGEOVER_LABELS,
  type ChangeoverEvent,
  type ChangeoverKind,
} from '../core/changeover';
import {
  monthOf,
  monthLabel,
  rollUpByMonth,
  spansMonths,
  type ChartBucket as CoreChartBucket,
  type DisplayBucket,
} from '../core/chartrollup';
import { parseHandover } from '../core/handover';
import { STATUS_MAP } from '../core/status';
import { isSupervisor } from './supervisor-auth';
import {
  mountTracePanel,
  renderJobTraceCards,
  unmountTracePanel,
  type TracePanelView,
} from './trace';

/**
 * The hot-stamping ("Hstamp") press is a distinct secondary process, so its
 * output is broken out as its own category subtotal in the KPI TOTAL block
 * rather than lumped into "Other". Matches on machine code OR display name,
 * normalised (lower-cased, spaces / hyphens / underscores stripped) so it
 * works whichever the tenant used — "Hstamp", "HStamp", "Hot Stamp",
 * "Hot-Stamping". The demo "HS" (High-Speed Press) deliberately does NOT
 * match: neither "hshighspeedpress" contains "hstamp" nor "hotstamp".
 */
export function isHotStampMachine(m: Pick<Machine, 'machineCode' | 'displayName'>): boolean {
  const norm = `${m.machineCode} ${m.displayName}`.toLowerCase().replace(/[\s_-]/g, '');
  return norm.includes('hstamp') || norm.includes('hotstamp');
}

// Per-metric green / amber colour thresholds for the KPI table. Editable
// by a signed-in supervisor (the floor tunes them per plant); persisted
// per-browser in localStorage. A value ≥ green → green, ≥ amber → amber,
// else red.
interface KpiThresholds {
  effGreen: number;
  effAmber: number;
  yieldGreen: number;
  yieldAmber: number;
  /** Output vs planning-expected output (core/standards.ts), and the
   *  "vs Plan" column. Blue at/above planBlue %, amber at/above planAmber
   *  %, red below. */
  planBlue: number;
  planAmber: number;
}

const DEFAULT_THRESHOLDS: KpiThresholds = {
  effGreen: 85,
  effAmber: 70,
  yieldGreen: 98,
  yieldAmber: 95,
  planBlue: 95,
  planAmber: 80,
};

const THRESHOLDS_KEY = 'pmd.kpiThresholds';

function loadThresholds(): KpiThresholds {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    const parsed = JSON.parse(raw) as Partial<KpiThresholds>;
    // Merge over defaults so a partial / older blob never yields NaN.
    return { ...DEFAULT_THRESHOLDS, ...parsed };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function saveThresholds(t: KpiThresholds): void {
  try {
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(t));
  } catch {
    /* private mode — keep the in-memory copy, just don't persist */
  }
}

// Management KPI view (`#/kpi`) for daily / weekly / monthly meetings.
// Per-machine OEE, output, reject, run/down/setup hours, plus a per-shift
// breakdown (Day / Afternoon / Night) under each machine row.

type PeriodKey = 'last3' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'custom';
type KpiPageView = 'metrics' | TracePanelView;

// Two presets the meetings actually use; any other window is picked
// directly on the always-visible From/To inputs (which is what 'custom'
// is now — no tab). periodRange still understands the removed keys, so
// nothing breaks if one comes back.
const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'last3', label: 'Last 24h' },
  { key: 'thisWeek', label: 'This Week' },
];

const SHIFT_ORDER: ShiftCode[] = SHIFTS.map((s) => s.code);

export interface HandoverEntry {
  jobNumber: string;
  shiftId: string;
  machine: string;
  mold: string;
  material: string;
  method: string;
}

interface ShiftAgg {
  output: number;
  reject: number;
  yieldPct: number;
  runHrs: number;
  downHrs: number;
  setupHrs: number;
  dieHrs: number;
  colorHrs: number;
  insertHrs: number;
  /** S slots × 0.5h — warm-up, its own column next to Down h. */
  startupHrs: number;
  /** Distinct shifts rolled into this slice, so Reject can be judged per
   *  shift rather than against a total whose size depends on how wide the
   *  row is. */
  shifts: number;
  oee: number | null;
  /** Planning-driven expected good pieces (see core/standards.ts). null =
   *  not computed for this slice (job rows / category rows) or no cycle
   *  time anywhere in it — the Output cell stays uncoloured. */
  expOutput: number | null;
  /** Standard changeover allowances (changeovers × standard duration,
   *  one changeover per order — see countSetupEvents).
   *  null = not computed for this slice; numbers colour the Die / Colour /
   *  Insert hour cells red-amber-blue against the actuals. */
  dieStdHrs: number | null;
  colorStdHrs: number | null;
  insertStdHrs: number | null;
}

interface JobAgg {
  jobNumber: string;
  partDescShort: string;
  color: ColorTag;
  agg: ShiftAgg;
  /** Epoch ms the order last came off the press inside the window; null
   *  when it has no slot with a status. Orders are listed by this. */
  lastRunAt: number | null;
}

interface ColorTag {
  name: string;
  /** CSS colour for the swatch; '' = let CSS pick the neutral. */
  hex: string;
  neutral: boolean;
}

/**
 * Match a colour word in a part description so the KPIs can show a swatch
 * + label per job. Order matters — compound names (e.g. "Navy", "Charcoal")
 * must come before their generic root ("Blue", "Black") otherwise the
 * generic eats the match. Hex values pick legible-on-white swatches.
 */
const COLOR_KEYWORDS: Array<{ kw: RegExp; name: string; hex: string }> = [
  { kw: /\bcharcoal\b/i, name: 'Charcoal', hex: '#374151' },
  { kw: /\bgraphite\b/i, name: 'Graphite', hex: '#4b5563' },
  { kw: /\bivory\b/i, name: 'Ivory', hex: '#f5e7c4' },
  { kw: /\bcream\b/i, name: 'Cream', hex: '#fff4d6' },
  { kw: /\bbeige\b/i, name: 'Beige', hex: '#e6d3a3' },
  { kw: /\btan\b/i, name: 'Tan', hex: '#d2b48c' },
  { kw: /\bnavy\b/i, name: 'Navy', hex: '#14467c' },
  { kw: /\bsky\b/i, name: 'Sky', hex: '#7dd3fc' },
  { kw: /\bturquoise\b/i, name: 'Turquoise', hex: '#06b6d4' },
  { kw: /\bteal\b/i, name: 'Teal', hex: '#0d9488' },
  { kw: /\bcyan\b/i, name: 'Cyan', hex: '#22d3ee' },
  { kw: /\bblue\b/i, name: 'Blue', hex: '#2563eb' },
  { kw: /\bmaroon\b/i, name: 'Maroon', hex: '#7f1d1d' },
  { kw: /\bburgundy\b/i, name: 'Burgundy', hex: '#9b1c31' },
  { kw: /\bcrimson\b/i, name: 'Crimson', hex: '#dc2626' },
  { kw: /\bscarlet\b/i, name: 'Scarlet', hex: '#ef4444' },
  { kw: /\bred\b/i, name: 'Red', hex: '#dc2626' },
  { kw: /\borange\b/i, name: 'Orange', hex: '#f97316' },
  { kw: /\bamber\b/i, name: 'Amber', hex: '#f59e0b' },
  { kw: /\byellow\b/i, name: 'Yellow', hex: '#eab308' },
  { kw: /\blime\b/i, name: 'Lime', hex: '#84cc16' },
  { kw: /\bolive\b/i, name: 'Olive', hex: '#65a30d' },
  { kw: /\bgreen\b/i, name: 'Green', hex: '#16a34a' },
  { kw: /\bmagenta\b/i, name: 'Magenta', hex: '#d946ef' },
  { kw: /\bviolet\b/i, name: 'Violet', hex: '#7c3aed' },
  { kw: /\bpurple\b/i, name: 'Purple', hex: '#9333ea' },
  { kw: /\bindigo\b/i, name: 'Indigo', hex: '#4338ca' },
  { kw: /\bpink\b/i, name: 'Pink', hex: '#ec4899' },
  { kw: /\bbrown\b/i, name: 'Brown', hex: '#92400e' },
  { kw: /\bchocolate\b/i, name: 'Chocolate', hex: '#7c2d12' },
  { kw: /\bblack\b/i, name: 'Black', hex: '#111827' },
  { kw: /\bwhite\b/i, name: 'White', hex: '#f9fafb' },
  { kw: /\bsilver\b/i, name: 'Silver', hex: '#cbd5e1' },
  { kw: /\bgold\b/i, name: 'Gold', hex: '#d4af37' },
  { kw: /\b(grey|gray)\b/i, name: 'Grey', hex: '#6b7280' },
];

function detectColor(desc: string): ColorTag {
  if (desc) {
    for (const c of COLOR_KEYWORDS) {
      if (c.kw.test(desc)) return { name: c.name, hex: c.hex, neutral: false };
    }
  }
  return { name: 'neutral', hex: '', neutral: true };
}

/**
 * PMD_ProductDieColor (per-Part # die / paint hex) wins over the
 * keyword scan above. The list captures the authoritative shop-floor
 * colour where the description text might be ambiguous ("Postura
 * Standard" doesn't say what colour it is). Keyword fallback covers
 * parts that aren't in the list yet.
 */
function colorForJob(
  partNumber: string,
  desc: string,
  dieColors: Map<string, { hex: string; name: string }>,
): ColorTag {
  // Lookup is keyed by upper-trim Part # so case / whitespace drift
  // between PMD_ProductDieColor and the production / planning sources
  // can't drop the match.
  const direct = partNumber ? dieColors.get(partNumber.trim().toUpperCase()) : undefined;
  if (direct?.hex) {
    return { name: direct.name || direct.hex, hex: direct.hex, neutral: false };
  }
  return detectColor(desc);
}

interface KpiRow {
  machineCode: string;
  /** One period-wide Handover collection for this machine. Handover is
   *  intentionally not part of ShiftAgg: carrying it through every metric
   *  aggregation made the same note appear on machine, shift, order, job,
   *  and category rows. */
  handovers: HandoverEntry[];
  total: ShiftAgg;
  byShift: Record<ShiftCode, ShiftAgg>;
  /** Per (shift, job) breakdown for the 3rd-level expansion. */
  jobsByShift: Record<ShiftCode, JobAgg[]>;
  /** Per-Job# rollup across every shift in the selected period — drives
   *  the "> Orders" toggle on the machine row. Sorted by output desc. */
  byJobTotal: JobAgg[];
}

interface KpiState {
  /** KPI periods plus the two operational panels moved from Trace. */
  view: KpiPageView;
  period: PeriodKey;
  /** Custom range bounds (YYYY-MM-DD), used only when period === 'custom'.
   *  Default to a sensible last-7-days window so the first render isn't
   *  empty. */
  customFrom: string;
  customTo: string;
  /** Editable colour thresholds (supervisor-tunable, localStorage). */
  thresholds: KpiThresholds;
  machines: Machine[];
  loading: boolean;
  rows: KpiRow[];
  chartBuckets: ChartBucket[];
  /** YYYY-MM of the rolled-up months the user has opened to daily bars.
   *  Only consulted when the range crosses a month boundary; the newest
   *  month in the range is always daily and never appears here. Shared by
   *  both trend charts — they are two readings of the same days, and
   *  letting them disagree would just invite comparing May against
   *  15 May. */
  expandedMonths: Set<string>;
  /** Machine codes whose shift sub-rows are hidden. */
  collapsed: Set<string>;
  /** "${mc}|${shiftCode}" pairs whose Job#+Part rows are revealed. Default
   *  collapsed so the table stays compact; the operator clicks the row's
   *  ▸ chevron to drill into the per-job split. */
  jobsExpanded: Set<string>;
  /** Machine codes whose per-Job# (across shifts) rollup is revealed —
   *  toggled by the > chevron on the machine row, independent of the
   *  shift breakdown. */
  ordersExpanded: Set<string>;
  /** Floor-wide totals split by PMD_ProductDieColor.Category (e.g.
   *  "Battens"), rendered as subtotal rows above the grand TOTAL.
   *  Parts without a category land in "Other". */
  catTotals: Array<{ category: string; agg: ShiftAgg }>;
  /** Reject quantity per RejectCode, sliced floor-wide and per machine.
   *  Quantity + shift come directly from PMD_Rejects; the human label is
   *  resolved by RejectCode from PMD_RejectCategories. RejectCategory on
   *  the event row is preserved separately as MachineStatus context so R
   *  rejects can be distinguished from Startup/changeover scrap. Sorted
   *  value-descending. */
  rejectPareto: { floor: ParetoSlice[]; byMachine: Map<string, ParetoSlice[]> };
  /** Breakdown downtime hours per BDCode, sliced the same way. Sourced
   *  from PMD_BreakDownlog (label = breakdown cause from the taxonomy). */
  downtimePareto: { floor: ParetoSlice[]; byMachine: Map<string, ParetoSlice[]> };
  /** Reject code → human description (PMD_RejectCategories, e.g. D01 →
   *  "ShortShot"), so the Reject drill spells the codes out. */
  rejectDescByCode: Map<string, string>;
  /** Every D/C/I changeover and B breakdown in the window, floor-wide.
   *  Feeds the supervisor-only duration box plot. */
  changeoverEvents: ChangeoverEvent[];
  /** jobNumber → DieNumber, resolved order → part → PMD_ProductDieColor.
   *  Lets a die change be attributed to the tool it fitted. */
  dieByJob: Map<string, string>;
  /** Failed reads for the current computation. Values from successful
   *  sources still render, but the banner stops missing rows being read as
   *  real zero production/reject/downtime. */
  errors: string[];
  catalogErrors: string[];
}

// ChartBucket now lives in core/chartrollup.ts — the month rollup owns the
// shape it aggregates. Re-exported here so the rest of this file reads the
// same as before.
type ChartBucket = CoreChartBucket;

let S: KpiState | null = null;
let dalRef: PmdDataLayer;
let computeVersion = 0;

/** The 3 most-recently-ENDED shifts as of `now`, oldest → newest. */
function lastThreeShifts(now: Date): string[] {
  const out: string[] = [];
  let sid: string | null = currentShift(now).shiftId;
  for (let i = 0; i < 3 && sid; i++) {
    sid = previousShift(sid);
    if (sid) out.unshift(sid);
  }
  return out;
}

function periodRange(
  key: PeriodKey,
  now: Date,
): { from: Date; to: Date; label: string; shiftIds?: Set<string> } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (key === 'custom') {
    const fromStr = S?.customFrom || dateKey(d);
    const toStr = S?.customTo || dateKey(d);
    return {
      from: new Date(fromStr + 'T00:00:00'),
      to: new Date(toStr + 'T23:59:59'),
      label: `${fromStr} → ${toStr}`,
    };
  }
  if (key === 'last3') {
    const ids = lastThreeShifts(now);
    const dates = ids.map((s) => s.slice(0, 10)).sort();
    const from = new Date(dates[0] + 'T00:00:00');
    const to = new Date(dates[dates.length - 1] + 'T23:59:59');
    // Weekend bridge: the last 3 completed shifts on a Monday are all
    // Sunday's — and an idle weekend makes that an empty window. Walk
    // `from` back over any Saturday / Sunday so Monday's "Last 24h"
    // reaches the previous Friday and shows the last working day's
    // output (Fri → Sun) instead of empty Sunday cells. Switch to a
    // date-range match (drop shiftIds) so the bridged weekend days are
    // included; on a normal weekday from===to so it's equivalent to the
    // exact 3-shift set.
    let bridged = false;
    while (from.getDay() === 0 || from.getDay() === 6) {
      from.setDate(from.getDate() - 1);
      bridged = true;
    }
    if (bridged) {
      return {
        from,
        to,
        label: `Last working day (${dateKey(from)} → ${dateKey(to)})`,
      };
    }
    return {
      from,
      to,
      label: `Last 3 completed shifts (${ids[0]} → ${ids[ids.length - 1]})`,
      shiftIds: new Set(ids),
    };
  }
  if (key === 'thisWeek' || key === 'lastWeek') {
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    if (key === 'lastWeek') monday.setDate(monday.getDate() - 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: monday, to: sunday, label: `${dateKey(monday)} → ${dateKey(sunday)}` };
  }
  const base = new Date(d.getFullYear(), d.getMonth(), 1);
  if (key === 'lastMonth') base.setMonth(base.getMonth() - 1);
  const from = base;
  const to = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return {
    from,
    to,
    label: from.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
  };
}

function inRange(
  record: ProductionRecord,
  from: Date,
  to: Date,
  shiftIds?: Set<string>,
): boolean {
  if (shiftIds) return shiftIds.has(record.shiftId);
  const p = parseShiftId(record.shiftId);
  if (!p) return false;
  const d = new Date(p.year, p.month - 1, p.day);
  return d >= from && d <= to;
}

// Handover parsing lives in core/handover.ts so the operator side-panel
// and the KPIs cell agree on every shape (JSON, "People: x\n…", legacy
// plain text) without each file maintaining its own parser copy.

export function collectHandovers(records: ProductionRecord[]): HandoverEntry[] {
  // Handover lives on slotIndex 0 per (machine, shift, job). De-dup by
  // SHIFT + job, because the same job can carry a different handover on
  // successive shifts. Job-only de-dup silently discarded all but one.
  const seen = new Set<string>();
  const out: HandoverEntry[] = [];
  for (const r of records) {
    if (r.slotIndex !== 0) continue;
    if (!r.handoverNote) continue;
    const key = `${r.shiftId}|${r.jobNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const h = parseHandover(r.handoverNote);
    if (!h.machine && !h.mold && !h.material && !h.method) continue;
    out.push({ jobNumber: r.jobNumber, shiftId: r.shiftId, ...h });
  }
  return sortHandoversNewest(out);
}

/** Newest shift first; Job # uses natural order within the same shift. */
export function sortHandoversNewest(
  handovers: ReadonlyArray<HandoverEntry>,
): HandoverEntry[] {
  const jobOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...handovers].sort((a, b) => {
    const aTime = shiftBounds(a.shiftId)?.start.getTime();
    const bTime = shiftBounds(b.shiftId)?.start.getTime();
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    const shiftOrder = b.shiftId.localeCompare(a.shiftId);
    return shiftOrder || jobOrder.compare(a.jobNumber, b.jobNumber);
  });
}

function toAgg(k: Kpi): ShiftAgg {
  const good = k.output;
  const reject = k.scrap;
  const yieldPct = good + reject > 0 ? (good / (good + reject)) * 100 : 100;
  return {
    output: good,
    reject,
    yieldPct: +yieldPct.toFixed(1),
    runHrs: k.runHrs,
    downHrs: k.downtimeHrs,
    setupHrs: k.setupHrs,
    dieHrs: k.dieHrs,
    colorHrs: k.colorHrs,
    insertHrs: k.insertHrs,
    startupHrs: k.startupHrs,
    shifts: k.shifts,
    oee: k.oee,
    // Expectation / standards are computed PER SHIFT BUCKET (the runs-of-D
    // counting and the planned-start cut only make sense against one
    // shift's clock window) and summed onto the agg by the caller — a
    // bare toAgg slice (job rows, category rows) stays unjudged.
    expOutput: null,
    dieStdHrs: null,
    colorStdHrs: null,
    insertStdHrs: null,
  };
}

function emptyAgg(): ShiftAgg {
  return {
    output: 0,
    reject: 0,
    yieldPct: 100,
    runHrs: 0,
    downHrs: 0,
    setupHrs: 0,
    dieHrs: 0,
    colorHrs: 0,
    insertHrs: 0,
    startupHrs: 0,
    shifts: 0,
    oee: null,
    expOutput: null,
    dieStdHrs: null,
    colorStdHrs: null,
    insertStdHrs: null,
  };
}

/** Add a bucket's expectation/standards onto a running agg (null-aware:
 *  the first computed bucket turns the field from null into a number). */
function addStd(
  a: ShiftAgg,
  exp: number | null,
  std: { dieStdHrs: number; colorStdHrs: number; insertStdHrs: number },
): void {
  if (exp != null) a.expOutput = (a.expOutput ?? 0) + exp;
  a.dieStdHrs = (a.dieStdHrs ?? 0) + std.dieStdHrs;
  a.colorStdHrs = (a.colorStdHrs ?? 0) + std.colorStdHrs;
  a.insertStdHrs = (a.insertStdHrs ?? 0) + std.insertStdHrs;
}

function emptyChartShift(): ChartBucket['byShift'][ShiftCode] {
  return { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0 };
}

/** First two words of a part description — keeps the per-job row narrow
 *  enough to read on a 10" iPad while still distinguishing "Battery Tray
 *  Black" from "Battery Lid Grey". Caller still sets a full-text title. */
function firstTwoWords(s: string): string {
  if (!s) return '';
  const words = s.trim().split(/\s+/);
  return words.slice(0, 2).join(' ');
}

/**
 * When an order last ran in the window: the end of the latest half-hour
 * slot it has a status in, as epoch ms. null when none of its records
 * carries a status (placeholder rows only), which is not the same as
 * "ran at time zero" and must not sort as if it were.
 *
 * Slot end rather than slot start — a job that occupies 14:00–14:30 came
 * off the press at 14:30, and that is the moment being ordered by.
 */
export function lastRunAt(recs: ProductionRecord[]): number | null {
  let last: number | null = null;
  for (const r of recs) {
    if (!r.statusCode) continue;
    const end = slotTimeRange(r.shiftId, r.slotIndex)?.end.getTime();
    if (end != null && (last === null || end > last)) last = end;
  }
  return last;
}

/**
 * Orders in the sequence the floor finished them, earliest first — the
 * order a supervisor walks the line in, so the list reads like the day
 * rather than like a leaderboard. Ranking by Output instead (as this
 * used to) interleaves Monday and Friday by size, which says nothing
 * about what happened when.
 *
 * An order with no known finish time sorts last: "still unknown" belongs
 * after everything that did come off. Job number breaks ties so two
 * orders ending in the same half-hour keep a stable, repeatable order.
 */
export function byCompletion(
  a: { lastRunAt: number | null; jobNumber: string },
  b: { lastRunAt: number | null; jobNumber: string },
): number {
  const ta = a.lastRunAt ?? Number.POSITIVE_INFINITY;
  const tb = b.lastRunAt ?? Number.POSITIVE_INFINITY;
  // Guard the compare: Infinity - Infinity is NaN, which would leave the
  // unfinished orders in whatever order the Map happened to yield.
  if (ta !== tb) return ta - tb;
  return a.jobNumber < b.jobNumber ? -1 : a.jobNumber > b.jobNumber ? 1 : 0;
}

/**
 * The four boxes, in the order they cost the floor: die change, colour
 * change, insert change, breakdown. Colours come from the status palette
 * so the chart speaks the same language as the operator timeline, and
 * each point carries its press + order so an outlier dot can name itself.
 */
export function changeoverBoxSeries(events: ChangeoverEvent[]): BoxSeries[] {
  const spec: Array<{ kind: ChangeoverKind; color: string; std: number | null }> = [
    { kind: 'die', color: '#ea580c', std: DIE_CHANGE_STD_HRS },
    { kind: 'color', color: '#d97706', std: COLOR_CHANGE_STD_HRS },
    { kind: 'insert', color: '#c2410c', std: INSERT_CHANGE_STD_HRS },
    // A breakdown has no allowance — the floor doesn't budget for one.
    { kind: 'down', color: '#dc2626', std: null },
  ];
  return spec.map((s) => ({
    label: CHANGEOVER_LABELS[s.kind],
    color: s.color,
    std: s.std,
    points: events
      .filter((e) => e.kind === s.kind)
      .map((e) => ({
        value: e.hours,
        label: `${e.machineCode}${e.jobNumber ? ' · ' + e.jobNumber : ''} · ${e.shiftId}`,
      })),
  }));
}

/** "02 Aug 14:30" — the finish time spelled onto the row's tooltip so the
 *  list's sequence is explicable without opening anything. */
function finishedLabel(t: number | null): string {
  if (t === null) return 'no completed slot in this window';
  const d = new Date(t);
  return `finished ${d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Add a record's per-code reject quantities into a running tally. Reads
 *  the `rejects` JSON ({"D01":3,…}); falls back to the flat rejectCount
 *  under an "Unspecified" bucket when the JSON is absent/unparseable so
 *  no scrap silently vanishes from the Pareto. */
async function compute(now = new Date()): Promise<void> {
  if (!S) return;
  const state = S;
  const version = ++computeVersion;
  const errors: string[] = [];
  const recordError = (label: string, err: unknown): void => {
    console.error(`[kpi] ${label} failed:`, err);
    errors.push(`${label}: ${(err as Error).message || 'read failed'}`);
  };
  state.loading = true;
  state.errors = [];
  const { from, to, shiftIds } = periodRange(state.period, now);
  // listPlanning and the per-machine production reads have no
  // dependencies on each other — parallelise so the screen render
  // isn't pinned to N×latency. Per-machine errors don't abort the whole
  // page: a single 1600T fetch failure used to take down the entire KPI
  // table (Promise.all rejects on the first failure); now each machine
  // that errors just shows up as zeros and the rest still render.
  // Reject / Downtime Pareto come straight from PMD_Rejects /
  // PMD_BreakDownlog — one round-trip each, the SP source-of-truth,
  // and no per-record JSON aggregation in the UI. Filter by the same
  // calendar window the table uses so the Pareto totals match what the
  // table's Reject / Down-hour columns show. Floor + per-machine in
  // parallel; per-machine failures contribute an empty list rather
  // than dropping the floor chart.
  const fromKey = dateKey(from);
  const toKey = dateKey(to);
  const paretoMachines = ['', ...S!.machines.map((m) => m.machineCode)];
  const [planning, perMachineProd, dieColorList, rejectParetoBy, downtimeParetoBy] =
    await Promise.all([
      dalRef.listPlanning({}).catch((err) => {
        recordError('Planning', err);
        return [] as PlanningOrder[];
      }),
      Promise.all(
        S!.machines.map((m) =>
          dalRef
            .listProduction({ machineCode: m.machineCode })
            // KPIs are a management view of *finished* shift work: only
            // signed-off rows count. Excluding unsigned PMD_LiveStatus
            // rows keeps in-progress (and frequently mis-typed) jobs
            // out of the OEE / output / reject totals until the
            // supervisor has reviewed and signed them off.
            .then((p) => p.filter((r) => r.locked && inRange(r, from, to, shiftIds)))
            .catch((err) => {
              recordError(`Production ${m.machineCode}`, err);
              return [] as ProductionRecord[];
            }),
        ),
      ),
      dalRef.listProductDieColors
        ? dalRef.listProductDieColors().catch((err) => {
            recordError('Part/die colours', err);
            return [];
          })
        : Promise.resolve([]),
      Promise.all(
        paretoMachines.map((mc) =>
          dalRef.listRejectPareto
            ? dalRef
                .listRejectPareto({ from: fromKey, to: toKey, machineCode: mc || undefined })
                .catch((err) => {
                  recordError(`Reject Pareto ${mc || 'floor'}`, err);
                  return [] as ParetoSlice[];
                })
            : Promise.resolve([] as ParetoSlice[]),
        ),
      ),
      Promise.all(
        paretoMachines.map((mc) =>
          dalRef.listDowntimePareto
            ? dalRef
                .listDowntimePareto({ from: fromKey, to: toKey, machineCode: mc || undefined })
                .catch((err) => {
                  recordError(`Downtime Pareto ${mc || 'floor'}`, err);
                  return [] as ParetoSlice[];
                })
            : Promise.resolve([] as ParetoSlice[]),
        ),
      ),
    ]);
  // Ignore a response for a range that is no longer active. All mutations
  // happen below this guard, so an older slow request cannot repaint the
  // table after the user's newer selection has completed.
  if (version !== computeVersion || S !== state) return;
  const dieColors = new Map(
    dieColorList.map((c) => [
      c.partNumber.trim().toUpperCase(),
      { hex: c.hex, name: c.name },
    ]),
  );
  // Part # per Job — populated below from every PMD_Production record
  // (which now carries JobHead_PartNum), falling back to planning when
  // the job has no production rows yet. Records win because planning
  // orders roll off Epicor while signed-off production stays.
  const partNumByJob = new Map<string, string>();
  for (const o of planning) partNumByJob.set(o.jobNumber, o.partNumber);

  // JobNum → partDescription lookup. PMD_Production carries the
  // denormalised JobHead_PartDescription on every signed-off row, so
  // resolve from there first; planning is only the seed for jobs that
  // have no production rows yet. Planning rolls off Epicor when an
  // order completes, so trusting planning alone made a finished job's
  // description silently blank — production rows survive forever and
  // are the source of truth here.
  const partDescByJob = new Map<string, string>();
  for (const o of planning) partDescByJob.set(o.jobNumber, o.partDescription);

  // Cycle time (hours per piece — Epicor JobOper_ProdStandard, the
  // "Standard hour") and planned start (JobHead_StartDate + StartHour)
  // per job, feeding the expected-output judgement (core/standards.ts).
  // Planning seeds both; the signed rows' denormalised copies override
  // below, because planning rolls off Epicor once an order completes.
  const ctByJob = new Map<string, number>();
  const psByJob = new Map<string, string>();
  for (const o of planning) {
    if (o.qtyPerHr > 0) ctByJob.set(o.jobNumber, o.qtyPerHr);
    if (o.plannedStart) psByJob.set(o.jobNumber, o.plannedStart);
  }

  const charts = new Map<string, ChartBucket>();
  const rows: KpiRow[] = S!.machines.map((m, i) => {
    const all = perMachineProd[i];
    // PMD_Production / PMD_LiveStatus now carry JobHead_PartNum on
    // every row. Use it as the authoritative source — overrides the
    // planning fallback so a job whose order has rolled off Epicor
    // still resolves a swatch.
    for (const r of all) {
      if (r.partNumber) partNumByJob.set(r.jobNumber, r.partNumber);
      // Production wins for partDescription too — see partDescByJob
      // comment above. Skip blanks so we never blow away a planning seed
      // with an empty production row (the non-canonical slots carry '').
      if (r.partDescription) partDescByJob.set(r.jobNumber, r.partDescription);
      // Same production-wins rule for the expectation inputs.
      if (r.cycleTime && r.cycleTime > 0) ctByJob.set(r.jobNumber, r.cycleTime);
      if (r.plannedStart) psByJob.set(r.jobNumber, r.plannedStart);
    }
    // Planning queue for the schedule-based expectation: this machine's
    // live orders in planned sequence. Die-change pseudo-rows are
    // excluded — changeover time enters the model as the OBSERVED
    // occurrences × standard instead.
    const planQueue = planning
      .filter((o) => o.machineCode === m.machineCode && !o.isDieChange)
      .map((o) => ({
        jobNumber: o.jobNumber,
        plannedStart: o.plannedStart,
        remainingLaborHrs: o.duration,
        remainingQty: o.jobRequired > 0 ? o.jobRequired : o.orderQty,
        hrsPerPiece: o.qtyPerHr,
      }));
    // Single pass per machine: partition into byShift × byDateBucket, then
    // aggregate each slice once at the end. Avoids re-filtering `all` 3×
    // and re-walking each shift slice to bucket by date.
    const buckets = new Map<ShiftCode, Map<string, ProductionRecord[]>>();
    for (const code of SHIFT_ORDER) buckets.set(code, new Map());
    for (const r of all) {
      const p = parseShiftId(r.shiftId);
      if (!p) continue;
      const dateKey = r.shiftId.slice(0, 10);
      const m2 = buckets.get(p.code);
      if (!m2) continue;
      const arr = m2.get(dateKey) ?? [];
      arr.push(r);
      m2.set(dateKey, arr);
    }

    const byShift: Record<ShiftCode, ShiftAgg> = {
      Day: emptyAgg(),
      Afternoon: emptyAgg(),
      Night: emptyAgg(),
    };
    const jobsByShift: Record<ShiftCode, JobAgg[]> = {
      Day: [],
      Afternoon: [],
      Night: [],
    };
    for (const code of SHIFT_ORDER) {
      const shiftBuckets = buckets.get(code)!;
      const flat: ProductionRecord[] = [];
      const stdAcc: Array<{
        exp: number | null;
        std: { dieStdHrs: number; colorStdHrs: number; insertStdHrs: number };
      }> = [];
      for (const [dateKey, recs] of shiftBuckets) {
        flat.push(...recs);
        const k = aggregate(recs);
        // Planning-driven expectation + changeover standards are per
        // SHIFT INSTANCE (runs-of-D counting and the planned-start cut
        // both need one shift's clock window); summed onto the shift agg
        // after toAgg below. The planned-queue simulation is the primary
        // model (order sequence + RemainingQty caps); when the bucket's
        // orders have rolled off planning (history), fall back to the
        // records-based footprint model, whose inputs are denormalised
        // onto the signed rows.
        const bShiftId = `${dateKey}-${code}`;
        const std = setupStandardHours(countSetupEvents(recs));
        const smokoHrs =
          recs.filter((r) => r.statusCode === 'M').length * 0.5;
        // Exact remaining at THIS shift's start beats the planning
        // snapshot: each signed canonical row carries JobLeft (order
        // TOTAL − Σ good of earlier-started signed shifts, retro-healed
        // on late sign-offs) + CycleTime, denormalised at sign-off.
        // Epicor's Calculated_Remaining* decrement daily as shifts book
        // in, so for any bucket older than the last sync they overstate
        // progress; the ledger value is per-shift truth. Planning stays
        // in the queue for orders that DIDN'T run (the follow-on order
        // the shift was supposed to start).
        const q = new Map(planQueue.map((o) => [o.jobNumber, o]));
        for (const r of recs) {
          if (r.slotIndex !== 0 || r.jobLeft == null) continue;
          const ct =
            r.cycleTime && r.cycleTime > 0
              ? r.cycleTime
              : (q.get(r.jobNumber)?.hrsPerPiece ?? 0);
          if (!(ct > 0)) continue;
          q.set(r.jobNumber, {
            jobNumber: r.jobNumber,
            // JobLeft is measured AT shift start, so the entry is
            // runnable from the shift's first slot unless planning says
            // it wasn't due yet.
            plannedStart:
              r.plannedStart ||
              q.get(r.jobNumber)?.plannedStart ||
              shiftBounds(bShiftId)?.start.toISOString() ||
              '',
            remainingLaborHrs: r.jobLeft * ct,
            remainingQty: r.jobLeft,
            hrsPerPiece: ct,
          });
        }
        const fromPlan = expectedShiftOutputFromPlanning(
          bShiftId,
          [...q.values()],
          std.dieStdHrs + std.colorStdHrs + std.insertStdHrs,
          smokoHrs,
        );
        // Primary model: Σ Shift Targets of the orders that ran — the
        // SAME per-job number the operator sheet showed and sign-off
        // stamped (min(JobLeft, hours-left-after-earlier-orders-and-
        // changeover ÷ ProdStandard), core/targets.ts), so Output "/n"
        // and vs Plan judge against the target the floor was actually
        // given. Buckets whose rows lack the denormalised JobLeft /
        // CycleTime (legacy sign-offs) fall back to the planned-queue
        // simulation, then the records-footprint model.
        const expPieces =
          expectedShiftOutputFromTargets(recs, ctByJob) ??
          fromPlan.pieces ??
          expectedShiftOutput(bShiftId, recs, ctByJob, psByJob).pieces;
        stdAcc.push({ exp: expPieces, std });
        const cb = charts.get(dateKey) ?? {
          key: dateKey, // full YYYY-MM-DD — the month rollup groups on it
          label: dateKey.slice(5), // MM-DD
          byShift: { Day: emptyChartShift(), Afternoon: emptyChartShift(), Night: emptyChartShift() },
        };
        const cell = cb.byShift[code];
        cell.good += k.output;
        cell.reject += k.scrap;
        cell.runHrs += k.runHrs;
        cell.downHrs += k.downtimeHrs;
        cell.setupHrs += k.setupHrs;
        charts.set(dateKey, cb);
      }
      byShift[code] = toAgg(aggregate(flat));
      for (const s of stdAcc) addStd(byShift[code], s.exp, s.std);

      // 3rd-level breakdown: group this shift's records by JobNum,
      // aggregate each, attach the part description (first two words).
      const byJob = new Map<string, ProductionRecord[]>();
      for (const r of flat) {
        const arr = byJob.get(r.jobNumber) ?? [];
        arr.push(r);
        byJob.set(r.jobNumber, arr);
      }
      jobsByShift[code] = Array.from(byJob.entries())
        .map(([jobNumber, recs]) => {
          const desc = partDescByJob.get(jobNumber) ?? '';
          return {
            jobNumber,
            partDescShort: firstTwoWords(desc),
            color: colorForJob(partNumByJob.get(jobNumber) ?? '', desc, dieColors),
            agg: toAgg(aggregate(recs)),
            lastRunAt: lastRunAt(recs),
          };
        })
        .sort(byCompletion);
    }
    const total = toAgg(aggregate(all));
    // Machine total = Σ of its shift aggs' expectations / standards.
    for (const code of SHIFT_ORDER) {
      const s = byShift[code];
      addStd(total, s.expOutput, {
        dieStdHrs: s.dieStdHrs ?? 0,
        colorStdHrs: s.colorStdHrs ?? 0,
        insertStdHrs: s.insertStdHrs ?? 0,
      });
    }

    // Per-Job# rollup across every shift in the period. The supervisor
    // uses this to answer "how is each order doing on 1600T over the
    // week?" without scanning three shift sub-tables. Listed in the
    // sequence the press finished them, so the rollup reads down the
    // week the way the machine lived it.
    const allByJob = new Map<string, ProductionRecord[]>();
    for (const r of all) {
      if (!r.jobNumber) continue;
      const arr = allByJob.get(r.jobNumber) ?? [];
      arr.push(r);
      allByJob.set(r.jobNumber, arr);
    }
    const byJobTotal: JobAgg[] = Array.from(allByJob.entries())
      .map(([jobNumber, recs]) => {
        const desc = partDescByJob.get(jobNumber) ?? '';
        return {
          jobNumber,
          partDescShort: firstTwoWords(desc),
          color: colorForJob(partNumByJob.get(jobNumber) ?? '', desc, dieColors),
          agg: toAgg(aggregate(recs)),
          lastRunAt: lastRunAt(recs),
        };
      })
      .sort(byCompletion);

    // Schedule Adherence was retired here — the Output "vs Plan" column
    // now carries plan attainment, judged against the simulated planned-
    // queue expectation rather than a separate scheduled-qty ratio.
    return {
      machineCode: m.machineCode,
      handovers: collectHandovers(all),
      total,
      byShift,
      jobsByShift,
      byJobTotal,
    };
  });

  S!.rows = rows;

  // Every changeover and breakdown in the window, floor-wide, for the
  // supervisor's box plot. Collected across all presses at once so the
  // distribution answers "how long does a die change take HERE", not
  // "on this one machine" — but each event keeps its press and order so
  // an outlier can be named.
  S!.changeoverEvents = collectChangeoverEvents(perMachineProd.flat());
  // order → part → die, so a die change can be attributed to the tool it
  // fitted. partNumByJob is production-first (see above), which matters
  // here: an order that has rolled off Epicor planning still resolves.
  const dieByPart = new Map<string, string>();
  for (const c of dieColorList) {
    if (c.dieNumber) dieByPart.set(c.partNumber.trim().toUpperCase(), c.dieNumber.trim());
  }
  S!.dieByJob = new Map(
    Array.from(partNumByJob.entries())
      .map(([job, part]) => [job, dieByPart.get(part.trim().toUpperCase()) ?? ''] as const)
      .filter(([, die]) => die),
  );

  // Floor-wide totals split by PMD_ProductDieColor.Category. Resolution
  // chain per record: JobNum → Part # (partNumByJob, fully populated by
  // the rows pass above — records win over planning) → Category. Parts
  // with no category row land in "Other" so the subtotals always sum to
  // the grand TOTAL.
  //
  // Exception: anything run on the hot-stamping press is bucketed as its
  // own "Hstamp" category (machine wins over part category) so hot-stamp
  // output shows on its own line in the Chair / Shell / Component summary
  // instead of disappearing into "Other" — which is where its
  // uncategorised parts landed before. Bucketing stays exclusive, so
  // pulling Hstamp out deducts exactly that total from "Other" and the
  // subtotals still sum to the grand TOTAL.
  const categoryByPart = new Map<string, string>();
  for (const c of dieColorList) {
    if (c.category) categoryByPart.set(c.partNumber.trim().toUpperCase(), c.category);
  }
  const hstampCodes = new Set(
    S!.machines.filter(isHotStampMachine).map((m) => m.machineCode),
  );
  const byCategory = new Map<string, ProductionRecord[]>();
  for (const recs of perMachineProd) {
    for (const r of recs) {
      let cat: string;
      if (hstampCodes.has(r.machineCode)) {
        cat = 'Hstamp';
      } else {
        const part = (partNumByJob.get(r.jobNumber) ?? '').trim().toUpperCase();
        cat = (part && categoryByPart.get(part)) || 'Other';
      }
      const arr = byCategory.get(cat) ?? [];
      arr.push(r);
      byCategory.set(cat, arr);
    }
  }
  S!.catTotals = Array.from(byCategory.entries())
    .map(([category, recs]) => ({ category, agg: toAgg(aggregate(recs)) }))
    .sort((a, b2) => b2.agg.output - a.agg.output);

  // paretoMachines = ['', ...machineCodes] above; index 0 is the floor,
  // indices 1..N are the per-machine slices. The drill-down keys on the
  // machine code (or 'FLOOR') to look up the right slice.
  const rejectByMachine = new Map<string, ParetoSlice[]>();
  const downtimeByMachine = new Map<string, ParetoSlice[]>();
  S!.machines.forEach((m, i) => {
    rejectByMachine.set(
      m.machineCode,
      applyRejectDescriptions(rejectParetoBy[i + 1] ?? [], S!.rejectDescByCode),
    );
    downtimeByMachine.set(m.machineCode, downtimeParetoBy[i + 1] ?? []);
  });
  S!.rejectPareto = {
    floor: applyRejectDescriptions(rejectParetoBy[0] ?? [], S!.rejectDescByCode),
    byMachine: rejectByMachine,
  };
  S!.downtimePareto = {
    floor: downtimeParetoBy[0] ?? [],
    byMachine: downtimeByMachine,
  };

  S!.chartBuckets = Array.from(charts.entries())
    .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0))
    .map(([, v]) => v);
  // Drop expansions for months the new range no longer covers, so changing
  // the dates can't leave a month open that isn't on screen — and so the
  // newest month (always daily anyway) never lingers in the set.
  const live = new Set(S!.chartBuckets.map((b) => monthOf(b.key)));
  for (const m of [...S!.expandedMonths]) if (!live.has(m)) S!.expandedMonths.delete(m);
  state.errors = errors;
  state.loading = false;
  render();
}

function colourClass(v: number | null, green: number, amber: number): string {
  if (v == null) return 'gray';
  if (v >= green) return 'green';
  if (v >= amber) return 'amber';
  return 'red';
}

/** Output-vs-plan colouring, on the one unified traffic-light language as
 *  every other KPI: green = met, amber = close, red = short; '' (no
 *  colour) when there's nothing to judge against. (Was 红黄蓝 with blue
 *  for "met" — dropped so the whole board reads consistently.) */
function planColourClass(pct: number | null, t: KpiThresholds): string {
  if (pct == null) return '';
  if (pct >= t.planBlue) return 'green';
  if (pct >= t.planAmber) return 'amber';
  return 'red';
}

/** Output cell judged against the planning-driven expectation: value
 *  coloured green / amber / red, tooltip explains the maths. Plain cell
 *  when the slice carries no expectation (job rows, no cycle time). */
function outputCell(a: ShiftAgg): string {
  const n = a.output ? String(a.output) : '—';
  if (a.expOutput == null || a.expOutput <= 0) return `<td class="num">${n}</td>`;
  const pct = Math.round((a.output / a.expOutput) * 100);
  const cls = planColourClass(pct, S!.thresholds);
  const title = `Expected ≈ ${a.expOutput} pcs = Σ Shift Target of the orders run (per job: the smaller of Job Left and the shift hours left after earlier orders + changeover, ÷ JobOper_ProdStandard — the same target the operator sheet showed). Shifts without recorded targets use the planned order queue instead (capped by remaining qty; changeover standards deducted: die 4h, colour/insert 30min) — actual ${a.output} = ${pct}%`;
  return `<td class="num ${cls}" title="${escapeHtml(title)}">${n} <span class="kpi-exp">/${a.expOutput}</span></td>`;
}

/** Die / Colour / Insert hour cell judged against the standard allowance
 *  (changeovers × standard, one per order). Blue = within standard,
 *  amber = one block
 *  over, red = worse; plain when the slice wasn't judged / had none. */
function setupCell(actualHrs: number, stdHrs: number | null, stdEachHrs: number, label: string): string {
  const v = actualHrs ? actualHrs.toFixed(1) : '—';
  // Changeover hours ride the ordinary green/amber/red system — within
  // standard is green (not the plan-blue used for Output). setupJudgement
  // still returns 'blue' for at/under standard; remap it to green here.
  const cls = setupJudgement(actualHrs, stdHrs).replace('blue', 'green');
  if (!cls) return `<td class="num">${v}</td>`;
  const changeovers = Math.round((stdHrs ?? 0) / stdEachHrs);
  const title = `${label}: ${changeovers} changeover${changeovers === 1 ? '' : 's'} × ${stdEachHrs}h standard = ${(stdHrs ?? 0).toFixed(1)}h allowed — actual ${actualHrs.toFixed(1)}h${
    actualHrs > (stdHrs ?? 0) ? ` (+${(actualHrs - (stdHrs ?? 0)).toFixed(1)}h over)` : ' (within standard)'
  }`;
  return `<td class="num ${cls}" title="${escapeHtml(title)}">${v}</td>`;
}

function handoverShiftLabel(shiftId: string, compact = false): string {
  const p = parseShiftId(shiftId);
  if (!p) return shiftId || 'Unknown shift';
  // Midday avoids DST / timezone edge cases when formatting this wall date.
  const date = new Date(p.year, p.month - 1, p.day, 12).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    ...(compact ? {} : { year: 'numeric' as const }),
  });
  return compact ? `${date} · ${p.code}` : `${date} · ${p.code} shift`;
}

/** One compact entry on the machine row. Detail text never participates in
 *  the table's width calculation; the button opens the full grouped view. */
function formatHandoverCell(machineCode: string, handovers: HandoverEntry[]): string {
  if (handovers.length === 0) return '<td class="kpi-ho-cell muted">—</td>';
  const sorted = sortHandoversNewest(handovers);
  const latest = sorted[0];
  const countLabel = `${sorted.length} handover${sorted.length === 1 ? '' : 's'}`;
  const latestLabel = `${handoverShiftLabel(latest.shiftId, true)} · Job ${latest.jobNumber || '—'}`;
  return `<td class="kpi-ho-cell">
    <button type="button" class="kpi-ho-summary" data-handover-machine="${escapeHtml(
      machineCode,
    )}" aria-haspopup="dialog" aria-label="View ${escapeHtml(countLabel)} for ${escapeHtml(
      machineCode,
    )}" title="${escapeHtml(`${countLabel} · latest: ${latestLabel}`)}">
      <span class="kpi-ho-count">${sorted.length}</span>
      <span class="kpi-ho-latest">${escapeHtml(latestLabel)}</span>
      <span class="kpi-ho-arrow" aria-hidden="true">›</span>
    </button>
  </td>`;
}

/** Expanded hierarchy rows intentionally carry no Handover content. */
function emptyHandoverCell(): string {
  return '<td class="kpi-ho-cell kpi-ho-empty" aria-hidden="true"></td>';
}

function handoverField(icon: string, label: string, value: string): string {
  if (!value) return '';
  return `<div class="kpi-ho-field">
    <span class="kpi-ho-field-label">${icon} ${escapeHtml(label)}</span>
    <p>${escapeHtml(value)}</p>
  </div>`;
}

/** Full Handover history for one machine, grouped newest shift first and
 *  naturally ordered by Job # inside each shift. */
function openHandoverDetail(machineCode: string, handovers: HandoverEntry[]): void {
  const sorted = sortHandoversNewest(handovers);
  const grouped = new Map<string, HandoverEntry[]>();
  for (const h of sorted) {
    const entries = grouped.get(h.shiftId) ?? [];
    entries.push(h);
    grouped.set(h.shiftId, entries);
  }
  const groups = Array.from(grouped.entries())
    .map(([shiftId, entries]) => `<section class="kpi-ho-group">
      <div class="kpi-ho-shift-head">
        <b>${escapeHtml(handoverShiftLabel(shiftId))}</b>
        <span>${entries.length} job${entries.length === 1 ? '' : 's'}</span>
      </div>
      <div class="kpi-ho-jobs">
        ${entries
          .map((h) => `<article class="kpi-ho-job">
            <h3>Job ${escapeHtml(h.jobNumber || '—')}</h3>
            <div class="kpi-ho-fields">
              ${handoverField('🛠', 'Machine', h.machine)}
              ${handoverField('🧩', 'Mold', h.mold)}
              ${handoverField('📦', 'Material', h.material)}
              ${handoverField('📋', 'Method', h.method)}
            </div>
          </article>`)
          .join('')}
      </div>
    </section>`)
    .join('');
  const mc = openModal(`<div class="bd-modal kpi-handover-modal">
    <div class="kpi-ho-modal-head">
      <div>
        <h2 class="bd-title">📝 Handover — ${escapeHtml(machineCode)}</h2>
        <p class="bd-sub">${sorted.length} handover${
          sorted.length === 1 ? '' : 's'
        } · newest shift first · Job # order within each shift</p>
      </div>
      <button type="button" class="btn-primary-big kpi-ho-close" data-handover-close>Close</button>
    </div>
    <div class="kpi-ho-history">${groups}</div>
  </div>`);
  mc.querySelector('[data-handover-close]')?.addEventListener('click', closeModal);
}

/** Job-name row header: the job number is a button that opens the Trace
 *  detail popup (slot-by-slot timeline) for that job, followed by the
 *  muted part-description. */
function jobNameTh(jobNumber: string, partDescShort: string, fullDesc: string): string {
  return `<th class="kpi-job-name" title="${escapeHtml(fullDesc)}"><button type="button" class="kpi-job-link" data-job-trace="${escapeHtml(
    jobNumber,
  )}" title="View slot-by-slot Trace detail for ${escapeHtml(
    jobNumber,
  )}">${escapeHtml(jobNumber)}</button><span class="kpi-job-part">${escapeHtml(
    partDescShort,
  )}</span></th>`;
}

/** Color cell. Pass `undefined` for rolled-up rows (machine / shift /
 *  total) where there is no single colour to point at; pass a ColorTag
 *  on a job row to render swatch + label ("neutral" when no colour word
 *  was found in the part description). */
function colorCell(c?: ColorTag): string {
  if (!c) return `<td class="kpi-color-cell muted">—</td>`;
  if (c.neutral) {
    return `<td class="kpi-color-cell"><span class="kpi-swatch is-neutral" aria-hidden="true"></span><span class="kpi-color-name muted">neutral</span></td>`;
  }
  return `<td class="kpi-color-cell"><span class="kpi-swatch" style="background:${c.hex}" aria-hidden="true"></span><span class="kpi-color-name">${escapeHtml(
    c.name,
  )}</span></td>`;
}

/** Scrap a single shift is allowed before the number turns red. */
export const REJECT_PER_SHIFT_MAX = 5;

/**
 * Reject is judged PER SHIFT, never against the raw row total: five
 * rejects is one shift's tolerance, so a slice covering N shifts stays
 * green up to N × that. Scaling matters because the same column carries
 * one shift (sub-row) and a whole week of them (machine row, TOTAL) —
 * a flat cut-off would paint a machine red for three green shifts.
 *
 * When `drillKey` is given (machine code, or 'FLOOR') and the row has
 * scrap, the number becomes a button that opens the per-code Pareto
 * drill-down. Sub-rows (shift / job / category) pass nothing and render a
 * plain number.
 */
export function rejectCell(reject: number, shifts: number, drillKey?: string): string {
  // No scrap at all: a dash, uncoloured. Green here would read as a
  // measurement ("we made 0 bad parts") on rows that simply logged none.
  if (!reject) return `<td class="num">—</td>`;
  const span = Math.max(1, shifts);
  const cls = reject <= REJECT_PER_SHIFT_MAX * span ? 'green' : 'red';
  const perShift =
    span === 1
      ? `${reject} in the shift`
      : `${reject} over ${span} shifts = ${(reject / span).toFixed(1)}/shift`;
  const verdict = `${perShift} · ${cls === 'green' ? '🟢 within' : '🔴 above'} ${REJECT_PER_SHIFT_MAX} per shift`;
  if (!drillKey) {
    return `<td class="num ${cls}" title="${escapeHtml(verdict)}">${reject}</td>`;
  }
  return `<td class="num ${cls}"><button type="button" class="kpi-reject-drill" data-reject-drill="${escapeHtml(
    drillKey,
  )}" title="${escapeHtml(verdict)} — tap to break down by RejectCode (Pareto)">${reject}</button></td>`;
}

/** Same idea for Down hours: clickable on the machine head + floor TOTAL,
 *  opens the BDCode breakdown for that scope. Sub-rows stay plain. */
function downHrsCell(downHrs: number, drillKey?: string): string {
  const v = downHrs ? downHrs.toFixed(1) : '—';
  if (!drillKey || !downHrs) return `<td class="num">${v}</td>`;
  return `<td class="num"><button type="button" class="kpi-downtime-drill" data-downtime-drill="${escapeHtml(
    drillKey,
  )}" title="Break down ${downHrs.toFixed(1)} h of breakdown by BDCode (Pareto)">${v}</button></td>`;
}

function aggCells(
  a: ShiftAgg,
  _legacy: number | null = null,
  colourOee = true,
  rejectDrillKey?: string,
  downtimeDrillKey?: string,
): string {
  const t = S!.thresholds;
  const yc = colourClass(a.yieldPct, t.yieldGreen, t.yieldAmber);
  const oc = colourClass(a.oee, t.effGreen, t.effAmber);
  // vs Plan: same attainment the Output cell colours by, surfaced as its
  // own percentage column (replaced Schedule Adherence). null when the
  // slice carries no planning expectation.
  const planPct =
    a.expOutput != null && a.expOutput > 0 ? Math.round((a.output / a.expOutput) * 100) : null;
  const pc = planColourClass(planPct, t);
  // Empty cells render an em-dash instead of "0" / "0.0%" — a literal
  // zero in an Efficiency / output column reads as a real measurement (the
  // press ran but made nothing), where what we actually mean is "no
  // data for this slice". The dash makes that distinction visible.
  const h = (v: number): string => (v ? v.toFixed(1) : '—');
  // Yield is meaningless without pieces: emptyAgg() defaults yieldPct to
  // 100, so a slice with no output AND no reject must show '—', not a
  // green "100%" that reads as a perfect shift.
  const noPieces = !a.output && !a.reject;
  return `
    ${outputCell(a)}
    ${rejectCell(a.reject, a.shifts, rejectDrillKey)}
    <td class="num ${noPieces ? '' : yc}">${noPieces ? '—' : `${a.yieldPct}%`}</td>
    <td class="num">${h(a.runHrs)}</td>
    ${downHrsCell(a.downHrs, downtimeDrillKey)}
    <td class="num">${h(a.startupHrs)}</td>
    ${setupCell(a.dieHrs, a.dieStdHrs, DIE_CHANGE_STD_HRS, 'Die change')}
    ${setupCell(a.colorHrs, a.colorStdHrs, COLOR_CHANGE_STD_HRS, 'Colour change')}
    ${setupCell(a.insertHrs, a.insertStdHrs, INSERT_CHANGE_STD_HRS, 'Insert change')}
    <td class="num ${colourOee ? oc : ''}">${a.oee == null ? '—' : a.oee + '%'}</td>
    <td class="num ${pc}">${planPct == null ? '—' : planPct + '%'}</td>`;
}

/**
 * Supervisor-only editor for the green / amber colour thresholds. Hidden
 * for operators (read-only view); a signed-in supervisor can tune them
 * per plant and the values persist per-browser. Six number inputs:
 * green + amber for Efficiency, Yield, Schedule Adherence.
 */
function buildThresholdEditor(): string {
  if (!isSupervisor()) return '';
  const t = S!.thresholds;
  const field = (key: keyof KpiThresholds, label: string): string =>
    `<label class="kpi-th-field">${escapeHtml(label)}
      <input type="number" min="0" max="100" step="1" data-th="${key}" value="${t[key]}">
    </label>`;
  return `<div class="kpi-thresholds">
    <span class="kpi-th-title">🎚 Colour thresholds</span>
    <div class="kpi-th-group"><b>Efficiency</b>${field('effGreen', '🟢 ≥')}${field('effAmber', '🟡 ≥')}</div>
    <div class="kpi-th-group"><b>Yield</b>${field('yieldGreen', '🟢 ≥')}${field('yieldAmber', '🟡 ≥')}</div>
    <div class="kpi-th-group"><b>Output / vs Plan</b>${field('planBlue', '🟢 ≥')}${field('planAmber', '🟡 ≥')}</div>
    <button type="button" class="kpi-th-reset" data-th-reset title="Restore default thresholds">Reset</button>
  </div>`;
}

function setKpiHash(view: KpiPageView): void {
  const hash = view === 'metrics' ? '#/kpi' : `#/kpi/${view}`;
  window.history.replaceState(null, '', hash);
}

/** Wire the four same-level KPI buttons. Period tabs compute signed-off
 *  metrics; Live Status and Job Search mount their operational panels. */
function wireKpiNavigation(app: HTMLElement): void {
  app.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      computeVersion++; // cancel a previous range computation, if any
      unmountTracePanel();
      S!.view = 'metrics';
      S!.period = b.dataset.period as PeriodKey;
      S!.loading = true;
      setKpiHash('metrics');
      render();
      void compute();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-kpi-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const view = b.dataset.kpiView as TracePanelView;
      if (S!.view === view) return;
      computeVersion++; // a slow KPI read must not remount over this panel
      unmountTracePanel();
      S!.view = view;
      setKpiHash(view);
      render();
    }),
  );
}

function render(): void {
  const app = document.getElementById('app')!;
  const dataErrors = [...S!.catalogErrors, ...S!.errors];
  const errorBanner = dataErrors.length
    ? `<div class="data-error-banner" role="alert"><b>⚠ Partial data only.</b> ${dataErrors
        .map((e) => escapeHtml(e))
        .join(' · ')}</div>`
    : '';
  const tabs = PERIODS.map(
    (p) =>
      `<button class="shift-btn${S!.view === 'metrics' && p.key === S!.period ? ' a' : ''}" data-period="${p.key}">${escapeHtml(
        p.label,
      )}</button>`,
  ).join('') +
    `<button class="shift-btn${S!.view === 'live' ? ' a' : ''}" data-kpi-view="live">📡 Live Status</button>` +
    `<button class="shift-btn${S!.view === 'search' ? ' a' : ''}" data-kpi-view="search">🔍 Job Search</button>`;

  // Live and Search share the KPI toolbar but own their content/data.
  // They do not need the KPI period range, threshold editor or charts.
  if (S!.view !== 'metrics') {
    const panelView = S!.view;
    app.innerHTML = `<div class="kpi">
      <div class="kpi-head"><div class="shift-tabs">${tabs}</div></div>
      <div class="kpi-trace-host"></div>
    </div>`;
    wireKpiNavigation(app);
    const host = app.querySelector<HTMLElement>('.kpi-trace-host');
    if (host) void mountTracePanel(dalRef, host, panelView);
    return;
  }
  // Global toggles live in the Machine column header — one click flips
  // every machine instead of N clicks per row.
  //  • "+" mirrors the per-row + / – (shift breakdown)
  //  • ">" mirrors the per-row › / ⌄ (per-order rollup)
  // Machines with no jobs in the selected period have no shift breakdown
  // and no order rollup, so they're excluded from the "any collapsed?"
  // tally and from the toggle-all targets below. Without this filter the
  // global "–" glyph stuck on "+" because the empty machines are never
  // tracked in S!.collapsed, and the "expand all" click tried to drill
  // into rows that have nothing to expand.
  const machinesWithData = S!.rows.filter((r) => r.byJobTotal.length > 0);
  const anyShiftsCollapsed = machinesWithData.some((r) => S!.collapsed.has(r.machineCode));
  const anyOrdersHidden = S!.ordersExpanded.size < machinesWithData.length;
  const allShiftsGlyph = anyShiftsCollapsed ? '+' : '–';
  const allOrdersGlyph = anyOrdersHidden ? '›' : '⌄';

  const tot = S!.rows.reduce(
    (a, r) => {
      a.output += r.total.output;
      a.reject += r.total.reject;
      a.runHrs += r.total.runHrs;
      a.downHrs += r.total.downHrs;
      a.setupHrs += r.total.setupHrs;
      a.dieHrs += r.total.dieHrs;
      a.colorHrs += r.total.colorHrs;
      a.insertHrs += r.total.insertHrs;
      a.startupHrs += r.total.startupHrs;
      // Machine-shifts, not shifts: floor-wide scrap is judged against
      // every press's shift allowance, the same way each machine row is
      // judged against its own.
      a.shifts += r.total.shifts;
      if (r.total.expOutput != null) a.expOutput = (a.expOutput ?? 0) + r.total.expOutput;
      a.dieStdHrs = (a.dieStdHrs ?? 0) + (r.total.dieStdHrs ?? 0);
      a.colorStdHrs = (a.colorStdHrs ?? 0) + (r.total.colorStdHrs ?? 0);
      a.insertStdHrs = (a.insertStdHrs ?? 0) + (r.total.insertStdHrs ?? 0);
      return a;
    },
    {
      output: 0,
      reject: 0,
      runHrs: 0,
      downHrs: 0,
      setupHrs: 0,
      dieHrs: 0,
      colorHrs: 0,
      insertHrs: 0,
      startupHrs: 0,
      shifts: 0,
      expOutput: null as number | null,
      dieStdHrs: null as number | null,
      colorStdHrs: null as number | null,
      insertStdHrs: null as number | null,
    },
  );
  const totPieces = tot.output + tot.reject;
  const totYield =
    totPieces > 0 ? ((tot.output / totPieces) * 100).toFixed(1) : null;
  // Floor OEE for the headline tile — run share of all logged hours,
  // same definition as the per-row OEE* and the hours chart overlay.
  const totLogged = tot.runHrs + tot.downHrs + tot.setupHrs;
  const totOee = totLogged > 0 ? Math.round((tot.runHrs / totLogged) * 100) : null;

  let body: string;
  if (S!.loading) {
    body = `<tr><td colspan="14" class="muted">Loading…</td></tr>`;
  } else {
    body = S!.rows
      .map((r) => {
        const hasData = r.byJobTotal.length > 0;
        const isCollapsed = S!.collapsed.has(r.machineCode) || !hasData;
        const ordersOpen = S!.ordersExpanded.has(r.machineCode);
        // A machine with no jobs in the period has no shift breakdown
        // to show either (Day / Afternoon / Night would all be empty),
        // so suppress the + chevron entirely — same rule as the >-orders
        // toggle below. Operator gets a clean read-only row.
        const toggle = hasData
          ? `<button type="button" class="kpi-toggle" data-toggle="${escapeHtml(
              r.machineCode,
            )}" aria-label="${isCollapsed ? 'Show shift breakdown' : 'Hide shift breakdown'} for ${escapeHtml(r.machineCode)}" title="Toggle Day / Afternoon / Night breakdown">${
              isCollapsed ? '+' : '–'
            }</button>`
          : '';
        const ordersToggle = hasData
          ? `<button type="button" class="kpi-toggle kpi-orders-toggle" data-orders="${escapeHtml(
              r.machineCode,
            )}" aria-label="${ordersOpen ? 'Hide' : 'Show'} per-order rollup for ${escapeHtml(r.machineCode)}" title="Toggle per-Job# rollup across all shifts in this period">${
              ordersOpen ? '⌄' : '›'
            }</button>`
          : '';
        const headRow = `<tr class="kpi-machine">
          <th>${toggle}${ordersToggle}<span class="kpi-mc-name">${escapeHtml(r.machineCode)}</span></th>
          ${colorCell()}
          ${aggCells(r.total, null, true, r.machineCode, r.machineCode)}
          ${formatHandoverCell(r.machineCode, r.handovers)}
        </tr>`;
        const orderRows = ordersOpen
          ? r.byJobTotal
              .map((j) => {
                const fullDesc = `${j.jobNumber}${
                  j.partDescShort ? ' — ' + j.partDescShort : ''
                } (period total) · ${finishedLabel(j.lastRunAt)}`;
                return `<tr class="kpi-job kpi-order-total">
                  ${jobNameTh(j.jobNumber, j.partDescShort, fullDesc)}
                  ${colorCell(j.color)}
                  ${aggCells(j.agg, null, false)}
                  ${emptyHandoverCell()}
                </tr>`;
              })
              .join('')
          : '';
        if (isCollapsed) return headRow + orderRows;
        const shiftRows = SHIFT_ORDER.map((code) => {
          const a = r.byShift[code];
          const jobs = r.jobsByShift[code];
          const expandKey = `${r.machineCode}|${code}`;
          const jobsOpen = S!.jobsExpanded.has(expandKey);
          // ▸ when collapsed, ▾ when open. Hide the chevron entirely if the
          // shift has no per-job split (no records logged), to avoid an
          // un-actionable click target.
          const chev = jobs.length
            ? `<button type="button" class="kpi-job-toggle" data-jobs="${escapeHtml(expandKey)}" aria-label="${
                jobsOpen ? 'Hide' : 'Show'
              } jobs for ${escapeHtml(code)}">${jobsOpen ? '▾' : '▸'}</button>`
            : '<span class="kpi-job-toggle ph"></span>';
          const shiftRow = `<tr class="kpi-shift">
            <th class="kpi-shift-name">${chev}${escapeHtml(code)}</th>
            ${colorCell()}
            ${aggCells(a, null, false)}
            ${emptyHandoverCell()}
          </tr>`;
          if (!jobsOpen) return shiftRow;
          const jobRows = jobs
            .map((j) => {
              const fullDesc = `${j.jobNumber}${
                j.partDescShort ? ' — ' + j.partDescShort : ''
              } · ${finishedLabel(j.lastRunAt)}`;
              return `<tr class="kpi-job">
                ${jobNameTh(j.jobNumber, j.partDescShort, fullDesc)}
                ${colorCell(j.color)}
                ${aggCells(j.agg, null, false)}
                ${emptyHandoverCell()}
              </tr>`;
            })
            .join('');
          return shiftRow + jobRows;
        }).join('');
        return headRow + orderRows + shiftRows;
      })
      .join('');
    // Category subtotals close the body, directly above the sticky
    // grand-TOTAL footer. One row per PMD_ProductDieColor.Category that
    // saw production this period; "Other" collects uncategorised parts.
    body += S!.catTotals
      .map(
        (c, i) => `<tr class="kpi-cat-total${i === 0 ? ' kpi-cat-first' : ''}">
          <th>${escapeHtml(c.category)}</th>
          ${colorCell()}
          ${aggCells(c.agg, null, false)}
          ${emptyHandoverCell()}
        </tr>`,
      )
      .join('');
  }

  // Charts: one bucket per date with shift segments. Output (stacked by
  // shift) + Reject line; Run/Down/Setup (stacked) + OEE line. Each chart
  // sums every machine in the period — total floor view.
  //
  // Over a range that crosses a month boundary the days are rolled up to
  // months (see core/chartrollup.ts) — 90 daily bars in a card this wide
  // is a smear, not a trend — leaving the newest month on daily bars and
  // letting any earlier month be opened to its days by clicking it.
  const rolled = spansMonths(S!.chartBuckets);
  const displayBuckets: DisplayBucket[] = rolled
    ? rollUpByMonth(S!.chartBuckets, S!.expandedMonths)
    : S!.chartBuckets.map((b) => ({ ...b, month: monthOf(b.key), isMonth: false, days: 1 }));
  const multiYear = new Set(S!.chartBuckets.map((b) => b.key.slice(0, 4))).size > 1;
  // Only bars that actually toggle something are clickable: a month bar
  // opens, a day of an OPENED month closes it again. Days of the newest
  // month have nothing to toggle and stay inert rather than offering a
  // click that would do nothing.
  const chartMeta = displayBuckets.map((b) => {
    if (b.isMonth) {
      return {
        clickKey: b.month,
        title: `${monthLabel(b.month, multiYear)} — ${b.days} day${
          b.days === 1 ? '' : 's'
        } summed. Click to open the daily bars.`,
      };
    }
    if (S!.expandedMonths.has(b.month)) {
      return {
        clickKey: b.month,
        title: `${b.key} · part of ${monthLabel(
          b.month,
          multiYear,
        )}, opened. Click to roll the month back up.`,
      };
    }
    return { clickKey: undefined, title: undefined };
  });
  const outChartData = displayBuckets.map((b, i) => ({
    ...chartMeta[i],
    label: b.label,
    day: b.byShift.Day.good,
    afternoon: b.byShift.Afternoon.good,
    night: b.byShift.Night.good,
    reject: b.byShift.Day.reject + b.byShift.Afternoon.reject + b.byShift.Night.reject,
  }));
  const hoursChartData = displayBuckets.map((b, i) => {
    const run = b.byShift.Day.runHrs + b.byShift.Afternoon.runHrs + b.byShift.Night.runHrs;
    const down = b.byShift.Day.downHrs + b.byShift.Afternoon.downHrs + b.byShift.Night.downHrs;
    const setup = b.byShift.Day.setupHrs + b.byShift.Afternoon.setupHrs + b.byShift.Night.setupHrs;
    const logged = run + down + setup;
    // Ratio of the sums on a month bar too, so a month with one busy week
    // and three quiet ones reads as the month it was.
    const oee = logged > 0 ? Math.round((run / logged) * 100) : null;
    return { ...chartMeta[i], label: b.label, run, down, setup, oee };
  });
  // Reject Pareto counts + shift/status splits come from PMD_Rejects; its
  // legend resolves RejectCode through PMD_RejectCategories and displays
  // RejectCategory separately as MachineStatus context. Downtime Pareto
  // comes from PMD_BreakDownlog (BDCode bars + cause legend). Either chart
  // independently hides when its source list returns nothing.
  // Stack the floor Reject Pareto by shift when PMD_Rejects carried the
  // Shift split (SharePoint backend); fall back to the single-colour bar
  // when no slice has a byShift breakdown (memory DAL / older data).
  const rejectHasShiftSplit = S!.rejectPareto.floor.some((s) => s.byShift);
  const rejectChart = S!.rejectPareto.floor.length
    ? `<div class="kpi-chart">
          <h4>Reject Pareto — RejectCode${
            rejectHasShiftSplit ? ' by shift' : ''
          } · MachineStatus context below (click a Reject number to drill)</h4>
          ${
            rejectHasShiftSplit
              ? renderParetoByShiftChart(toParetoShiftBuckets(S!.rejectPareto.floor))
              : renderParetoChart(toParetoBuckets(S!.rejectPareto.floor))
          }
          ${renderParetoLegend(S!.rejectPareto.floor)}
        </div>`
    : '';
  const downtimeChart = S!.downtimePareto.floor.length
    ? `<div class="kpi-chart">
          <h4>Downtime Pareto — BDCode (click a Down h number in the table to drill)</h4>
          ${renderParetoChart(toParetoBuckets(S!.downtimePareto.floor, 'h'))}
          ${renderParetoLegend(S!.downtimePareto.floor, 'h')}
        </div>`
    : '';
  // Distribution of how long each kind of stoppage actually takes.
  // Supervisor-only: it is a "why are we slow" chart, and it names the
  // press and order behind every outlier — the conversation an operator
  // should be having with their supervisor, not reading off a board.
  const stoppageChart = isSupervisor() && S!.changeoverEvents.length
    ? `<div class="kpi-chart kpi-chart-box">
          <h4>Changeover &amp; breakdown duration spread 🔒 — box = middle half, line = median, dots = outliers (hover names the press and order)</h4>
          ${renderBoxPlotChart(changeoverBoxSeries(S!.changeoverEvents))}
          <div class="kpi-chart-note">
            One D / C / I per order counts as a single changeover however
            many pieces the sheet recorded it in; each unbroken run of B is
            one breakdown. Dashed “std” = the floor allowance (die 4 h ·
            colour 0.5 h · insert 0.5 h); breakdowns have none.
          </div>
          ${
            dalRef.updateDieMaster
              ? `<button type="button" class="btn kpi-median-import" data-import-die-medians
                   title="Write each die's median CHANGEOVER hours to PMD_DieMaster.ChangeOverMedian — preview first">
                   ⤓ Import die medians → PMD_DieMaster
                 </button>`
              : ''
          }
        </div>`
    : '';
  // One line above both trend charts explaining the rollup, plus a chip
  // per opened month so a month can be closed from the text as well as
  // from its bars — after opening two or three, the bars alone stop being
  // an obvious way back. It spans the grid rather than sitting in each
  // card: the two charts share one setting, and printing the same
  // paragraph twice side by side reads as a mistake.
  const openChips = [...S!.expandedMonths]
    .sort()
    .map(
      (m) =>
        `<button type="button" class="kpi-month-chip" data-collapse-month="${escapeHtml(
          m,
        )}" title="Roll ${monthLabel(m, multiYear)} back up to one bar">${escapeHtml(
          monthLabel(m, multiYear),
        )} ✕</button>`,
    )
    .join('');
  const rollupNote = rolled
    ? `<div class="kpi-chart-note kpi-rollup-note">
         📅 Range crosses a month, so earlier months are summed into one bar
         each and <b>${escapeHtml(
           monthLabel(monthOf(S!.chartBuckets[S!.chartBuckets.length - 1].key), multiYear),
         )}</b> is shown by day. <b>Click a month</b> to open its days, click
         them again to close — both charts below follow the same setting.
         ${openChips ? `<span class="kpi-month-chips">Open: ${openChips}</span>` : ''}
       </div>`
    : '';
  const charts = S!.loading || S!.chartBuckets.length === 0
    ? ''
    : `<div class="kpi-charts">
        ${rollupNote}
        <div class="kpi-chart">
          <h4>Output by shift (stacked) vs Reject${rolled ? ' — by month' : ''}</h4>
          ${renderOutputByShiftChart(outChartData)}
        </div>
        <div class="kpi-chart">
          <h4>Run / Down / Setup hours (stacked) vs Efficiency${rolled ? ' — by month' : ''}</h4>
          ${renderHoursOeeChart(hoursChartData)}
        </div>
        ${rejectChart}
        ${downtimeChart}
        ${stoppageChart}
      </div>`;

  // Headline stat tiles — the numbers a daily production meeting opens
  // with, readable from the back of the room before anyone drills into
  // the per-machine table.
  const asAt = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  const stat = (label: string, value: string, cls = ''): string =>
    `<div class="kpi-stat${cls ? ' ' + cls : ''}"><span class="kpi-stat-label">${escapeHtml(
      label,
    )}</span><b class="kpi-stat-value">${value}</b></div>`;
  const totPlanPct =
    tot.expOutput != null && tot.expOutput > 0
      ? Math.round((tot.output / tot.expOutput) * 100)
      : null;
  const stats = S!.loading
    ? ''
    : `<div class="kpi-stats">
        ${stat('Output', tot.output ? String(tot.output) : '—')}
        ${stat(
          'vs Plan',
          totPlanPct != null ? totPlanPct + '%' : '—',
          totPlanPct != null ? 'is-' + planColourClass(totPlanPct, S!.thresholds) : '',
        )}
        ${stat('Reject', tot.reject ? String(tot.reject) : '—', 'is-red')}
        ${stat('Yield', totYield != null ? totYield + '%' : '—', totYield != null ? 'is-' + colourClass(+totYield, S!.thresholds.yieldGreen, S!.thresholds.yieldAmber) : '')}
        ${stat('Run hours', tot.runHrs ? tot.runHrs.toFixed(1) : '—', 'is-green')}
        ${stat('Down hours', tot.downHrs ? tot.downHrs.toFixed(1) : '—', tot.downHrs ? 'is-red' : '')}
        ${(() => {
          // C/O tile judged like the table cells: within the combined
          // die+colour+insert standard is green, a little over amber, worse
          // red (setupJudgement's 'blue' remapped to green — no plan-blue
          // on changeover).
          const coStd = (tot.dieStdHrs ?? 0) + (tot.colorStdHrs ?? 0) + (tot.insertStdHrs ?? 0);
          const coCls = tot.setupHrs ? setupJudgement(tot.setupHrs, coStd).replace('blue', 'green') : '';
          return stat('C/O hours', tot.setupHrs ? tot.setupHrs.toFixed(1) : '—', coCls ? 'is-' + coCls : '');
        })()}
        ${stat('Efficiency*', totOee != null ? totOee + '%' : '—', totOee != null ? 'is-' + colourClass(totOee, S!.thresholds.effGreen, S!.thresholds.effAmber) : '')}
      </div>`;

  // From/To always reflect the active window: for a preset tab they mirror
  // the computed range (read-only intent, but still editable — editing
  // drops to a custom range); under a custom range they show the picked
  // bounds. periodRange returns Date objects, so key them to YYYY-MM-DD.
  const activeRange = periodRange(S!.period, new Date());
  const fromVal = S!.period === 'custom' ? S!.customFrom : dateKey(activeRange.from);
  const toVal = S!.period === 'custom' ? S!.customTo : dateKey(activeRange.to);
  app.innerHTML = `
    <div class="kpi">
      <div class="kpi-head">
        <div class="shift-tabs">${tabs}</div>
        <div class="kpi-range" title="Signed-off shifts only · as at ${escapeHtml(asAt)}">
          <label>From <input type="date" data-range="from" value="${escapeHtml(fromVal)}"></label>
          <label>To <input type="date" data-range="to" value="${escapeHtml(toVal)}"></label>
        </div>
      </div>
      ${errorBanner}
      ${buildThresholdEditor()}
      ${stats}
      <div class="kpi-table-wrap">
        <table class="summary-table kpi-table">
          <colgroup>
            <col class="kpi-col-machine">
            <col class="kpi-col-color">
            <col span="11" class="kpi-col-metric">
            <col class="kpi-col-handover">
          </colgroup>
          <thead><tr>
            <th class="kpi-machine-head">Machine
              <button type="button" class="kpi-toggle kpi-toggle-all" data-toggle-all-shifts title="Toggle shift breakdown on every machine">${allShiftsGlyph}</button>
              <button type="button" class="kpi-toggle kpi-toggle-all kpi-orders-toggle" data-toggle-all-orders title="Toggle per-order rollup on every machine">${allOrdersGlyph}</button>
            </th><th class="kpi-color-head">Color</th>
            <th>Output</th><th>Reject</th><th>Yield%</th>
            <th>Run h</th><th>Down h</th>
            <th title="S — Startup / warm-up">Startup h</th>
            <th title="D — Die change">Die h</th>
            <th title="C — Colour change">Colour h</th>
            <th title="I — Insert change">Insert h</th>
            <th>Efficiency*</th><th title="Total Good ÷ expected (Σ Shift Targets of the orders run; planning fallback)">vs Plan</th>
            <th class="kpi-ho-head">Handover</th>
          </tr></thead>
          <tbody>${body}</tbody>
          ${
            S!.loading
              ? ''
              : (() => {
                  const tn = (v: number): string => (v ? String(v) : '—');
                  const th = (v: number): string => (v ? v.toFixed(1) : '—');
                  const totPct =
                    tot.expOutput != null && tot.expOutput > 0
                      ? Math.round((tot.output / tot.expOutput) * 100)
                      : null;
                  const totCls = planColourClass(totPct, S!.thresholds);
                  return `<tfoot><tr class="kpi-total">
                    <th>TOTAL</th>
                    ${colorCell()}
                    <td class="num ${totCls}"${
                      totPct != null
                        ? ` title="Expected ≈ ${tot.expOutput} pcs floor-wide — actual ${tot.output} = ${totPct}%"`
                        : ''
                    }>${tn(tot.output)}${
                      tot.expOutput != null && tot.expOutput > 0
                        ? ` <span class="kpi-exp">/${tot.expOutput}</span>`
                        : ''
                    }</td>
                    ${rejectCell(tot.reject, tot.shifts, 'FLOOR')}
                    <td class="num">${totYield != null ? totYield + '%' : '—'}</td>
                    <td class="num">${th(tot.runHrs)}</td>
                    ${downHrsCell(tot.downHrs, 'FLOOR')}
                    <td class="num">${th(tot.startupHrs)}</td>
                    ${setupCell(tot.dieHrs, tot.dieStdHrs, DIE_CHANGE_STD_HRS, 'Die change')}
                    ${setupCell(tot.colorHrs, tot.colorStdHrs, COLOR_CHANGE_STD_HRS, 'Colour change')}
                    ${setupCell(tot.insertHrs, tot.insertStdHrs, INSERT_CHANGE_STD_HRS, 'Insert change')}
                    <td class="num">—</td>
                    <td class="num ${totCls}">${totPct == null ? '—' : totPct + '%'}</td>
                    <td class="kpi-ho-cell muted">—</td>
                  </tr></tfoot>`;
                })()
          }
        </table>
      </div>
      ${charts}
      <div class="kpi-note">
        <div>Every metric uses one traffic-light language: <b>🟢 met · 🟡 close · 🔴 short</b>.</div>
        <div><b>Output 🟢🟡🔴</b> = Σ Total Good vs expected (the small “/n”). Expected = Σ Shift Target of the orders run that shift — per job the smaller of its Job Left at shift start and ⌊(8 h − hours held by earlier orders − changeover D/C/I) ÷ ProdStandard⌋, i.e. the very target the operator sheet showed. Shifts signed before Job Left / CycleTime were recorded fall back to simulating the machine's planned order queue (window = 8 h − Σ changeover standards − smoko; per order capped by its remaining qty).</div>
        <div><b>Yield%</b> = Good ÷ (Good + Reject).</div>
        <div><b>Reject 🟢🔴</b> = judged per shift: 🟢 up to ${REJECT_PER_SHIFT_MAX} rejects a shift, 🔴 above. Rows covering several shifts (machine, order, TOTAL) scale the allowance by the shifts they roll up, so a machine isn't red for three green shifts.</div>
        <div><b>Startup h</b> = hours in S blocks (warm-up). Counted separately from the D / C / I changeover columns.</div>
        <div><b>Efficiency*</b> = Run slots ÷ all filled slots.</div>
        <div><b>vs Plan 🟢🟡🔴</b> = Total Good ÷ the same expectation the Output cell shows (Σ Shift Targets, planning fallback) — the percentage form of Output's “/n”.</div>
        <div><b>Die / Colour / Insert h 🟢🟡🔴</b> = hours in D / C / I blocks vs standard = changeovers × (die 4 h · colour 0.5 h · insert 0.5 h); 🟢 ≤ std, 🟡 ≤ std + 0.5 h, 🔴 above. <b>One changeover per order</b> — a die change the sheet logged in two pieces earns one 4 h allowance, not two.</div>
        <div>Colour thresholds for Output / Yield / Efficiency are editable in the panel above. Shift sub-rows show each shift's contribution to the period total.</div>
      </div>
    </div>`;

  wireKpiNavigation(app);
  app.querySelectorAll<HTMLInputElement>('[data-range]').forEach((el) =>
    el.addEventListener('change', () => {
      const v = el.value;
      if (!v) return;
      // Editing either date drops the active preset into a custom range.
      // Seed both bounds from what the inputs currently show so the first
      // edit doesn't reach back to a stale week-ago default.
      if (S!.period !== 'custom') {
        const r = periodRange(S!.period, new Date());
        S!.customFrom = dateKey(r.from);
        S!.customTo = dateKey(r.to);
        S!.period = 'custom';
      }
      if (el.dataset.range === 'from') {
        S!.customFrom = v;
        if (S!.customTo < v) S!.customTo = v; // keep from ≤ to
      } else {
        S!.customTo = v;
        if (v < S!.customFrom) S!.customFrom = v;
      }
      S!.loading = true;
      render();
      void compute();
    }),
  );
  app.querySelectorAll<HTMLInputElement>('[data-th]').forEach((el) =>
    el.addEventListener('change', () => {
      const key = el.dataset.th as keyof KpiThresholds;
      const v = Math.max(0, Math.min(100, Math.round(Number(el.value) || 0)));
      S!.thresholds = { ...S!.thresholds, [key]: v };
      saveThresholds(S!.thresholds);
      // Recolour only — no data refetch needed.
      render();
    }),
  );
  app.querySelector<HTMLButtonElement>('[data-th-reset]')?.addEventListener('click', () => {
    S!.thresholds = { ...DEFAULT_THRESHOLDS };
    saveThresholds(S!.thresholds);
    render();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const mc = b.dataset.toggle!;
      if (S!.collapsed.has(mc)) S!.collapsed.delete(mc);
      else S!.collapsed.add(mc);
      render();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-job-trace]').forEach((b) =>
    b.addEventListener('click', () => void openJobTrace(b.dataset.jobTrace!)),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-handover-machine]').forEach((b) =>
    b.addEventListener('click', () => {
      const machineCode = b.dataset.handoverMachine!;
      const row = S!.rows.find((r) => r.machineCode === machineCode);
      if (row?.handovers.length) openHandoverDetail(machineCode, row.handovers);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-reject-drill]').forEach((b) =>
    b.addEventListener('click', () => openRejectDrill(b.dataset.rejectDrill!)),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-downtime-drill]').forEach((b) =>
    b.addEventListener('click', () => openDowntimeDrill(b.dataset.downtimeDrill!)),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-jobs]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.jobs!;
      if (S!.jobsExpanded.has(key)) S!.jobsExpanded.delete(key);
      else S!.jobsExpanded.add(key);
      render();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-orders]').forEach((b) =>
    b.addEventListener('click', () => {
      const mc = b.dataset.orders!;
      if (S!.ordersExpanded.has(mc)) S!.ordersExpanded.delete(mc);
      else S!.ordersExpanded.add(mc);
      render();
    }),
  );
  const allShiftsBtn = app.querySelector<HTMLButtonElement>('[data-toggle-all-shifts]');
  if (allShiftsBtn) {
    allShiftsBtn.addEventListener('click', () => {
      // Only flip machines that have data — empties have no + chevron
      // and aren't tracked anyway.
      const targets = S!.rows
        .filter((r) => r.byJobTotal.length > 0)
        .map((r) => r.machineCode);
      if (S!.collapsed.size > 0) S!.collapsed = new Set();
      else S!.collapsed = new Set(targets);
      render();
    });
  }
  const allOrdersBtn = app.querySelector<HTMLButtonElement>('[data-toggle-all-orders]');
  if (allOrdersBtn) {
    allOrdersBtn.addEventListener('click', () => {
      const targets = S!.rows.filter((r) => r.byJobTotal.length > 0).map((r) => r.machineCode);
      if (S!.ordersExpanded.size < targets.length) S!.ordersExpanded = new Set(targets);
      else S!.ordersExpanded = new Set();
      render();
    });
  }
  app
    .querySelector<HTMLButtonElement>('[data-import-die-medians]')
    ?.addEventListener('click', () => void openDieMedianImport());

  // Month rollup: a bar carrying data-bucket toggles its month open or
  // closed. Delegated per chart rather than bound per <rect> — both trend
  // charts emit the same keys, and re-render replaces every node anyway.
  // Keyboard parity comes free: the hit target is a focusable role=button,
  // so Enter/Space reach the same handler.
  const toggleMonth = (m: string): void => {
    if (!m) return;
    if (S!.expandedMonths.has(m)) S!.expandedMonths.delete(m);
    else S!.expandedMonths.add(m);
    render();
  };
  app.querySelectorAll<SVGElement>('.chart-hit[data-bucket]').forEach((hit) => {
    hit.addEventListener('click', () => toggleMonth(hit.dataset.bucket ?? ''));
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleMonth(hit.dataset.bucket ?? '');
    });
  });
  app
    .querySelectorAll<HTMLButtonElement>('[data-collapse-month]')
    .forEach((b) => b.addEventListener('click', () => toggleMonth(b.dataset.collapseMonth!)));
}

/**
 * Preview then write the observed die-change medians onto
 * PMD_DieMaster.ChangeOverMedian.
 *
 * A preview rather than a bare confirm: this writes to a list the
 * toolroom reads and edits by hand, so the supervisor gets to see every
 * die, its current value, the new one and how many changeovers it was
 * measured from BEFORE anything leaves the browser. Dies whose value is
 * already correct are listed but not written — there is no reason to
 * touch a row to set it to what it already says.
 */
async function openDieMedianImport(): Promise<void> {
  const medians = dieChangeoverMedians(S!.changeoverEvents, S!.dieByJob);
  const master = dalRef.listDieMaster ? await dalRef.listDieMaster().catch(() => []) : [];
  const byDie = new Map(master.map((m) => [m.dieNumber.trim().toUpperCase(), m]));
  const rows = medians.map((m) => {
    const row = byDie.get(m.dieNumber.trim().toUpperCase());
    return {
      ...m,
      known: !!row,
      current: row?.changeOverMedian ?? null,
      nominal: row?.changeOverIn ?? null,
    };
  });
  // Only dies the register actually has a row for can be written; the
  // rest are shown so a missing tool is visible rather than silently
  // dropped.
  const writable = rows.filter((r) => r.known && r.current !== r.medianHrs);
  const missing = rows.filter((r) => !r.known);
  const mc = openModal(`<div class="bd-modal kpi-median-modal">
    <div class="bd-head">
      <h2 class="bd-title">Import die-change medians → PMD_DieMaster.ChangeOverMedian</h2>
      <button type="button" class="btn" data-median-close>Close</button>
    </div>
    <p class="kpi-median-intro">
      Median hours per die over the selected window, from signed-off
      production only. <b>${writable.length}</b> of ${rows.length} die${
        rows.length === 1 ? '' : 's'
      } would change.
    </p>
    <div class="kpi-median-scroll"><table class="kpi-median-table">
      <thead><tr><th>Die</th><th class="num">Nominal in</th><th class="num">Current</th><th class="num">New median</th><th class="num">Changeovers</th><th></th></tr></thead>
      <tbody>${
        rows.length
          ? rows
              .map(
                (r) => `<tr class="${r.known ? (r.current === r.medianHrs ? 'is-same' : '') : 'is-missing'}">
                  <td>${escapeHtml(r.dieNumber)}</td>
                  <td class="num">${r.nominal == null ? '—' : r.nominal.toFixed(2)}</td>
                  <td class="num">${r.current == null ? '—' : r.current.toFixed(2)}</td>
                  <td class="num"><b>${r.medianHrs.toFixed(2)}</b></td>
                  <td class="num">${r.events}</td>
                  <td>${
                    !r.known
                      ? 'no PMD_DieMaster row'
                      : r.current === r.medianHrs
                        ? 'unchanged'
                        : 'will write'
                  }</td>
                </tr>`,
              )
              .join('')
          : `<tr><td colspan="6">No die change was observed in this window — nothing to import.</td></tr>`
      }</tbody>
    </table></div>
    <div class="kpi-median-actions">
      <span class="kpi-median-status" data-median-status>${
        missing.length ? `${missing.length} die(s) have no PMD_DieMaster row and will be skipped.` : ''
      }</span>
      <button type="button" class="btn primary" data-median-write ${
        writable.length ? '' : 'disabled'
      }>Write ${writable.length} row${writable.length === 1 ? '' : 's'}</button>
    </div>
  </div>`);
  mc.querySelector('[data-median-close]')?.addEventListener('click', () => closeModal());
  const status = mc.querySelector<HTMLElement>('[data-median-status]');
  const write = mc.querySelector<HTMLButtonElement>('[data-median-write]');
  write?.addEventListener('click', async () => {
    if (!dalRef.updateDieMaster) {
      toast('This backend cannot write PMD_DieMaster', 'err');
      return;
    }
    write.disabled = true;
    let done = 0;
    const failed: string[] = [];
    for (const r of writable) {
      if (status) status.textContent = `Writing ${done + 1} of ${writable.length}…`;
      try {
        await dalRef.updateDieMaster(r.dieNumber, { changeOverMedian: r.medianHrs });
        done++;
      } catch (e) {
        // Keep going: one unwritable row shouldn't cost the other 40.
        console.warn('[pmd] ChangeOverMedian write failed for', r.dieNumber, e);
        failed.push(r.dieNumber);
      }
    }
    if (status) {
      status.textContent = failed.length
        ? `Wrote ${done}; failed on ${failed.join(', ')}`
        : `Wrote ${done} row${done === 1 ? '' : 's'}.`;
    }
    toast(
      failed.length ? `ChangeOverMedian: ${done} written, ${failed.length} failed` : `ChangeOverMedian updated on ${done} die${done === 1 ? '' : 's'}`,
      failed.length ? 'warn' : 'ok',
    );
  });
}

/** Compact code → "code label value(%)" legend under a Pareto chart, so
 *  bars (labelled by short code on the x-axis) are readable without a
 *  tooltip. `unit` is appended to the value ('' for counts, 'h' for hours). */
function renderParetoLegend(slices: ParetoSlice[], unit = ''): string {
  if (slices.length === 0) return '';
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const items = slices
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.code)}</b> ${escapeHtml(s.label)} <span class="kpi-rej-qty">${formatValue(
          s.value,
          unit,
        )}</span> <span class="muted">(${((s.value / total) * 100).toFixed(0)}%)</span>${renderRejectStatusBadges(
          s,
        )}</li>`,
    )
    .join('');
  return `<ul class="kpi-reject-legend">${items}</ul>`;
}

/** Replace any legacy/misinterpreted PMD_Rejects.RejectCategory label with
 *  the real RejectCode description. R/B/C/D/I/M/O/P/S stay available in
 *  `byStatus` as valuable occurrence context; they are simply not defect
 *  names. Pure and exported for regression tests. */
export function applyRejectDescriptions(
  slices: ReadonlyArray<ParetoSlice>,
  descriptions: ReadonlyMap<string, string>,
): ParetoSlice[] {
  const isMachineStatus = (label: string): boolean => /^[RBCDIMOPS]$/.test(label.trim());
  return slices.map((s) => {
    const fromMaster = (
      descriptions.get(s.code) ?? descriptions.get(s.code.trim().toUpperCase())
    )?.trim();
    const existing = s.label?.trim() ?? '';
    const label = fromMaster || (!existing || isMachineStatus(existing) ? s.code : existing);
    return { ...s, label };
  });
}

const REJECT_STATUS_ORDER: Array<StatusCode | 'Unknown'> = [
  'R',
  'S',
  'B',
  'C',
  'D',
  'I',
  'M',
  'P',
  'O',
  'Unknown',
];

/** Quantifies the action signal without inventing a plant-specific alarm
 *  threshold. Managers see the raw R quantity and its share, then decide
 *  whether the volume warrants Take Action. */
export function rejectActionContext(slice: ParetoSlice): {
  runningQty: number;
  startupQty: number;
  unknownQty: number;
  statusTotal: number;
  runningPct: number | null;
} {
  const runningQty = slice.byStatus?.R ?? 0;
  const startupQty = slice.byStatus?.S ?? 0;
  const unknownQty = slice.byStatus?.Unknown ?? 0;
  const statusTotal = Object.values(slice.byStatus ?? {}).reduce(
    (sum, qty) => sum + (Number(qty) || 0),
    0,
  );
  return {
    runningQty,
    startupQty,
    unknownQty,
    statusTotal,
    runningPct: statusTotal > 0 ? Math.round((runningQty / statusTotal) * 100) : null,
  };
}

function renderRejectStatusBadges(slice: ParetoSlice): string {
  const badges = REJECT_STATUS_ORDER.flatMap((code) => {
    const qty = slice.byStatus?.[code] ?? 0;
    if (qty <= 0) return [];
    const label =
      code === 'Unknown'
        ? 'Unknown machine status'
        : code === 'S'
          ? 'Startup / Shutdown'
          : STATUS_MAP[code]?.label ?? code;
    const cls =
      code === 'R'
        ? ' is-running'
        : code === 'S'
          ? ' is-startup'
          : code === 'Unknown'
            ? ' is-unknown'
            : ' is-context';
    return [
      `<span class="kpi-reject-status${cls}" title="${escapeHtml(
        label,
      )}">${escapeHtml(code)} <b>${qty}</b></span>`,
    ];
  }).join('');
  return badges ? `<span class="kpi-reject-statuses">${badges}</span>` : '';
}

/** Standard Pareto bar scale: Top 1 fills the track and every other row is
 * proportional to it. Exported so the visual rule has a regression test. */
export function paretoRelativeBarWidth(value: number, topValue: number): number {
  if (!isFinite(value) || !isFinite(topValue) || value <= 0 || topValue <= 0) return 0;
  return Math.max(0, Math.min(100, (value / topValue) * 100));
}

/** Same stacked MachineStatus bar used by the Die detail Pareto. The outer
 * fill is scaled against the Top-1 reject code; inside that fill, segment
 * widths are each MachineStatus quantity's share. */
function renderRejectStatusBar(
  slice: ParetoSlice,
  barWidthPct: number,
  paretoPct: number,
): string {
  const split = Object.entries(slice.byStatus ?? {})
    .map(([status, qty]) => [status, Number(qty) || 0] as const)
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = split.reduce((sum, [, qty]) => sum + qty, 0);
  if (total <= 0) return '';
  const statusTip = split
    .map(([status, qty]) => `${STATUS_MAP[status]?.label ?? status} ×${qty}`)
    .join(' · ');
  const tip = `${statusTip} · ${paretoPct.toFixed(1)}% of rejects`;
  const segments = split
    .map(([status, qty]) => {
      const meta = STATUS_MAP[status];
      const width = (qty / total) * 100;
      const paint = meta
        ? `;background:${meta.color};border-color:${meta.border};color:${meta.text}`
        : '';
      return `<i class="die-bar-seg" style="width:${width}%${paint}">${
        width >= 8 ? escapeHtml(status) : ''
      }</i>`;
    })
    .join('');
  return `<span class="die-bar-track" role="img" aria-label="${escapeHtml(
    tip,
  )}" title="${escapeHtml(tip)}"><span class="die-bar-fill" style="width:${Math.max(
    0,
    Math.min(100, barWidthPct),
  )}%">${segments}</span></span>`;
}

/** Shape slices for renderParetoChart: short code on the x-axis, value
 *  unchanged. Unit is only used at render time, not in the chart input. */
function toParetoBuckets(
  slices: ParetoSlice[],
  _unit = '',
): Array<{ label: string; value: number }> {
  return slices.map((s) => ({ label: s.code, value: s.value }));
}

/** Shape slices for renderParetoByShiftChart: short code on the x-axis,
 *  Day/Afternoon/Night split from the slice's byShift breakdown (0 when
 *  a shift saw no rejects for that code). */
function toParetoShiftBuckets(
  slices: ParetoSlice[],
): Array<{ label: string; day: number; afternoon: number; night: number }> {
  return slices.map((s) => ({
    label: s.code,
    day: s.byShift?.Day ?? 0,
    afternoon: s.byShift?.Afternoon ?? 0,
    night: s.byShift?.Night ?? 0,
  }));
}

function formatValue(v: number, unit: string): string {
  if (unit === 'h') return `${v.toFixed(1)}h`;
  return String(v);
}

/** Drill-down: a Pareto for one scope (a machine, or the whole floor).
 *  Used by both Reject and Downtime drills — same table shape, only the
 *  column headers and value unit change. */
function openParetoDrill(opts: {
  title: string;
  unit: '' | 'h';
  valueLabel: string;
  source: { floor: ParetoSlice[]; byMachine: Map<string, ParetoSlice[]> };
  scopeKey: string;
  showRejectStatus?: boolean;
  showChart?: boolean;
}): void {
  const slices =
    opts.scopeKey === 'FLOOR'
      ? opts.source.floor
      : opts.source.byMachine.get(opts.scopeKey) ?? [];
  const scopeLabel = opts.scopeKey === 'FLOOR' ? 'All machines' : opts.scopeKey;
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) return;
  const topValue = Math.max(...slices.map((s) => s.value));
  let cum = 0;
  const rows = slices
    .map((s, i) => {
      cum += s.value;
      const pctValue = (s.value / total) * 100;
      const pct = pctValue.toFixed(1);
      const cumPct = ((cum / total) * 100).toFixed(1);
      const statusCells = opts.showRejectStatus
        ? `<td>${
            renderRejectStatusBar(s, paretoRelativeBarWidth(s.value, topValue), pctValue) ||
            '<span class="muted">—</span>'
          }</td>`
        : '';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td><b>${escapeHtml(s.code)}</b></td>
        <td>${escapeHtml(s.label)}</td>
        ${statusCells}
        <td class="num r">${formatValue(s.value, opts.unit)}</td>
        <td class="num">${pct}%</td>
        <td class="num">${cumPct}%</td>
      </tr>`;
    })
    .join('');
  const chart =
    opts.showChart === false
      ? ''
      : `<div class="kpi-drill-chart">${renderParetoChart(toParetoBuckets(slices))}</div>`;
  const totalDisplay = formatValue(+total.toFixed(2), opts.unit);
  const statusHeads = opts.showRejectStatus ? '<th>MachineStatus at defect</th>' : '';
  const contextNote = opts.showRejectStatus
    ? ' · R = during production (review volume/ratio) · S = Startup / Shutdown context'
    : '';
  const totalSpan = opts.showRejectStatus ? 4 : 3;
  const mc = openModal(`<div class="bd-modal kpi-drill-modal${
    opts.showRejectStatus ? ' kpi-reject-drill-modal' : ''
  }">
    <h2 class="bd-title">🔬 ${escapeHtml(opts.title)} — ${escapeHtml(scopeLabel)}</h2>
    <p class="bd-sub">${totalDisplay} across ${slices.length} code${
      slices.length === 1 ? '' : 's'
    } · ${escapeHtml(periodRange(S!.period, new Date()).label)}${contextNote}</p>
    ${chart}
    <table class="summary-table kpi-drill-table">
      <thead><tr><th>#</th><th>Code</th><th>${escapeHtml(
        opts.valueLabel,
      )}</th>${statusHeads}<th>Value</th><th>%</th><th>Cum %</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="kpi-total"><th colspan="${totalSpan}">TOTAL</th><td class="num r">${totalDisplay}</td><td class="num">100%</td><td class="num">—</td></tr></tfoot>
    </table>
    <div class="bd-actions"><button class="btn-primary-big" data-drill-close>Close</button></div>
  </div>`);
  mc.querySelector('[data-drill-close]')?.addEventListener('click', closeModal);
}

/** Job-number popup: the same slot-by-slot Trace cards the Trace tab
 *  shows, rendered in a modal so a supervisor can drill from a KPI number
 *  into what actually happened on the floor without leaving the meeting
 *  view. Loads asynchronously (shows a spinner first). */
async function openJobTrace(jobNumber: string): Promise<void> {
  const mc = openModal(`<div class="bd-modal kpi-trace-modal">
    <div class="kpi-trace-head">
      <h2 class="bd-title"><b class="trace-head-job">${escapeHtml(jobNumber)}</b></h2>
      <button type="button" class="btn-primary-big kpi-trace-close" data-drill-close>Close</button>
    </div>
    <div class="trace kpi-trace-body"><div class="trace-empty">Loading…</div></div>
  </div>`);
  mc.querySelector('[data-drill-close]')?.addEventListener('click', closeModal);
  try {
    // Press / part / description only exist once the history is read, so
    // the title starts as the order number and fills in on resolve.
    const view = await renderJobTraceCards(dalRef, jobNumber);
    const body = mc.querySelector('.kpi-trace-body');
    const title = mc.querySelector('.kpi-trace-head .bd-title');
    if (title) title.innerHTML = view.heading;
    if (body) body.innerHTML = view.html;
  } catch (e) {
    console.warn('[pmd] job Trace load failed', e);
    const body = mc.querySelector('.kpi-trace-body');
    if (body) body.innerHTML = `<div class="trace-empty">Couldn't load Trace detail for ${escapeHtml(jobNumber)}.</div>`;
  }
}

function openRejectDrill(scopeKey: string): void {
  openParetoDrill({
    title: 'Reject breakdown',
    unit: '',
    // PMD_Rejects supplies code/qty/shift AND the occurrence status. The
    // code label comes from PMD_RejectCategories; R/S remain visible as a
    // separate context dimension, never mislabelled as the defect itself.
    valueLabel: 'Reject description',
    source: S!.rejectPareto,
    scopeKey,
    showRejectStatus: true,
    showChart: false,
  });
}

function openDowntimeDrill(scopeKey: string): void {
  openParetoDrill({
    title: 'Downtime breakdown',
    unit: 'h',
    valueLabel: 'Cause',
    source: S!.downtimePareto,
    scopeKey,
  });
}

export async function renderKpi(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  document.body.className = 'shift-day';
  const machines = (await dal.listMachines()).sort((a, b) => a.sequence - b.sequence);
  // Default custom range: last 7 calendar days, so switching to the
  // Custom tab and pressing nothing still shows a meaningful window.
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  S = {
    view: window.location.hash.startsWith('#/kpi/live')
      ? 'live'
      : window.location.hash.startsWith('#/kpi/search')
        ? 'search'
        : 'metrics',
    period: 'last3',
    customFrom: dateKey(weekAgo),
    customTo: dateKey(today),
    thresholds: loadThresholds(),
    machines,
    loading: true,
    rows: [],
    chartBuckets: [],
    expandedMonths: new Set(),
    collapsed: new Set(),
    jobsExpanded: new Set(),
    ordersExpanded: new Set(),
    catTotals: [],
    rejectPareto: { floor: [], byMachine: new Map() },
    downtimePareto: { floor: [], byMachine: new Map() },
    rejectDescByCode: new Map(),
    changeoverEvents: [],
    dieByJob: new Map(),
    errors: [],
    catalogErrors: [],
  };
  // Reject code → description (D01 → "ShortShot"), for the Reject drill's
  // Description column. Cheap, changes rarely; load once at mount.
  try {
    const cats = await dal.listRejectCategories();
    S.rejectDescByCode = new Map(
      cats.map((c) => [c.code.trim().toUpperCase(), c.label]),
    );
  } catch (e) {
    console.warn('[pmd] reject categories load failed', e);
    S.catalogErrors = [`Reject categories: ${(e as Error).message || 'read failed'}`];
  }
  // No supervisor-change subscription needed here: main.ts already
  // re-routes (→ renderKpi) on every supervisor toggle, so the threshold
  // editor appears/disappears on unlock without a page reload.
  render();
  if (S.view === 'metrics') await compute();
}
