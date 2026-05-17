// Tiny dependency-free SVG charts (§4.1: 3 charts per machine card).

export interface Stack {
  name: string;
  color: string;
  values: number[];
}
export interface LineOverlay {
  name: string;
  color: string;
  values: number[]; // 0..100 (%)
}

const W = 280;
const H = 120;
const PAD = 20;

function svgOpen(): string {
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">`;
}

/** Stacked bars with an optional right-axis percentage line (0..100). */
export function stackedBarLine(
  labels: string[],
  stacks: Stack[],
  line?: LineOverlay,
): string {
  const n = Math.max(labels.length, 1);
  const totals = labels.map((_, i) =>
    stacks.reduce((a, s) => a + (s.values[i] || 0), 0),
  );
  const maxY = Math.max(1, ...totals);
  const bw = (W - 2 * PAD) / n;
  const plotH = H - 2 * PAD;
  let bars = '';
  for (let i = 0; i < n; i++) {
    let yCursor = H - PAD;
    const x = PAD + i * bw + bw * 0.15;
    const w = bw * 0.7;
    for (const s of stacks) {
      const v = s.values[i] || 0;
      const h = (v / maxY) * plotH;
      if (h > 0) {
        yCursor -= h;
        bars += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${w.toFixed(
          1,
        )}" height="${h.toFixed(1)}" fill="${s.color}"/>`;
      }
    }
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" font-size="7" fill="#64748b" text-anchor="middle">${labels[i]}</text>`;
  }
  let path = '';
  if (line) {
    const pts = line.values.map((v, i) => {
      const x = PAD + i * bw + bw / 2;
      const y = H - PAD - (Math.max(0, Math.min(100, v)) / 100) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    if (pts.length)
      path = `<polyline points="${pts.join(' ')}" fill="none" stroke="${line.color}" stroke-width="2"/>`;
  }
  return `${svgOpen()}${bars}${path}</svg>`;
}

/** Setup-time Plan vs Actual: actual D/C/I stacked, plan as a marker line. */
export function setupPlanActual(
  labels: string[],
  plan: number[],
  actual: { d: number[]; c: number[]; i: number[] },
): string {
  const stacks: Stack[] = [
    { name: 'Die', color: '#fed7aa', values: actual.d },
    { name: 'Color', color: '#fde68a', values: actual.c },
    { name: 'Insert', color: '#fca5a5', values: actual.i },
  ];
  const n = Math.max(labels.length, 1);
  const totals = labels.map((_, i) =>
    Math.max(plan[i] || 0, stacks.reduce((a, s) => a + (s.values[i] || 0), 0)),
  );
  const maxY = Math.max(1, ...totals);
  const bw = (W - 2 * PAD) / n;
  const plotH = H - 2 * PAD;
  let out = stackedBarLineRaw(labels, stacks, maxY);
  // plan markers
  for (let i = 0; i < n; i++) {
    const x = PAD + i * bw + bw * 0.1;
    const w = bw * 0.8;
    const y = H - PAD - ((plan[i] || 0) / maxY) * plotH;
    out += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + w).toFixed(
      1,
    )}" y2="${y.toFixed(1)}" stroke="#1e40af" stroke-width="2" stroke-dasharray="3 2"/>`;
  }
  return `${svgOpen()}${out}</svg>`;
}

function stackedBarLineRaw(labels: string[], stacks: Stack[], maxY: number): string {
  const n = Math.max(labels.length, 1);
  const bw = (W - 2 * PAD) / n;
  const plotH = H - 2 * PAD;
  let bars = '';
  for (let i = 0; i < n; i++) {
    let yCursor = H - PAD;
    const x = PAD + i * bw + bw * 0.15;
    const w = bw * 0.7;
    for (const s of stacks) {
      const v = s.values[i] || 0;
      const h = (v / maxY) * plotH;
      if (h > 0) {
        yCursor -= h;
        bars += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${w.toFixed(
          1,
        )}" height="${h.toFixed(1)}" fill="${s.color}"/>`;
      }
    }
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" font-size="7" fill="#64748b" text-anchor="middle">${labels[i]}</text>`;
  }
  return bars;
}
