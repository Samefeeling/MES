import { expect, it } from 'vitest';
import { periodRange, rangeWeeks } from '../src/ui/assembly-kpi';
import { renderUtilizationChart } from '../src/ui/charts';

// Months are 0-based: 10 is November 2026. The 20th is a Friday.
const at = (d: number, h = 9) => new Date(2026, 10, d, h, 0, 0);

it('Last 24h is the working day before today, never today', () => {
  expect(periodRange('lastDay', at(20))).toEqual({ from: '2026-11-19', to: '2026-11-19' });
  expect(periodRange('lastDay', at(20, 23))).toEqual({ from: '2026-11-19', to: '2026-11-19' });
});

it('on a Monday, and over the weekend, Last 24h is Friday to yesterday', () => {
  expect(periodRange('lastDay', at(23))).toEqual({ from: '2026-11-20', to: '2026-11-22' });
  expect(periodRange('lastDay', at(22))).toEqual({ from: '2026-11-20', to: '2026-11-21' });
  expect(periodRange('lastDay', at(21))).toEqual({ from: '2026-11-20', to: '2026-11-20' });
});

it('Last Week is Monday to Sunday of the week before this one', () => {
  expect(periodRange('lastWeek', at(20))).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  expect(periodRange('lastWeek', at(23))).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  // A Sunday is still in the week that is ending.
  expect(periodRange('lastWeek', at(22))).toEqual({ from: '2026-11-09', to: '2026-11-15' });
});

it('the efficiency chart has a week for every week From–To touches, and marks the ones it holds only part of', () => {
  expect(rangeWeeks('2026-11-20', '2026-11-22')).toEqual({ weeks: ['2026-11-16'], partial: [true] });
  expect(rangeWeeks('2026-11-16', '2026-11-22')).toEqual({ weeks: ['2026-11-16'], partial: [false] });
  expect(rangeWeeks('2026-10-28', '2026-11-16')).toEqual({
    weeks: ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'],
    partial: [true, false, false, true],
  });
  expect(rangeWeeks('2026-11-22', '2026-11-01').weeks).toEqual([]);
  expect(rangeWeeks('', '2026-11-01').weeks).toEqual([]);
});

it('the Utilization chart is drawn at the width it is given, never scaled to fit', () => {
  const bars = [{ month: 'YTD', runHours: 10, availableHours: 20, pct: 50 }, { month: '2026-10', runHours: 5, availableHours: 10, pct: 50 }];
  const wide = renderUtilizationChart(bars, 1200);
  expect(wide).toContain('width="1200" height="220" viewBox="0 0 1200 220"');
  expect(wide).not.toContain('preserveAspectRatio');
  expect(renderUtilizationChart(bars, 500)).toContain('font-size="11"');
});
