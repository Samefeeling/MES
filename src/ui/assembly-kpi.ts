/**
 * Assembly results (`#/kpi/assembly`), in the shape the PMD KPI page uses.
 *
 * Read from `ASSY_CompletedJobs`: one row per order finished on a day, as
 * Epicor reported it in `CompletedJobs.csv` and a supervisor confirmed who
 * finished it on the Assembly board. The page is laid out the way PMD's is —
 * department and period tabs, a From/To range, headline tiles, one table with
 * a TOTAL under it, and a legend — with what this record can support: orders,
 * quantity and standard hours finished, the people who finished them, and
 * whether each order met its Due Date. See `core/assembly-completions`.
 */

import type { AssemblyDataLayer, AssemblyResult, AssemblyRosterPerson } from '../types/assembly';
import { ASSEMBLY_THRESHOLDS, PRODUCTIVE_HOURS_PER_PERSON, colourClass } from '../core/assembly-metrics';
import {
  completedOrderDays,
  completionSummary,
  completionsByLine,
  completionsByPerson,
  trendWeeks,
  weeklyEfficiency,
  weeklyLineEfficiency,
  weeklyPersonEfficiency,
  type CompletedOrderDay,
  type CompletionSummary,
} from '../core/assembly-completions';
import { SERIES_COLORS, renderEfficiencyTrend, type TrendSeries } from './charts';
import { departmentTabs } from './kpi-nav';
import { escapeHtml } from './modal';

/**
 * The lines in the order the board lays them out, so the table reads like the
 * floor rather than like an alphabet. Names, not keys: the record stores what
 * the board displayed. Anything not on this list still gets a row, after these.
 */
const LINE_ORDER = [
  'TBP',
  'PMD',
  'UPL-CUT',
  'UPL-Gluing',
  'UPL-SSS',
  'Assembly',
  'Table',
  'General',
  'Factory General',
];

export type PeriodKey = 'lastDay' | 'lastWeek' | 'custom';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'lastDay', label: 'Last 24h' },
  { key: 'lastWeek', label: 'Last Week' },
];

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const au = (day: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10).split('-').reverse().join('/') : '—';

/**
 * The window each period tab means.
 *
 * "Last 24h" is the last working day before today — never today, which has
 * not been worked yet, let alone confirmed. On a Monday it is Friday to
 * Sunday, the same window the board's completed-orders dialog asks about, so
 * what was confirmed this morning is what this tab shows. Named to match the
 * PMD tab beside it, which bridges the weekend the same way.
 */
export function periodRange(key: PeriodKey, now: Date): { from: string; to: string } {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (key === 'lastWeek') {
    // Monday to Sunday of the week before this one; a Sunday belongs to the
    // week that is ending, so on a Sunday "last week" is the one before it.
    const monday = new Date(day);
    monday.setDate(day.getDate() - ((day.getDay() + 6) % 7) - 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: localDay(monday), to: localDay(sunday) };
  }
  const yesterday = new Date(day);
  yesterday.setDate(day.getDate() - 1);
  const from = new Date(yesterday);
  while (from.getDay() === 0 || from.getDay() === 6) from.setDate(from.getDate() - 1);
  return { from: localDay(from), to: localDay(yesterday) };
}

/**
 * The period and range last chosen, kept while MES is open: the page is
 * rebuilt every time it is opened from PMD, and a range somebody typed must
 * not snap back to the default each time. A preset tab is worked out afresh
 * from today; a typed range is kept as typed.
 */
let chosen: { period: PeriodKey; from: string; to: string } | null = null;
let chosenPerson: string | null = null;

interface PageState {
  period: PeriodKey;
  from: string;
  to: string;
  rows: AssemblyResult[];
  /** Lines opened out into their orders. */
  expanded: Set<string>;
  loading: boolean;
  error: string;
  /** The person picked in the people table, whose trend the chart shows. */
  person: string | null;
  roster: AssemblyRosterPerson[];
  /** The last month's completions, for the trend; null until read. */
  trend: CompletedOrderDay[] | null;
  trendError: string;
}

const n = (v: number): string => (v ? v.toLocaleString('en-AU') : '—');
const h = (v: number): string => (v ? v.toFixed(1) : '—');
const pct = (v: number | null): string => (v === null ? '—' : `${v}%`);

/** A metric cell, judged the way PMD judges its own. */
function cell(value: string, cls = ''): string {
  return `<td class="num${cls ? ' ' + cls : ''}">${value}</td>`;
}

const onTimeOf = (sum: CompletionSummary): number | null =>
  sum.datedOrders ? Math.round((sum.onTimeOrders / sum.datedOrders) * 100) : null;

/** The metric cells of one row — a line, an order, or the floor. */
function metricCells(sum: CompletionSummary): string {
  const t = ASSEMBLY_THRESHOLDS;
  const on = onTimeOf(sum);
  return (
    cell(n(sum.orders)) +
    cell(n(sum.qty)) +
    cell(h(sum.stdHours)) +
    cell(n(sum.people)) +
    cell(n(sum.personDays)) +
    cell(sum.perPersonDay === null ? '—' : sum.perPersonDay.toFixed(2)) +
    cell(pct(sum.efficiency), colourClass(sum.efficiency, t.effGreen, t.effAmber)) +
    cell(pct(on), colourClass(on, t.onTimeGreen, t.onTimeAmber))
  );
}

/** Headline tiles: what the meeting opens with, before anyone drills in. */
function statTiles(sum: CompletionSummary): string {
  const t = ASSEMBLY_THRESHOLDS;
  const on = onTimeOf(sum);
  const tile = (label: string, value: string, cls = ''): string =>
    `<div class="kpi-stat${cls ? ' ' + cls : ''}"><span class="kpi-stat-label">${escapeHtml(
      label,
    )}</span><b class="kpi-stat-value">${value}</b></div>`;
  const band = (v: number | null, green: number, amber: number): string =>
    v === null ? '' : 'is-' + colourClass(v, green, amber);
  return `<div class="kpi-stats">
    ${tile('Orders completed', n(sum.orders))}
    ${tile('Qty', n(sum.qty))}
    ${tile('Std h', h(sum.stdHours))}
    ${tile('People', n(sum.people))}
    ${tile('Std h / person-day', sum.perPersonDay === null ? '—' : sum.perPersonDay.toFixed(2))}
    ${tile('Efficiency', pct(sum.efficiency), band(sum.efficiency, t.effGreen, t.effAmber))}
    ${tile('On time', pct(on), band(on, t.onTimeGreen, t.onTimeAmber))}
  </div>`;
}

/** Supervisors and managers are on the roster but finish no orders themselves. */
const OFF_THE_FLOOR = /supervisor|manager/i;

/** The lines in their fixed colour order: a line keeps its colour whichever others appear. */
const COLOUR_ORDER = LINE_ORDER.filter((l) => l !== 'PMD');
const lineColour = (line: string): string => {
  const i = COLOUR_ORDER.findIndex((l) => l.toUpperCase() === line.toUpperCase());
  return i >= 0 && i < SERIES_COLORS.length ? SERIES_COLORS[i] : '#94a3b8';
};

/**
 * The last month's efficiency, week by week: every line, or the person picked
 * beside the floor as a whole.
 */
function trendCard(S: PageState, yesterday: string): string {
  const { weeks } = trendWeeks(yesterday);
  const partial = new Date(`${yesterday}T12:00:00`).getDay() !== 0;
  const labels = weeks.map((w, i) => `${au(w).slice(0, 5)}${partial && i === weeks.length - 1 ? '*' : ''}`);
  const target = ASSEMBLY_THRESHOLDS.effGreen;
  let body: string;
  if (S.trend === null) {
    body = `<div class="kpi-empty">${S.trendError ? escapeHtml(S.trendError) : 'Loading the last month…'}</div>`;
  } else {
    const series: TrendSeries[] = S.person
      ? [
          { name: S.person, color: SERIES_COLORS[0], values: weeklyPersonEfficiency(S.trend, weeks, S.person) },
          { name: 'All Assembly', color: '#94a3b8', values: weeklyEfficiency(S.trend, weeks), reference: true },
        ]
      : weeklyLineEfficiency(S.trend, weeks, LINE_ORDER).map((l) => ({ name: l.name, color: lineColour(l.name), values: l.values }));
    body = renderEfficiencyTrend(labels, series, target);
  }
  return `<div class="kpi-chart assembly-trend">
      <div class="kpi-chart-head">
        <h4>Efficiency by week — last month · ${S.person ? escapeHtml(S.person) : 'every line'}</h4>
        ${S.person ? '<button type="button" class="shift-btn kpi-util-all" data-person-clear>All lines</button>' : ''}
      </div>
      ${body}
      <div class="kpi-chart-note">Week starting Monday${partial ? '; * = the week so far' : ''}. Efficiency = Std h ÷ person-days ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h, from <code>ASSY_CompletedJobs</code>; a week with no confirmed completion is a gap. ${
        S.person ? 'The dashed grey line is the whole floor, for comparison.' : 'Click a person in the table to see theirs.'
      }</div>
    </div>`;
}

/** Per person beside the trend, and per completion: the detail under the line table. */
function detailTables(done: readonly CompletedOrderDay[], S: PageState, yesterday: string): string {
  const t = ASSEMBLY_THRESHOLDS;
  const people = completionsByPerson(done);
  const worked = new Set(people.map((p) => p.name.toLowerCase()));
  const away = S.roster
    .filter((r) => !OFF_THE_FLOOR.test(r.position) && !worked.has(r.name.toLowerCase()))
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));
  const picked = (name: string): string =>
    S.person && S.person.toLowerCase() === name.toLowerCase() ? ' is-selected' : '';
  const rows =
    people
      .map(
        (p) => `<tr class="kpi-person${picked(p.name)}" data-person="${escapeHtml(p.name)}" title="Show ${escapeHtml(p.name)}'s efficiency by week"><th>${escapeHtml(p.name)}</th>${cell(n(p.orders))}${cell(h(p.stdHours))}${cell(n(p.days))}${cell(
          p.perDay.toFixed(2),
        )}${cell(`${p.efficiency}%`, colourClass(p.efficiency, t.effGreen, t.effAmber))}</tr>`,
      )
      .join('') +
    away
      .map(
        (name) => `<tr class="kpi-person kpi-away${picked(name)}" data-person="${escapeHtml(name)}" title="On the roster, named on no confirmed completion in this period"><th>${escapeHtml(name)}</th><td colspan="5" class="gray">On leave</td></tr>`,
      )
      .join('');
  return `<div class="assembly-people-grid">
    <div>
      <h3 class="kpi-section-title">By person</h3>
      <div class="kpi-table-wrap">
        <table class="summary-table kpi-table assembly-people-table">
          <thead><tr>
            <th class="kpi-machine-head">Person</th><th>Orders</th>
            <th title="Their share of the standard hours of the orders they finished — an order finished by three people gives each a third">Std h</th>
            <th title="Days they are named on a completion">Days</th>
            <th title="Std h ÷ Days">Std h / day</th>
            <th title="Std h / day ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h">Efficiency</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="kpi-empty">Nobody is named on a completion in this period.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    ${trendCard(S, yesterday)}
  </div>
    ${done.length ? `<h3 class="kpi-section-title">Completions</h3>
    <div class="kpi-table-wrap kpi-bookings">
      <table class="summary-table kpi-table">
        <thead><tr>
          <th>Completed</th><th>Order</th><th>Part</th><th>Line</th><th>Qty</th><th>Std h</th>
          <th>Due</th><th>On time</th><th title="This day finished the order's whole quantity">Order done</th><th>Finished by</th><th>Confirmed by</th>
        </tr></thead>
        <tbody>${done
          .map(
            (d) => `<tr>
              <td>${au(d.day)}</td><td>${escapeHtml(d.job)}</td><td>${escapeHtml(d.partNum)}</td><td>${escapeHtml(d.line)}</td>
              <td class="num">${n(d.qty)}</td><td class="num">${h(d.stdHours)}</td>
              <td>${d.due ? au(d.due) : '—'}</td>
              <td class="${d.onTime === null ? 'gray' : d.onTime ? 'green' : 'red'}">${d.onTime === null ? '—' : d.onTime ? 'Yes' : 'Late'}</td>
              <td>${d.finished ? 'Yes' : '—'}</td>
              <td>${escapeHtml(d.people.join(', '))}</td><td>${escapeHtml(d.confirmedBy)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>` : ''}`;
}

export async function renderAssemblyKpi(dal: AssemblyDataLayer): Promise<void> {
  const app = document.getElementById('app')!;
  const period: PeriodKey = chosen?.period ?? 'lastDay';
  const opening = period === 'custom' && chosen ? chosen : periodRange(period, new Date());
  const S: PageState = {
    period,
    from: opening.from,
    to: opening.to,
    rows: [],
    expanded: new Set(),
    loading: true,
    error: '',
    person: chosenPerson,
    roster: [],
    trend: null,
    trendError: '',
  };
  const yesterday = periodRange('lastDay', new Date()).to;
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

    const done = completedOrderDays(S.rows);
    const total = completionSummary(done);
    const lines = completionsByLine(done, LINE_ORDER);
    const body = S.loading
      ? `<tr><td colspan="9" class="kpi-empty">Loading Assembly results…</td></tr>`
      : lines.length === 0
        ? `<tr><td colspan="9" class="kpi-empty">No confirmed completions in this period. They appear once a supervisor confirms who finished each order in the Assembly board's <b>✓ Completed</b> dialog.</td></tr>`
        : lines
            .map((line) => {
              const open = S.expanded.has(line.line);
              return (
                `<tr><th><button type="button" class="kpi-toggle" data-line="${escapeHtml(
                  line.line,
                )}" title="${open ? 'Hide' : 'Show'} the orders on this line">${open ? '–' : '+'}</button><span class="kpi-mc-name">${escapeHtml(
                  line.line,
                )}</span></th>${metricCells(line.summary)}</tr>` +
                (open
                  ? line.orders
                      .map(
                        (order) =>
                          `<tr class="kpi-sub"><th class="kpi-job-name" title="${escapeHtml(
                            order.partNum,
                          )}">${escapeHtml(order.job)}<span class="kpi-sub-note">${
                            order.days
                          } ${order.days === 1 ? 'day' : 'days'}${
                            order.due ? ` · due ${au(order.due)}` : ''
                          }${order.finished ? ' · done' : ''}</span></th>${metricCells(order.summary)}</tr>`,
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
          <div class="kpi-range" title="Days the orders were completed">
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
              <col span="8" class="kpi-col-metric">
            </colgroup>
            <thead><tr>
              <th class="kpi-machine-head">Line</th>
              <th title="Distinct orders with a completion in the period">Orders</th>
              <th title="Quantity Epicor shows finished">Qty</th>
              <th title="Standard hours of that quantity, as Epicor values it">Std h</th>
              <th title="People named as having finished them">People</th>
              <th title="One person named on at least one completion on one day">Person-days</th>
              <th title="Std h ÷ Person-days">Std h / person-day</th>
              <th title="Std h / person-day ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h">Efficiency</th>
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

        ${S.loading ? '' : detailTables(done, S, yesterday)}

        <div class="kpi-note">
          <div>Every figure comes from <code>ASSY_CompletedJobs</code>: one row per order finished on a day — what <code>CompletedJobs.csv</code> shows reported (every planner but PMD), once a supervisor has confirmed who finished it in the Assembly board's <b>✓ Completed</b> dialog. A big order finished over several days has a row for each day and is <b>one</b> order in every count.</div>
          <div><b>Qty</b> and <b>Std h</b> are Epicor's (<code>LaborDtl_LaborQty</code>, <code>LaborDtl_LaborHrs</code> — standard hours, not clocked time).</div>
          <div><b>Person-days</b> = each person counted once for each day they are named on a completion. <b>Std h / person-day</b> = Std h ÷ Person-days, and <b>Efficiency 🟢🟡🔴</b> is that over ${PRODUCTIVE_HOURS_PER_PERSON} h, the 07:00–15:30 shift less morning tea and lunch — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.effGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.effAmber}%. Per person, an order's Std h is shared equally among the people who finished it. It counts finished work only, so a day spent on an order finished on a later day earns nothing here.</div>
          <div><b>On time% 🟢🟡🔴</b> = orders whose last completion in the period was on or before their Due Date ÷ orders with a Due Date to judge — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.onTimeGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.onTimeAmber}%. <b>Order done</b> marks the day the export's running total reached the order's quantity.</div>
          <div><b>By person</b> lists everyone on <code>ASSY_Operator</code> (supervisors and managers excepted): a person named on no confirmed completion in the period is marked <b>On leave</b> — which also covers anybody who spent the period on an order not yet finished. Click a person to see their efficiency by week on the right, beside the whole floor; click again for every line.</div>
          <div><b>Last 24h</b> is the last working day before today (Friday to Sunday on a Monday); <b>Last Week</b> is Monday to Sunday of the week before this one.</div>
          <div>Press "+" on a line to see the orders behind its figures.</div>
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
    app.querySelectorAll<HTMLElement>('[data-person]').forEach((tr) =>
      tr.addEventListener('click', () => {
        const name = tr.dataset.person!;
        S.person = S.person?.toLowerCase() === name.toLowerCase() ? null : name;
        chosenPerson = S.person;
        render();
      }),
    );
    app.querySelector<HTMLButtonElement>('[data-person-clear]')?.addEventListener('click', () => {
      S.person = null;
      chosenPerson = null;
      render();
    });
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
    chosen = { period: S.period, from: S.from, to: S.to };
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

  /** The last month and the roster: read once a visit, whatever the period. */
  async function loadContext(): Promise<void> {
    const range = trendWeeks(yesterday);
    const [trend, roster] = await Promise.allSettled([
      dal.results(range.from, range.to),
      dal.roster ? dal.roster() : Promise.resolve([]),
    ]);
    if (!app.isConnected) return;
    if (trend.status === 'fulfilled') S.trend = completedOrderDays(trend.value);
    else S.trendError = `The last month could not be read: ${trend.reason instanceof Error ? trend.reason.message : String(trend.reason)}`;
    if (roster.status === 'fulfilled') S.roster = roster.value;
    if (!S.loading) render();
  }

  void loadContext();
  await load();
}
