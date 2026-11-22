import { expect, it } from 'vitest';
import { periodRange } from '../src/ui/assembly-kpi';

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
