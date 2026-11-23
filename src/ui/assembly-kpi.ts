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

import type { AssemblyAttendance, AssemblyDataLayer, AssemblyResult, AssemblyRosterPerson } from '../types/assembly';
import {
  attendanceByEmployee,
  attendanceCovers,
  attendanceWeeks,
  unusualWorkTypes,
  type AttendanceEntry,
  type PersonAttendance,
} from '../core/attendance';
import { HISTORY_GROUPS, historyGroup, weeklyHistory, type HistoryGroup, type HistoryRow } from '../core/assembly-history';
import { ASSEMBLY_THRESHOLDS, PRODUCTIVE_HOURS_PER_PERSON, colourClass } from '../core/assembly-metrics';
import {
  completedOrderDays,
  completionSummary,
  completionsByLine,
  completionsByPerson,
  mondayOf,
  weeklyEfficiency,
  weeklyLineEfficiency,
  weeklyPersonEfficiency,
  filterCompletions,
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
  /**
   * The person picked (a name pressed anywhere on the page): narrows the
   * Completions table and puts their weeks on the chart. `job` narrows the
   * table to one order.
   */
  person: string | null;
  job: string | null;
  loading: boolean;
  error: string;
  roster: AssemblyRosterPerson[];
  /** What of the roster's leave could not be read. */
  rosterWarning: string | null;
  /** Payroll's timesheets; null until read (or with none to read). */
  attendance: AssemblyAttendance | null;
  attendanceError: string;
  /** `CompletedJobs.csv`'s standard hours, every day it holds; null until read. */
  history: HistoryRow[] | null;
  historyError: string;
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

/** A name that narrows the Completions table to that person when pressed. */
function nameButton(name: string, active: string | null): string {
  const on = active !== null && active.toLowerCase() === name.toLowerCase();
  return `<button type="button" class="kpi-name${on ? ' a' : ''}" data-person="${escapeHtml(name)}" title="${
    on ? 'Show every completion' : `Show ${escapeHtml(name)}'s completions`
  }">${escapeHtml(name)}</button>`;
}

/** The names cell beside People: who is on the line, or on the order. */
const namesCell = (names: readonly string[], active: string | null): string =>
  `<td class="kpi-names">${names.map((name) => nameButton(name, active)).join('')}</td>`;

/**
 * The metric cells of one row — a line, an order, or the floor. `names` is
 * the names cell; the floor's TOTAL leaves it empty, the By person table
 * below being the list of everybody.
 */
function metricCells(sum: CompletionSummary, names = '<td class="kpi-names"></td>'): string {
  const t = ASSEMBLY_THRESHOLDS;
  const on = onTimeOf(sum);
  return (
    cell(n(sum.orders)) +
    cell(n(sum.qty)) +
    cell(h(sum.stdHours)) +
    cell(n(sum.people)) +
    names +
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

/** What the trend chart draws; drawn once the card is on the page and its size is known. */
interface TrendModel {
  labels: string[];
  series: TrendSeries[];
  target: number;
}

/** The history lines' colours: fixed, so a line keeps its colour whichever others appear. */
const groupColour = (g: string): string => {
  const i = HISTORY_GROUPS.indexOf(g as (typeof HISTORY_GROUPS)[number]);
  return i >= 0 ? SERIES_COLORS[i] : '#94a3b8';
};

/**
 * What the timesheets say, made ready for the page: the lines that are
 * Assembly's (a person on ASSY_Operator, or anybody whose Location is an
 * Assembly one), each roster person's payroll id, and the weeks covered.
 */
interface AttendanceView {
  entries: AttendanceEntry[];
  weeks: Set<string>;
  byName: Map<string, AssemblyRosterPerson>;
  groupOf: (employeeId: string) => HistoryGroup | null;
  /** Payroll names with Assembly hours and no `EmployeeId` on ASSY_Operator. */
  unmatched: string[];
}

function attendanceView(S: PageState): AttendanceView | null {
  if (!S.attendance || S.attendance.entries.length === 0) return null;
  const byEmployee = new Map(S.roster.filter((r) => r.employeeId).map((r) => [r.employeeId, r]));
  const entries = S.attendance.entries.filter((e) => byEmployee.has(e.employeeId) || /assembly/i.test(e.location));
  const unmatched = [...new Set(entries.filter((e) => !byEmployee.has(e.employeeId) && e.kind === 'direct').map((e) => e.name || e.employeeId))].sort();
  return {
    entries,
    weeks: attendanceWeeks(entries),
    byName: new Map(S.roster.map((r) => [r.name.toLowerCase(), r])),
    groupOf: (id) => historyGroup(byEmployee.get(id)?.line ?? ''),
    unmatched,
  };
}

const addDaysLocal = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};

const hoursOf = (v: number | null): string => (v === null ? '—' : v.toFixed(v >= 100 ? 0 : 1));

/**
 * The weeks of the From–To range (their Mondays), and which of them the range
 * holds only part of — the first and last, when it starts after a Monday or
 * ends before a Sunday.
 */
export function rangeWeeks(from: string, to: string): { weeks: string[]; partial: boolean[] } {
  const weeks: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return { weeks, partial: [] };
  for (let w = mondayOf(from); w <= to && weeks.length < 160; w = addDaysLocal(w, 7)) weeks.push(w);
  return { weeks, partial: weeks.map((w) => w < from || addDaysLocal(w, 6) > to) };
}

/** The From–To range's efficiency, week by week: every line, or the person picked beside the whole floor. */
function trendModel(S: PageState, done: readonly CompletedOrderDay[]): TrendModel | null {
  const { weeks, partial } = rangeWeeks(S.from, S.to);
  if (!weeks.length) return null;
  const labels = weeks.map((w, i) => `w/c ${au(w).slice(0, 5)}${partial[i] ? '*' : ''}`);
  const att = attendanceView(S);
  const inRange = (d: { day: string }): boolean => d.day >= S.from && d.day <= S.to;
  // Std h finished over direct hours attended, once there are timesheets and
  // the export to set them against — both counted only inside From–To.
  if (att && S.history) {
    const hist = weeklyHistory(S.history.filter(inRange), att.entries.filter(inRange), att.groupOf, weeks, att.weeks);
    const detail = (p: { stdHours: number; directHours: number | null }): string =>
      p.directHours === null ? `${hoursOf(p.stdHours)} Std h · no timesheet` : `${hoursOf(p.stdHours)} / ${hoursOf(p.directHours)} h`;
    const floor: TrendSeries = {
      name: 'All Assembly',
      color: '#94a3b8',
      values: hist.floor.map((p) => p.efficiency),
      details: hist.floor.map(detail),
      reference: true,
    };
    if (!S.person) {
      return {
        labels,
        target: ASSEMBLY_THRESHOLDS.effGreen,
        series: hist.lines.map((l) => ({
          name: l.name,
          color: groupColour(l.name),
          values: l.points.map((p) => p.efficiency),
          details: l.points.map(detail),
        })),
      };
    }
    const who = att.byName.get(S.person.toLowerCase());
    if (who?.employeeId) {
      const mine = done;
      const points = weeks.map((w) => {
        const start = w < S.from ? S.from : w;
        const end = addDaysLocal(w, 6) > S.to ? S.to : addDaysLocal(w, 6);
        const share = completionsByPerson(mine.filter((d) => d.day >= start && d.day <= end)).find(
          (p) => p.name.toLowerCase() === S.person!.toLowerCase(),
        )?.stdHours ?? 0;
        const direct = att.weeks.has(w) ? attendanceByEmployee(att.entries, start, end).get(who.employeeId)?.direct ?? 0 : null;
        return { stdHours: share, directHours: direct, efficiency: direct ? Math.round((share / direct) * 100) : null };
      });
      return {
        labels,
        target: ASSEMBLY_THRESHOLDS.effGreen,
        series: [
          { name: S.person, color: SERIES_COLORS[0], values: points.map((p) => p.efficiency), details: points.map(detail) },
          floor,
        ],
      };
    }
  }
  const series: TrendSeries[] = S.person
    ? [
        { name: S.person, color: SERIES_COLORS[0], values: weeklyPersonEfficiency(done, weeks, S.person) },
        { name: 'All Assembly', color: '#94a3b8', values: weeklyEfficiency(done, weeks), reference: true },
      ]
    : weeklyLineEfficiency(done, weeks, LINE_ORDER).map((l) => ({ name: l.name, color: lineColour(l.name), values: l.values }));
  return { labels, series, target: ASSEMBLY_THRESHOLDS.effGreen };
}

/** The chart's card: legend, the plot (filled in by `drawTrend`), and how to read it. */
function trendCard(S: PageState, model: TrendModel | null): string {
  const partial = rangeWeeks(S.from, S.to).partial.some(Boolean);
  const att = attendanceView(S);
  const byHours = Boolean(att && S.history && (!S.person || att.byName.get(S.person.toLowerCase())?.employeeId));
  const note = byHours
    ? `Weeks start on Monday${partial ? '; * = only part of the week is inside From–To' : ''}. Efficiency = Std h finished (<code>CompletedJobs.csv</code>${
        S.person ? `; for ${escapeHtml(S.person)}, their share of confirmed completions` : ''
      }) ÷ direct hours attended (timesheets in <code>Attendance</code>). UPL is its three benches together — the export does not tell them apart. A week no timesheet covers is a gap. ${
        S.person ? 'Dashed grey: the whole floor, for comparison.' : 'Press a name to see that person beside the floor.'
      }`
    : `Weeks start on Monday${partial ? '; * = only part of the week is inside From–To' : ''}. Efficiency = Std h ÷ person-days ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h, from <code>ASSY_CompletedJobs</code>; a week with no confirmed completion is a gap. ${
        S.person ? 'Dashed grey: the whole floor, for comparison.' : 'Press a name to see that person beside the floor.'
      }${
        S.person && att && S.history ? ` ${escapeHtml(S.person)} has no <code>EmployeeId</code> on ASSY_Operator, so their timesheet cannot be matched.` : ''
      }${!att && S.history && S.attendance ? ' No timesheet found in <code>Attendance</code> yet: once there is one, this becomes Std h ÷ direct hours attended.' : ''}`;
  const legend = model
    ? model.series
        .map(
          (s) =>
            `<span class="trend-key${s.reference ? ' ref' : ''}"><i style="--c:${s.color}"></i>${escapeHtml(s.name)}</span>`,
        )
        .join('')
    : '';
  return `<div class="assembly-trend-card">
      <div class="trend-top">
        <div class="trend-legend">${legend}</div>
        ${S.person ? '<button type="button" class="kpi-filter-clear" data-person-clear title="Every line">✕ All lines</button>' : ''}
      </div>
      <div class="trend-plot" data-trend-plot>${
        model ? '' : '<div class="kpi-empty">Choose a From–To range.</div>'
      }<div class="trend-tip" hidden></div></div>
      <div class="kpi-chart-note">${note}</div>
    </div>`;
}

/**
 * Draw the trend into its card at the card's own size, and keep it drawn to
 * size. Hovering shows a guide and every series' value for that week.
 */
function drawTrend(app: HTMLElement, model: TrendModel | null): ResizeObserver | null {
  const plot = app.querySelector<HTMLElement>('[data-trend-plot]');
  if (!plot || !model) return null;
  const tip = plot.querySelector<HTMLElement>('.trend-tip')!;
  let xs: number[] = [];
  const draw = (): void => {
    const g = renderEfficiencyTrend(model.labels, model.series, model.target, {
      width: plot.clientWidth,
      height: plot.clientHeight,
    });
    plot.querySelector('svg')?.remove();
    plot.insertAdjacentHTML('afterbegin', g.svg);
    xs = g.xs;
  };
  draw();
  plot.onmousemove = (e) => {
    const svg = plot.querySelector('svg');
    if (!svg || xs.length === 0) return;
    const box = svg.getBoundingClientRect();
    const x = e.clientX - box.left;
    const i = xs.reduce((best, xi, k) => (Math.abs(xi - x) < Math.abs(xs[best] - x) ? k : best), 0);
    const guide = svg.querySelector<SVGLineElement>('.trend-guide');
    guide?.setAttribute('x1', String(xs[i]));
    guide?.setAttribute('x2', String(xs[i]));
    guide?.setAttribute('visibility', 'visible');
    const rows = model.series
      .map(
        (s) =>
          `<div><i style="--c:${s.color}"></i>${escapeHtml(s.name)}<b>${s.values[i] === null ? '—' : `${s.values[i]}%`}</b>${
            s.details?.[i] ? `<small>${escapeHtml(s.details[i]!)}</small>` : ''
          }</div>`,
      )
      .join('');
    tip.innerHTML = `<div class="trend-tip-head">${escapeHtml(model.labels[i])}</div>${rows}`;
    tip.hidden = false;
    const left = xs[i] + 14 + tip.offsetWidth > plot.clientWidth ? xs[i] - 14 - tip.offsetWidth : xs[i] + 14;
    tip.style.left = `${Math.max(0, left)}px`;
  };
  plot.onmouseleave = () => {
    tip.hidden = true;
    plot.querySelector<SVGLineElement>('.trend-guide')?.setAttribute('visibility', 'hidden');
  };
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  observer.observe(plot);
  return observer;
}

/**
 * Per person beside the trend, and per completion: the detail under the line
 * table. A person picked (a name pressed anywhere on the page) narrows the
 * Completions list to them and puts their weeks on the chart.
 */
function detailTables(done: readonly CompletedOrderDay[], S: PageState): string {
  const t = ASSEMBLY_THRESHOLDS;
  const filter = { person: S.person, job: S.job };
  const people = completionsByPerson(done);
  const shown = filterCompletions(done, filter);
  const person = filter.person;
  // A person's share of each completion: its Std h split equally among the
  // people who finished it — the figure their row in By person adds up.
  const share = (d: CompletedOrderDay): number => (d.people.length ? d.stdHours / d.people.length : 0);
  const filterNote = [
    person ? `named on by <b>${escapeHtml(person)}</b>` : '',
    filter.job ? `of order <b>${escapeHtml(filter.job)}</b>` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  const worked = new Set(people.map((p) => p.name.toLowerCase()));
  const roster = new Map(S.roster.map((r) => [r.name.toLowerCase(), r]));
  // With timesheets for every week of the period, a person's efficiency is
  // their share of Std h over the direct hours they attended, and their leave
  // is payroll's as well as the board's.
  const att = attendanceView(S);
  const timed = Boolean(att && attendanceCovers(att.weeks, S.from, S.to));
  const clock = timed ? attendanceByEmployee(att!.entries, S.from, S.to) : new Map<string, PersonAttendance>();
  const clockOf = (name: string): PersonAttendance | null => {
    const id = roster.get(name.toLowerCase())?.employeeId;
    return id ? clock.get(id) ?? { direct: 0, indirect: 0, leave: 0, leaveDays: [] } : null;
  };
  // Leave inside the period: booked annual leave and days marked off on the
  // board, and the leave lines of the timesheets.
  const leaveDays = (name: string): string[] => [
    ...new Set([
      ...(roster.get(name.toLowerCase())?.leaveDays.filter((d) => d >= S.from && d <= S.to) ?? []),
      ...(clockOf(name)?.leaveDays ?? []),
    ]),
  ];
  const leaveIn = (name: string): number => leaveDays(name).length;
  const leaveCell = (name: string): string => {
    const days = leaveIn(name);
    return `<td class="num${days ? '' : ' gray'}">${days ? `${days} d` : '—'}</td>`;
  };
  /** Away all period: leave, and no direct hour on the timesheet (when there is one). */
  const onLeave = (name: string): boolean => leaveIn(name) > 0 && !((clockOf(name)?.direct ?? 0) > 0);
  const away = S.roster
    .filter((r) => !OFF_THE_FLOOR.test(r.position) && !worked.has(r.name.toLowerCase()))
    .map((r) => r.name)
    .sort((a, b) => Number(onLeave(b)) - Number(onLeave(a)) || a.localeCompare(b));
  const picked = (name: string): string =>
    person && person.toLowerCase() === name.toLowerCase() ? ' class="kpi-picked"' : '';
  const personCells = (p: (typeof people)[number]): string => {
    if (!timed) {
      return cell(p.perDay.toFixed(2)) + cell(`${p.efficiency}%`, colourClass(p.efficiency, t.effGreen, t.effAmber));
    }
    const direct = clockOf(p.name)?.direct ?? null;
    const eff = direct ? Math.round((p.stdHours / direct) * 100) : null;
    return (
      `<td class="num${direct === null ? ' gray' : ''}"${direct === null ? ' title="No EmployeeId on ASSY_Operator: their timesheet cannot be matched"' : ''}>${
        direct === null ? '?' : h(direct)
      }</td>` + cell(pct(eff), colourClass(eff, t.effGreen, t.effAmber))
    );
  };
  const awayText = (name: string): { text: string; cls: string; title: string } => {
    if (onLeave(name)) return { text: 'On leave', cls: 'kpi-leave', title: 'On leave in this period' };
    const c = timed ? clockOf(name) : null;
    if (c && c.direct > 0) {
      return {
        text: `No completion · ${h(c.direct)} direct h`,
        cls: 'gray',
        title: 'At work on direct hours, and named on no confirmed completion in this period',
      };
    }
    if (c && c.indirect > 0) return { text: 'No completion · indirect only', cls: 'gray', title: 'Only indirect hours on the timesheet in this period' };
    return { text: 'No completion', cls: 'gray', title: 'Not on leave, and named on no confirmed completion in this period' };
  };
  const rows =
    people
      .map(
        (p) => `<tr${picked(p.name)}><th>${nameButton(p.name, person)}</th>${cell(n(p.orders))}${cell(h(p.stdHours))}${cell(n(p.days))}${personCells(
          p,
        )}${leaveCell(p.name)}</tr>`,
      )
      .join('') +
    away
      .map((name) => {
        const a = awayText(name);
        return `<tr${picked(name) || ' class="kpi-away"'} title="${a.title}"><th>${nameButton(name, person)}</th><td colspan="5" class="${a.cls}">${
          a.text
        }</td>${leaveCell(name)}</tr>`;
      })
      .join('');
  const warnings = [
    S.rosterWarning,
    S.attendanceError,
    S.historyError,
    ...(S.attendance?.errors.slice(0, 3) ?? []),
    att?.unmatched.length
      ? `${att.unmatched.length} on the timesheets with Assembly direct hours have no EmployeeId on ASSY_Operator (${att.unmatched.slice(0, 6).join(', ')}${
          att.unmatched.length > 6 ? '…' : ''
        }): their hours count for the whole floor only, so the line they work on reads high. Fill in their EmployeeId to fix it.`
      : '',
  ].filter(Boolean);
  const unusual = att ? unusualWorkTypes(att.entries) : [];
  const timedNote = att
    ? timed
      ? `Hours and Efficiency from the timesheets (${S.attendance!.files.length} in <code>Attendance</code>): Efficiency = Std h ÷ direct hours attended.${
          unusual.length ? ` Counted as work: ${unusual.map(escapeHtml).join(', ')}.` : ''
        }`
      : 'No timesheet covers every week of this period: Efficiency here is Std h ÷ days ÷ 7.5 h.'
    : '';
  const leaveNote =
    (timedNote ? `<div class="kpi-chart-note">${timedNote}</div>` : '') +
    warnings.map((w) => `<div class="kpi-chart-note">⚠ ${escapeHtml(w!)}</div>`).join('');
  return `<div class="assembly-people-grid">
    <h3 class="kpi-section-title apg-title-l">By person<span class="kpi-sub-note">press a name to see their completions and weeks</span></h3>
    <h3 class="kpi-section-title apg-title-r">Efficiency by week<span class="kpi-sub-note">${au(S.from)} – ${au(S.to)} · ${
      S.person ? escapeHtml(S.person) : 'every line'
    }</span></h3>
    <div class="apg-box-l">
      <div class="kpi-table-wrap">
        <table class="summary-table kpi-table assembly-people-table">
          <thead><tr>
            <th class="kpi-machine-head">Person</th>
            <th title="Orders they are named on. An order three people finished is one order for each of them; its Std h is split three ways.">Orders</th>
            <th title="Their share of the standard hours of the orders they finished — an order finished by three people gives each a third">Std h</th>
            <th title="Days they are named on a completion">Days</th>
            ${
              timed
                ? '<th title="Direct hours attended in the period, from the timesheets (Total Duration of lines at a Direct location, leave excepted)">Direct h</th><th title="Std h ÷ Direct h">Efficiency</th>'
                : `<th title="Std h ÷ Days">Std h / day</th><th title="Std h / day ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h">Efficiency</th>`
            }
            <th title="Days on leave in this period: booked annual leave, days marked off on the board, and leave lines on the timesheets">Leave</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="kpi-empty">Nobody is named on a completion in this period.</td></tr>`}</tbody>
        </table>
      </div>
      ${leaveNote}
    </div>
    ${trendCard(S, trendModel(S, done))}
  </div>
    ${done.length ? `<h3 class="kpi-section-title">Completions${
      filterNote
        ? `<span class="kpi-filter">${shown.length} ${filterNote} <button type="button" class="kpi-filter-clear" data-clear-filter title="Show every completion">✕ Show all</button></span>`
        : '<span class="kpi-sub-note">press a name or an order to narrow this list</span>'
    }</h3>
    <div class="kpi-table-wrap kpi-bookings">
      <table class="summary-table kpi-table">
        <thead><tr>
          <th>Completed</th><th>Order</th><th>Part</th><th>Line</th><th>Qty</th><th>Std h</th>
          ${person ? `<th title="${escapeHtml(person)}'s share: Std h ÷ the people who finished it">Share</th>` : ''}
          <th>Due</th><th>On time</th><th title="This day finished the order's whole quantity">Order done</th><th>Finished by</th><th>Confirmed by</th>
        </tr></thead>
        <tbody>${shown
          .map(
            (d) => `<tr>
              <td>${au(d.day)}</td><td>${jobButton(d.job, filter.job)}</td><td>${escapeHtml(d.partNum)}</td><td>${escapeHtml(d.line)}</td>
              <td class="num">${n(d.qty)}</td><td class="num">${h(d.stdHours)}</td>
              ${person ? `<td class="num">${share(d).toFixed(2)}</td>` : ''}
              <td>${d.due ? au(d.due) : '—'}</td>
              <td class="${d.onTime === null ? 'gray' : d.onTime ? 'green' : 'red'}"${
                d.onTime === null && d.due && !d.finished ? ' title="A part of the order, before its Due Date: judged when the order is finished"' : ''
              }>${d.onTime === null ? (d.due && !d.finished ? 'In progress' : '—') : d.onTime ? 'Yes' : 'Late'}</td>
              <td>${d.finished ? 'Yes' : '—'}</td>
              <td class="kpi-names">${d.people.map((p) => nameButton(p, person)).join('')}</td><td>${escapeHtml(d.confirmedBy)}</td>
            </tr>`,
          )
          .join('')}</tbody>${
          filterNote && shown.length
            ? `<tfoot><tr class="kpi-total"><th colspan="4">TOTAL</th><td class="num">${n(
                shown.reduce((a, d) => a + d.qty, 0),
              )}</td><td class="num">${h(shown.reduce((a, d) => a + d.stdHours, 0))}</td>${
                person ? `<td class="num">${shown.reduce((a, d) => a + share(d), 0).toFixed(2)}</td>` : ''
              }<td colspan="5"></td></tr></tfoot>`
            : ''
        }
      </table>
    </div>` : ''}`;
}

/** An order number that narrows the Completions table to it when pressed. */
function jobButton(job: string, active: string | null): string {
  const on = active === job;
  return `<button type="button" class="kpi-job-link${on ? ' a' : ''}" data-job="${escapeHtml(job)}" title="${
    on ? 'Show every completion' : `Show ${escapeHtml(job)}'s completions`
  }">${escapeHtml(job)}</button>`;
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
    person: chosenPerson,
    job: null,
    loading: true,
    error: '',
    roster: [],
    rosterWarning: null,
    attendance: null,
    attendanceError: '',
    history: null,
    historyError: '',
  };
  let request = 0;
  let trendObserver: ResizeObserver | null = null;

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
      ? `<tr><td colspan="10" class="kpi-empty">Loading Assembly results…</td></tr>`
      : lines.length === 0
        ? `<tr><td colspan="10" class="kpi-empty">No confirmed completions in this period. They appear once a supervisor confirms who finished each order in the Assembly board's <b>✓ Completed</b> dialog.</td></tr>`
        : lines
            .map((line) => {
              const open = S.expanded.has(line.line);
              return (
                `<tr><th><button type="button" class="kpi-toggle" data-line="${escapeHtml(
                  line.line,
                )}" title="${open ? 'Hide' : 'Show'} the orders on this line">${open ? '–' : '+'}</button><span class="kpi-mc-name">${escapeHtml(
                  line.line,
                )}</span></th>${metricCells(line.summary, namesCell(line.summary.names, S.person))}</tr>` +
                (open
                  ? line.orders
                      .map(
                        (order) =>
                          `<tr class="kpi-sub"><th class="kpi-job-name" title="${escapeHtml(
                            order.partNum,
                          )}">${jobButton(order.job, S.job)}<span class="kpi-sub-note">${
                            order.days
                          } ${order.days === 1 ? 'day' : 'days'}${
                            order.due ? ` · due ${au(order.due)}` : ''
                          }${order.finished ? ' · done' : ''}</span></th>${metricCells(order.summary, namesCell(order.summary.names, S.person))}</tr>`,
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
              <col span="4" class="kpi-col-metric">
              <col class="kpi-col-names">
              <col span="4" class="kpi-col-metric">
            </colgroup>
            <thead><tr>
              <th class="kpi-machine-head">Line</th>
              <th title="Distinct orders with a completion in the period">Orders</th>
              <th title="Quantity Epicor shows finished">Qty</th>
              <th title="Standard hours of that quantity, as Epicor values it">Std h</th>
              <th title="People named as having finished them">People</th>
              <th class="kpi-names-head" title="Who they are — press a name to see their completions below">Names</th>
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

        ${S.loading ? '' : detailTables(done, S)}

        <div class="kpi-note">
          <div>Every figure comes from <code>ASSY_CompletedJobs</code>: one row per order finished on a day — what <code>CompletedJobs.csv</code> shows reported (every planner but PMD), once a supervisor has confirmed who finished it in the Assembly board's <b>✓ Completed</b> dialog. A big order finished over several days has a row for each day and is <b>one</b> order in every count.</div>
          <div><b>Qty</b> and <b>Std h</b> are Epicor's (<code>LaborDtl_LaborQty</code>, <code>LaborDtl_LaborHrs</code> — standard hours, not clocked time).</div>
          <div><b>Person-days</b> = each person counted once for each day they are named on a completion. <b>Std h / person-day</b> = Std h ÷ Person-days, and <b>Efficiency 🟢🟡🔴</b> is that over ${PRODUCTIVE_HOURS_PER_PERSON} h, the 07:00–15:30 shift less morning tea and lunch — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.effGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.effAmber}%. Per person, an order's Std h is shared equally among the people who finished it. It counts finished work only, so a day spent on an order finished on a later day earns nothing here.</div>
          <div><b>On time% 🟢🟡🔴</b> = orders finished in full in the period on or before their <b>Due Date</b> ÷ orders finished in full with a Due Date. An order is judged once, on the day it was finished in full (<b>Order done</b>); in the Completions list a part of an order delivered after its Due Date is already <b>Late</b>, and one before it is <b>In progress</b> — 🟢 ≥ ${ASSEMBLY_THRESHOLDS.onTimeGreen}% · 🟡 ≥ ${ASSEMBLY_THRESHOLDS.onTimeAmber}%. <b>Order done</b> marks the day the export's running total reached the order's quantity.</div>
          <div><b>By person</b> lists everyone on <code>ASSY_Operator</code> (supervisors and managers excepted): <b>Leave</b> is the days they are on leave in the period — booked annual leave (<code>PlannedAnnualLeave</code>), days marked off on the board, and the leave lines of payroll's timesheets. Somebody named on no confirmed completion is <b>On leave</b> when they have leave and no direct hour in the period, else <b>No completion</b> (with their direct hours when the timesheets have them; indirect-only time is No completion too).</div>
          <div><b>Timesheets</b> are payroll's weekly exports in the <code>Attendance</code> folder beside Planning.csv (sheet <code>Export</code>), matched to people by <code>EmployeeId</code> on ASSY_Operator. <b>Direct h</b> = Total Duration of the lines at a Direct location (the 54-minute break already out of it), leave and Indirect excepted. When they cover every week of the period, By person's Efficiency is a person's Std h ÷ their Direct h. The chart is then Std h finished in <code>CompletedJobs.csv</code> ÷ direct hours attended, by line (a person's hours go to their line on the board, else the first line of their Skills); without timesheets it is Std h ÷ person-days ÷ ${PRODUCTIVE_HOURS_PER_PERSON} h of confirmed completions.</div>
          <div><b>Last 24h</b> is the last working day before today (Friday to Sunday on a Monday); <b>Last Week</b> is Monday to Sunday of the week before this one.</div>
          <div>Press "+" on a line to see the orders behind its figures. Press a name or an order number to narrow the Completions list to it (a name also puts that person on the chart); filtered by a person, it adds their <b>Share</b> of each order (Std h ÷ the people who finished it), which is what their row in By person adds up.</div>
        </div>
      </div>`;
    wire();
    trendObserver?.disconnect();
    trendObserver = S.loading ? null : drawTrend(app, trendModel(S, completedOrderDays(S.rows)));
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
    // A name or an order narrows the Completions table; pressing it again,
    // or ✕ Show all, lets go. Nothing is read again for it.
    app.querySelectorAll<HTMLButtonElement>('[data-person]').forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.dataset.person!;
        S.person = S.person?.toLowerCase() === name.toLowerCase() ? null : name;
        chosenPerson = S.person;
        render();
      }),
    );
    app.querySelectorAll<HTMLButtonElement>('[data-job]').forEach((b) =>
      b.addEventListener('click', () => {
        const job = b.dataset.job!;
        S.job = S.job === job ? null : job;
        render();
      }),
    );
    app.querySelector<HTMLButtonElement>('[data-person-clear]')?.addEventListener('click', () => {
      S.person = null;
      chosenPerson = null;
      render();
    });
    app.querySelector<HTMLButtonElement>('[data-clear-filter]')?.addEventListener('click', () => {
      S.person = null;
      chosenPerson = null;
      S.job = null;
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

  /** The roster, the timesheets and the export: read once a visit, whatever the period. */
  async function loadContext(): Promise<void> {
    const reason = (r: PromiseRejectedResult): string => (r.reason instanceof Error ? r.reason.message : String(r.reason));
    const [roster, attendance, history] = await Promise.allSettled([
      dal.roster ? dal.roster() : Promise.resolve({ people: [], warning: null }),
      dal.attendance ? dal.attendance() : Promise.resolve(null),
      dal.history ? dal.history() : Promise.resolve(null),
    ]);
    if (!app.isConnected) return;
    if (attendance.status === 'fulfilled') S.attendance = attendance.value;
    else S.attendanceError = `Timesheets not read (${reason(attendance)}): efficiency stays on person-days.`;
    if (history.status === 'fulfilled') {
      S.history = history.value?.rows ?? null;
      S.historyError = history.value?.errors[0] ?? '';
    } else S.historyError = `CompletedJobs.csv not read (${reason(history)}): the chart stays on confirmed completions.`;
    if (roster.status === 'fulfilled') {
      S.roster = roster.value.people;
      S.rosterWarning = roster.value.warning;
    } else {
      S.rosterWarning = `ASSY_Operator not read (${roster.reason instanceof Error ? roster.reason.message : String(roster.reason)}): nobody without a completion is listed.`;
    }
    if (!S.loading) render();
  }

  void loadContext();
  await load();
}
