// Tiny dependency-free SVG bar chart for the zoomed-out operator views.
// Stacks Good (production) + Reject for each bucket; outlined like a Pareto
// to make scrap visible at a glance.

import { boxStats } from '../core/boxplot';

export interface BarBucket {
  label: string;
  good: number;
  reject: number;
}

const PAD_L = 36;
const PAD_R = 10;
const PAD_T = 18;
const PAD_B = 32;
const H = 220;

function escAttr(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Pure renderer — returns an inline `<svg>` string for the given buckets. */
export function renderOutputRejectChart(buckets: BarBucket[]): string {
  const n = Math.max(buckets.length, 1);
  const width = Math.max(360, PAD_L + PAD_R + n * 60);
  const innerH = H - PAD_T - PAD_B;
  const innerW = width - PAD_L - PAD_R;
  const maxStack = Math.max(
    1,
    ...buckets.map((b) => (b.good || 0) + (b.reject || 0)),
  );
  // Round the axis up to a nice number for readable gridlines.
  const niceMax = niceCeil(maxStack);

  const slot = innerW / n;
  const bw = Math.min(48, slot * 0.6);

  let bars = '';
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const x = PAD_L + i * slot + (slot - bw) / 2;
    const yGood = PAD_T + innerH - (b.good / niceMax) * innerH;
    const hGood = (b.good / niceMax) * innerH;
    const hRej = (b.reject / niceMax) * innerH;
    const yRej = yGood - hRej;
    if (hGood > 0)
      bars += `<rect x="${x.toFixed(1)}" y="${yGood.toFixed(1)}" width="${bw.toFixed(
        1,
      )}" height="${hGood.toFixed(1)}" fill="#16a34a" rx="3"></rect>`;
    if (hRej > 0)
      bars += `<rect x="${x.toFixed(1)}" y="${yRej.toFixed(1)}" width="${bw.toFixed(
        1,
      )}" height="${hRej.toFixed(1)}" fill="#dc2626" rx="3"></rect>`;
    const total = (b.good || 0) + (b.reject || 0);
    if (total > 0)
      bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(yRej - 4).toFixed(
        1,
      )}" font-size="11" fill="#1e293b" text-anchor="middle" font-weight="700">${total}</text>`;
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" font-size="11" fill="#475569" text-anchor="middle">${escAttr(b.label)}</text>`;
  }

  // Y axis gridlines + labels (4 ticks).
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + innerH - (g / 4) * innerH;
    const v = Math.round((g / 4) * niceMax);
    grid += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(width - PAD_R).toFixed(
      1,
    )}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${PAD_L - 6}" y="${(y + 3).toFixed(
      1,
    )}" font-size="10" fill="#64748b" text-anchor="end">${v}</text>`;
  }

  const legend = `
    <g transform="translate(${PAD_L},${PAD_T - 6})" font-size="11" fill="#1e293b">
      <rect width="10" height="10" y="-9" fill="#16a34a"/>
      <text x="14" y="0">Good</text>
      <rect width="10" height="10" x="60" y="-9" fill="#dc2626"/>
      <text x="74" y="0">Reject</text>
    </g>`;

  return `<svg viewBox="0 0 ${width} ${H}" width="100%" height="${H}" role="img" aria-label="Output and reject by bucket" preserveAspectRatio="xMidYMid meet">${grid}${bars}${legend}</svg>`;
}

function niceCeil(n: number): number {
  if (n <= 10) return Math.max(10, Math.ceil(n));
  const mag = 10 ** Math.floor(Math.log10(n));
  const norm = n / mag;
  const round = norm <= 1.5 ? 1.5 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10;
  return round * mag;
}

// =========================================================================
// Dual-axis stacked-bar + line chart shared by the two KPI charts below.
// Left axis: stacked bar segments. Right axis: overlay line.
// =========================================================================

export interface StackBucket {
  label: string;
  segments: number[]; // bottom -> top; index aligns with `segmentColors`
  overlay: number | null; // value on the right axis (null skips the point)
  /** Makes this bar clickable: the whole column (not just the drawn bar,
   *  which can be a few pixels wide) becomes a hit target carrying
   *  `data-bucket="<key>"`, so the page can wire a handler by delegation.
   *  Undefined leaves the bar inert. */
  clickKey?: string;
  /** Hover text for the column. Also the accessible name of the hit
   *  target — a clickable bar has to say what clicking it does. */
  title?: string;
}

export interface DualOpts {
  segmentColors: string[];
  segmentLabels: string[];
  overlayLabel: string;
  overlayColor: string;
  overlayAsPercent?: boolean; // forces right axis to 0..100
  /** Print each segment's own value inside it. Segments too short to fit
   *  the text are left bare. */
  labelSegments?: boolean;
  /** false leaves the legend to the page — an HTML legend wraps where an
   *  SVG one runs off the chart. */
  legend?: boolean;
  /** Bars only: no line and no right axis. */
  noOverlay?: boolean;
  /** Colour of the segment labels — white on saturated fills; 'auto' picks
   *  dark or white ink per fill, for a palette that has both. */
  segmentLabelColor?: string;
  /** Right axis from this value to 100 instead of 0 to 100. A yield line at
   *  97–99% on a 0–100 axis is a flat line along the top. */
  overlayFloor?: number;
  /** Each bar's total above it. */
  labelTotals?: boolean;
  /** A thin surface-coloured gap between stacked segments, so a stack of
   *  many colours does not run together. */
  segmentGap?: boolean;
}

/** Dark ink on a light fill, white on a dark one (WCAG relative luminance). */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#1e293b';
  const lin = (i: number): number => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // Contrast with white beats contrast with #1e293b below this luminance.
  return l < 0.3 ? '#fff' : '#1e293b';
}

interface LegendItem {
  label: string;
  color: string;
  line?: boolean;
}

/** SVG legend items laid out left to right from x0, wrapping at `maxX`.
 *  Returns the marks and the number of rows they took. */
function svgLegend(items: LegendItem[], x0: number, y0: number, maxX: number): { svg: string; rows: number } {
  let x = x0;
  let row = 0;
  let svg = '';
  for (const it of items) {
    const w = (it.line ? 40 : 34) + it.label.length * 6;
    if (x > x0 && x + w > maxX) {
      x = x0;
      row++;
    }
    const y = y0 + row * 16;
    svg += it.line
      ? `<g transform="translate(${x},${y})"><line x1="0" y1="-4" x2="14" y2="-4" stroke="${it.color}" stroke-width="2.5"/><circle cx="7" cy="-4" r="3" fill="${it.color}"/><text x="20" y="0" font-size="11" fill="#1e293b">${escAttr(it.label)}</text></g>`
      : `<g transform="translate(${x},${y})"><rect width="10" height="10" y="-9" fill="${it.color}"/><text x="14" y="0" font-size="11" fill="#1e293b">${escAttr(it.label)}</text></g>`;
    x += w;
  }
  return { svg, rows: row + 1 };
}

function renderDualAxis(buckets: StackBucket[], o: DualOpts): string {
  const PL = 42, PR = 48, PB = 36;
  const n = Math.max(buckets.length, 1);
  const width = Math.max(420, PL + PR + n * 60);
  // A legend too long for one row wraps, and the plot moves down under it.
  const legendItems: LegendItem[] = o.segmentLabels.map((label, s) => ({ label, color: o.segmentColors[s] }));
  if (!o.noOverlay) legendItems.push({ label: o.overlayLabel, color: o.overlayColor, line: true });
  const legendOut = svgLegend(legendItems, PL, 14, width - PR);
  const extra = o.legend === false ? 0 : (legendOut.rows - 1) * 16;
  const PT = 24 + extra + (o.labelTotals ? 8 : 0);
  const H2 = 240 + extra + (o.labelTotals ? 8 : 0);
  const innerH = H2 - PT - PB;
  const innerW = width - PL - PR;
  const slot = innerW / n;
  const bw = Math.min(46, slot * 0.55);

  const maxStack = Math.max(
    1,
    ...buckets.map((b) => b.segments.reduce((a, v) => a + (v || 0), 0)),
  );
  const niceLeft = niceCeil(maxStack);
  const niceRight = o.overlayAsPercent
    ? 100
    : niceCeil(
        Math.max(1, ...buckets.map((b) => Math.max(b.overlay ?? 0, 0))),
      );
  const floorRight = o.overlayAsPercent && o.overlayFloor != null ? Math.min(o.overlayFloor, 99) : 0;

  let bars = '';
  const linePts: string[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const cx = PL + i * slot + slot / 2;
    const x = cx - bw / 2;
    let cumY = PT + innerH;
    for (let s = 0; s < b.segments.length; s++) {
      const v = b.segments[s] || 0;
      if (v <= 0) continue;
      const h = (v / niceLeft) * innerH;
      cumY -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${cumY.toFixed(1)}" width="${bw.toFixed(
        1,
      )}" height="${h.toFixed(1)}" fill="${o.segmentColors[s]}" rx="2"${
        o.segmentGap ? ' stroke="#fff" stroke-width="1.5"' : ''
      }></rect>`;
      // The segment's own value, centred in it (skip if too short to fit).
      if (o.labelSegments && h >= 12) {
        const ink = o.segmentLabelColor === 'auto' ? inkOn(o.segmentColors[s]) : o.segmentLabelColor ?? '#1e293b';
        bars += `<text x="${cx.toFixed(1)}" y="${(cumY + h / 2 + 3).toFixed(
          1,
        )}" font-size="9" fill="${ink}" text-anchor="middle">${v}</text>`;
      }
    }
    if (o.labelTotals) {
      const total = b.segments.reduce((a, v) => a + (v || 0), 0);
      if (total > 0) {
        bars += `<text x="${cx.toFixed(1)}" y="${(cumY - 4).toFixed(1)}" font-size="10" font-weight="700" fill="#1e293b" text-anchor="middle">${total}</text>`;
      }
    }
    if (b.overlay != null && !o.noOverlay) {
      const v = Math.max(floorRight, b.overlay);
      const y = PT + innerH - ((v - floorRight) / (niceRight - floorRight)) * innerH;
      linePts.push(`${cx.toFixed(1)},${y.toFixed(1)}`);
    }
    bars += `<text x="${cx.toFixed(1)}" y="${H2 - 14}" font-size="11" font-weight="${
      b.clickKey ? 700 : 400
    }" fill="${b.clickKey ? '#1d4ed8' : '#475569'}" text-anchor="middle">${escAttr(
      b.label,
    )}</text>`;
    // Hit target last so it sits above the bars it covers. Full plot
    // height and a full slot wide: over a quarter a day's bar is only a
    // few pixels, and a target you have to aim at is not a control.
    if (b.clickKey) {
      bars += `<rect class="chart-hit" x="${(cx - slot / 2).toFixed(1)}" y="${PT}" width="${slot.toFixed(
        1,
      )}" height="${(innerH + 18).toFixed(1)}" fill="transparent" data-bucket="${escAttr(
        b.clickKey,
      )}" role="button" tabindex="0"><title>${escAttr(b.title ?? b.label)}</title></rect>`;
    } else if (b.title) {
      // Hover only: the column's numbers, without making it a control.
      bars += `<rect x="${(cx - slot / 2).toFixed(1)}" y="${PT}" width="${slot.toFixed(
        1,
      )}" height="${(innerH + 18).toFixed(1)}" fill="transparent"><title>${escAttr(b.title)}</title></rect>`;
    }
  }

  // overlay line + dots
  let line = '';
  if (linePts.length > 1) {
    line += `<polyline points="${linePts.join(' ')}" fill="none" stroke="${o.overlayColor}" stroke-width="2.5"/>`;
  }
  for (const p of linePts) {
    const [px, py] = p.split(',');
    line += `<circle cx="${px}" cy="${py}" r="3.5" fill="${o.overlayColor}"/>`;
  }

  // gridlines + dual axis labels
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const y = PT + innerH - (g / 4) * innerH;
    const vL = +((g / 4) * niceLeft).toFixed(1);
    const vR = +(floorRight + (g / 4) * (niceRight - floorRight)).toFixed(1);
    grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${(width - PR).toFixed(
      1,
    )}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${PL - 6}" y="${(y + 3).toFixed(
      1,
    )}" font-size="10" fill="#64748b" text-anchor="end">${vL}</text>`;
    if (!o.noOverlay)
      grid += `<text x="${(width - PR + 6).toFixed(1)}" y="${(y + 3).toFixed(
        1,
      )}" font-size="10" fill="${o.overlayColor}" text-anchor="start">${vR}${
        o.overlayAsPercent ? '%' : ''
      }</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${H2}" width="100%" height="${H2}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${bars}${line}${o.legend === false ? '' : legendOut.svg}</svg>`;
}

/** Any stacked series on the left axis with one line on the right. */
export const renderStackedLineChart = renderDualAxis;

// Exported so any chart split by shift speaks the same colour language as
// the stacked Output chart — a reader learns "green = Afternoon" once.
export const SHIFT_COLORS = ['#60a5fa', '#4ade80', '#fbbf24']; // Day / Afternoon / Night
const SHIFT_LABELS = ['Day', 'Afternoon', 'Night'];

/** Stacked Output by shift (left axis) + Reject line on the right axis. */
export function renderOutputByShiftChart(
  buckets: Array<{
    label: string;
    day: number;
    afternoon: number;
    night: number;
    reject: number;
    clickKey?: string;
    title?: string;
  }>,
): string {
  const data: StackBucket[] = buckets.map((b) => ({
    label: b.label,
    segments: [b.day, b.afternoon, b.night],
    overlay: b.reject,
    clickKey: b.clickKey,
    title: b.title,
  }));
  // Each shift segment prints its own Good count — the chart is about
  // output, so the number in the bar is the output, not a ratio the bar
  // height doesn't represent.
  return renderDualAxis(data, {
    segmentColors: SHIFT_COLORS,
    segmentLabels: SHIFT_LABELS,
    overlayLabel: 'Reject',
    overlayColor: '#dc2626',
    labelSegments: true,
  });
}

/**
 * Pareto chart: reject quantity bars sorted descending (left axis) with a
 * cumulative-% line (right axis, 0..100). The classic "80/20" view — the
 * few defect codes left of where the line crosses ~80% are the ones worth
 * chasing. Caller passes unsorted {label, value}; we sort + accumulate.
 */
export function renderParetoChart(
  items: Array<{ label: string; value: number }>,
): string {
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((a, i) => a + i.value, 0);
  let cum = 0;
  const data: StackBucket[] = sorted.map((i) => {
    cum += i.value;
    return {
      label: i.label,
      segments: [i.value],
      overlay: total > 0 ? +((cum / total) * 100).toFixed(1) : 0,
    };
  });
  return renderDualAxis(data, {
    segmentColors: ['#dc2626'],
    segmentLabels: ['Reject qty'],
    overlayLabel: 'Cumulative %',
    overlayColor: '#1d4ed8',
    overlayAsPercent: true,
  });
}

/**
 * Reject Pareto stacked by shift. Same Pareto layout as renderParetoChart
 * (bars sorted descending by total, cumulative-% line on the right axis),
 * but each bar is split into Day / Afternoon / Night segments — matching
 * the Output-by-shift colours. Cumulative % is over the grand total.
 */
export function renderParetoByShiftChart(
  items: Array<{ label: string; day: number; afternoon: number; night: number }>,
): string {
  const sorted = items
    .map((i) => ({ ...i, total: (i.day || 0) + (i.afternoon || 0) + (i.night || 0) }))
    .filter((i) => i.total > 0)
    .sort((a, b) => b.total - a.total);
  const grand = sorted.reduce((a, i) => a + i.total, 0);
  let cum = 0;
  const data: StackBucket[] = sorted.map((i) => {
    cum += i.total;
    return {
      label: i.label,
      segments: [i.day, i.afternoon, i.night],
      overlay: grand > 0 ? +((cum / grand) * 100).toFixed(1) : 0,
    };
  });
  return renderDualAxis(data, {
    segmentColors: SHIFT_COLORS,
    segmentLabels: SHIFT_LABELS,
    overlayLabel: 'Cumulative %',
    overlayColor: '#1d4ed8',
    overlayAsPercent: true,
  });
}

/** Stacked Run/Down/Setup hours + OEE % line on the right axis. */
export function renderHoursOeeChart(
  buckets: Array<{
    label: string;
    run: number;
    down: number;
    setup: number;
    oee: number | null;
    clickKey?: string;
    title?: string;
  }>,
): string {
  const data: StackBucket[] = buckets.map((b) => ({
    label: b.label,
    segments: [b.run, b.down, b.setup],
    overlay: b.oee,
    clickKey: b.clickKey,
    title: b.title,
  }));
  return renderDualAxis(data, {
    segmentColors: ['#16a34a', '#dc2626', '#f59e0b'],
    segmentLabels: ['Run h', 'Down h', 'Setup h'],
    overlayLabel: 'Efficiency %',
    overlayColor: '#1d4ed8',
    overlayAsPercent: true,
  });
}

// =========================================================================
// Horizontal stacked bars — one row per person or thing being ranked.
// Names read along the row instead of being squeezed under a column, which
// is what a ranking of fifteen operators needs. Same ink, grid and legend
// as the column charts above.
// =========================================================================

export interface BarRow {
  label: string;
  segments: number[];
  /** Printed after the bar, e.g. "2.5 h over". */
  end?: string;
  clickKey?: string;
  title?: string;
}

/** Whole-number ticks for counts: 0, 1, 2… or 0, 2, 4… — never 2.5 of a
 *  stoppage. */
function countTicks(max: number): { top: number; step: number } {
  const target = Math.max(1, max);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((st) => target / st <= 6) ?? 1000;
  return { top: Math.ceil(target / step) * step, step };
}

export function renderStackedBarsH(
  rows: BarRow[],
  o: { segmentColors: string[]; segmentLabels: string[] },
): string {
  const width = 640;
  const labelW = Math.min(170, Math.max(90, Math.max(0, ...rows.map((r) => r.label.length)) * 6.6 + 14));
  const endW = Math.max(40, Math.max(0, ...rows.map((r) => (r.end ?? '').length)) * 6 + 12);
  const PL = labelW, PR = endW;
  // Over the plot when it fits on one row there, else from the left edge.
  const items = o.segmentLabels.map((label, s) => ({ label, color: o.segmentColors[s] }));
  const legendW = items.reduce((w, it) => w + 34 + it.label.length * 6, 0);
  const legend = svgLegend(items, Math.max(10, Math.min(PL, width - 10 - legendW)), 14, width - 10);
  const PT = 26 + (legend.rows - 1) * 16;
  const ROW = 26, BAR = 16, PB = 22;
  const innerW = width - PL - PR;
  const H2 = PT + rows.length * ROW + PB;
  const max = Math.max(0, ...rows.map((r) => r.segments.reduce((a, v) => a + (v || 0), 0)));
  const { top, step } = countTicks(max);
  const xOf = (v: number): number => PL + (v / top) * innerW;

  let grid = '';
  for (let v = 0; v <= top; v += step) {
    const x = xOf(v);
    grid += `<line x1="${x.toFixed(1)}" y1="${PT - 4}" x2="${x.toFixed(1)}" y2="${(H2 - PB + 2).toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${x.toFixed(1)}" y="${(H2 - 6).toFixed(1)}" font-size="10" fill="#64748b" text-anchor="middle">${v}</text>`;
  }

  let bars = '';
  rows.forEach((r, i) => {
    const y = PT + i * ROW + (ROW - BAR) / 2;
    const cy = y + BAR / 2;
    bars += `<text x="${PL - 8}" y="${(cy + 4).toFixed(1)}" font-size="11" font-weight="${
      r.clickKey ? 700 : 400
    }" fill="${r.clickKey ? '#1d4ed8' : '#475569'}" text-anchor="end">${escAttr(r.label)}</text>`;
    let x = PL;
    r.segments.forEach((v, s) => {
      if (!(v > 0)) return;
      const w = (v / top) * innerW;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${BAR}" fill="${
        o.segmentColors[s]
      }" rx="2" stroke="#fff" stroke-width="1.5"></rect>`;
      if (w >= 14) {
        bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" font-size="9.5" font-weight="700" fill="${inkOn(
          o.segmentColors[s],
        )}" text-anchor="middle">${v}</text>`;
      }
      x += w;
    });
    if (r.end) {
      bars += `<text x="${(x + 6).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-size="10.5" fill="#1e293b">${escAttr(r.end)}</text>`;
    }
    if (r.clickKey || r.title) {
      bars += `<rect${r.clickKey ? ' class="chart-hit"' : ''} x="0" y="${(PT + i * ROW).toFixed(1)}" width="${width}" height="${ROW}" fill="transparent"${
        r.clickKey ? ` data-bucket="${escAttr(r.clickKey)}" role="button" tabindex="0"` : ''
      }><title>${escAttr(r.title ?? r.label)}</title></rect>`;
    }
  });

  // Fixed height like the column charts: it shrinks into a narrow card but
  // never blows its text up in a wide one.
  return `<svg viewBox="0 0 ${width} ${H2}" width="100%" height="${H2}" role="img" preserveAspectRatio="xMidYMin meet">${legend.svg}${grid}${bars}</svg>`;
}

// =========================================================================
// Box plot — how long each kind of stoppage actually takes.
// =========================================================================

/** One event on a box: its duration, and enough identity to name it when
 *  it turns out to be the outlier worth asking about. */
export interface BoxPoint {
  value: number;
  label: string;
}

export interface BoxSeries {
  label: string;
  color: string;
  points: BoxPoint[];
  /** Standard allowance, drawn as a dashed reference across the box.
   *  null where the floor has no standard (a breakdown has none). */
  std?: number | null;
}

/** Hour-friendly axis top. The shared niceCeil floors at 10, which would
 *  squash a 3-hour chart into the bottom third. */
function niceHours(n: number): number {
  if (n <= 0) return 1;
  for (const s of [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48]) {
    if (n <= s) return s;
  }
  return Math.ceil(n / 24) * 24;
}

const h1 = (v: number): string => `${v.toFixed(1)} h`;

/**
 * One box per category on a SHARED hours axis — the comparison is the
 * point: a die change costing eight times a colour change is the finding,
 * and scaling each box to its own range would hide exactly that. Small
 * categories stay legible via a minimum box height, the median printed
 * above each box, and each category's standard drawn where it has one.
 */
export function renderBoxPlotChart(series: BoxSeries[]): string {
  const PL = 44, PR = 14, PT = 26, PB = 46;
  const HB = 260;
  const n = Math.max(series.length, 1);
  // The viewBox scales to fit BOTH width and height, so its aspect ratio
  // decides how much of the card actually gets used: too narrow a box and
  // the fixed 260px height letterboxes the chart into the middle third.
  // ~160px a category matches the half-width KPI card's proportions.
  const width = Math.max(680, PL + PR + n * 160);
  const innerH = HB - PT - PB;
  const innerW = width - PL - PR;
  const slotW = innerW / n;
  const bw = Math.min(58, slotW * 0.5);

  const stats = series.map((s) => boxStats(s.points.map((p) => p.value)));
  const top = niceHours(
    Math.max(
      0.5,
      ...stats.map((st) => st?.max ?? 0),
      ...series.map((s) => s.std ?? 0),
    ),
  );
  const y = (v: number): number => PT + innerH - (Math.min(v, top) / top) * innerH;

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = PT + innerH - (g / 4) * innerH;
    grid += `<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${(width - PR).toFixed(1)}" y2="${gy.toFixed(
      1,
    )}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${PL - 6}" y="${(gy + 3).toFixed(
      1,
    )}" font-size="10" fill="#64748b" text-anchor="end">${+((g / 4) * top).toFixed(1)}</text>`;
  }
  grid += `<text x="10" y="${PT - 12}" font-size="10" fill="#64748b">hours</text>`;

  let body = '';
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const st = stats[i];
    const cx = PL + i * slotW + slotW / 2;
    const x = cx - bw / 2;

    if (!st) {
      body += `<text x="${cx.toFixed(1)}" y="${(PT + innerH / 2).toFixed(
        1,
      )}" font-size="11" fill="#94a3b8" text-anchor="middle">no events</text>`;
      body += `<text x="${cx.toFixed(1)}" y="${HB - 26}" font-size="11" fill="#475569" text-anchor="middle">${escAttr(
        s.label,
      )}</text>`;
      continue;
    }

    const yq1 = y(st.q1);
    const yq3 = y(st.q3);
    // A category where every event took the same time has a zero-height
    // box; draw it as a 3px bar so it reads as "no spread", not "absent".
    const boxH = Math.max(3, yq1 - yq3);
    const yBox = Math.min(yq3, yq1 - boxH);

    const tip = [
      `${s.label} — ${st.n} event${st.n === 1 ? '' : 's'}`,
      `median ${h1(st.median)} · mean ${h1(st.mean)}`,
      `middle half ${h1(st.q1)} – ${h1(st.q3)}`,
      `range ${h1(st.min)} – ${h1(st.max)}`,
      s.std != null ? `standard ${h1(s.std)}` : '',
      st.outliers.length ? `${st.outliers.length} beyond 1.5×IQR` : '',
    ]
      .filter(Boolean)
      .join('\n');

    body += `<g><title>${escAttr(tip)}</title>`;
    // whisker spine + caps
    body += `<line x1="${cx.toFixed(1)}" y1="${y(st.upperWhisker).toFixed(1)}" x2="${cx.toFixed(
      1,
    )}" y2="${y(st.lowerWhisker).toFixed(1)}" stroke="${s.color}" stroke-width="1.5"/>`;
    for (const w of [st.upperWhisker, st.lowerWhisker]) {
      body += `<line x1="${(cx - bw / 4).toFixed(1)}" y1="${y(w).toFixed(1)}" x2="${(
        cx + bw / 4
      ).toFixed(1)}" y2="${y(w).toFixed(1)}" stroke="${s.color}" stroke-width="1.5"/>`;
    }
    body += `<rect x="${x.toFixed(1)}" y="${yBox.toFixed(1)}" width="${bw.toFixed(
      1,
    )}" height="${boxH.toFixed(1)}" fill="${s.color}" fill-opacity="0.28" stroke="${
      s.color
    }" stroke-width="1.5" rx="2"/>`;
    body += `<line x1="${x.toFixed(1)}" y1="${y(st.median).toFixed(1)}" x2="${(x + bw).toFixed(
      1,
    )}" y2="${y(st.median).toFixed(1)}" stroke="${s.color}" stroke-width="3"/>`;
    body += `</g>`;

    // Standard allowance — the line the box is meant to sit under.
    if (s.std != null && s.std > 0) {
      const ys = y(s.std);
      body += `<g><title>${escAttr(`${s.label} standard ${h1(s.std)}`)}</title>`;
      body += `<line x1="${(cx - bw / 2 - 8).toFixed(1)}" y1="${ys.toFixed(1)}" x2="${(
        cx +
        bw / 2 +
        8
      ).toFixed(
        1,
      )}" y2="${ys.toFixed(1)}" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      body += `<text x="${(cx + bw / 2 + 10).toFixed(1)}" y="${(ys + 3).toFixed(
        1,
      )}" font-size="9" fill="#1e293b">std</text></g>`;
    }

    // Outliers, each named — this is the actionable end of the chart.
    const byValue = new Map<number, string[]>();
    for (const p of s.points) {
      if (!st.outliers.includes(p.value)) continue;
      byValue.set(p.value, [...(byValue.get(p.value) ?? []), p.label]);
    }
    for (const [value, labels] of byValue) {
      body += `<g><title>${escAttr(`${h1(value)} — ${labels.join(', ')}`)}</title><circle cx="${cx.toFixed(
        1,
      )}" cy="${y(value).toFixed(1)}" r="3" fill="#fff" stroke="${
        s.color
      }" stroke-width="1.5"/></g>`;
    }

    body += `<text x="${cx.toFixed(1)}" y="${Math.max(PT + 9, y(st.upperWhisker) - 6).toFixed(
      1,
    )}" font-size="10" font-weight="700" fill="#1e293b" text-anchor="middle">${st.median.toFixed(
      1,
    )}</text>`;
    body += `<text x="${cx.toFixed(1)}" y="${HB - 26}" font-size="11" fill="#475569" text-anchor="middle">${escAttr(
      s.label,
    )}</text>`;
    body += `<text x="${cx.toFixed(1)}" y="${HB - 13}" font-size="10" fill="#94a3b8" text-anchor="middle">n=${
      st.n
    }</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${HB}" width="100%" height="${HB}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${body}</svg>`;
}
