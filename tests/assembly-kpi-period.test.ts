/**
 * KPIs · Assembly opens on "Last 24h": the last working day before today.
 * Completions are confirmed the morning after, so today has none yet.
 */
import { expect, it } from 'vitest';
import { periodRange } from '../src/ui/assembly-kpi';

const at = (iso: string): Date => new Date(`${iso}T09:00:00`);

it('opens on yesterday on a weekday', () => {
  expect(periodRange('lastDay', at('2026-11-20'))).toEqual({ from: '2026-11-19', to: '2026-11-19' });
});

it('opens on Friday on a Monday, Saturday or Sunday', () => {
  for (const day of ['2026-11-23', '2026-11-22', '2026-11-21']) {
    expect(periodRange('lastDay', at(day))).toEqual({ from: '2026-11-20', to: '2026-11-20' });
  }
});

it('This Week runs Monday to today', () => {
  expect(periodRange('thisWeek', at('2026-11-20'))).toEqual({ from: '2026-11-16', to: '2026-11-20' });
});
