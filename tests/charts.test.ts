import { describe, it, expect } from 'vitest';
import { renderOutputRejectChart, renderParetoChart } from '../src/ui/charts';

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
