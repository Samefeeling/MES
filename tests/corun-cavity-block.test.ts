import { describe, expect, it } from 'vitest';
import { cavityBlockReminders, type CoRunOrderProgress } from '../src/core/corun';
import { shiftCapacityFor, shiftTargetFor } from '../src/core/targets';

// A co-running pair with uneven quantities is run together until the smaller
// order is made; that part's cavity is then blocked and the die carries on
// with the other. The sheet names the cavity to block from the moment the
// smaller order has less than one shift of output left.

/** Part A's order is 'A', part B's is 'B'… unless a part is given. */
const order = (
  jobNumber: string,
  jobLeft: number | null,
  shiftCapacity: number | null = 800,
  onShift = true,
  partNumber = `P-${jobNumber}`,
): CoRunOrderProgress => ({ jobNumber, partNumber, jobLeft, shiftCapacity, onShift });

const named = (out: ReturnType<typeof cavityBlockReminders>): string[] => out.map((r) => r.partNumber);

describe('cavityBlockReminders', () => {
  it('names the part with less than a shift left while its co-runner has more', () => {
    const out = cavityBlockReminders([order('A', 300), order('B', 2000)]);
    expect(out).toEqual([
      {
        partNumber: 'P-A',
        jobNumbers: ['A'],
        left: 300,
        shiftCapacity: 800,
        done: false,
        continuing: [{ partNumber: 'P-B', jobNumbers: ['B'], left: 2000 }],
      },
    ]);
  });

  it('says nothing while both still have a shift or more to run', () => {
    expect(cavityBlockReminders([order('A', 800), order('B', 2000)])).toEqual([]);
    expect(cavityBlockReminders([order('A', 1500), order('B', 2000)])).toEqual([]);
  });

  it('says nothing when the pair runs out together — that is an end of run', () => {
    expect(cavityBlockReminders([order('A', 300), order('B', 300)])).toEqual([]);
    expect(cavityBlockReminders([order('A', 0), order('B', 0)])).toEqual([]);
  });

  it('does not name the last part standing', () => {
    // B finishes this shift too, but nothing outlasts it: the die comes out.
    expect(named(cavityBlockReminders([order('A', 100), order('B', 500)]))).toEqual(['P-A']);
  });

  it('walks a three-part die down one cavity at a time, nearest first', () => {
    const out = cavityBlockReminders([order('C', 5000), order('B', 600), order('A', 100)]);
    expect(named(out)).toEqual(['P-A', 'P-B']);
    expect(out[0].continuing.map((c) => c.partNumber)).toEqual(['P-C', 'P-B']);
    expect(out[1].continuing.map((c) => c.partNumber)).toEqual(['P-C']);
  });

  it('adds a part up over all its orders — a cavity makes a part, not an order', () => {
    // 300 left on this order, but the next order for the same part is
    // waiting: the cavity keeps running, and must not be blocked.
    expect(
      cavityBlockReminders([
        order('A1', 300, 800, true, 'SEAT'),
        order('A2', 1000, 800, false, 'SEAT'),
        order('B', 2000, 800, true, 'BACK'),
      ]),
    ).toEqual([]);
    // Two short orders that together are still less than a shift: named once,
    // for the part, with both orders.
    const out = cavityBlockReminders([
      order('A1', 300, 800, true, 'SEAT'),
      order('A2', 200, 800, false, 'seat '),
      order('B', 2000, 800, true, 'BACK'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ partNumber: 'SEAT', jobNumbers: ['A1', 'A2'], left: 500 });
    // …and what carries on is the other part's total, over its orders.
    const two = cavityBlockReminders([
      order('A', 300, 800, true, 'SEAT'),
      order('B1', 35, 800, true, 'BACK'),
      order('B2', 400, 800, false, 'BACK'),
    ]);
    expect(named(two)).toEqual(['SEAT']);
    expect(two[0].continuing).toEqual([{ partNumber: 'BACK', jobNumbers: ['B1', 'B2'], left: 435 }]);
  });

  it('a finished part is named on the shift it was finished on, as done', () => {
    const out = cavityBlockReminders([order('A', 0), order('B', 2000)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ partNumber: 'P-A', done: true });
  });

  it('…and not on later shifts, where it is only still in the planning list', () => {
    expect(cavityBlockReminders([order('A', 0, 800, false), order('B', 2000)])).toEqual([]);
  });

  it('a part nearly made is named before it has any entry on the shift', () => {
    // Start of shift: nothing recorded yet, the plan alone shows it coming.
    const out = cavityBlockReminders([order('A', 300, 800, false), order('B', 2000, 800, false)]);
    expect(named(out)).toEqual(['P-A']);
  });

  it('judges each part by its own standard', () => {
    // 2-cavity part beside a 1-cavity part: 900 left is a full shift for one
    // and not for the other.
    expect(cavityBlockReminders([order('A', 900, 800), order('B', 4000, 1600)])).toEqual([]);
    expect(named(cavityBlockReminders([order('A', 900, 1600), order('B', 4000, 800)]))).toEqual(['P-A']);
  });

  it('stays silent on what it cannot work out', () => {
    // No standard: "less than a shift" cannot be judged.
    expect(cavityBlockReminders([order('A', 300, null), order('B', 2000)])).toEqual([]);
    // The co-runner's Job Left is unknown: nothing says it carries on.
    expect(cavityBlockReminders([order('A', 300), order('B', null)])).toEqual([]);
    // Unknown Job Left of the order itself, or of another order for its part.
    expect(cavityBlockReminders([order('A', null), order('B', 2000)])).toEqual([]);
    expect(
      cavityBlockReminders([
        order('A1', 300, 800, true, 'SEAT'),
        order('A2', null, 800, false, 'SEAT'),
        order('B', 2000, 800, true, 'BACK'),
      ]),
    ).toEqual([]);
    // An order on its own.
    expect(cavityBlockReminders([order('A', 300)])).toEqual([]);
  });

  it('what is known of a part still counts as more left for the others', () => {
    const out = cavityBlockReminders([
      order('A', 300, 800, true, 'SEAT'),
      order('B1', 2000, 800, true, 'BACK'),
      order('B2', null, 800, false, 'BACK'),
    ]);
    expect(named(out)).toEqual(['SEAT']);
  });
});

describe('shiftCapacityFor', () => {
  it('is the full-shift output at the standard, the capacity of the Shift Target rule', () => {
    // 100 pieces an hour → 0.01 h a piece → 800 in eight hours.
    expect(shiftCapacityFor({ qtyPerHr: 0.01 })).toBe(800);
    expect(shiftCapacityFor({ qtyPerHr: 0.01 }, 4)).toBe(400);
    // Shift Target is still min(Job Left, capacity).
    expect(shiftTargetFor({ qtyPerHr: 0.01 }, 5000)).toBe(800);
    expect(shiftTargetFor({ qtyPerHr: 0.01 }, 300)).toBe(300);
    expect(shiftTargetFor({ qtyPerHr: 0.01 }, 5000, 4)).toBe(400);
  });

  it('is null without a standard', () => {
    expect(shiftCapacityFor({ qtyPerHr: 0 })).toBeNull();
    expect(shiftTargetFor({ qtyPerHr: 0 }, 300)).toBeNull();
  });
});
