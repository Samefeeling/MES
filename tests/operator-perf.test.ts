import { describe, expect, it } from 'vitest';

import {
  collectStartups,
  operatorByTuple,
  operatorPerformance,
  outputByTime,
} from '../src/core/operator-perf';
import { rec } from './helpers';
import type { ProductionRecord, StatusCode } from '../src/types';

/** One (press, shift, order) as the sheet stores it: slot 0 carries the
 *  operator and the counters, then one row per status slot. */
const order = (
  operator: string,
  codes: string,
  over: Partial<ProductionRecord> = {},
): ProductionRecord[] => {
  const base = { jobNumber: 'J1', machineCode: '125T', shiftId: '2026-10-06-Day', ...over };
  const rows: ProductionRecord[] = [];
  [...codes].forEach((c, i) => {
    if (c === '.') return;
    rows.push(rec({ ...base, slotIndex: i, statusCode: c as StatusCode }));
  });
  const head = rows.find((r) => r.slotIndex === 0) ?? rec({ ...base, slotIndex: 0, statusCode: '' });
  if (!rows.includes(head)) rows.unshift(head);
  Object.assign(head, { operator, countStart: over.countStart ?? null, countEnd: over.countEnd ?? null });
  return rows;
};

const perf = (records: ProductionRecord[], name: string) =>
  operatorPerformance(records).find((p) => p.operator === name)!;

describe('operator per order and shift', () => {
  it('reads the name off the canonical row and gives it every slot of the order', () => {
    const recs = order('  Aryan   Apte ', 'RRRR');
    expect([...operatorByTuple(recs).values()]).toEqual(['Aryan Apte']);
    expect(perf(recs, 'Aryan Apte').kpi.runHrs).toBe(2);
  });

  it('keeps an order with no operator under its own blank row', () => {
    const rows = operatorPerformance([...order('', 'RR'), ...order('Erin Toman', 'RR', { jobNumber: 'J2' })]);
    expect(rows.map((r) => r.operator).sort()).toEqual(['', 'Erin Toman']);
  });
});

describe('stoppages against the limits', () => {
  it('flags a die setup only when it runs past 4 h', () => {
    const exactly4 = order('A', 'DDDDDDDD');
    const over4 = order('B', 'DDDDDDDDD', { jobNumber: 'J2', shiftId: '2026-10-07-Day' });
    const a = perf([...exactly4, ...over4], 'A');
    const b = perf([...exactly4, ...over4], 'B');
    expect(a.tally.die).toEqual({ events: 1, flagged: 0, hours: 4 });
    expect(b.tally.die).toEqual({ events: 1, flagged: 1, hours: 4.5 });
    expect(b.hoursOver).toBe(0.5);
  });

  it('flags an insert or colour change past half an hour and a startup past an hour', () => {
    const p = perf(order('A', 'CIISSSRR'), 'A');
    expect(p.tally.change).toEqual({ events: 2, flagged: 1, hours: 1.5 });
    expect(p.tally.startup).toEqual({ events: 1, flagged: 1, hours: 1.5 });
    expect(p.hoursOver).toBe(1);
  });

  it('counts every breakdown, and all its hours', () => {
    const p = perf(order('A', 'RBBRB'), 'A');
    expect(p.tally.breakdown).toEqual({ events: 2, flagged: 2, hours: 1.5 });
    expect(p.hoursOver).toBe(1.5);
  });

  it('puts a die change across a shift change to whoever logged most of it', () => {
    const recs = [
      ...order('Day op', '.............DDD', { jobNumber: 'J9' }),
      ...order('Arvo op', 'DDDDDDRR', { jobNumber: 'J9', shiftId: '2026-10-06-Afternoon' }),
    ];
    expect(perf(recs, 'Arvo op').tally.die).toEqual({ events: 1, flagged: 1, hours: 4.5 });
    expect(perf(recs, 'Day op').tally.die.events).toBe(0);
    // The hours each logged still count under each of them.
    expect(perf(recs, 'Day op').kpi.dieHrs).toBe(1.5);
  });

  it('leaves the presses the caller excludes out of the stoppages, not out of the output', () => {
    const recs = order('A', 'DDDDDDDDDRRR', { machineCode: 'HSTAMP', countStart: 0, countEnd: 50 });
    const [p] = operatorPerformance(recs, undefined, (mc) => mc !== 'HSTAMP');
    expect(p.stops).toEqual([]);
    expect(p.kpi.output).toBe(50);
  });
});

describe('startups', () => {
  it('runs until the press runs, smoko and breakdowns included', () => {
    const [e] = collectStartups(order('A', 'SSMBSR'));
    expect(e.records.map((r) => r.slotIndex)).toEqual([0, 1, 4]);
  });

  it('starts again after production, or after a shift with no S', () => {
    expect(collectStartups(order('A', 'SSRSS'))).toHaveLength(2);
    const twoDays = [...order('A', 'SS'), ...order('A', 'SS', { shiftId: '2026-10-07-Day' })];
    expect(collectStartups(twoDays)).toHaveLength(2);
  });
});

describe('output over time', () => {
  it('sums good and reject per press per day, or per week from Monday', () => {
    const recs = [
      ...order('A', 'RR', { countStart: 0, countEnd: 100 }),
      ...order('A', 'RR', { machineCode: '320T', countStart: 0, countEnd: 40 }),
      ...order('A', 'RR', { shiftId: '2026-10-08-Night', countStart: 10, countEnd: 30 }),
    ];
    recs[0].rejectCount = 5;
    const daily = outputByTime(recs);
    expect(daily.map((b) => b.key)).toEqual(['2026-10-06', '2026-10-08']);
    expect(daily[0].byMachine.get('125T')).toEqual({ good: 95, reject: 5 });
    expect(daily[0].byMachine.get('320T')).toEqual({ good: 40, reject: 0 });
    const weekly = outputByTime(recs, true);
    expect(weekly.map((b) => b.key)).toEqual(['2026-10-05']);
    expect(weekly[0].byMachine.get('125T')).toEqual({ good: 115, reject: 5 });
  });
});
