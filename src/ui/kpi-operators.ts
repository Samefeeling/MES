// KPI page, supervisor only: what each operator made, and the stoppages on
// their watch that ran past the floor's limits. The numbers come from
// core/operator-perf; this draws the two tables and their charts.

import type { KpiThresholds } from '../core/kpi-thresholds';
import {
  STOP_KINDS,
  STOP_LABELS,
  STOP_LIMIT_HRS,
  outputByTime,
  type OperatorPerf,
  type OperatorStop,
  type StopKind,
} from '../core/operator-perf';
import { yieldPctOf } from '../core/impw';
import { renderStackedLineChart, type StackBucket } from './charts';
import { escapeHtml } from './modal';

export interface OperatorView {
  perf: OperatorPerf[];
  /** Weekly bars instead of daily — the range runs past a month. */
  weekly: boolean;
  /** Presses in the page's order, so a chart stacks them the same way every time. */
  machineOrder: string[];
  thresholds: KpiThresholds;
  /** The operator the output chart draws; '' picks the top producer. */
  pick: string;
  /** Operators whose stoppage list is open under their row. */
  open: Set<string>;
}

/** Categorical slots, in the order they are handed out. */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#94a3b8';
const LINE = '#0f172a';
const STOP_COLORS: Record<StopKind, string> = {
  startup: '#2a78d6',
  die: '#eb6834',
  change: '#1baf7a',
  breakdown: '#e34948',
};
const CHART_OPERATORS = 15;

const nameOf = (op: string): string => op || 'Not recorded';
/** "Aryan Apte" → "Aryan A." — an axis label has about ten characters. */
const shortName = (op: string): string => {
  const w = nameOf(op).split(' ');
  return w.length > 1 && op ? `${w[0]} ${w[w.length - 1][0]}.` : nameOf(op);
};
const hrs = (v: number): string => (v ? v.toFixed(1) : '—');
const paint = (v: number | null, green: number, amber: number): string =>
  v == null ? '' : v >= green ? 'green' : v >= amber ? 'amber' : 'red';
const when = (shiftId: string): string => {
  const [y, m, d, shift] = [shiftId.slice(0, 4), shiftId.slice(5, 7), shiftId.slice(8, 10), shiftId.slice(11)];
  return `${d}/${m}/${y.slice(2)} ${shift}`;
};
const flaggedTotal = (p: OperatorPerf): number => STOP_KINDS.reduce((n, k) => n + p.tally[k].flagged, 0);

export const pickedOperator = (v: OperatorView): OperatorPerf | undefined => {
  const named = v.perf.filter((p) => p.operator);
  return (
    v.perf.find((p) => p.operator === v.pick) ??
    [...named].sort((a, b) => b.kpi.output - a.kpi.output)[0] ??
    v.perf[0]
  );
};

function outputCard(v: OperatorView): string {
  const t = v.thresholds;
  const pick = pickedOperator(v);
  const rows = [...v.perf]
    .sort((a, b) => (!a.operator ? 1 : !b.operator ? -1 : b.kpi.output - a.kpi.output))
    .map((p) => {
      const k = p.kpi;
      const y = k.output + k.scrap > 0 ? yieldPctOf(k.output, k.scrap) : null;
      return `<tr class="${p === pick ? 'is-picked' : ''}" data-op-pick="${escapeHtml(p.operator)}" tabindex="0" title="Show ${escapeHtml(nameOf(p.operator))} on the chart">
        <th class="${p.operator ? '' : 'muted'}">${escapeHtml(nameOf(p.operator))}</th>
        <td class="num">${k.shifts}</td>
        <td title="${escapeHtml(p.machines.join(', '))}">${escapeHtml(p.machines.join(', '))}</td>
        <td class="num">${hrs(k.runHrs)}</td>
        <td class="num">${k.output || '—'}</td>
        <td class="num">${k.scrap || '—'}</td>
        <td class="num ${paint(y, t.yieldGreen, t.yieldAmber)}">${y == null ? '—' : `${y}%`}</td>
        <td class="num ${paint(k.efficiency, t.effGreen, t.effAmber)}">${k.efficiency == null ? '—' : `${k.efficiency}%`}</td>
      </tr>`;
    })
    .join('');
  return `<div class="kpi-ops-card">
    <h3>👷 Operator output &amp; yield 🔒</h3>
    <div class="kpi-ops-split">
      <div class="kpi-ops-scroll">
        <table class="kpi-ops-table">
          <thead><tr><th>Operator</th><th>Shifts</th><th>Presses</th><th>Run h</th><th>Output</th><th>Reject</th><th>Yield %</th><th title="Standard hours of the output ÷ run hours, as in the table above">Efficiency</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pick ? outputChart(pick, v) : ''}
    </div>
    <div class="kpi-chart-note">Click an operator to chart them. Each order's operator is the one named on its sheet for that shift, and every hour and piece of that order on that shift is theirs. Signed-off shifts only.</div>
  </div>`;
}

function outputChart(p: OperatorPerf, v: OperatorView): string {
  const buckets = outputByTime(p.records, v.weekly);
  const rank = (mc: string): number => {
    const i = v.machineOrder.indexOf(mc);
    return i < 0 ? v.machineOrder.length : i;
  };
  const machines = [...new Set(buckets.flatMap((b) => [...b.byMachine.keys()]))].sort((a, b) => rank(a) - rank(b));
  // Eight colours; a ninth press and beyond share one grey.
  const shown = machines.slice(0, machines.length > PALETTE.length ? PALETTE.length - 1 : PALETTE.length);
  const rest = machines.filter((m) => !shown.includes(m));
  const labels = [...shown, ...(rest.length ? ['Other'] : [])];
  const colors = [...PALETTE.slice(0, shown.length), ...(rest.length ? [OTHER] : [])];
  const data: StackBucket[] = buckets.map((b) => {
    let good = 0;
    let reject = 0;
    for (const m of b.byMachine.values()) {
      good += m.good;
      reject += m.reject;
    }
    const seg = shown.map((mc) => b.byMachine.get(mc)?.good ?? 0);
    if (rest.length) seg.push(rest.reduce((n, mc) => n + (b.byMachine.get(mc)?.good ?? 0), 0));
    return {
      label: v.weekly ? `wk ${b.key.slice(5)}` : b.key.slice(5),
      segments: seg,
      overlay: good + reject > 0 ? yieldPctOf(good, reject) : null,
    };
  });
  const legend = labels
    .map((l, i) => `<span><i class="kpi-ops-sw" style="background:${colors[i]}"></i>${escapeHtml(l)}</span>`)
    .join('');
  return `<div class="kpi-chart">
    <h4>${escapeHtml(nameOf(p.operator))} — good pieces by press, yield % line, by ${v.weekly ? 'week' : 'day'}</h4>
    <div class="kpi-ops-legend">${legend}<span><i class="kpi-ops-ln" style="background:${LINE}"></i>Yield %</span></div>
    ${
      data.length
        ? renderStackedLineChart(data, {
            segmentColors: colors,
            segmentLabels: labels,
            overlayLabel: 'Yield %',
            overlayColor: LINE,
            overlayAsPercent: true,
            labelSegments: true,
            segmentLabelColor: '#fff',
            legend: false,
          })
        : '<div class="muted">No pieces counted on their orders in this range.</div>'
    }
  </div>`;
}

const STOP_WHAT: Record<string, string> = {
  S: 'Startup',
  D: 'Die setup',
  C: 'Colour change',
  I: 'Insert change',
  B: 'Breakdown',
};

function stopRows(p: OperatorPerf): string {
  const flagged = p.stops.filter((s) => s.flagged);
  if (!flagged.length) return '<tr class="kpi-ops-detail"><td colspan="10" class="muted">Nothing over its limit and no breakdowns.</td></tr>';
  const row = (s: OperatorStop): string => {
    const limit = s.kind === 'breakdown' ? null : STOP_LIMIT_HRS[s.kind];
    return `<tr><td>${escapeHtml(when(s.shiftId))}</td><td>${escapeHtml(s.machineCode)}</td><td>${escapeHtml(
      s.jobNumber || '—',
    )}</td><td><i class="kpi-ops-sw" style="background:${STOP_COLORS[s.kind]}"></i>${STOP_WHAT[s.code] ?? s.code}</td><td class="num">${s.hours.toFixed(
      1,
    )}</td><td class="num">${limit == null ? '—' : limit}</td><td class="num red">${
      limit == null ? s.hours.toFixed(1) : `+${(s.hours - limit).toFixed(1)}`
    }</td></tr>`;
  };
  return `<tr class="kpi-ops-detail"><td colspan="10">
    <table class="kpi-ops-stops">
      <thead><tr><th>Started</th><th>Press</th><th>Order</th><th>What</th><th>Hours</th><th>Limit h</th><th>Over h</th></tr></thead>
      <tbody>${flagged.map(row).join('')}</tbody>
    </table>
  </td></tr>`;
}

function stopsCard(v: OperatorView): string {
  const ranked = [...v.perf].sort(
    (a, b) => flaggedTotal(b) - flaggedTotal(a) || b.hoursOver - a.hoursOver || nameOf(a.operator).localeCompare(nameOf(b.operator)),
  );
  const cell = (p: OperatorPerf, k: StopKind): string => {
    const t = p.tally[k];
    if (!t.events) return '<td class="num muted">—</td>';
    if (k === 'breakdown') return `<td class="num ${t.flagged ? 'red' : ''}" title="${t.events} breakdown(s), ${t.hours.toFixed(1)} h">${t.events} · ${t.hours.toFixed(1)} h</td>`;
    return `<td class="num ${t.flagged ? 'red' : 'green'}" title="${t.flagged} of ${t.events} over ${STOP_LIMIT_HRS[k]} h · ${t.hours.toFixed(1)} h in all">${t.flagged} / ${t.events}</td>`;
  };
  const rows = ranked
    .map((p) => {
      const open = v.open.has(p.operator);
      const k = p.kpi;
      return `<tr class="kpi-ops-row" data-op-open="${escapeHtml(p.operator)}" tabindex="0" aria-expanded="${open}" title="${open ? 'Hide' : 'List'} the stoppages over their limit">
        <th class="${p.operator ? '' : 'muted'}"><span class="kpi-ops-chev">${open ? '▾' : '▸'}</span> ${escapeHtml(nameOf(p.operator))}</th>
        <td class="num">${k.shifts}</td>
        <td class="num" title="Die ${hrs(k.dieHrs)} · colour ${hrs(k.colorHrs)} · insert ${hrs(k.insertHrs)}">${hrs(k.setupHrs)}</td>
        <td class="num">${hrs(k.startupHrs)}</td>
        <td class="num" title="Breakdown and smoko, as the Down h column above">${hrs(k.downtimeHrs)}</td>
        ${STOP_KINDS.map((kind) => cell(p, kind)).join('')}
        <td class="num ${p.hoursOver ? 'red' : ''}">${hrs(p.hoursOver)}</td>
      </tr>${open ? stopRows(p) : ''}`;
    })
    .join('');

  const charted = ranked.filter((p) => flaggedTotal(p) > 0).slice(0, CHART_OPERATORS);
  const data: StackBucket[] = charted.map((p) => ({
    label: shortName(p.operator),
    segments: STOP_KINDS.map((k) => p.tally[k].flagged),
    overlay: null,
    clickKey: p.operator || ' ',
    title: `${nameOf(p.operator)} — ${STOP_KINDS.map((k) => `${STOP_LABELS[k]}: ${p.tally[k].flagged}`).join(' · ')} · ${p.hoursOver.toFixed(1)} h over. Click to list them.`,
  }));
  const legend = STOP_KINDS.map(
    (k) => `<span><i class="kpi-ops-sw" style="background:${STOP_COLORS[k]}"></i>${STOP_LABELS[k]}</span>`,
  ).join('');
  return `<div class="kpi-ops-card">
    <h3>⏱ Operator setups, startups &amp; downtime against the limits 🔒</h3>
    ${
      data.length
        ? `<div class="kpi-chart">
            <h4>Stoppages over their limit, per operator${
              ranked.filter((p) => flaggedTotal(p) > 0).length > CHART_OPERATORS ? ` — the ${CHART_OPERATORS} with most` : ''
            }</h4>
            <div class="kpi-ops-legend">${legend}</div>
            ${renderStackedLineChart(data, {
              segmentColors: STOP_KINDS.map((k) => STOP_COLORS[k]),
              segmentLabels: STOP_KINDS.map((k) => STOP_LABELS[k]),
              overlayLabel: '',
              overlayColor: LINE,
              labelSegments: true,
              segmentLabelColor: '#fff',
              legend: false,
              noOverlay: true,
            })}
          </div>`
        : '<div class="kpi-chart muted">No stoppage over its limit in this range.</div>'
    }
    <div class="kpi-ops-scroll">
      <table class="kpi-ops-table">
        <thead><tr>
          <th>Operator</th><th>Shifts</th>
          <th title="D + C + I hours — the C/O hours of the table above">Setup h</th>
          <th title="S hours">Startup h</th>
          <th title="B + M hours">Down h</th>
          ${STOP_KINDS.map((k) => `<th title="${k === 'breakdown' ? 'Breakdowns · their hours' : 'Over the limit / all of them'}">${STOP_LABELS[k]}</th>`).join('')}
          <th title="Hours past the limits on the flagged stoppages, plus every breakdown hour">Hours over</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="kpi-chart-note">
      Limits: startup over 1 h, die setup over 4 h, insert or colour change over 0.5 h; every breakdown is listed.
      A die / colour / insert change is one per order however many pieces the sheet logged it in, a startup runs until the press runs, and a breakdown is each unbroken run of B — the same events as the duration chart.
      One that crosses a shift change goes to the operator who logged most of it; the hours columns count every half-hour under whoever logged it.
      The hot-stamp press keys its setups its own way and is left out here. Click an operator to list their stoppages.
    </div>
  </div>`;
}

/** Both cards, or nothing when the range has no signed-off work. */
export function renderOperatorSection(v: OperatorView): string {
  if (!v.perf.length) return '';
  return `<section class="kpi-ops" aria-label="Operator performance">${outputCard(v)}${stopsCard(v)}</section>`;
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
      rerender();
    }),
  );
}
