import { describe, it, expect } from 'vitest';
import {
  aggregate,
  cavityGross,
  countSetupEvents,
  oeeColor,
  scrapColor,
} from '../src/core/metrics';
import { partsCoRun } from '../src/core/corun';
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

  it('counts D/C/I changeover events, not slots', () => {
    const recs = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'D' }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'D' }), // same run
      rec({ jobNumber: 'J', slotIndex: 2, statusCode: 'R' }),
      rec({ jobNumber: 'J', slotIndex: 3, statusCode: 'D' }), // new event
    ];
    expect(countSetupEvents(recs).dieChanges).toBe(2);
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
