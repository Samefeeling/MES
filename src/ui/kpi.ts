import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord, ShiftCode } from '../types';
import { aggregate, type Kpi } from '../core/metrics';
import { currentShift, dateKey, parseShiftId, previousShift, SHIFTS } from '../core/shifts';
import { escapeHtml } from './modal';
import { renderHoursOeeChart, renderOutputByShiftChart } from './charts';
import { parseHandover } from '../core/handover';

// Management KPI view (`#/kpi`) for daily / weekly / monthly meetings.
// Per-machine OEE, output, reject, run/down/setup hours, plus a per-shift
// breakdown (Day / Afternoon / Night) under each machine row.

type PeriodKey = 'last3' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'last3', label: 'Last 24h' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
];

const SHIFT_ORDER: ShiftCode[] = SHIFTS.map((s) => s.code);

interface HandoverEntry {
  jobNumber: string;
  people: string;
  plant: string;
  machine: string;
  material: string;
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
  const direct = dieColors.get(partNumber);
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
  schedAdh: number | null;
}

interface KpiState {
  period: PeriodKey;
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
}

interface ChartBucket {
  label: string;
  byShift: Record<ShiftCode, { good: number; reject: number; runHrs: number; downHrs: number; setupHrs: number; oee: number | null }>;
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
  if (key === 'last3') {
    const ids = lastThreeShifts(now);
    const dates = ids.map((s) => s.slice(0, 10)).sort();
    return {
      from: new Date(dates[0] + 'T00:00:00'),
      to: new Date(dates[dates.length - 1] + 'T23:59:59'),
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

function plannedInRange(order: PlanningOrder, from: Date, to: Date): boolean {
  const t = new Date(order.plannedStart);
  return t >= from && t <= new Date(to.getTime() + 86400_000 - 1);
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
    if (!h.people && !h.plant && !h.machine && !h.material) continue;
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
  };
}

function emptyChartShift(): ChartBucket['byShift'][ShiftCode] {
  return { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null };
}

/** First two words of a part description — keeps the per-job row narrow
 *  enough to read on a 10" iPad while still distinguishing "Battery Tray
 *  Black" from "Battery Lid Grey". Caller still sets a full-text title. */
function firstTwoWords(s: string): string {
  if (!s) return '';
  const words = s.trim().split(/\s+/);
  return words.slice(0, 2).join(' ');
}

async function compute(now = new Date()): Promise<void> {
  const { from, to, shiftIds } = periodRange(S!.period, now);
  // listPlanning and the per-machine production reads have no
  // dependencies on each other — parallelise so the screen render
  // isn't pinned to N×latency. Per-machine errors don't abort the whole
  // page: a single 1600T fetch failure used to take down the entire KPI
  // table (Promise.all rejects on the first failure); now each machine
  // that errors just shows up as zeros and the rest still render.
  const [planning, perMachineProd, dieColorList] = await Promise.all([
    dalRef.listPlanning({}).catch((err) => {
      console.error('[kpi] listPlanning failed:', err);
      return [] as PlanningOrder[];
    }),
    Promise.all(
      S!.machines.map((m) =>
        dalRef
          .listProduction({ machineCode: m.machineCode })
          .then((p) => p.filter((r) => inRange(r, from, to, shiftIds)))
          .catch((err) => {
            console.error(`[kpi] listProduction(${m.machineCode}) failed:`, err);
            return [] as ProductionRecord[];
          }),
      ),
    ),
    dalRef.listProductDieColors
      ? dalRef.listProductDieColors().catch(() => [])
      : Promise.resolve([]),
  ]);
  const dieColors = new Map(
    dieColorList.map((c) => [c.partNumber, { hex: c.hex, name: c.name }]),
  );
  // Part # per Job for the die-colour lookup (the keyword-scan
  // fallback still uses the description).
  const partNumByJob = new Map<string, string>();
  for (const o of planning) partNumByJob.set(o.jobNumber, o.partNumber);

  // Build a JobNum → partDescription lookup once, used by the per-job
  // breakdown rows (3rd indent level). Falls back to empty string for jobs
  // not in the planning list (closed in Epicor since the shift ran).
  const partDescByJob = new Map<string, string>();
  for (const o of planning) partDescByJob.set(o.jobNumber, o.partDescription);

  const charts = new Map<string, ChartBucket>();
  const rows: KpiRow[] = S!.machines.map((m, i) => {
    const all = perMachineProd[i];
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
      for (const [dateKey, recs] of shiftBuckets) {
        flat.push(...recs);
        const k = aggregate(recs);
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
        charts.set(dateKey, cb);
      }
      byShift[code] = toAgg(aggregate(flat), flat);

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

    const planned =
      S!.period === 'last3'
        ? 0
        : planning
            .filter((o) => !o.isDieChange && plannedInRange(o, from, to))
            .reduce((a, o) => a + (o.jobRequired || 0), 0);
    const schedAdh = planned > 0 ? Math.round((total.output / planned) * 100) : null;
    return { machineCode: m.machineCode, total, byShift, jobsByShift, byJobTotal, schedAdh };
  });

  S!.rows = rows;
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

function formatHandoverCell(handovers: HandoverEntry[]): string {
  if (handovers.length === 0) return '<td class="kpi-ho-cell muted">—</td>';
  // Compact: one row per job, four emoji-prefixed segments; whitespace
  // collapsed. Full text available via `title=` tooltip.
  const compact = handovers
    .map((h) => {
      const parts: string[] = [];
      if (h.people) parts.push(`👥 ${h.people.replace(/\s+/g, ' ').trim()}`);
      if (h.plant) parts.push(`🏭 ${h.plant.replace(/\s+/g, ' ').trim()}`);
      if (h.machine) parts.push(`🛠 ${h.machine.replace(/\s+/g, ' ').trim()}`);
      if (h.material) parts.push(`📦 ${h.material.replace(/\s+/g, ' ').trim()}`);
      return parts.join(' · ');
    })
    .join(' || ');
  const full = handovers
    .map((h) => {
      const lines: string[] = [`Job ${h.jobNumber || '—'}`];
      if (h.people) lines.push(`  👥 ${h.people}`);
      if (h.plant) lines.push(`  🏭 ${h.plant}`);
      if (h.machine) lines.push(`  🛠 ${h.machine}`);
      if (h.material) lines.push(`  📦 ${h.material}`);
      return lines.join('\n');
    })
    .join('\n\n');
  return `<td class="kpi-ho-cell" title="${escapeHtml(full)}">${escapeHtml(compact)}</td>`;
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

function aggCells(a: ShiftAgg, includeSched: number | null = null, oeeAndSched = true): string {
  const yc = colourClass(a.yieldPct, 98, 95);
  const oc = colourClass(a.oee, 85, 70);
  const sc = colourClass(includeSched, 95, 80);
  return `
    <td class="num">${a.output}</td>
    <td class="num r">${a.reject}</td>
    <td class="num ${yc}">${a.yieldPct}%</td>
    <td class="num">${a.runHrs.toFixed(1)}</td>
    <td class="num">${a.downHrs.toFixed(1)}</td>
    <td class="num">${a.dieHrs.toFixed(1)}</td>
    <td class="num">${a.colorHrs.toFixed(1)}</td>
    <td class="num">${a.insertHrs.toFixed(1)}</td>
    <td class="num ${oeeAndSched ? oc : ''}">${a.oee == null ? '—' : a.oee + '%'}</td>
    <td class="num ${oeeAndSched ? sc : ''}">${
      includeSched == null ? '—' : includeSched + '%'
    }</td>
    ${formatHandoverCell(a.handovers)}`;
}

function render(): void {
  const app = document.getElementById('app')!;
  const tabs = PERIODS.map(
    (p) =>
      `<button class="shift-btn${p.key === S!.period ? ' a' : ''}" data-period="${p.key}">${escapeHtml(
        p.label,
      )}</button>`,
  ).join('');
  const rangeLabel = periodRange(S!.period, new Date()).label;
  // Global toggles live in the Machine column header — one click flips
  // every machine instead of N clicks per row.
  //  • "+" mirrors the per-row + / – (shift breakdown)
  //  • ">" mirrors the per-row › / ⌄ (per-order rollup)
  const anyShiftsCollapsed = S!.collapsed.size > 0;
  const anyOrdersHidden =
    S!.ordersExpanded.size <
    S!.rows.filter((r) => r.byJobTotal.length > 0).length;
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
    },
  );
  const totYield =
    tot.output + tot.reject > 0
      ? ((tot.output / (tot.output + tot.reject)) * 100).toFixed(1)
      : '100.0';

  let body: string;
  if (S!.loading) {
    body = `<tr><td colspan="13" class="muted">Loading…</td></tr>`;
  } else {
    body = S!.rows
      .map((r) => {
        const isCollapsed = S!.collapsed.has(r.machineCode);
        const ordersOpen = S!.ordersExpanded.has(r.machineCode);
        const toggle = `<button type="button" class="kpi-toggle" data-toggle="${escapeHtml(
          r.machineCode,
        )}" aria-label="${isCollapsed ? 'Show shift breakdown' : 'Hide shift breakdown'} for ${escapeHtml(r.machineCode)}" title="Toggle Day / Afternoon / Night breakdown">${
          isCollapsed ? '+' : '–'
        }</button>`;
        const ordersToggle = r.byJobTotal.length
          ? `<button type="button" class="kpi-toggle kpi-orders-toggle" data-orders="${escapeHtml(
              r.machineCode,
            )}" aria-label="${ordersOpen ? 'Hide' : 'Show'} per-order rollup for ${escapeHtml(r.machineCode)}" title="Toggle per-Job# rollup across all shifts in this period">${
              ordersOpen ? '⌄' : '›'
            }</button>`
          : '';
        const headRow = `<tr class="kpi-machine">
          <th>${toggle}${ordersToggle}<span class="kpi-mc-name">${escapeHtml(r.machineCode)}</span></th>
          ${colorCell()}
          ${aggCells(r.total, r.schedAdh)}
        </tr>`;
        const orderRows = ordersOpen
          ? r.byJobTotal
              .map((j) => {
                const fullDesc = `${j.jobNumber}${
                  j.partDescShort ? ' — ' + j.partDescShort : ''
                } (period total)`;
                return `<tr class="kpi-job kpi-order-total">
                  <th class="kpi-job-name" title="${escapeHtml(fullDesc)}">${escapeHtml(
                    j.jobNumber,
                  )}<span class="kpi-job-part">${escapeHtml(j.partDescShort)}</span></th>
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
                <th class="kpi-job-name" title="${escapeHtml(fullDesc)}">${escapeHtml(
                  j.jobNumber,
                )}<span class="kpi-job-part">${escapeHtml(j.partDescShort)}</span></th>
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
  }

  // Charts: one bucket per date with shift segments. Output (stacked by
  // shift) + Reject line; Run/Down/Setup (stacked) + OEE line. Each chart
  // sums every machine in the period — total floor view.
  const outChartData = S!.chartBuckets.map((b) => ({
    label: b.label,
    day: b.byShift.Day.good,
    afternoon: b.byShift.Afternoon.good,
    night: b.byShift.Night.good,
    reject:
      b.byShift.Day.reject + b.byShift.Afternoon.reject + b.byShift.Night.reject,
  }));
  const hoursChartData = S!.chartBuckets.map((b) => {
    const run = b.byShift.Day.runHrs + b.byShift.Afternoon.runHrs + b.byShift.Night.runHrs;
    const down = b.byShift.Day.downHrs + b.byShift.Afternoon.downHrs + b.byShift.Night.downHrs;
    const setup = b.byShift.Day.setupHrs + b.byShift.Afternoon.setupHrs + b.byShift.Night.setupHrs;
    const logged = run + down + setup;
    const oee = logged > 0 ? Math.round((run / logged) * 100) : null;
    return { label: b.label, run, down, setup, oee };
  });
  const charts = S!.loading || S!.chartBuckets.length === 0
    ? ''
    : `<div class="kpi-charts">
        <div class="kpi-chart">
          <h4>Output by shift (stacked) vs Reject</h4>
          ${renderOutputByShiftChart(outChartData)}
        </div>
        <div class="kpi-chart">
          <h4>Run / Down / Setup hours (stacked) vs OEE</h4>
          ${renderHoursOeeChart(hoursChartData)}
        </div>
      </div>`;

  app.innerHTML = `
    <div class="kpi">
      <div class="kpi-head">
        <h2>📊 Production KPIs — ${escapeHtml(rangeLabel)}</h2>
        <div class="shift-tabs">${tabs}</div>
      </div>
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
            <th>OEE*</th><th>Sched. Adh.</th>
            <th class="kpi-ho-head">Handover</th>
          </tr></thead>
          <tbody>${body}</tbody>
          ${
            S!.loading
              ? ''
              : `<tfoot><tr class="kpi-total">
                  <th>TOTAL</th>
                  ${colorCell()}
                  <td class="num">${tot.output}</td>
                  <td class="num r">${tot.reject}</td>
                  <td class="num">${totYield}%</td>
                  <td class="num">${tot.runHrs.toFixed(1)}</td>
                  <td class="num">${tot.downHrs.toFixed(1)}</td>
                  <td class="num">${tot.dieHrs.toFixed(1)}</td>
                  <td class="num">${tot.colorHrs.toFixed(1)}</td>
                  <td class="num">${tot.insertHrs.toFixed(1)}</td>
                  <td class="num">—</td><td class="num">—</td>
                  <td class="kpi-ho-cell muted">—</td>
                </tr></tfoot>`
          }
        </table>
      </div>
      ${charts}
      <p class="bd-sub">OEE* = run-slot share of all filled slots. Schedule Adherence = good qty ÷ planned qty for jobs starting in the period (suppressed in Last-24h). Shift sub-rows show each shift's contribution to the period total.</p>
    </div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.period = b.dataset.period as PeriodKey;
      S!.loading = true;
      render();
      void compute();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const mc = b.dataset.toggle!;
      if (S!.collapsed.has(mc)) S!.collapsed.delete(mc);
      else S!.collapsed.add(mc);
      render();
    }),
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
      if (S!.collapsed.size > 0) S!.collapsed = new Set();
      else S!.collapsed = new Set(S!.machines.map((m) => m.machineCode));
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

export async function renderKpi(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  document.body.className = 'shift-day';
  const machines = (await dal.listMachines()).sort((a, b) => a.sequence - b.sequence);
  S = {
    period: 'last3',
    machines,
    loading: true,
    rows: [],
    chartBuckets: [],
    collapsed: new Set(),
    jobsExpanded: new Set(),
    ordersExpanded: new Set(),
  };
  render();
  await compute();
}
