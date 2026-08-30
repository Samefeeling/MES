import { describe, it, expect } from 'vitest';
import {
  aggregate,
  cavityGross,
  countSetupEvents,
  oeeColor,
  scrapColor,
} from '../src/core/metrics';
import { partsCoRun, ordersCoRun } from '../src/core/corun';
import { rec } from './helpers';

describe('KPI aggregation (§4.1)', () => {
  it('OEE = run-slot ratio; null when no filled slots', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'J1', slotIndex: 2, statusCode: 'R' }),
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'B' }),
    ];
    expect(aggregate(recs).oee).toBe(75);
    expect(aggregate([]).oee).toBeNull();
  });

  it('downtime = (B+M) × 0.5h; setup = (D+C+I) × 0.5h', () => {
    const recs = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'B' }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'M' }),
      rec({ jobNumber: 'J', slotIndex: 2, statusCode: 'D' }),
      rec({ jobNumber: 'J', slotIndex: 3, statusCode: 'C' }),
      rec({ jobNumber: 'J', slotIndex: 4, statusCode: 'I' }),
      rec({ jobNumber: 'J', slotIndex: 5, statusCode: 'O' }), // idle, not counted
    ];
    const k = aggregate(recs);
    expect(k.downtimeHrs).toBe(1); // 2 × 0.5
    expect(k.setupHrs).toBe(1.5); // 3 × 0.5
  });

  it('output = good = countEnd-countStart-rejects; scrap% off gross', () => {
    const recs = [
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        countStart: 0,
        countEnd: 100,
        rejects: JSON.stringify({ P11: 3, P14: 2 }),
      }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R' }),
    ];
    const k = aggregate(recs);
    expect(k.scrap).toBe(5);
    expect(k.output).toBe(95); // 100 - 0 - 5
    expect(k.scrapPct).toBe(5); // 5 / 100 * 100
  });

  it('multi-cavity die doubles gross + good; rejects stay actual parts', () => {
    const recs = [
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        countStart: 0,
        countEnd: 100,
        cavities: 2,
        rejects: JSON.stringify({ P11: 10 }),
      }),
    ];
    const k = aggregate(recs);
    // gross = 100 cycles × 2 = 200; good = 200 − 10 rejects = 190.
    expect(k.output).toBe(190);
    expect(k.scrap).toBe(10);
    expect(k.scrapPct).toBe(5); // 10 / 200
  });

  it('counts one D/C/I changeover per order, not one per run of slots', () => {
    const recs = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'D' }),
      rec({ jobNumber: 'J', slotIndex: 2, statusCode: 'R' }),
      // Same order, so the same die change — the sheet just recorded it
      // in two pieces. Counting runs would grant 2 × 4 h of standard and
      // let an 8-hour changeover pass as within standard.
      rec({ jobNumber: 'J', slotIndex: 3, statusCode: 'D' }),
    ];
    expect(countSetupEvents(recs).dieChanges).toBe(1);
  });

  it('still counts a second order’s changeover separately', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'J2', slotIndex: 1, statusCode: 'D' }),
    ];
    expect(countSetupEvents(recs).dieChanges).toBe(2);
  });

  it('reports Startup (S) hours on their own, outside the D/C/I setup trio', () => {
    const recs = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'S' }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'S' }),
      rec({ jobNumber: 'J', slotIndex: 2, statusCode: 'S' }),
      rec({ jobNumber: 'J', slotIndex: 3, statusCode: 'D' }),
      rec({ jobNumber: 'J', slotIndex: 4, statusCode: 'R' }),
    ];
    const k = aggregate(recs);
    expect(k.startupHrs).toBe(1.5); // 3 slots × 0.5h
    // Startup is warm-up, not a changeover: it must not leak into the
    // Die/Colour/Insert columns those hours are judged against.
    expect(k.setupHrs).toBe(0.5);
    expect(k.dieHrs).toBe(0.5);
    // It is still a filled slot, so Efficiency counts it: 1 run of 5.
    expect(k.oee).toBe(20);
  });

  it('reports zero Startup hours for a shift that never warmed up', () => {
    expect(aggregate([rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R' })]).startupHrs).toBe(0);
  });

  it('counts the distinct shifts a slice covers, so totals can be judged per shift', () => {
    const recs = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', shiftId: '2026-07-01-Day' }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'R', shiftId: '2026-07-01-Day' }),
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', shiftId: '2026-07-01-Night' }),
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', shiftId: '2026-07-02-Day' }),
    ];
    expect(aggregate(recs).shifts).toBe(3);
    expect(aggregate([]).shifts).toBe(0);
  });
});

describe('cavityGross', () => {
  it('multiplies cycles by cavities, defaults to 1, clamps negatives, handles nulls', () => {
    expect(cavityGross(0, 100, 1)).toBe(100);
    expect(cavityGross(0, 100, 2)).toBe(200);
    expect(cavityGross(10, 50, 2)).toBe(80); // (50-10)*2
    expect(cavityGross(0, 100, 0)).toBe(100); // 0 → treated as 1
    expect(cavityGross(0, 100, undefined)).toBe(100);
    expect(cavityGross(100, 0, 2)).toBe(0); // negative clamps to 0
    expect(cavityGross(null, 100, 2)).toBe(0);
    expect(cavityGross(0, null, 2)).toBe(0);
  });
});

describe('partsCoRun', () => {
  const yes = (dieNumber: string): { dieNumber: string; coRun: boolean } => ({ dieNumber, coRun: true });
  const no = (dieNumber: string): { dieNumber: string; coRun: boolean } => ({ dieNumber, coRun: false });
  it('co-runs only when both flagged AND same non-empty die', () => {
    expect(partsCoRun(yes('D9'), yes('D9'))).toBe(true);
    expect(partsCoRun(yes('D9'), yes('D8'))).toBe(false); // different die
    expect(partsCoRun(yes('D9'), no('D9'))).toBe(false); // one not flagged
    expect(partsCoRun(no('D9'), no('D9'))).toBe(false); // neither flagged
    expect(partsCoRun(yes(''), yes(''))).toBe(false); // blank die never groups
    expect(partsCoRun(yes('D9'), undefined)).toBe(false);
    expect(partsCoRun(undefined, undefined)).toBe(false);
  });
});

describe('ordersCoRun', () => {
  const yes = (dieNumber: string): { dieNumber: string; coRun: boolean } => ({ dieNumber, coRun: true });
  const no = (dieNumber: string): { dieNumber: string; coRun: boolean } => ({ dieNumber, coRun: false });
  it('co-runs only when parts co-run AND order quantities are equal & known', () => {
    // same die, both flagged, equal qty → co-run
    expect(ordersCoRun(yes('D9'), yes('D9'), 1400, 1400)).toBe(true);
    // same die, both flagged, DIFFERENT qty → not co-run (the bug case:
    // different colours share the die but run separately)
    expect(ordersCoRun(yes('D9'), yes('D9'), 1400, 1200)).toBe(false);
    // parts don't co-run (one flag off) → qty equality is irrelevant
    expect(ordersCoRun(yes('D9'), no('D9'), 1400, 1400)).toBe(false);
    // unknown qty on either side can't be confirmed equal → not co-run
    expect(ordersCoRun(yes('D9'), yes('D9'), 1400, null)).toBe(false);
    expect(ordersCoRun(yes('D9'), yes('D9'), null, 1400)).toBe(false);
    expect(ordersCoRun(yes('D9'), yes('D9'), undefined, undefined)).toBe(false);
    // non-positive quantities are treated as unknown
    expect(ordersCoRun(yes('D9'), yes('D9'), 0, 0)).toBe(false);
    expect(ordersCoRun(yes('D9'), yes('D9'), -5, -5)).toBe(false);
  });
});

describe('KPI thresholds (§4.2)', () => {
  it('OEE colors', () => {
    expect(oeeColor(90)).toBe('green');
    expect(oeeColor(80)).toBe('amber');
    expect(oeeColor(60)).toBe('red');
    expect(oeeColor(null)).toBe('gray');
  });
  it('scrap colors', () => {
    expect(scrapColor(1)).toBe('green');
    expect(scrapColor(3)).toBe('amber');
    expect(scrapColor(7)).toBe('red');
  });
});
