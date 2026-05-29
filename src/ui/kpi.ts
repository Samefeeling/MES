import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord } from '../types';
import { aggregate } from '../core/metrics';
import { dateKey, parseShiftId } from '../core/shifts';
import { escapeHtml } from './modal';

// Management KPI view (`#/kpi`) for daily / weekly / monthly meetings.
// Per-machine Output, Reject, Yield%, Run/Down/Setup hours, a simplified
// OEE (Availability × Quality), and Schedule Adherence (good vs planned).

type PeriodKey = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
];

interface KpiState {
  period: PeriodKey;
  machines: Machine[];
  loading: boolean;
  rows: KpiRow[];
}

interface KpiRow {
  machineCode: string;
  output: number;
  reject: number;
  yieldPct: number;
  runHrs: number;
  downHrs: number;
  setupHrs: number;
  oee: number | null; // simplified: availability × quality
  schedAdh: number | null; // good / planned qty
}

let S: KpiState | null = null;
let dalRef: PmdDataLayer;

function periodRange(key: PeriodKey, now: Date): { from: Date; to: Date; label: string } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (key === 'thisWeek' || key === 'lastWeek') {
    // Week = Monday..Sunday.
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    if (key === 'lastWeek') monday.setDate(monday.getDate() - 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: monday, to: sunday, label: `${dateKey(monday)} → ${dateKey(sunday)}` };
  }
  // Month.
  const base = new Date(d.getFullYear(), d.getMonth(), 1);
  if (key === 'lastMonth') base.setMonth(base.getMonth() - 1);
  const from = base;
  const to = new Date(base.getFullYear(), base.getMonth() + 1, 0); // last day of month
  return {
    from,
    to,
    label: from.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
  };
}

function inRange(record: ProductionRecord, from: Date, to: Date): boolean {
  const p = parseShiftId(record.shiftId);
  if (!p) return false;
  const d = new Date(p.year, p.month - 1, p.day);
  return d >= from && d <= to;
}

function plannedInRange(order: PlanningOrder, from: Date, to: Date): boolean {
  const t = new Date(order.plannedStart);
  return t >= from && t <= new Date(to.getTime() + 86400_000 - 1);
}

async function compute(now = new Date()): Promise<void> {
  const { from, to } = periodRange(S!.period, now);
  const planning = await dalRef.listPlanning({});
  const rows: KpiRow[] = [];
  for (const m of S!.machines) {
    const prod = (await dalRef.listProduction({ machineCode: m.machineCode })).filter((r) =>
      inRange(r, from, to),
    );
    const k = aggregate(prod);
    const good = k.output;
    const reject = k.scrap;
    const yieldPct = good + reject > 0 ? (good / (good + reject)) * 100 : 100;
    const quality = good + reject > 0 ? good / (good + reject) : 1;
    const loggedHrs = k.runHrs + k.downtimeHrs + k.setupHrs;
    const availability = loggedHrs > 0 ? k.runHrs / loggedHrs : 0;
    const oee = loggedHrs > 0 ? Math.round(availability * quality * 100) : null;
    const planned = planning
      .filter((o) => o.machineCode === m.machineCode && !o.isDieChange)
      .filter((o) => plannedInRange(o, from, to))
      .reduce((a, o) => a + (o.jobRequired || 0), 0);
    const schedAdh = planned > 0 ? Math.round((good / planned) * 100) : null;
    rows.push({
      machineCode: m.machineCode,
      output: good,
      reject,
      yieldPct: +yieldPct.toFixed(1),
      runHrs: k.runHrs,
      downHrs: k.downtimeHrs,
      setupHrs: k.setupHrs,
      oee,
      schedAdh,
    });
  }
  S!.rows = rows;
  S!.loading = false;
  render();
}

function colourClass(v: number | null, green: number, amber: number): string {
  if (v == null) return 'gray';
  if (v >= green) return 'green';
  if (v >= amber) return 'amber';
  return 'red';
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

  // Totals row.
  const tot = S!.rows.reduce(
    (a, r) => {
      a.output += r.output;
      a.reject += r.reject;
      a.runHrs += r.runHrs;
      a.downHrs += r.downHrs;
      a.setupHrs += r.setupHrs;
      return a;
    },
    { output: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0 },
  );
  const totYield =
    tot.output + tot.reject > 0
      ? ((tot.output / (tot.output + tot.reject)) * 100).toFixed(1)
      : '100.0';

  const body = S!.loading
    ? `<tr><td colspan="9" class="muted">Loading…</td></tr>`
    : S!.rows
        .map((r) => {
          const yc = colourClass(r.yieldPct, 98, 95);
          const oc = colourClass(r.oee, 85, 70);
          const sc = colourClass(r.schedAdh, 95, 80);
          return `<tr>
            <th>${escapeHtml(r.machineCode)}</th>
            <td class="num">${r.output}</td>
            <td class="num r">${r.reject}</td>
            <td class="num ${yc}">${r.yieldPct}%</td>
            <td class="num">${r.runHrs.toFixed(1)}</td>
            <td class="num">${r.downHrs.toFixed(1)}</td>
            <td class="num">${r.setupHrs.toFixed(1)}</td>
            <td class="num ${oc}">${r.oee == null ? '—' : r.oee + '%'}</td>
            <td class="num ${sc}">${r.schedAdh == null ? '—' : r.schedAdh + '%'}</td>
          </tr>`;
        })
        .join('');

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
      <p class="bd-sub">OEE* = Availability × Quality (simplified — Performance
      needs ideal cycle time, not yet captured). Schedule Adherence = good qty
      ÷ planned qty for jobs starting in the period. Read-only.</p>
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
  document.body.className = 'shift-day'; // neutral theme
  const machines = (await dal.listMachines()).sort((a, b) => a.sequence - b.sequence);
  S = { period: 'lastMonth', machines, loading: true, rows: [] };
  render();
  await compute();
}
