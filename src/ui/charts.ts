// Tiny dependency-free SVG bar chart for the zoomed-out operator views.
// Stacks Good (production) + Reject for each bucket; outlined like a Pareto
// to make scrap visible at a glance.

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
}

interface DualOpts {
  segmentColors: string[];
  segmentLabels: string[];
  overlayLabel: string;
  overlayColor: string;
  overlayAsPercent?: boolean; // forces right axis to 0..100
}

function renderDualAxis(buckets: StackBucket[], o: DualOpts): string {
  const PL = 42, PR = 48, PT = 24, PB = 36;
  const H2 = 240;
  const n = Math.max(buckets.length, 1);
  const width = Math.max(420, PL + PR + n * 60);
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
      )}" height="${h.toFixed(1)}" fill="${o.segmentColors[s]}" rx="2"></rect>`;
    }
    if (b.overlay != null) {
      const y = PT + innerH - (b.overlay / niceRight) * innerH;
      linePts.push(`${cx.toFixed(1)},${y.toFixed(1)}`);
    }
    bars += `<text x="${cx.toFixed(1)}" y="${H2 - 14}" font-size="11" fill="#475569" text-anchor="middle">${escAttr(
      b.label,
    )}</text>`;
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
    const vL = Math.round((g / 4) * niceLeft);
    const vR = +((g / 4) * niceRight).toFixed(1);
    grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${(width - PR).toFixed(
      1,
    )}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
    grid += `<text x="${PL - 6}" y="${(y + 3).toFixed(
      1,
    )}" font-size="10" fill="#64748b" text-anchor="end">${vL}</text>`;
    grid += `<text x="${(width - PR + 6).toFixed(1)}" y="${(y + 3).toFixed(
      1,
    )}" font-size="10" fill="${o.overlayColor}" text-anchor="start">${vR}${
      o.overlayAsPercent ? '%' : ''
    }</text>`;
  }

  // legend
  let legendX = PL;
  const legend: string[] = [];
  for (let s = 0; s < o.segmentLabels.length; s++) {
    legend.push(
      `<g transform="translate(${legendX},${PT - 10})"><rect width="10" height="10" y="-9" fill="${o.segmentColors[s]}"/><text x="14" y="0" font-size="11" fill="#1e293b">${escAttr(o.segmentLabels[s])}</text></g>`,
    );
    legendX += 12 + 14 + o.segmentLabels[s].length * 6 + 8;
  }
  legend.push(
    `<g transform="translate(${legendX},${PT - 10})"><line x1="0" y1="-4" x2="14" y2="-4" stroke="${o.overlayColor}" stroke-width="2.5"/><circle cx="7" cy="-4" r="3" fill="${o.overlayColor}"/><text x="20" y="0" font-size="11" fill="#1e293b">${escAttr(o.overlayLabel)}</text></g>`,
  );

  return `<svg viewBox="0 0 ${width} ${H2}" width="100%" height="${H2}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${bars}${line}${legend.join('')}</svg>`;
}

const SHIFT_COLORS = ['#60a5fa', '#4ade80', '#fbbf24']; // Day / Afternoon / Night
const SHIFT_LABELS = ['Day', 'Afternoon', 'Night'];

/** Stacked Output by shift (left axis) + Reject line on the right axis. */
export function renderOutputByShiftChart(
  buckets: Array<{
    label: string;
    day: number;
    afternoon: number;
    night: number;
    reject: number;
  }>,
): string {
  const data: StackBucket[] = buckets.map((b) => ({
    label: b.label,
    segments: [b.day, b.afternoon, b.night],
    overlay: b.reject,
  }));
  return renderDualAxis(data, {
    segmentColors: SHIFT_COLORS,
    segmentLabels: SHIFT_LABELS,
    overlayLabel: 'Reject',
    overlayColor: '#dc2626',
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
  }>,
): string {
  const data: StackBucket[] = buckets.map((b) => ({
    label: b.label,
    segments: [b.run, b.down, b.setup],
    overlay: b.oee,
  }));
  return renderDualAxis(data, {
    segmentColors: ['#16a34a', '#dc2626', '#f59e0b'],
    segmentLabels: ['Run h', 'Down h', 'Setup h'],
    overlayLabel: 'OEE %',
    overlayColor: '#1d4ed8',
    overlayAsPercent: true,
  });
}
