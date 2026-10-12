// KPI page, supervisor only: what each operator made, and the stoppages on
// their watch that ran past the floor's limits. The numbers come from
// core/operator-perf; this draws them in the page's own chart and table
// language — the same cards, axes and legend as the charts above, and the
// same header bar, row height and colour verdicts as the machine table.

import type { KpiThresholds } from '../core/kpi-thresholds';
import type { Kpi } from '../core/metrics';
import {
  STOP_KINDS,
  STOP_LIMIT_HRS,
  outputByTime,
  type OperatorPerf,
  type OperatorStop,
  type StopKind,
} from '../core/operator-perf';
import { yieldPctOf } from '../core/impw';
import { renderStackedBarsH, renderStackedLineChart, type BarRow, type StackBucket } from './charts';
import { escapeHtml } from './modal';

export interface OperatorView {
  perf: OperatorPerf[];
  /** Weekly bars instead of daily — the range runs past a month. */
  weekly: boolean;
  /** The injection presses in the page's order. A press keeps its colour on
   *  every operator's chart, and stacks in this order. */
  machineOrder: string[];
  thresholds: KpiThresholds;
  /** The operator the output chart draws; '' picks the top producer. */
  pick: string;
  /** Operators whose stoppage list is open under their row. */
  open: Set<string>;
  /** Everything in the slice, for the TOTAL rows. */
  total: Kpi | null;
  /** Row to bring into view after the next render (a bar was clicked). */
  scrollTo?: string;
}

/**
 * One colour per press, by its place in the page's press order — the
 * validated categorical order, so presses that stack next to each other
 * stay apart for colour-blind readers too. The ninth is navy, checked
 * against its neighbours. Hot stamp, and anything past the ninth press,
 * is slate: a different process, not another hue to learn.
 */
const PRESS_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#1e3a8a'];
const NEUTRAL = '#64748b';
const YIELD_INK = '#0f172a';
/** Startup blue; the two setups in the Setup h amber family; breakdown in
 *  the Down h red — the colours the hours chart above already taught. */
const STOP_COLORS: Record<StopKind, string> = {
  startup: '#2a78d6',
  die: '#c2410c',
  change: '#f59e0b',
  breakdown: '#dc2626',
};
const STOP_SHORT: Record<StopKind, string> = {
  startup: 'Startup > 1 h',
  die: 'Die setup > 4 h',
  change: 'Insert / colour > 0.5 h',
  breakdown: 'Breakdown',
};
const STOP_WHAT: Record<string, string> = {
  S: 'Startup',
  D: 'Die setup',
  C: 'Colour change',
  I: 'Insert change',
  B: 'Breakdown',
};
const CHART_OPERATORS = 15;

const nameOf = (op: string): string => op || 'Not recorded';
const hrs = (v: number): string => (v ? v.toFixed(1) : '—');
const verdict = (v: number | null, green: number, amber: number): string =>
  v == null ? '' : v >= green ? 'green' : v >= amber ? 'amber' : 'red';
const when = (shiftId: string): string => {
  const [y, m, d, shift] = [shiftId.slice(0, 4), shiftId.slice(5, 7), shiftId.slice(8, 10), shiftId.slice(11)];
  return `${d}/${m}/${y.slice(2)} ${shift}`;
};
const flaggedTotal = (p: OperatorPerf): number => STOP_KINDS.reduce((n, k) => n + p.tally[k].flagged, 0);
const yieldOf = (good: number, reject: number): number | null => (good + reject > 0 ? yieldPctOf(good, reject) : null);
/** One decimal always, so 98.0% does not sit under 98.4% as "98%". */
const pct = (v: number | null): string => (v == null ? '—' : `${v.toFixed(1)}%`);

function pressColor(v: OperatorView, mc: string): string {
  const i = v.machineOrder.indexOf(mc);
  return i >= 0 && i < PRESS_COLORS.length ? PRESS_COLORS[i] : NEUTRAL;
}
const pressRank = (v: OperatorView, mc: string): number => {
  const i = v.machineOrder.indexOf(mc);
  return i < 0 ? v.machineOrder.length : i;
};

export const pickedOperator = (v: OperatorView): OperatorPerf | undefined => {
  const named = v.perf.filter((p) => p.operator);
  return (
    v.perf.find((p) => p.operator === v.pick) ??
    [...named].sort((a, b) => b.kpi.output - a.kpi.output)[0] ??
    v.perf[0]
  );
};

const byOutput = (a: OperatorPerf, b: OperatorPerf): number =>
  !a.operator ? 1 : !b.operator ? -1 : b.kpi.output - a.kpi.output;
const byStoppages = (a: OperatorPerf, b: OperatorPerf): number =>
  flaggedTotal(b) - flaggedTotal(a) || b.hoursOver - a.hoursOver || nameOf(a.operator).localeCompare(nameOf(b.operator));

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function outputChart(v: OperatorView, p: OperatorPerf | undefined): string {
  const options = [...v.perf]
    .sort(byOutput)
    .map(
      (o) =>
        `<option value="${escapeHtml(o.operator)}"${o === p ? ' selected' : ''}>${escapeHtml(nameOf(o.operator))}</option>`,
    )
    .join('');
  const head = `<div class="kpi-chart-head">
      <h4>Operator output by press (stacked) vs Yield — by ${v.weekly ? 'week' : 'day'} 🔒</h4>
      <label class="kpi-ops-pick">Operator <select data-op-select>${options}</select></label>
    </div>`;
  if (!p) return `<div class="kpi-chart">${head}</div>`;

  const buckets = outputByTime(p.records, v.weekly);
  const presses = [...new Set(buckets.flatMap((b) => [...b.byMachine.keys()]))].sort(
    (a, b) => pressRank(v, a) - pressRank(v, b) || a.localeCompare(b),
  );
  const yields = buckets
    .map((b) => {
      let good = 0;
      let reject = 0;
      for (const m of b.byMachine.values()) {
        good += m.good;
        reject += m.reject;
      }
      return yieldOf(good, reject);
    });
  const lowest = Math.min(100, ...yields.filter((y): y is number => y != null));
  // The axis starts just below the worst point, so a 97–99% line has room
  // to move instead of running flat along the top of a 0–100 axis. Spans
  // that split into four whole-number ticks: 92, 94, 96, 98, 100.
  const span = [4, 8, 12, 20, 40, 60, 100].find((d) => 100 - d <= lowest - 1) ?? 100;
  const floor = 100 - span;
  const data: StackBucket[] = buckets.map((b, i) => {
    const label = v.weekly ? `wk ${b.key.slice(5)}` : b.key.slice(5);
    const parts = presses
      .filter((mc) => b.byMachine.has(mc))
      .map((mc) => `${mc} ${b.byMachine.get(mc)!.good}`);
    const good = presses.reduce((n, mc) => n + (b.byMachine.get(mc)?.good ?? 0), 0);
    return {
      label,
      segments: presses.map((mc) => b.byMachine.get(mc)?.good ?? 0),
      overlay: yields[i],
      title: `${label} · ${good} good (${parts.join(' · ')})${yields[i] != null ? ` · yield ${yields[i]}%` : ''}`,
    };
  });
  const body = data.length
    ? renderStackedLineChart(data, {
        segmentColors: presses.map((mc) => pressColor(v, mc)),
        segmentLabels: presses,
        overlayLabel: 'Yield %',
        overlayColor: YIELD_INK,
        overlayAsPercent: true,
        overlayFloor: floor,
        labelSegments: true,
        segmentLabelColor: 'auto',
        labelTotals: true,
        segmentGap: true,
      })
    : '<div class="kpi-ops-empty">No pieces counted on their orders in this range.</div>';
  return `<div class="kpi-chart">
    ${head}
    ${body}
    <div class="kpi-chart-note">Good pieces on the orders ${escapeHtml(nameOf(p.operator))} is named on, by press${
      floor > 0 ? `; Yield axis from ${floor}%` : ''
    }. Pick an operator here or in the table below.</div>
  </div>`;
}

function stoppageChart(v: OperatorView): string {
  const ranked = v.perf.filter((p) => flaggedTotal(p) > 0).sort(byStoppages);
  const shown = ranked.slice(0, CHART_OPERATORS);
  const rows: BarRow[] = shown.map((p) => {
    const name = nameOf(p.operator);
    return {
      label: name.length > 24 ? `${name.slice(0, 23)}…` : name,
      segments: STOP_KINDS.map((k) => p.tally[k].flagged),
      end: `${p.hoursOver.toFixed(1)} h over`,
      clickKey: p.operator || ' ',
      title: `${name} — ${STOP_KINDS.filter((k) => p.tally[k].flagged)
        .map((k) => `${STOP_SHORT[k]}: ${p.tally[k].flagged}`)
        .join(' · ')} · ${p.hoursOver.toFixed(1)} h past the limits. Click to list them.`,
    };
  });
  return `<div class="kpi-chart">
    <div class="kpi-chart-head">
      <h4>Stoppages over the limit by operator (stacked)${ranked.length > CHART_OPERATORS ? ` — top ${CHART_OPERATORS}` : ''} 🔒</h4>
    </div>
    ${
      rows.length
        ? renderStackedBarsH(rows, {
            segmentColors: STOP_KINDS.map((k) => STOP_COLORS[k]),
            segmentLabels: STOP_KINDS.map((k) => STOP_SHORT[k]),
          })
        : '<div class="kpi-ops-empty">No stoppage over its limit in this range.</div>'
    }
    <div class="kpi-chart-note">Count of stoppages over their limit; the figure after each bar is the hours past the limits (every breakdown hour counts). Click an operator to list them.</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function pressChips(v: OperatorView, machines: string[]): string {
  return [...machines]
    .sort((a, b) => pressRank(v, a) - pressRank(v, b) || a.localeCompare(b))
    .map((mc) => `<span class="kpi-ops-press"><i style="background:${pressColor(v, mc)}"></i>${escapeHtml(mc)}</span>`)
    .join('');
}

function outputTable(v: OperatorView, pick: OperatorPerf | undefined): string {
  const t = v.thresholds;
  const rows = [...v.perf]
    .sort(byOutput)
    .map((p) => {
      const k = p.kpi;
      const y = yieldOf(k.output, k.scrap);
      const picked = p === pick;
      return `<tr class="${picked ? 'is-picked' : ''}" data-op-pick="${escapeHtml(p.operator)}" tabindex="0" aria-selected="${picked}" title="Chart ${escapeHtml(nameOf(p.operator))}">
        <th class="${p.operator ? '' : 'muted'}">${escapeHtml(nameOf(p.operator))}</th>
        <td class="num">${k.shifts}</td>
        <td class="kpi-ops-presses" title="${escapeHtml(p.machines.join(', '))}">${pressChips(v, p.machines)}</td>
        <td class="num">${hrs(k.runHrs)}</td>
        <td class="num strong">${k.output || '—'}</td>
        <td class="num ${k.scrap ? 'red' : ''}">${k.scrap || '—'}</td>
        <td class="num ${verdict(y, t.yieldGreen, t.yieldAmber)}">${pct(y)}</td>
        <td class="num ${verdict(k.efficiency, t.effGreen, t.effAmber)}">${k.efficiency == null ? '—' : `${k.efficiency}%`}</td>
      </tr>`;
    })
    .join('');
  const tot = v.total;
  const ty = tot ? yieldOf(tot.output, tot.scrap) : null;
  const allPresses = [...new Set(v.perf.flatMap((p) => p.machines))];
  const foot = tot
    ? `<tfoot><tr class="kpi-ops-total">
        <th>TOTAL</th>
        <td class="num">${v.perf.reduce((n, p) => n + p.kpi.shifts, 0)}</td>
        <td class="muted">${allPresses.length} press${allPresses.length === 1 ? '' : 'es'}</td>
        <td class="num">${hrs(tot.runHrs)}</td>
        <td class="num">${tot.output || '—'}</td>
        <td class="num ${tot.scrap ? 'red' : ''}">${tot.scrap || '—'}</td>
        <td class="num ${verdict(ty, t.yieldGreen, t.yieldAmber)}">${pct(ty)}</td>
        <td class="num ${verdict(tot.efficiency, t.effGreen, t.effAmber)}">${tot.efficiency == null ? '—' : `${tot.efficiency}%`}</td>
      </tr></tfoot>`
    : '';
  return `<div class="kpi-ops-block">
    <div class="kpi-ops-caption"><h4>Operator output &amp; yield 🔒</h4><span>Click a row to chart that operator</span></div>
    <div class="kpi-ops-wrap">
      <table class="kpi-ops-table kpi-ops-output">
        <colgroup><col class="c-name"><col class="c-n"><col><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-e"></colgroup>
        <thead><tr>
          <th>Operator</th>
          <th class="num" title="Shifts they are named on">Shifts</th>
          <th>Presses</th>
          <th class="num">Run h</th>
          <th class="num">Output</th>
          <th class="num">Reject</th>
          <th class="num">Yield</th>
          <th class="num" title="Standard hours of the output ÷ run hours, as in the machine table">Efficiency</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        ${foot}
      </table>
    </div>
    <div class="kpi-chart-note">An order's operator is the one named on its sheet for that shift; every hour and piece of that order on that shift is theirs. Shifts counts each operator's own shifts, so the total is operator-shifts. Signed-off shifts only.</div>
  </div>`;
}

function stopDetail(p: OperatorPerf): string {
  const flagged = p.stops.filter((s) => s.flagged);
  if (!flagged.length) {
    return '<tr class="kpi-ops-detail"><td colspan="11"><span class="muted">Nothing over its limit and no breakdowns.</span></td></tr>';
  }
  const row = (s: OperatorStop): string => {
    const limit = s.kind === 'breakdown' ? null : STOP_LIMIT_HRS[s.kind];
    return `<tr>
      <td>${escapeHtml(when(s.shiftId))}</td>
      <td>${escapeHtml(s.machineCode)}</td>
      <td>${escapeHtml(s.jobNumber || '—')}</td>
      <td><i class="kpi-ops-sw" style="background:${STOP_COLORS[s.kind]}"></i>${STOP_WHAT[s.code] ?? s.code}</td>
      <td class="num">${s.hours.toFixed(1)}</td>
      <td class="num">${limit == null ? '—' : limit}</td>
      <td class="num red">${limit == null ? s.hours.toFixed(1) : `+${(s.hours - limit).toFixed(1)}`}</td>
    </tr>`;
  };
  return `<tr class="kpi-ops-detail"><td colspan="11">
    <table class="kpi-ops-stops">
      <thead><tr><th>Started</th><th>Press</th><th>Order</th><th>Stoppage</th><th class="num">Hours</th><th class="num">Limit h</th><th class="num">Over h</th></tr></thead>
      <tbody>${flagged.map(row).join('')}</tbody>
    </table>
  </td></tr>`;
}

/** "2 / 5": over the limit, of all of that kind. The first of a column
 *  group carries the group's left rule. */
function flaggedCell(flagged: number, events: number, limit: number, first: boolean): string {
  const cls = `num${first ? ' kpi-ops-grp' : ''}`;
  if (!events) return `<td class="${cls} muted">—</td>`;
  const title = `${flagged} of ${events} over ${limit} h`;
  return flagged
    ? `<td class="${cls}" title="${title}"><b class="kpi-ops-over">${flagged}</b><span class="kpi-ops-of"> / ${events}</span></td>`
    : `<td class="${cls} kpi-ops-of" title="${title}">0 / ${events}</td>`;
}
const LIMITED = ['startup', 'die', 'change'] as const;

function stopsTable(v: OperatorView): string {
  const ranked = [...v.perf].sort(byStoppages);
  const body = ranked
    .map((p) => {
      const open = v.open.has(p.operator);
      const k = p.kpi;
      const bd = p.tally.breakdown;
      return `<tr class="kpi-ops-row${open ? ' is-open' : ''}" data-op-open="${escapeHtml(p.operator)}" tabindex="0" aria-expanded="${open}" title="${open ? 'Hide' : 'List'} the stoppages over their limit">
        <th class="${p.operator ? '' : 'muted'}"><span class="kpi-ops-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${escapeHtml(nameOf(p.operator))}</th>
        <td class="num">${k.shifts}</td>
        <td class="num kpi-ops-grp" title="Die ${hrs(k.dieHrs)} · colour ${hrs(k.colorHrs)} · insert ${hrs(k.insertHrs)}">${hrs(k.setupHrs)}</td>
        <td class="num">${hrs(k.startupHrs)}</td>
        <td class="num" title="Breakdown and smoko, as Down h in the machine table">${hrs(k.downtimeHrs)}</td>
        ${LIMITED.map((kind, i) => flaggedCell(p.tally[kind].flagged, p.tally[kind].events, STOP_LIMIT_HRS[kind], i === 0)).join('')}
        <td class="num kpi-ops-grp ${bd.events ? '' : 'muted'}">${bd.events || '—'}</td>
        <td class="num ${bd.events ? '' : 'muted'}">${bd.events ? bd.hours.toFixed(1) : '—'}</td>
        <td class="num kpi-ops-grp ${p.hoursOver ? 'red' : 'muted'}">${p.hoursOver ? p.hoursOver.toFixed(1) : '—'}</td>
      </tr>${open ? stopDetail(p) : ''}`;
    })
    .join('');
  const tot = v.total;
  const sum = (kind: StopKind, f: 'flagged' | 'events' | 'hours'): number =>
    v.perf.reduce((n, p) => n + p.tally[kind][f], 0);
  const over = v.perf.reduce((n, p) => n + p.hoursOver, 0);
  const foot = tot
    ? `<tfoot><tr class="kpi-ops-total">
        <th>TOTAL</th>
        <td class="num">${v.perf.reduce((n, p) => n + p.kpi.shifts, 0)}</td>
        <td class="num kpi-ops-grp">${hrs(tot.setupHrs)}</td>
        <td class="num">${hrs(tot.startupHrs)}</td>
        <td class="num">${hrs(tot.downtimeHrs)}</td>
        ${LIMITED.map((kind, i) => flaggedCell(sum(kind, 'flagged'), sum(kind, 'events'), STOP_LIMIT_HRS[kind], i === 0)).join('')}
        <td class="num kpi-ops-grp">${sum('breakdown', 'events') || '—'}</td>
        <td class="num">${hrs(sum('breakdown', 'hours'))}</td>
        <td class="num kpi-ops-grp ${over ? 'red' : ''}">${hrs(over)}</td>
      </tr></tfoot>`
    : '';
  return `<div class="kpi-ops-block">
    <div class="kpi-ops-caption"><h4>Operator setups, startups &amp; downtime against the limits 🔒</h4><span>Click a row to list the stoppages over their limit</span></div>
    <div class="kpi-ops-wrap">
      <table class="kpi-ops-table kpi-ops-limits">
        <colgroup><col class="c-name"><col class="c-n">${'<col class="c-n">'.repeat(3)}${'<col class="c-w">'.repeat(3)}${'<col class="c-n">'.repeat(3)}</colgroup>
        <thead>
          <tr class="kpi-ops-groups">
            <th rowspan="2">Operator</th>
            <th rowspan="2" class="num">Shifts</th>
            <th colspan="3" class="kpi-ops-grp">Hours logged</th>
            <th colspan="3" class="kpi-ops-grp" title="Over the limit / all of that kind">Over the limit · over / all</th>
            <th colspan="2" class="kpi-ops-grp">Breakdowns</th>
            <th rowspan="2" class="num kpi-ops-grp" title="Hours past the limits on the stoppages over them, plus every breakdown hour">Hours over</th>
          </tr>
          <tr>
            <th class="num kpi-ops-grp" title="D + C + I — C/O hours in the machine table">Setup</th>
            <th class="num" title="S">Startup</th>
            <th class="num" title="B + M">Down</th>
            <th class="num kpi-ops-grp">Startup &gt; 1 h</th>
            <th class="num">Die setup &gt; 4 h</th>
            <th class="num">Insert / colour &gt; 0.5 h</th>
            <th class="num kpi-ops-grp">Count</th>
            <th class="num">Hours</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        ${foot}
      </table>
    </div>
    <div class="kpi-chart-note">
      A die / colour / insert change is one per order however many half-hours the sheet logged it in; a startup runs until the press runs; a breakdown is each unbroken run of B — the same events as the duration chart.
      One that crosses a shift change goes to the operator who logged most of it, while the hours columns count each half-hour under whoever logged it.
      The hot-stamp press keys its setups its own way and is left out of the limits.
    </div>
  </div>`;
}

/** Both charts and both tables, or nothing when the range has no signed-off work. */
export function renderOperatorSection(v: OperatorView): string {
  if (!v.perf.length) return '';
  const pick = pickedOperator(v);
  const named = v.perf.filter((p) => p.operator).length;
  return `<section class="kpi-ops" aria-label="Operator performance">
    <div class="kpi-ops-head">
      <h3>Operator performance 🔒</h3>
      <span>${named} operator${named === 1 ? '' : 's'} · signed-off shifts · supervisors only</span>
    </div>
    <div class="kpi-charts kpi-ops-charts">
      ${outputChart(v, pick)}
      ${stoppageChart(v)}
    </div>
    ${outputTable(v, pick)}
    ${stopsTable(v)}
  </section>`;
}

export function wireOperatorSection(app: HTMLElement, v: OperatorView, rerender: () => void): void {
  const onActivate = (el: Element, fn: () => void): void => {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k !== 'Enter' && k !== ' ') return;
      e.preventDefault();
      fn();
    });
  };
  app.querySelectorAll<HTMLElement>('.kpi-ops [data-op-pick]').forEach((tr) =>
    onActivate(tr, () => {
      v.pick = tr.dataset.opPick ?? '';
      rerender();
    }),
  );
  app.querySelector<HTMLSelectElement>('.kpi-ops [data-op-select]')?.addEventListener('change', (e) => {
    v.pick = (e.target as HTMLSelectElement).value;
    rerender();
  });
  const toggle = (op: string): void => {
    if (v.open.has(op)) v.open.delete(op);
    else v.open.add(op);
    rerender();
  };
  app.querySelectorAll<HTMLElement>('.kpi-ops [data-op-open]').forEach((tr) => onActivate(tr, () => toggle(tr.dataset.opOpen ?? '')));
  app.querySelectorAll<SVGElement>('.kpi-ops .chart-hit[data-bucket]').forEach((hit) =>
    onActivate(hit, () => {
      const op = (hit.dataset.bucket ?? '').trim();
      v.open.add(op);
      v.scrollTo = op;
      rerender();
    }),
  );
  if (v.scrollTo != null) {
    const op = v.scrollTo;
    v.scrollTo = undefined;
    const row = [...app.querySelectorAll<HTMLElement>('.kpi-ops [data-op-open]')].find((r) => r.dataset.opOpen === op);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.focus({ preventScroll: true });
  }
}
