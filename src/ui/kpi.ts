import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord, ShiftCode } from '../types';
import { aggregate, type Kpi } from '../core/metrics';
import { buildShiftId, currentShift, dateKey, parseShiftId } from '../core/shifts';
import { escapeHtml } from './modal';
import { renderHoursOeeChart, renderOutputByShiftChart } from './charts';

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

const SHIFT_ORDER: ShiftCode[] = ['Day', 'Afternoon', 'Night'];

interface ShiftAgg {
  output: number;
  reject: number;
  yieldPct: number;
  runHrs: number;
  downHrs: number;
  setupHrs: number;
  oee: number | null;
}

interface KpiRow {
  machineCode: string;
  total: ShiftAgg;
  byShift: Record<ShiftCode, ShiftAgg>;
  schedAdh: number | null;
}

interface KpiState {
  period: PeriodKey;
  machines: Machine[];
  loading: boolean;
  rows: KpiRow[];
  chartBuckets: ChartBucket[];
}

interface ChartBucket {
  label: string;
  byShift: Record<ShiftCode, { good: number; reject: number; runHrs: number; downHrs: number; setupHrs: number; oee: number | null }>;
}

let S: KpiState | null = null;
let dalRef: PmdDataLayer;

/** The 3 most-recently-ENDED shifts as of `now`, oldest → newest. */
function lastThreeShifts(now: Date): string[] {
  const cs = currentShift(now);
  const p = parseShiftId(cs.shiftId)!;
  let d = new Date(p.year, p.month - 1, p.day);
  let idx = SHIFT_ORDER.indexOf(p.code);
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    idx -= 1;
    if (idx < 0) {
      idx = SHIFT_ORDER.length - 1;
      d = new Date(d);
      d.setDate(d.getDate() - 1);
    }
    out.unshift(buildShiftId(d, SHIFT_ORDER[idx]));
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
    oee: k.oee,
  };
}

function emptyAgg(): ShiftAgg {
  return { output: 0, reject: 0, yieldPct: 100, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null };
}

async function compute(now = new Date()): Promise<void> {
  const { from, to, shiftIds } = periodRange(S!.period, now);
  const planning = await dalRef.listPlanning({});
  const rows: KpiRow[] = [];

  // Accumulator for the date-bucketed charts. Last24 → 3 shift buckets;
  // week/month → one bucket per day.
  const dateBucketKey = (sid: string): string => {
    // For Last 24h, group all 3 shifts into a single date bucket so each
    // shift segment is the whole shift's contribution (not split across days).
    const p = parseShiftId(sid);
    return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : '';
  };
  const charts = new Map<string, ChartBucket>();

  for (const m of S!.machines) {
    const all = (await dalRef.listProduction({ machineCode: m.machineCode })).filter((r) =>
      inRange(r, from, to, shiftIds),
    );
    const total = toAgg(aggregate(all));
    const byShift: Record<ShiftCode, ShiftAgg> = {
      Day: emptyAgg(),
      Afternoon: emptyAgg(),
      Night: emptyAgg(),
    };
    for (const code of SHIFT_ORDER) {
      const subset = all.filter((r) => r.shiftId.endsWith(`-${code}`));
      byShift[code] = toAgg(aggregate(subset));
      // Fold this machine's per-(date,shift) numbers into the chart bucket
      // for that date.
      for (const r of subset) {
        const key = dateBucketKey(r.shiftId);
        if (!key) continue;
        if (!charts.has(key)) {
          charts.set(key, {
            label: key.slice(5), // MM-DD
            byShift: {
              Day: { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null },
              Afternoon: { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null },
              Night: { good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null },
            },
          });
        }
      }
      // Aggregate per-(date,shift) into chart buckets — one pass per shift.
      const byDate = new Map<string, ProductionRecord[]>();
      for (const r of subset) {
        const key = dateBucketKey(r.shiftId);
        if (!key) continue;
        const arr = byDate.get(key) ?? [];
        arr.push(r);
        byDate.set(key, arr);
      }
      for (const [key, recs] of byDate) {
        const k = aggregate(recs);
        const bucket = charts.get(key)!.byShift[code];
        bucket.good += k.output;
        bucket.reject += k.scrap;
        bucket.runHrs += k.runHrs;
        bucket.downHrs += k.downtimeHrs;
        bucket.setupHrs += k.setupHrs;
      }
    }

    const planned =
      S!.period === 'last3'
        ? 0
        : planning
            .filter((o) => !o.isDieChange)
            .filter((o) => plannedInRange(o, from, to))
            .reduce((a, o) => a + (o.jobRequired || 0), 0);
    const schedAdh = planned > 0 ? Math.round((total.output / planned) * 100) : null;
    rows.push({ machineCode: m.machineCode, total, byShift, schedAdh });
  }

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
    <td class="num">${a.setupHrs.toFixed(1)}</td>
    <td class="num ${oeeAndSched ? oc : ''}">${a.oee == null ? '—' : a.oee + '%'}</td>
    <td class="num ${oeeAndSched ? sc : ''}">${
      includeSched == null ? '—' : includeSched + '%'
    }</td>`;
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

  const tot = S!.rows.reduce(
    (a, r) => {
      a.output += r.total.output;
      a.reject += r.total.reject;
      a.runHrs += r.total.runHrs;
      a.downHrs += r.total.downHrs;
      a.setupHrs += r.total.setupHrs;
      return a;
    },
    { output: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0 },
  );
  const totYield =
    tot.output + tot.reject > 0
      ? ((tot.output / (tot.output + tot.reject)) * 100).toFixed(1)
      : '100.0';

  let body: string;
  if (S!.loading) {
    body = `<tr><td colspan="9" class="muted">Loading…</td></tr>`;
  } else {
    body = S!.rows
      .map((r) => {
        const headRow = `<tr class="kpi-machine">
          <th>${escapeHtml(r.machineCode)}</th>
          ${aggCells(r.total, r.schedAdh)}
        </tr>`;
        const shiftRows = SHIFT_ORDER.map((code) => {
          const a = r.byShift[code];
          return `<tr class="kpi-shift">
            <th class="kpi-shift-name">${escapeHtml(code)}</th>
            ${aggCells(a, null, false)}
          </tr>`;
        }).join('');
        return headRow + shiftRows;
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
      <table class="summary-table kpi-table">
        <thead><tr>
          <th>Machine</th><th>Output</th><th>Reject</th><th>Yield%</th>
          <th>Run h</th><th>Down h</th><th>Setup h</th><th>OEE*</th><th>Sched. Adh.</th>
        </tr></thead>
        <tbody>${body}</tbody>
        ${
          S!.loading
            ? ''
            : `<tfoot><tr class="kpi-total">
                <th>TOTAL</th>
                <td class="num">${tot.output}</td>
                <td class="num r">${tot.reject}</td>
                <td class="num">${totYield}%</td>
                <td class="num">${tot.runHrs.toFixed(1)}</td>
                <td class="num">${tot.downHrs.toFixed(1)}</td>
                <td class="num">${tot.setupHrs.toFixed(1)}</td>
                <td class="num">—</td><td class="num">—</td>
              </tr></tfoot>`
        }
      </table>
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
}

export async function renderKpi(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  document.body.className = 'shift-day';
  const machines = (await dal.listMachines()).sort((a, b) => a.sequence - b.sequence);
  S = { period: 'last3', machines, loading: true, rows: [], chartBuckets: [] };
  render();
  await compute();
}
