import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord, ShiftCode } from '../types';
import { aggregate } from '../core/metrics';
import { buildShiftId, currentShift, dateKey, parseShiftId } from '../core/shifts';
import { closeModal, escapeHtml, openModal } from './modal';

// Management KPI view (`#/kpi`) for daily / weekly / monthly meetings.
// Per-machine Output, Reject, Yield%, Run/Down/Setup hours, a simplified
// OEE (Availability × Quality), and Schedule Adherence (good vs planned).

type PeriodKey = 'last3' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'last3', label: 'Last 24h' },
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

const SHIFT_ORDER: ShiftCode[] = ['Day', 'Afternoon', 'Night'];

/** The 3 most-recently-ENDED shifts as of `now`, oldest → newest. */
function lastThreeShifts(now: Date): string[] {
  const cs = currentShift(now);
  const p = parseShiftId(cs.shiftId)!;
  let d = new Date(p.year, p.month - 1, p.day);
  let idx = SHIFT_ORDER.indexOf(p.code);
  const out: string[] = [];
  // Step back from the current (still in-progress) shift.
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
    const fromKey = ids[0].slice(0, 10);
    const toKey = ids[ids.length - 1].slice(0, 10);
    return {
      from: new Date(fromKey + 'T00:00:00'),
      to: new Date(toKey + 'T23:59:59'),
      label: `Last 3 completed shifts (${ids[0]} → ${ids[ids.length - 1]})`,
      shiftIds: new Set(ids),
    };
  }
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

async function compute(now = new Date()): Promise<void> {
  const { from, to, shiftIds } = periodRange(S!.period, now);
  // Planning has no machine assignment now (Epicor source), so Sched.Adh
  // is computed across all PMD orders rather than per-machine.
  const planning = await dalRef.listPlanning({});
  const rows: KpiRow[] = [];
  for (const m of S!.machines) {
    const prod = (await dalRef.listProduction({ machineCode: m.machineCode })).filter((r) =>
      inRange(r, from, to, shiftIds),
    );
    const k = aggregate(prod);
    const good = k.output;
    const reject = k.scrap;
    const yieldPct = good + reject > 0 ? (good / (good + reject)) * 100 : 100;
    const quality = good + reject > 0 ? good / (good + reject) : 1;
    const loggedHrs = k.runHrs + k.downtimeHrs + k.setupHrs;
    const availability = loggedHrs > 0 ? k.runHrs / loggedHrs : 0;
    const oee = loggedHrs > 0 ? Math.round(availability * quality * 100) : null;
    const planned =
      S!.period === 'last3'
        ? 0
        : planning
            .filter((o) => !o.isDieChange)
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
          const clickable = S!.period === 'last3' ? ' data-drill="' + escapeHtml(r.machineCode) + '"' : '';
          return `<tr${clickable}>
            <th>${escapeHtml(r.machineCode)}${clickable ? ' <span class="muted">›</span>' : ''}</th>
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

  const hint =
    S!.period === 'last3'
      ? '<p class="bd-sub">Tap a machine row to drill into per-shift Day / Afternoon / Night detail with Handover notes.</p>'
      : '<p class="bd-sub">OEE* = Availability × Quality (simplified — Performance needs ideal cycle time, not yet captured). Schedule Adherence = good qty ÷ planned qty for jobs starting in the period. Read-only.</p>';

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
      ${hint}
    </div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      S!.period = b.dataset.period as PeriodKey;
      S!.loading = true;
      render();
      void compute();
    }),
  );
  app.querySelectorAll<HTMLElement>('tr[data-drill]').forEach((row) =>
    row.addEventListener('click', () => {
      void openMachineDrill(row.dataset.drill!);
    }),
  );
}

interface Handover {
  people: string;
  plant: string;
  machine: string;
  material: string;
}

function parseHandover(note: string): Handover {
  const blank: Handover = { people: '', plant: '', machine: '', material: '' };
  if (!note) return blank;
  try {
    const j = JSON.parse(note) as Partial<Handover>;
    return { ...blank, ...j };
  } catch {
    return { ...blank, people: note };
  }
}

function handoverHasContent(h: Handover): boolean {
  return !!(h.people || h.plant || h.machine || h.material);
}

function fmtHandover(h: Handover): string {
  const parts: string[] = [];
  if (h.people) parts.push(`<div class="ho-cell"><b>👥 People</b><span>${escapeHtml(h.people)}</span></div>`);
  if (h.plant) parts.push(`<div class="ho-cell"><b>🏭 Plant</b><span>${escapeHtml(h.plant)}</span></div>`);
  if (h.machine) parts.push(`<div class="ho-cell"><b>🛠 Machine</b><span>${escapeHtml(h.machine)}</span></div>`);
  if (h.material) parts.push(`<div class="ho-cell"><b>📦 Material</b><span>${escapeHtml(h.material)}</span></div>`);
  return parts.length ? `<div class="ho-grid">${parts.join('')}</div>` : '<div class="muted">No notes left.</div>';
}

async function openMachineDrill(machineCode: string): Promise<void> {
  const now = new Date();
  const shiftIds = lastThreeShifts(now);
  openModal(`<div class="bd-modal drill">
    <h3 class="bd-title">📊 ${escapeHtml(machineCode)} — last 3 shifts</h3>
    <div class="drill-body muted">Loading…</div>
    <div class="bd-actions"><button data-mod="close" class="btn-ghost-big">Close</button></div>
  </div>`);
  document
    .querySelector('[data-mod="close"]')!
    .addEventListener('click', () => closeModal());

  const prod = await dalRef.listProduction({ machineCode });
  const byShift = new Map<string, ProductionRecord[]>();
  for (const r of prod) {
    if (!shiftIds.includes(r.shiftId)) continue;
    const arr = byShift.get(r.shiftId) ?? [];
    arr.push(r);
    byShift.set(r.shiftId, arr);
  }
  const blocks = shiftIds
    .map((sid) => {
      const rows = byShift.get(sid) ?? [];
      const k = aggregate(rows);
      const logged = k.runHrs + k.downtimeHrs + k.setupHrs;
      const avail = logged > 0 ? Math.round((k.runHrs / logged) * 100) : null;
      const yieldPct =
        k.output + k.scrap > 0
          ? ((k.output / (k.output + k.scrap)) * 100).toFixed(1)
          : '100.0';
      // Handover is canonical on slotIndex=0 per job. Show one per job that
      // has any content — operators may run multiple jobs in a shift.
      const canon = rows.filter((r) => r.slotIndex === 0);
      const notes = canon
        .map((c) => {
          const h = parseHandover(c.handoverNote);
          if (!handoverHasContent(h) && !c.bdIssue) return '';
          return `<div class="ho-job">
            <div class="ho-job-head">Job ${escapeHtml(c.jobNumber || '—')} · op ${escapeHtml(c.operator || '—')} · sup ${escapeHtml(c.supervisor || '—')}</div>
            ${fmtHandover(h)}
          </div>`;
        })
        .filter(Boolean)
        .join('');
      const jobLine = canon.length
        ? canon.map((c) => escapeHtml(c.jobNumber || '—')).join(', ')
        : '<span class="muted">no production logged</span>';
      return `<section class="drill-shift">
        <h4>${escapeHtml(sid)}</h4>
        <div class="drill-kpis">
          <div><label>Good</label><b>${k.output}</b></div>
          <div><label>Reject</label><b class="r">${k.scrap}</b></div>
          <div><label>Yield</label><b>${yieldPct}%</b></div>
          <div><label>Run h</label><b>${k.runHrs.toFixed(1)}</b></div>
          <div><label>Down h</label><b>${k.downtimeHrs.toFixed(1)}</b></div>
          <div><label>Setup h</label><b>${k.setupHrs.toFixed(1)}</b></div>
          <div><label>Avail.</label><b>${avail == null ? '—' : avail + '%'}</b></div>
        </div>
        <div class="drill-jobs"><label>Jobs</label> ${jobLine}</div>
        ${notes || '<div class="muted">No Handover notes recorded.</div>'}
      </section>`;
    })
    .join('');
  const body = document.querySelector('.drill-body');
  if (body) body.innerHTML = blocks;
}

export async function renderKpi(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  document.body.className = 'shift-day'; // neutral theme
  const machines = (await dal.listMachines()).sort((a, b) => a.sequence - b.sequence);
  S = { period: 'last3', machines, loading: true, rows: [] };
  render();
  await compute();
}
