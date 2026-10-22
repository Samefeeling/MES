import { describe, expect, it } from 'vitest';
import { orderFactsFromHistory, repairFromHistory } from '../src/core/order-history';
import { aggregate } from '../src/core/metrics';
import { targetTuplesForRecords } from '../src/core/kpi-attainment';
import { rec } from './helpers';

/** A signed run of SFM1 on 550T: slot 0 carries the counts. */
const run = (shiftId: string, from: number, to: number, extra: Parameters<typeof rec>[0] extends infer P ? Partial<P> : never = {}) => [
  rec({
    jobNumber: 'SFM1',
    machineCode: '550T',
    shiftId,
    slotIndex: 0,
    statusCode: 'R',
    countStart: from,
    countEnd: to,
    locked: true,
    ...extra,
  }),
  ...[1, 2, 3].map((slotIndex) =>
    rec({ jobNumber: 'SFM1', machineCode: '550T', shiftId, slotIndex, statusCode: 'R', locked: true }),
  ),
];

describe('an order Planning.csv no longer holds', () => {
  // Monday it was still planned, and its sign-off stamped everything.
  const monday = run('2026-10-19-Day', 0, 600, {
    partNumber: 'P1',
    partDescription: 'Pallet insert',
    jobRequired: 1000,
    cycleTime: 0.02,
    shiftTarget: 400,
  });
  // Tuesday's sign-off found it at a new rate.
  const tuesday = run('2026-10-20-Day', 600, 1000, { partNumber: 'P1', jobRequired: 1000, cycleTime: 0.01, shiftTarget: 400 });

  it('takes each fact from the newest shift that recorded it', () => {
    expect(orderFactsFromHistory([...monday, ...tuesday])).toEqual({
      partNumber: 'P1',
      partDescription: 'Pallet insert',
      jobRequired: 1000,
      cycleTime: 0.01,
    });
    expect(orderFactsFromHistory([])).toEqual({ partNumber: '', partDescription: '', jobRequired: 0, cycleTime: 0 });
  });

  it('fills a shift signed without its part, rate and target', () => {
    // Tuesday signed with nothing — Epicor had dropped the order. Another
    // order held the first two hours of the press, so 6 h were left to it:
    // 6 h at 50 an hour is 300, under the 400 still needed.
    const other = [0, 1, 2, 3].map((slotIndex) =>
      rec({ jobNumber: 'SFM2', machineCode: '550T', shiftId: '2026-10-20-Day', slotIndex, statusCode: 'R', locked: true, cycleTime: 0.01, shiftTarget: 100, partNumber: 'P9' }),
    );
    const bare = [
      rec({ jobNumber: 'SFM1', machineCode: '550T', shiftId: '2026-10-20-Day', slotIndex: 0, statusCode: '', countStart: 600, countEnd: 1000, locked: true }),
      ...[4, 5, 6, 7].map((slotIndex) =>
        rec({ jobNumber: 'SFM1', machineCode: '550T', shiftId: '2026-10-20-Day', slotIndex, statusCode: 'R', locked: true }),
      ),
    ];
    const history = new Map([['SFM1', [...monday, ...bare]]]);
    const fixed = repairFromHistory([...other, ...bare], history);

    const own = fixed.filter((r) => r.jobNumber === 'SFM1');
    expect(own.every((r) => r.partNumber === 'P1' && r.cycleTime === 0.02 && r.jobRequired === 1000)).toBe(true);
    expect(own.find((r) => r.slotIndex === 0)!.shiftTarget).toBe(300);
    expect(own.filter((r) => r.slotIndex !== 0).every((r) => r.shiftTarget === undefined)).toBe(true);
    // The other order is untouched, object for object.
    expect(fixed.slice(0, 4)).toEqual(other);
  });

  it('works out the ShiftTarget sign-off would have written', () => {
    // Tuesday signed with nothing: 400 still needed at the start of the
    // shift; 8 h at 100 an hour could make 800, so 400 is asked.
    const bare = run('2026-10-20-Day', 600, 1000);
    const history = new Map([['SFM1', [...monday, ...bare]]]);
    const [canon] = repairFromHistory(bare, history);
    expect(canon.shiftTarget).toBe(Math.min(400, Math.floor(8 / 0.02 + 0.01)));
    // An overrun shift is asked for nothing, which still counts as a plan.
    const after = run('2026-10-20-Afternoon', 1000, 1100);
    const [late] = repairFromHistory(after, new Map([['SFM1', [...monday, ...bare, ...after]]]));
    expect(late.shiftTarget).toBe(0);
    expect(targetTuplesForRecords([late])[0].planned).toBe(0);
  });

  it('gives its press an Efficiency again', () => {
    const bare = run('2026-10-20-Day', 600, 1000);
    expect(aggregate(bare).efficiency).toBeNull();
    const fixed = repairFromHistory(bare, new Map([['SFM1', [...monday, ...bare]]]));
    expect(aggregate(fixed).efficiency).not.toBeNull();
  });

  it('never replaces what the shift recorded itself', () => {
    const own = run('2026-10-20-Day', 600, 1000, { partNumber: 'P1-B', cycleTime: 0.05, shiftTarget: 7 });
    const [canon] = repairFromHistory(own, new Map([['SFM1', [...monday, ...own]]]));
    expect(canon.partNumber).toBe('P1-B');
    expect(canon.cycleTime).toBe(0.05);
    expect(canon.shiftTarget).toBe(7);
  });

  it('leaves orders it has no history for alone', () => {
    const bare = run('2026-10-20-Day', 600, 1000);
    expect(repairFromHistory(bare, new Map())).toEqual(bare);
  });
});
