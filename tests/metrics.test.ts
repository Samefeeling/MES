import { describe, it, expect } from 'vitest';
import {
  aggregate,
  countSetupEvents,
  oeeColor,
  scrapColor,
} from '../src/core/metrics';
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
