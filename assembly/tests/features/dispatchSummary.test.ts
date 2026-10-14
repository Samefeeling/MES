/**
 * The day and week roll-ups behind the dispatch chart and weekly table.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import { DEFAULT_DISPATCH_SETTINGS, EMPTY_DECISIONS } from '@/domain/dispatch';
import { planDispatch } from '@/engine/dispatch/plan';
import { isoWeek, summarise, weekStart } from '@/features/dispatch/summary';

const orders = parseWaybillCsv(
  readFileSync(fileURLToPath(new URL('../fixtures/waybill.sample.csv', import.meta.url)), 'utf8'),
).orders;
const plan = planDispatch(orders, DEFAULT_DISPATCH_SETTINGS, EMPTY_DECISIONS, '2026-10-08');
const total = plan.loads.reduce((s, l) => s + l.volumeM3, 0);

describe('summarise', () => {
  it('keeps every m³ whether grouped by day or week', () => {
    const byDay = summarise(plan.loads, 'day');
    const byWeek = summarise(plan.loads, 'week');
    expect(byDay.reduce((s, b) => s + b.total, 0)).toBeCloseTo(total);
    expect(byWeek.reduce((s, b) => s + b.total, 0)).toBeCloseTo(total);
  });

  it('splits a day by route', () => {
    const monday = summarise(plan.loads, 'day').find((b) => b.key === '2026-10-12')!;
    expect(monday.volume.fleet).toBeGreaterThan(0);
    expect(monday.volume.linehaul + monday.volume.container + monday.volume.pickup).toBe(0);
    expect(monday.total).toBeCloseTo(monday.volume.fleet);
  });

  it('counts vehicles and part loads apart', () => {
    const week = summarise(plan.loads, 'week').find((b) => b.key === '2026-10-12')!;
    // Brisbane and Melbourne go LTL that week; containers and trucks are vehicles.
    expect(week.partLoads).toBeGreaterThanOrEqual(2);
    expect(week.vehicles).toBeGreaterThan(0);
    expect(week.fill).not.toBeNull();
  });

  it('counts an order once even when it is split across loads', () => {
    const week = summarise(plan.loads, 'week').find((b) => b.key === '2026-10-12')!;
    const ids = new Set(
      plan.loads.filter((l) => weekStart(l.day) === '2026-10-12').flatMap((l) => l.drops.map((d) => d.orderId)),
    );
    expect(week.orders).toBe(ids.size);
  });
});

describe('weeks', () => {
  it('start on Monday and carry the ISO number', () => {
    expect(weekStart('2026-10-08')).toBe('2026-10-05');
    expect(weekStart('2026-10-05')).toBe('2026-10-05');
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
    expect(isoWeek('2026-10-08')).toBe(41);
    expect(isoWeek('2027-01-01')).toBe(53);
  });
});
