import { describe, it, expect } from 'vitest';
import {
  inkOn,
  renderOutputRejectChart,
  renderParetoByShiftChart,
  renderParetoChart,
  renderStackedBarsH,
  renderStackedLineChart,
} from '../src/ui/charts';

describe('output/reject bar chart', () => {
  it('renders an svg with bars for each bucket', () => {
    const svg = renderOutputRejectChart([
      { label: 'Day', good: 120, reject: 4 },
      { label: 'Afternoon', good: 95, reject: 7 },
      { label: 'Night', good: 110, reject: 2 },
    ]);
    expect(svg).toMatch(/^<svg/);
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(6); // 3 good + 3 reject
    expect(svg).toContain('Day');
    expect(svg).toContain('Night');
  });

  it('survives empty buckets and zero totals', () => {
    expect(renderOutputRejectChart([]).startsWith('<svg')).toBe(true);
    const svg = renderOutputRejectChart([{ label: 'x', good: 0, reject: 0 }]);
    expect(svg).toMatch(/^<svg/);
  });
});

describe('reject Pareto chart', () => {
  it('renders sorted bars and a cumulative-% overlay reaching 100', () => {
    const svg = renderParetoChart([
      { label: 'D02', value: 3 },
      { label: 'D01', value: 10 },
      { label: 'D05', value: 2 },
    ]);
    expect(svg).toMatch(/^<svg/);
    // 3 bars + the cumulative line endpoint at 100% (right-axis label).
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('100%'); // cumulative reaches 100
    expect(svg).toContain('D01');
  });

  it('drops zero-value codes and survives an all-empty set', () => {
    const svg = renderParetoChart([{ label: 'D01', value: 0 }]);
    expect(svg).toMatch(/^<svg/);
  });
});

describe('reject Pareto stacked by shift', () => {
  it('stacks Day/Afternoon/Night segments, sorts by total, reaches 100%', () => {
    const svg = renderParetoByShiftChart([
      { label: 'D02', day: 1, afternoon: 1, night: 1 }, // total 3
      { label: 'D01', day: 4, afternoon: 3, night: 3 }, // total 10
      { label: 'D05', day: 0, afternoon: 2, night: 0 }, // total 2
    ]);
    expect(svg).toMatch(/^<svg/);
    // D01 has 3 non-zero shift segments, D02 3, D05 1 → ≥7 bar rects.
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(svg).toContain('100%');
    // Shift legend present.
    expect(svg).toContain('Day');
    expect(svg).toContain('Afternoon');
    expect(svg).toContain('Night');
  });

  it('survives an all-zero / empty set', () => {
    expect(renderParetoByShiftChart([]).startsWith('<svg')).toBe(true);
    const svg = renderParetoByShiftChart([
      { label: 'D01', day: 0, afternoon: 0, night: 0 },
    ]);
    expect(svg).toMatch(/^<svg/);
  });
});

describe('stacked bars with a line — the operator output chart', () => {
  const opts = {
    segmentColors: ['#2a78d6', '#eda100'],
    segmentLabels: ['125T', '550T'],
    overlayLabel: 'Yield %',
    overlayColor: '#0f172a',
    overlayAsPercent: true,
  };

  it('starts the % axis at the floor it is given', () => {
    const svg = renderStackedLineChart([{ label: '10-06', segments: [10, 5], overlay: 98 }], { ...opts, overlayFloor: 92 });
    expect(svg).toContain('>92%<');
    expect(svg).toContain('>100%<');
    expect(svg).not.toContain('>0%<');
  });

  it('prints each bar’s total and gives a hover title to a bar that is not a control', () => {
    const svg = renderStackedLineChart(
      [{ label: '10-06', segments: [10, 5], overlay: 98, title: '10-06 · 15 good' }],
      { ...opts, labelTotals: true },
    );
    expect(svg).toContain('>15</text>');
    expect(svg).toContain('<title>10-06 · 15 good</title>');
    expect(svg).not.toContain('chart-hit');
  });

  it('wraps a legend too long for one row and moves the plot down', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Press ${i + 1}`);
    const svg = renderStackedLineChart([{ label: 'a', segments: many.map(() => 1), overlay: null }], {
      ...opts,
      segmentColors: many.map(() => '#2a78d6'),
      segmentLabels: many,
    });
    expect(Number(/height="(\d+)"/.exec(svg)![1])).toBeGreaterThan(240);
  });

  it('picks white ink on dark fills and dark ink on light ones', () => {
    expect(inkOn('#1e3a8a')).toBe('#fff');
    expect(inkOn('#eda100')).toBe('#1e293b');
  });
});

describe('horizontal stacked bars — the stoppage ranking', () => {
  const rows = [
    { label: 'Phong Xuan', segments: [0, 0, 1, 4], end: '2.5 h over', clickKey: 'Phong Xuan', title: 'Phong Xuan — 5' },
    { label: 'Edin Kulelija', segments: [1, 0, 0, 2], end: '2.0 h over' },
  ];
  const svg = renderStackedBarsH(rows, {
    segmentColors: ['#2a78d6', '#c2410c', '#f59e0b', '#dc2626'],
    segmentLabels: ['Startup > 1 h', 'Die setup > 4 h', 'Insert / colour > 0.5 h', 'Breakdown'],
  });

  it('draws a row per name with its end label', () => {
    expect(svg).toContain('>Phong Xuan</text>');
    expect(svg).toContain('>2.5 h over</text>');
    expect(svg).toContain('>Edin Kulelija</text>');
  });

  it('counts in whole numbers on the axis', () => {
    const ticks = [...svg.matchAll(/text-anchor="middle">(\d+(?:\.\d+)?)<\/text>/g)].map((m) => m[1]);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => !t.includes('.'))).toBe(true);
  });

  it('makes a row with a click key a control that names what clicking does', () => {
    expect(svg).toContain('data-bucket="Phong Xuan" role="button" tabindex="0"><title>Phong Xuan — 5</title>');
  });
});
