import type { PmdDataLayer } from '../dal';
import type {
  Machine,
  ParetoSlice,
  PlanningOrder,
  ProductionRecord,
  ShiftCode,
} from '../types';
import { aggregate, countSetupEvents, type Kpi } from '../core/metrics';
import {
  COLOR_CHANGE_STD_HRS,
  DIE_CHANGE_STD_HRS,
  INSERT_CHANGE_STD_HRS,
  expectedShiftOutput,
  expectedShiftOutputFromPlanning,
  setupJudgement,
  setupStandardHours,
} from '../core/standards';
import { currentShift, dateKey, parseShiftId, previousShift, shiftBounds, SHIFTS } from '../core/shifts';
import { closeModal, escapeHtml, openModal } from './modal';
import {
  renderHoursOeeChart,
  renderOutputByShiftChart,
  renderParetoByShiftChart,
  renderParetoChart,
} from './charts';
import { parseHandover } from '../core/handover';
import { isSupervisor } from './supervisor-auth';
import { renderJobTraceCards } from './trace';

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

// Two presets the meetings actually use; any other window is picked
// directly on the always-visible From/To inputs (which is what 'custom'
// is now — no tab). periodRange still understands the removed keys, so
// nothing breaks if one comes back.
const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'last3', label: 'Last 24h' },
  { key: 'thisWeek', label: 'This week' },
];

const SHIFT_ORDER: ShiftCode[] = SHIFTS.map((s) => s.code);

interface HandoverEntry {
  jobNumber: string;
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
  oee: number | null;
  handovers: HandoverEntry[];
  /** Planning-driven expected good pieces (see core/standards.ts). null =
   *  not computed for this slice (job rows / category rows) or no cycle
   *  time anywhere in it — the Output cell stays uncoloured. */
  expOutput: number | null;
  /** Standard changeover allowances (occurrences × standard duration).
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
  total: ShiftAgg;
  byShift: Record<ShiftCode, ShiftAgg>;
  /** Per (shift, job) breakdown for the 3rd-level expansion. */
  jobsByShift: Record<ShiftCode, JobAgg[]>;
  /** Per-Job# rollup across every shift in the selected period — drives
   *  the "> Orders" toggle on the machine row. Sorted by output desc. */
  byJobTotal: JobAgg[];
}

interface KpiState {
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
   *  Sourced from PMD_Rejects directly (label = RejectCategory). Sorted
   *  value-descending. Empty when the DAL can't supply the data. */
  rejectPareto: { floor: ParetoSlice[]; byMachine: Map<string, ParetoSlice[]> };
  /** Breakdown downtime hours per BDCode, sliced the same way. Sourced
   *  from PMD_BreakDownlog (label = breakdown cause from the taxonomy). */
  downtimePareto: { floor: ParetoSlice[]; byMachine: Map<string, ParetoSlice[]> };
  /** Reject code → human description (PMD_RejectCategories, e.g. D01 →
   *  "ShortShot"), so the Reject drill spells the codes out. */
  rejectDescByCode: Map<string, string>;
}

interface ChartBucket {
  label: string;
  byShift: Record<ShiftCode, { good: number; reject: number; runHrs: number; downHrs: number; setupHrs: number; oee: number | null; exp: number | null }>;
}

let S: KpiState | null = null;
let dalRef: PmdDataLayer;

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

function collectHandovers(records: ProductionRecord[]): HandoverEntry[] {
  // Handover lives on slotIndex 0 per (machine, shift, job). De-dup by
  // jobNumber so multiple jobs in a shift produce one row each.
  const seen = new Set<string>();
  const out: HandoverEntry[] = [];
  for (const r of records) {
    if (r.slotIndex !== 0) continue;
    if (!r.handoverNote) continue;
    if (seen.has(r.jobNumber)) continue;
    seen.add(r.jobNumber);
    const h = parseHandover(r.handoverNote);
    if (!h.machine && !h.mold && !h.material && !h.method) continue;
    out.push({ jobNumber: r.jobNumber, ...h });
  }
  return out;
}

function toAgg(k: Kpi, records: ProductionRecord[]): ShiftAgg {
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
    oee: k.oee,
    handovers: collectHandovers(records),
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
    oee: null,
    handovers: [],
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
  return { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null, exp: null };
}

/** First two words of a part description — keeps the per-job row narrow
 *  enough to read on a 10" iPad while still distinguishing "Battery Tray
 *  Black" from "Battery Lid Grey". Caller still sets a full-text title. */
function firstTwoWords(s: string): string {
  if (!s) return '';
  const words = s.trim().split(/\s+/);
  return words.slice(0, 2).join(' ');
}

/** Add a record's per-code reject quantities into a running tally. Reads
 *  the `rejects` JSON ({"D01":3,…}); falls back to the flat rejectCount
 *  under an "Unspecified" bucket when the JSON is absent/unparseable so
 *  no scrap silently vanishes from the Pareto. */
async function compute(now = new Date()): Promise<void> {
  const { from, to, shiftIds } = periodRange(S!.period, now);
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
        console.error('[kpi] listPlanning failed:', err);
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
              console.error(`[kpi] listProduction(${m.machineCode}) failed:`, err);
              return [] as ProductionRecord[];
            }),
        ),
      ),
      dalRef.listProductDieColors
        ? dalRef.listProductDieColors().catch(() => [])
        : Promise.resolve([]),
      Promise.all(
        paretoMachines.map((mc) =>
          dalRef.listRejectPareto
            ? dalRef
                .listRejectPareto({ from: fromKey, to: toKey, machineCode: mc || undefined })
                .catch((err) => {
                  console.warn('[kpi] listRejectPareto failed for', mc || 'floor', err);
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
                  console.warn('[kpi] listDowntimePareto failed for', mc || 'floor', err);
                  return [] as ParetoSlice[];
                })
            : Promise.resolve([] as ParetoSlice[]),
        ),
      ),
    ]);
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
        const expPieces =
          fromPlan.pieces ??
          expectedShiftOutput(bShiftId, recs, ctByJob, psByJob).pieces;
        stdAcc.push({ exp: expPieces, std });
        const cb = charts.get(dateKey) ?? {
          label: dateKey.slice(5), // MM-DD
          byShift: { Day: emptyChartShift(), Afternoon: emptyChartShift(), Night: emptyChartShift() },
        };
        const cell = cb.byShift[code];
        cell.good += k.output;
        cell.reject += k.scrap;
        cell.runHrs += k.runHrs;
        cell.downHrs += k.downtimeHrs;
        cell.setupHrs += k.setupHrs;
        if (expPieces != null) cell.exp = (cell.exp ?? 0) + expPieces;
        charts.set(dateKey, cb);
      }
      byShift[code] = toAgg(aggregate(flat), flat);
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
            agg: toAgg(aggregate(recs), recs),
          };
        })
        .sort((a, b2) => b2.agg.output - a.agg.output);
    }
    const total = toAgg(aggregate(all), all);
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
    // week?" without scanning three shift sub-tables.
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
          agg: toAgg(aggregate(recs), recs),
        };
      })
      .sort((a, b2) => b2.agg.output - a.agg.output);

    // Schedule Adherence was retired here — the Output "vs Plan" column
    // now carries plan attainment, judged against the simulated planned-
    // queue expectation rather than a separate scheduled-qty ratio.
    return { machineCode: m.machineCode, total, byShift, jobsByShift, byJobTotal };
  });

  S!.rows = rows;

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
    .map(([category, recs]) => ({ category, agg: toAgg(aggregate(recs), recs) }))
    .sort((a, b2) => b2.agg.output - a.agg.output);

  // paretoMachines = ['', ...machineCodes] above; index 0 is the floor,
  // indices 1..N are the per-machine slices. The drill-down keys on the
  // machine code (or 'FLOOR') to look up the right slice.
  const rejectByMachine = new Map<string, ParetoSlice[]>();
  const downtimeByMachine = new Map<string, ParetoSlice[]>();
  S!.machines.forEach((m, i) => {
    rejectByMachine.set(m.machineCode, rejectParetoBy[i + 1] ?? []);
    downtimeByMachine.set(m.machineCode, downtimeParetoBy[i + 1] ?? []);
  });
  S!.rejectPareto = { floor: rejectParetoBy[0] ?? [], byMachine: rejectByMachine };
  S!.downtimePareto = {
    floor: downtimeParetoBy[0] ?? [],
    byMachine: downtimeByMachine,
  };

  S!.chartBuckets = Array.from(charts.entries())
    .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0))
    .map(([, v]) => v);
  S!.loading = false;
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
  const title = `Expected ≈ ${a.expOutput} pcs from the planned order queue (StartDate+StartHour sequence, capped by remaining qty, at JobOper_ProdStandard; changeover standards deducted: die 4h, colour/insert 30min) — actual ${a.output} = ${pct}%`;
  return `<td class="num ${cls}" title="${escapeHtml(title)}">${n} <span class="kpi-exp">/${a.expOutput}</span></td>`;
}

/** Die / Colour / Insert hour cell judged against the standard allowance
 *  (occurrences × standard). Blue = within standard, amber = one block
 *  over, red = worse; plain when the slice wasn't judged / had none. */
function setupCell(actualHrs: number, stdHrs: number | null, stdEachHrs: number, label: string): string {
  const v = actualHrs ? actualHrs.toFixed(1) : '—';
  // Changeover hours ride the ordinary green/amber/red system — within
  // standard is green (not the plan-blue used for Output). setupJudgement
  // still returns 'blue' for at/under standard; remap it to green here.
  const cls = setupJudgement(actualHrs, stdHrs).replace('blue', 'green');
  if (!cls) return `<td class="num">${v}</td>`;
  const occurrences = Math.round((stdHrs ?? 0) / stdEachHrs);
  const title = `${label}: ${occurrences} × ${stdEachHrs}h standard = ${(stdHrs ?? 0).toFixed(1)}h allowed — actual ${actualHrs.toFixed(1)}h${
    actualHrs > (stdHrs ?? 0) ? ` (+${(actualHrs - (stdHrs ?? 0)).toFixed(1)}h over)` : ' (within standard)'
  }`;
  return `<td class="num ${cls}" title="${escapeHtml(title)}">${v}</td>`;
}

function formatHandoverCell(handovers: HandoverEntry[]): string {
  if (handovers.length === 0) return '<td class="kpi-ho-cell muted">—</td>';
  // Compact: one row per job, four emoji-prefixed segments; whitespace
  // collapsed. Full text available via `title=` tooltip.
  const compact = handovers
    .map((h) => {
      const parts: string[] = [];
      if (h.machine) parts.push(`🛠 ${h.machine.replace(/\s+/g, ' ').trim()}`);
      if (h.mold) parts.push(`🧩 ${h.mold.replace(/\s+/g, ' ').trim()}`);
      if (h.material) parts.push(`📦 ${h.material.replace(/\s+/g, ' ').trim()}`);
      if (h.method) parts.push(`📋 ${h.method.replace(/\s+/g, ' ').trim()}`);
      return parts.join(' · ');
    })
    .join(' || ');
  const full = handovers
    .map((h) => {
      const lines: string[] = [`Job ${h.jobNumber || '—'}`];
      if (h.machine) lines.push(`  🛠 ${h.machine}`);
      if (h.mold) lines.push(`  🧩 ${h.mold}`);
      if (h.material) lines.push(`  📦 ${h.material}`);
      if (h.method) lines.push(`  📋 ${h.method}`);
      return lines.join('\n');
    })
    .join('\n\n');
  return `<td class="kpi-ho-cell" title="${escapeHtml(full)}">${escapeHtml(compact)}</td>`;
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

/** When `drillKey` is given (machine code, or 'FLOOR') and the row has
 *  scrap, the Reject number becomes a button that opens the per-code
 *  Pareto drill-down. Sub-rows (shift / job / category) pass nothing and
 *  render a plain number. */
function rejectCell(reject: number, drillKey?: string): string {
  const n = reject ? String(reject) : '—';
  if (!drillKey || !reject) return `<td class="num r">${n}</td>`;
  return `<td class="num r"><button type="button" class="kpi-reject-drill" data-reject-drill="${escapeHtml(
    drillKey,
  )}" title="Break down ${reject} rejects by RejectCode (Pareto)">${n}</button></td>`;
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
    ${rejectCell(a.reject, rejectDrillKey)}
    <td class="num ${noPieces ? '' : yc}">${noPieces ? '—' : `${a.yieldPct}%`}</td>
    <td class="num">${h(a.runHrs)}</td>
    ${downHrsCell(a.downHrs, downtimeDrillKey)}
    ${setupCell(a.dieHrs, a.dieStdHrs, DIE_CHANGE_STD_HRS, 'Die change')}
    ${setupCell(a.colorHrs, a.colorStdHrs, COLOR_CHANGE_STD_HRS, 'Colour change')}
    ${setupCell(a.insertHrs, a.insertStdHrs, INSERT_CHANGE_STD_HRS, 'Insert change')}
    <td class="num ${colourOee ? oc : ''}">${a.oee == null ? '—' : a.oee + '%'}</td>
    <td class="num ${pc}">${planPct == null ? '—' : planPct + '%'}</td>
    ${formatHandoverCell(a.handovers)}`;
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

function render(): void {
  const app = document.getElementById('app')!;
  const tabs = PERIODS.map(
    (p) =>
      `<button class="shift-btn${p.key === S!.period ? ' a' : ''}" data-period="${p.key}">${escapeHtml(
        p.label,
      )}</button>`,
  ).join('');
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
    body = `<tr><td colspan="13" class="muted">Loading…</td></tr>`;
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
        </tr>`;
        const orderRows = ordersOpen
          ? r.byJobTotal
              .map((j) => {
                const fullDesc = `${j.jobNumber}${
                  j.partDescShort ? ' — ' + j.partDescShort : ''
                } (period total)`;
                return `<tr class="kpi-job kpi-order-total">
                  ${jobNameTh(j.jobNumber, j.partDescShort, fullDesc)}
                  ${colorCell(j.color)}
                  ${aggCells(j.agg, null, false)}
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
          </tr>`;
          if (!jobsOpen) return shiftRow;
          const jobRows = jobs
            .map((j) => {
              const fullDesc = `${j.jobNumber}${
                j.partDescShort ? ' — ' + j.partDescShort : ''
              }`;
              return `<tr class="kpi-job">
                ${jobNameTh(j.jobNumber, j.partDescShort, fullDesc)}
                ${colorCell(j.color)}
                ${aggCells(j.agg, null, false)}
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
        </tr>`,
      )
      .join('');
  }

  // Charts: one bucket per date with shift segments. Output (stacked by
  // shift) + Reject line; Run/Down/Setup (stacked) + OEE line. Each chart
  // sums every machine in the period — total floor view.
  const outChartData = S!.chartBuckets.map((b) => {
    // Day standard = sum of the shift expectations that were computable;
    // Per-shift vs-Plan % (good ÷ expected) labels each segment; null
    // when that shift had no planning expectation to divide by.
    const vsPlan = (good: number, exp: number | null): number | null =>
      exp != null && exp > 0 ? Math.round((good / exp) * 100) : null;
    return {
      label: b.label,
      day: b.byShift.Day.good,
      afternoon: b.byShift.Afternoon.good,
      night: b.byShift.Night.good,
      reject:
        b.byShift.Day.reject + b.byShift.Afternoon.reject + b.byShift.Night.reject,
      vsPlan: [
        vsPlan(b.byShift.Day.good, b.byShift.Day.exp),
        vsPlan(b.byShift.Afternoon.good, b.byShift.Afternoon.exp),
        vsPlan(b.byShift.Night.good, b.byShift.Night.exp),
      ],
    };
  });
  const hoursChartData = S!.chartBuckets.map((b) => {
    const run = b.byShift.Day.runHrs + b.byShift.Afternoon.runHrs + b.byShift.Night.runHrs;
    const down = b.byShift.Day.downHrs + b.byShift.Afternoon.downHrs + b.byShift.Night.downHrs;
    const setup = b.byShift.Day.setupHrs + b.byShift.Afternoon.setupHrs + b.byShift.Night.setupHrs;
    const logged = run + down + setup;
    const oee = logged > 0 ? Math.round((run / logged) * 100) : null;
    return { label: b.label, run, down, setup, oee };
  });
  // Reject Pareto from PMD_Rejects (RejectCode bars + RejectCategory
  // legend); Downtime Pareto from PMD_BreakDownlog (BDCode bars + cause
  // legend). Side by side in the chart strip; either one independently
  // hides when its source list returns nothing.
  // Stack the floor Reject Pareto by shift when PMD_Rejects carried the
  // Shift split (SharePoint backend); fall back to the single-colour bar
  // when no slice has a byShift breakdown (memory DAL / older data).
  const rejectHasShiftSplit = S!.rejectPareto.floor.some((s) => s.byShift);
  const rejectChart = S!.rejectPareto.floor.length
    ? `<div class="kpi-chart">
          <h4>Reject Pareto — RejectCode${
            rejectHasShiftSplit ? ' by shift' : ''
          } (click a Reject number in the table to drill)</h4>
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
  const charts = S!.loading || S!.chartBuckets.length === 0
    ? ''
    : `<div class="kpi-charts">
        <div class="kpi-chart">
          <h4>Output by shift (stacked) vs Reject</h4>
          ${renderOutputByShiftChart(outChartData)}
        </div>
        <div class="kpi-chart">
          <h4>Run / Down / Setup hours (stacked) vs Efficiency</h4>
          ${renderHoursOeeChart(hoursChartData)}
        </div>
        ${rejectChart}
        ${downtimeChart}
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
      ${buildThresholdEditor()}
      ${stats}
      <div class="kpi-table-wrap">
        <table class="summary-table kpi-table">
          <thead><tr>
            <th class="kpi-machine-head">Machine
              <button type="button" class="kpi-toggle kpi-toggle-all" data-toggle-all-shifts title="Toggle shift breakdown on every machine">${allShiftsGlyph}</button>
              <button type="button" class="kpi-toggle kpi-toggle-all kpi-orders-toggle" data-toggle-all-orders title="Toggle per-order rollup on every machine">${allOrdersGlyph}</button>
            </th><th class="kpi-color-head">Color</th>
            <th>Output</th><th>Reject</th><th>Yield%</th>
            <th>Run h</th><th>Down h</th>
            <th title="D — Die change">Die h</th>
            <th title="C — Colour change">Colour h</th>
            <th title="I — Insert change">Insert h</th>
            <th>Efficiency*</th><th title="Total Good ÷ planning expectation">vs Plan</th>
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
                    ${rejectCell(tot.reject, 'FLOOR')}
                    <td class="num">${totYield != null ? totYield + '%' : '—'}</td>
                    <td class="num">${th(tot.runHrs)}</td>
                    ${downHrsCell(tot.downHrs, 'FLOOR')}
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
        <div><b>Output 🟢🟡🔴</b> = Σ Total Good vs expected (the small “/n”). Expected: simulate the machine's planned order queue over the shift — window = 8 h − Σ changeover standards − smoko; per order, hours needed = RemainingLaborHrs (else Remaining × ProdStandard); order finishes → all its remaining pieces, else ⌊hours used ÷ ProdStandard⌋. Remaining = the signed shift's own Job Left when the order ran, else planning.csv.</div>
        <div><b>Yield%</b> = Good ÷ (Good + Reject).</div>
        <div><b>Efficiency*</b> = Run slots ÷ all filled slots.</div>
        <div><b>vs Plan 🟢🟡🔴</b> = Total Good ÷ the same planning expectation the Output cell shows — the percentage form of Output's “/n”.</div>
        <div><b>Die / Colour / Insert h 🟢🟡🔴</b> = hours in D / C / I blocks vs standard = occurrences × (die 4 h · colour 0.5 h · insert 0.5 h); 🟢 ≤ std, 🟡 ≤ std + 0.5 h, 🔴 above.</div>
        <div>Colour thresholds for Output / Yield / Efficiency are editable in the panel above. Shift sub-rows show each shift's contribution to the period total.</div>
      </div>
    </div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.period = b.dataset.period as PeriodKey;
      S!.loading = true;
      render();
      void compute();
    }),
  );
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
        )}</span> <span class="muted">(${((s.value / total) * 100).toFixed(0)}%)</span></li>`,
    )
    .join('');
  return `<ul class="kpi-reject-legend">${items}</ul>`;
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
  /** When set, adds a Description column that spells each code out
   *  (D01 → "ShortShot"). Used by the Reject drill; downtime omits it. */
  descByCode?: Map<string, string>;
}): void {
  const slices =
    opts.scopeKey === 'FLOOR'
      ? opts.source.floor
      : opts.source.byMachine.get(opts.scopeKey) ?? [];
  const scopeLabel = opts.scopeKey === 'FLOOR' ? 'All machines' : opts.scopeKey;
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) return;
  const withDesc = !!opts.descByCode;
  let cum = 0;
  const rows = slices
    .map((s, i) => {
      cum += s.value;
      const pct = ((s.value / total) * 100).toFixed(1);
      const cumPct = ((cum / total) * 100).toFixed(1);
      const descCell = withDesc
        ? `<td>${escapeHtml(opts.descByCode!.get(s.code) ?? s.label ?? '—')}</td>`
        : '';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td><b>${escapeHtml(s.code)}</b></td>
        ${descCell}
        <td>${escapeHtml(s.label)}</td>
        <td class="num r">${formatValue(s.value, opts.unit)}</td>
        <td class="num">${pct}%</td>
        <td class="num">${cumPct}%</td>
      </tr>`;
    })
    .join('');
  const chart = renderParetoChart(toParetoBuckets(slices));
  const totalDisplay = formatValue(+total.toFixed(2), opts.unit);
  const descHead = withDesc ? '<th>Description</th>' : '';
  const totalSpan = withDesc ? 4 : 3;
  const mc = openModal(`<div class="bd-modal kpi-drill-modal">
    <h2 class="bd-title">🔬 ${escapeHtml(opts.title)} — ${escapeHtml(scopeLabel)}</h2>
    <p class="bd-sub">${totalDisplay} across ${slices.length} code${
      slices.length === 1 ? '' : 's'
    } · ${escapeHtml(periodRange(S!.period, new Date()).label)}</p>
    <div class="kpi-drill-chart">${chart}</div>
    <table class="summary-table kpi-drill-table">
      <thead><tr><th>#</th><th>Code</th>${descHead}<th>${escapeHtml(opts.valueLabel)}</th><th>Value</th><th>%</th><th>Cum %</th></tr></thead>
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
      <h2 class="bd-title">🔍 ${escapeHtml(jobNumber)} — Trace detail</h2>
      <button type="button" class="btn-primary-big kpi-trace-close" data-drill-close>Close</button>
    </div>
    <div class="trace kpi-trace-body"><div class="trace-empty">Loading…</div></div>
  </div>`);
  mc.querySelector('[data-drill-close]')?.addEventListener('click', closeModal);
  try {
    const html = await renderJobTraceCards(dalRef, jobNumber);
    const body = mc.querySelector('.kpi-trace-body');
    if (body) body.innerHTML = html;
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
    // The old s.label column now reads as the row's RejectCategory
    // grouping; the new Description column spells the D-code out.
    valueLabel: 'Category',
    source: S!.rejectPareto,
    scopeKey,
    descByCode: S!.rejectDescByCode,
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
    period: 'last3',
    customFrom: dateKey(weekAgo),
    customTo: dateKey(today),
    thresholds: loadThresholds(),
    machines,
    loading: true,
    rows: [],
    chartBuckets: [],
    collapsed: new Set(),
    jobsExpanded: new Set(),
    ordersExpanded: new Set(),
    catTotals: [],
    rejectPareto: { floor: [], byMachine: new Map() },
    downtimePareto: { floor: [], byMachine: new Map() },
    rejectDescByCode: new Map(),
  };
  // Reject code → description (D01 → "ShortShot"), for the Reject drill's
  // Description column. Cheap, changes rarely; load once at mount.
  try {
    const cats = await dal.listRejectCategories();
    S.rejectDescByCode = new Map(cats.map((c) => [c.code, c.label]));
  } catch (e) {
    console.warn('[pmd] reject categories load failed', e);
  }
  // No supervisor-change subscription needed here: main.ts already
  // re-routes (→ renderKpi) on every supervisor toggle, so the threshold
  // editor appears/disappears on unlock without a page reload.
  render();
  await compute();
}
