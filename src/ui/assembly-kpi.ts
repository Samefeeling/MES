/**
 * Assembly results (`#/kpi/assembly`), in the shape the PMD KPI page uses.
 *
 * The two pages are read one after the other in the same meeting, so they are
 * laid out the same way — department and period tabs, a From/To range, a row
 * of headline tiles, one table with a TOTAL under it, and a legend saying what
 * every colour means. What differs is only what the record can support: PMD
 * rolls machine-shifts up per press, Assembly rolls order-days up per line,
 * and where PMD has OEE and changeover standards this has crew hours, the
 * standard the order carried, and whether it met its Due Date.
 */

import type { AssemblyDataLayer, AssemblyResult } from '../types/assembly';
import {
  ASSEMBLY_THRESHOLDS,
  PRODUCTIVE_HOURS_PER_PERSON,
  assemblyByLine,
  assemblyMetrics,
  colourClass,
  crewSize,
  efficiencyPct,
  onTimePct,
  plannedPct,
  yieldPct,
  type AssemblyAgg,
} from '../core/assembly-metrics';
import { departmentTabs } from './kpi-nav';
import { escapeHtml } from './modal';

/**
 * The lines in the order the board lays them out, so the table reads like the
 * floor rather than like an alphabet. Names, not keys: the production record
 * stores what the board displayed. Anything not on this list still gets a row,
 * after these.
 */
const LINE_ORDER = [
  'TBP',
  'PMD',
  'UPL-CUT',
  'UPL-Gluing',
  'UPL-SSS',
  'ASM',
  'Table',
  'General',
  'Factory General',
];

type PeriodKey = 'lastDay' | 'thisWeek' | 'custom';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'lastDay', label: 'Last 24h' },
  { key: 'thisWeek', label: 'This Week' },
];

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const au = (day: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10).split('-').reverse().join('/') : '—';

/**
 * The window each period tab means.
 *
 * "Last 24h" is the last working day, not literally the last twenty-four
 * hours: Assembly books one shift a day, so on a Monday morning the useful
 * question is what Friday did. Named to match the PMD tab beside it, which
 * bridges the weekend the same way.
 */
function periodRange(key: PeriodKey, now: Date): { from: string; to: string } {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (key === 'thisWeek') {
    const monday = new Date(day);
    // getDay(): Sunday is 0, so a Sunday belongs to the week that just ended.
    monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return { from: localDay(monday), to: localDay(day) };
  }
  const last = new Date(day);
  while (last.getDay() === 0 || last.getDay() === 6) {
    last.setDate(last.getDate() - 1);
  }
  return { from: localDay(last), to: localDay(last) };
}

interface PageState {
  period: PeriodKey;
  from: string;
  to: string;
  rows: AssemblyResult[];
  /** Lines opened out into their orders. */
  expanded: Set<string>;
  loading: boolean;
  error: string;
}

const n = (v: number): string => (v ? v.toLocaleString('en-AU') : '—');
const h = (v: number): string => (v ? v.toFixed(1) : '—');
const pct = (v: number | null): string => (v === null ? '—' : `${v}%`);

/** A metric cell, judged the way PMD judges its own. */
function cell(value: string, cls = ''): string {
  return `<td class="num${cls ? ' ' + cls : ''}">${value}</td>`;
}

/**
 * Output against what the plan asked of the crew who were on it, in PMD's own
 * shape: the figure, then a small `/n` for the denominator, coloured by the
 * ratio between them.
 */
function outputCell(agg: AssemblyAgg): string {
  const plan = plannedPct(agg);
  const t = ASSEMBLY_THRESHOLDS;
  const expected = Math.round(agg.plannedOutput);
  return `<td class="num ${colourClass(plan, t.planGreen, t.planAmber)}"${
    plan === null
      ? ''
      : ` title="${n(agg.output)} made against a plan of ${n(expected)} — ${plan}%"`
  }>${n(agg.output)}${expected > 0 ? ` <span class="kpi-exp">/${n(expected)}</span>` : ''}</td>`;
}

/** The twelve metric cells of one row — a line, an order, or the floor. */
function metricCells(agg: AssemblyAgg): string {
  const y = yieldPct(agg);
  const eff = efficiencyPct(agg);
  const on = onTimePct(agg);
  const t = ASSEMBLY_THRESHOLDS;
  return (
    cell(n(agg.orders)) +
    outputCell(agg) +
    cell(n(agg.complete)) +
    cell(n(agg.reject), agg.reject ? 'red' : 'gray') +
    cell(n(agg.rework), agg.rework ? 'amber' : 'gray') +
    cell(pct(y), colourClass(y, t.yieldGreen, t.yieldAmber)) +
    cell(h(agg.crewHours)) +
    cell(h(agg.bookedHours)) +
    cell(h(agg.earnedHours)) +
    cell(pct(eff), colourClass(eff, t.effGreen, t.effAmber)) +
    cell(h(agg.supportHours), agg.supportHours ? '' : 'gray') +
    cell(pct(on), colourClass(on, t.onTimeGreen, t.onTimeAmber))
  );
}

/** Headline tiles: what the meeting opens with, before anyone drills in. */
function statTiles(agg: AssemblyAgg): string {
  const t = ASSEMBLY_THRESHOLDS;
  const y = yieldPct(agg);
  const eff = efficiencyPct(agg);
  const on = onTimePct(agg);
  const tile = (label: string, value: string, cls = ''): string =>
    `<div class="kpi-stat${cls ? ' ' + cls : ''}"><span class="kpi-stat-label">${escapeHtml(
      label,
    )}</span><b class="kpi-stat-value">${value}</b></div>`;
  const band = (v: number | null, green: number, amber: number): string =>
    v === null ? '' : 'is-' + colourClass(v, green, amber);
  const plan = plannedPct(agg);
  return `<div class="kpi-stats">
    ${tile(
      'Output / Plan',
      agg.plannedOutput > 0
        ? `${n(agg.output)}<span class="kpi-exp"> /${n(Math.round(agg.plannedOutput))}</span>`
        : n(agg.output),
      band(plan, t.planGreen, t.planAmber),
    )}
    ${tile('Orders', n(agg.orders))}
    ${tile('Reject', n(agg.reject), agg.reject ? 'is-red' : '')}
    ${tile('Yield', pct(y), band(y, t.yieldGreen, t.yieldAmber))}
    ${tile('Crew hours', h(agg.crewHours), 'is-green')}
    ${tile('Efficiency*', pct(eff), band(eff, t.effGreen, t.effAmber))}
    ${tile('On time', pct(on), band(on, t.onTimeGreen, t.onTimeAmber))}
  </div>`;
}

/** One booked day, for the detail table under the summary. */
function bookingRow(row: AssemblyResult): string {
  const crew = crewSize(row.operators);
  return `<tr>
    <td>${au(row.day)}</td>
    <td>${escapeHtml(row.job)}</td>
    <td>${escapeHtml(row.line)}</td>
    <td>${escapeHtml(row.workType === 'Support' ? row.supportDepartment ?? '' : '')}</td>
    <td class="kpi-work">${escapeHtml(row.description ?? '')}</td>
    <td>${escapeHtml(row.operators)}</td>
    <td class="num">${row.workType === 'Support' ? h(row.laborHours ?? 0) : h(crew * PRODUCTIVE_HOURS_PER_PERSON)}</td>
    <td class="num">${n(row.output)}</td>
    <td class="num">${n(row.complete)}</td>
    <td class="num${row.reject ? ' red' : ''}">${n(row.reject)}</td>
    <td class="num">${n(row.rework)}</td>
    <td>${row.due ? au(row.due) : '—'}</td>
    <td>${row.completed ? 'Yes' : 'No'}</td>
  </tr>`;
}

export async function renderAssemblyKpi(dal: AssemblyDataLayer): Promise<void> {
  const app = document.getElementById('app')!;
  const opening = periodRange('lastDay', new Date());
  const S: PageState = {
    period: 'lastDay',
    from: opening.from,
    to: opening.to,
    rows: [],
    expanded: new Set(),
    loading: true,
    error: '',
  };
  let request = 0;

  function render(): void {
    const tabs =
      departmentTabs('assembly') +
      PERIODS.map(
        (p) =>
          `<button class="shift-btn${p.key === S.period ? ' a' : ''}" data-period="${p.key}">${escapeHtml(
            p.label,
          )}</button>`,
      ).join('');

    const total = assemblyMetrics(S.rows);
    const lines = assemblyByLine(S.rows, LINE_ORDER);
    const body = S.loading
      ? `<tr><td colspan="13" class="kpi-empty">Loading Assembly results…</td></tr>`
      : lines.length === 0
        ? `<tr><td colspan="13" class="kpi-empty">No Assembly results in this period.</td></tr>`
        : lines
            .map((line) => {
              const open = S.expanded.has(line.line);
              return (
                `<tr><th><button type="button" class="kpi-toggle" data-line="${escapeHtml(
                  line.line,
                )}" title="${open ? 'Hide' : 'Show'} the orders on this line">${open ? '–' : '+'}</button><span class="kpi-mc-name">${escapeHtml(
                  line.line,
                )}</span></th>${metricCells(line.agg)}</tr>` +
                (open
                  ? line.orders
                      .map(
                        (order) =>
                          `<tr class="kpi-sub"><th class="kpi-job-name" title="${escapeHtml(
                            order.description,
                          )}">${escapeHtml(order.job)}<span class="kpi-sub-note">${
                            order.days
                          } ${order.days === 1 ? 'day' : 'days'}${
                            order.due ? ` · due ${au(order.due)}` : ''
                          }${order.completed ? ' · done' : ''}</span></th>${metricCells(
                            order.agg,
                          )}</tr>`,
                      )
                      .join('')
                  : '')
              );
            })
            .join('');

    app.innerHTML = `
      <div class="kpi assembly-kpi">
        <div class="kpi-head">
          <div class="shift-tabs">${tabs}</div>
          <div class="kpi-range" title="Booked Assembly days">
            <label>From <input type="date" data-range="from" value="${escapeHtml(S.from)}"></label>
            <label>To <input type="date" data-range="to" value="${escapeHtml(S.to)}"></label>
          </div>
        </div>
        ${
          S.error
            ? `<div class="data-error-banner" role="alert"><b>⚠ Partial data only.</b> ${escapeHtml(
                S.error,
              )}</div>`
            : ''
        }
        ${S.loading ? '' : statTiles(total)}

        <div class="kpi-table-wrap">
          <table class="summary-table kpi-table assembly-kpi-table">
            <colgroup>
              <col class="kpi-col-machine">
              <col span="12" class="kpi-col-metric">
            </colgroup>
            <thead><tr>
              <th class="kpi-machine-head">Line</th>
              <th>Orders</th>
              <th title="What came off the line, over what the crew on it were planned to make">Output / Plan</th>
              <th>Complete</th><th>Reject</th><th>Rework</th>
              <th>Yield%</th>
              <th title="People on the order that day, at ${PRODUCTIVE_HOURS_PER_PERSON} h a head">Crew h</th>
              <th title="Output valued at the order's standard hours per piece">Booked h</th>
              <th title="Standard hours the finished units were worth">Std h</th>
              <th>Efficiency*</th>
              <th title="Factory General work, measured in the hours it took">Support h</th>
              <th>On time%</th>
            </tr></thead>
            <tbody>${body}</tbody>
            ${
              S.loading
                ? ''
                : `<tfoot><tr class="kpi-total"><th>TOTAL</th>${metricCells(total)}</tr></tfoot>`
            }
          </table>
        </div>

        ${
          S.loading || S.rows.length === 0
            ? ''
            : `<div class="kpi-table-wrap kpi-bookings">
                <table class="summary-table kpi-table">
                  <thead><tr>
                    <th>Date</th><th>Order</th><th>Line</th><th>Support department</th><th>Work</th>
                    <th>Crew</th><th>Crew h</th><th>Output</th><th>Complete</th><th>Reject</th>
                    <th>Rework</th><th>Due</th><th>Completed</th>
                  </tr></thead>
                  <tbody>${S.rows.map(bookingRow).join('')}</tbody>
                </table>
              </div>`
        }

        <div class="kpi-note">
          <div>Every metric uses one traffic-light language: <b>🟢 met · 🟡 close · 🔴 short</b>.</div>
          <div><b>Yield%</b> = Complete ÷ (Complete + Reject) — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.yieldGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.yieldAmber}%.</div>
          <div><b>Output / Plan 🟢🟡🔴</b> = what came off the line, over Crew h ÷ the order's standard — what the people who were actually on it were planned to make. 🟢 ≥ ${ASSEMBLY_THRESHOLDS.planGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.planAmber}%. Assembly keeps no separate daily schedule, so the plan is the crew's own hours at the standard rather than a figure from elsewhere.</div>
          <div><b>Crew h</b> = people booked on the order that day × ${PRODUCTIVE_HOURS_PER_PERSON} h — the 07:00–15:30 shift less morning tea and lunch, which is exactly what the board schedules with.</div>
          <div><b>Booked h</b> = Output × the order's standard hours per piece (<code>JobOper_ProdStandard</code>, carried on the record as PlannedHours ÷ OrderQty). <b>Std h</b> is the same sum over the <b>good</b> pieces only, so <b>Booked h − Std h is what the rejects cost in time</b>.</div>
          <div><b>Efficiency* 🟢🟡🔴</b> = Std h ÷ Crew h — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.effGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.effAmber}%. A day on an order carrying no standard is left out of <b>both</b> sides rather than counted as zero: an order nobody gave a labour standard is not an order that was worked badly.</div>
          <div><b>On time% 🟢🟡🔴</b> = orders finished on or before their Due Date ÷ orders finished with a Due Date to judge — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.onTimeGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.onTimeAmber}%.</div>
          <div><b>Support h</b> is Factory General work. It has no output at all, so it is never folded into Output, Yield or Efficiency — a line's support hours would otherwise read as a week spent making nothing.</div>
          <div>An order booked on five days is <b>one</b> order in every count. Press "+" on a line to see the orders behind its figures.</div>
        </div>
      </div>`;
    wire();
  }

  function wire(): void {
    app.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
      b.addEventListener('click', () => {
        S.period = b.dataset.period as PeriodKey;
        const range = periodRange(S.period, new Date());
        S.from = range.from;
        S.to = range.to;
        void load();
      }),
    );
    app.querySelectorAll<HTMLInputElement>('[data-range]').forEach((input) =>
      input.addEventListener('change', () => {
        // Editing either bound is a window of its own; the preset tabs let go.
        S.period = 'custom';
        if (input.dataset.range === 'from') S.from = input.value;
        else S.to = input.value;
        void load();
      }),
    );
    app.querySelectorAll<HTMLButtonElement>('[data-line]').forEach((b) =>
      b.addEventListener('click', () => {
        const line = b.dataset.line!;
        if (S.expanded.has(line)) S.expanded.delete(line);
        else S.expanded.add(line);
        render();
      }),
    );
  }

  async function load(): Promise<void> {
    const current = ++request;
    S.loading = true;
    S.error = '';
    render();
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(S.from) || !/^\d{4}-\d{2}-\d{2}$/.test(S.to)) {
        throw new Error('Choose both dates.');
      }
      if (S.from > S.to) throw new Error('From must be on or before To.');
      const rows = await dal.results(S.from, S.to);
      if (current !== request || !app.isConnected) return;
      S.rows = rows;
    } catch (e) {
      if (current !== request || !app.isConnected) return;
      S.rows = [];
      S.error = e instanceof Error ? e.message : String(e);
    }
    S.loading = false;
    render();
  }

  await load();
}
