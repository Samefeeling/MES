import { describe, it, expect } from 'vitest';
import { renderOutputRejectChart } from '../src/ui/charts';

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
