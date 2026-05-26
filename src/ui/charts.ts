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
