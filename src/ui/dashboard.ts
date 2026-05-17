import type { PmdDataLayer } from '../dal';
import type { Machine, ProductionRecord } from '../types';
import { aggregate, oeeColor, scrapColor } from '../core/metrics';
import { dateKey, parseShiftId } from '../core/shifts';
import { stackedBarLine, setupPlanActual } from './charts';
import { escapeHtml } from './modal';

type RangeKey = 'today' | '7d' | '30d';
const RANGE_DAYS: Record<RangeKey, number> = { today: 1, '7d': 7, '30d': 30 };
const RANGE_LABEL: Record<RangeKey, string> = {
  today: 'Today (24h)',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

let range: RangeKey = '7d';
const expanded = new Set<string>();

function dayList(days: number, now: Date): Date[] {
  const out: Date[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    out.push(d);
  }
  return out;
}

function recordsInRange(
  all: ProductionRecord[],
  days: Date[],
): Map<string, ProductionRecord[]> {
  const keys = new Set(days.map((d) => dateKey(d)));
  const byDay = new Map<string, ProductionRecord[]>();
  for (const r of all) {
    const p = parseShiftId(r.shiftId);
    if (!p) continue;
    const k = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (!keys.has(k)) continue;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(r);
  }
  return byDay;
}

function machineCard(m: Machine, recs: ProductionRecord[], days: Date[]): string {
  const kpi = aggregate(recs);
  const oc = oeeColor(kpi.oee);
  const sc = scrapColor(kpi.scrapPct);
  const isOpen = expanded.has(m.machineCode);

  const labels = days.map((d) =>
    d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
  );
  const byDay = recordsInRange(recs, days);
  const perDay = days.map((d) => aggregate(byDay.get(dateKey(d)) ?? []));

  const output = perDay.map((k) => k.output);
  const yieldPct = perDay.map((k) =>
    k.output + k.scrap > 0 ? (k.output / (k.output + k.scrap)) * 100 : 100,
  );
  const downB = perDay.map((k) => k.downtimeHrs);
  const scrapPctLine = perDay.map((k) => k.scrapPct);
  const setupD = perDay.map((k) => k.dieChanges * 0.5);
  const setupC = perDay.map((k) => k.colorChanges * 0.5);
  const setupI = perDay.map((k) => k.insertChanges * 0.25);
  const plan = perDay.map(() => 0.5); // std plan target per spec SETUP_STD

  const charts = isOpen
    ? `<div class="charts">
        <div class="chart-box"><h4>Output / Yield%</h4>${stackedBarLine(
          labels,
          [{ name: 'Good', color: '#86efac', values: output }],
          { name: 'Yield%', color: '#1e40af', values: yieldPct },
        )}</div>
        <div class="chart-box"><h4>Downtime / Scrap%</h4>${stackedBarLine(
          labels,
          [{ name: 'Downtime', color: '#fca5a5', values: downB }],
          { name: 'Scrap%', color: '#dc2626', values: scrapPctLine },
        )}</div>
        <div class="chart-box"><h4>Setup Plan vs Actual</h4>${setupPlanActual(
          labels,
          plan,
          { d: setupD, c: setupC, i: setupI },
        )}</div>
      </div>
      <button class="viewbtn" data-nav="#/machine/${encodeURIComponent(
        m.machineCode,
      )}">Open machine view →</button>`
    : '';

  return `<div class="mc ${oc}">
    <div class="ch" data-toggle="${escapeHtml(m.machineCode)}">
      <span class="mn">${escapeHtml(m.machineCode)}</span>
      <span class="bg ${oc}">${kpi.oee == null ? 'no data' : `OEE ${kpi.oee}%`}</span>
    </div>
    <div class="kg">
      <div class="kp ${oc}"><div class="kl">OEE</div><div class="kv">${
        kpi.oee == null ? '—' : kpi.oee + '<span class="ku">%</span>'
      }</div></div>
      <div class="kp"><div class="kl">Output</div><div class="kv">${kpi.output}</div></div>
      <div class="kp ${sc}"><div class="kl">Scrap</div><div class="kv">${kpi.scrapPct}<span class="ku">%</span></div></div>
      <div class="kp"><div class="kl">Downtime</div><div class="kv">${kpi.downtimeHrs}<span class="ku">h</span></div></div>
      <div class="kp"><div class="kl">Setup</div><div class="kv">${kpi.setupHrs}<span class="ku">h</span></div></div>
      <div class="kp"><div class="kl">Run</div><div class="kv">${kpi.runHrs}<span class="ku">h</span></div></div>
    </div>
    <div class="mc-open">${charts}</div>
  </div>`;
}

export async function renderDashboard(
  dal: PmdDataLayer,
  now: Date = new Date(),
): Promise<void> {
  const app = document.getElementById('app')!;
  const machines = await dal.listMachines();
  if (machines.length === 0) {
    app.innerHTML = `<div class="muted">No machines configured. Open admin panel.</div>`;
    return;
  }
  const days = dayList(RANGE_DAYS[range], now);
  machines.sort((a, b) => a.sequence - b.sequence);

  const cards: string[] = [];
  for (const m of machines) {
    const recs = await dal.listProduction({ machineCode: m.machineCode });
    const inRange = recordsInRange(recs, days);
    const flat = [...inRange.values()].flat();
    cards.push(machineCard(m, flat, days));
  }

  const ft = (['today', '7d', '30d'] as RangeKey[])
    .map(
      (k) =>
        `<button class="${k === range ? 'a' : ''}" data-range="${k}">${RANGE_LABEL[k]}</button>`,
    )
    .join('');

  app.innerHTML = `<div class="ft">${ft}</div><div class="mg">${cards.join('')}</div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      range = b.dataset.range as RangeKey;
      void renderDashboard(dal, now);
    }),
  );
  app.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) =>
    el.addEventListener('click', () => {
      const code = el.dataset.toggle!;
      if (expanded.has(code)) expanded.delete(code);
      else expanded.add(code);
      void renderDashboard(dal, now);
    }),
  );
  app.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) =>
    el.addEventListener('click', () => {
      window.location.hash = el.dataset.nav!;
    }),
  );
}
