import { describe, expect, it } from 'vitest';
import {
  canBatch,
  formatBatchJobs,
  inPlanOrder,
  parseBatchJobs,
  shareSlots,
  splitBatchSlots,
  type BatchSlot,
} from '../src/core/hs-batch';
import type { StatusCode } from '../src/types';

/** A timeline from a 16-character string: R, M, B… and '.' for empty. */
const timeline = (s: string): BatchSlot[] =>
  [...s].map((c, slotIndex) => ({ slotIndex, statusCode: (c === '.' ? '' : c) as StatusCode }));

/** Who owns each slot, as a string of job initials — '.' for an empty slot. */
const owners = (s: string, owner: Map<number, string>): string =>
  [...s].map((_, i) => owner.get(i)?.[0] ?? '.').join('');

describe('which presses batch', () => {
  it('is hot stamp only', () => {
    // The machine register's name for it, and Planning.csv's.
    expect(canBatch('Hstamp')).toBe(true);
    expect(canBatch('HS')).toBe(true);
    expect(canBatch(' hs ')).toBe(true);
    expect(canBatch('550T')).toBe(false);
  });
});

describe('the batch list on the record', () => {
  it('reads and writes A,B,C once each', () => {
    expect(parseBatchJobs(' A, B,,A ,C')).toEqual(['A', 'B', 'C']);
    expect(parseBatchJobs(undefined)).toEqual([]);
    expect(formatBatchJobs(['B', 'A', 'B'])).toBe('B,A');
  });
});

describe('plan order', () => {
  it('is by planned start, orders with none last, ties as given', () => {
    const got = inPlanOrder([
      { job: 'X' },
      { job: 'B', plannedStart: '2026-11-27T09:00:00' },
      { job: 'A', plannedStart: '2026-11-27T07:00:00' },
      { job: 'Y' },
    ]);
    expect(got.map((o) => o.job)).toEqual(['A', 'B', 'X', 'Y']);
  });
});

describe('sharing half-hours', () => {
  it('is in proportion, by largest remainder, totalling what there is', () => {
    expect(shareSlots(10, [100, 50, 50])).toEqual([5, 3, 2]);
    expect(shareSlots(16, [1, 1, 1, 1])).toEqual([4, 4, 4, 4]);
  });
  it('gives every order at least one, taken from the largest', () => {
    // 1 piece in 1000 is 0.01 of 10 slots: it still gets one.
    expect(shareSlots(10, [999, 1])).toEqual([9, 1]);
    expect(shareSlots(3, [100, 1, 1])).toEqual([1, 1, 1]);
  });
});

describe('splitting a batch timeline', () => {
  it('lays the orders end to end in plan order, by Good + Reject', () => {
    //            0123456789012345
    const line = 'RRRRRRRRRRRRRRRR';
    const res = splitBatchSlots(timeline(line), [
      { job: 'Cee', plannedStart: '2026-11-27T11:00:00', good: 20, reject: 0 },
      { job: 'Aye', plannedStart: '2026-11-27T07:00:00', good: 90, reject: 10 },
      { job: 'Bee', plannedStart: '2026-11-27T09:00:00', good: 40, reject: 0 },
    ]);
    if (!res.ok) throw new Error(res.error);
    // 100 : 40 : 20 of 16 half-hours = 10 : 4 : 2.
    expect(res.split.jobs).toEqual(['Aye', 'Bee', 'Cee']);
    expect(res.split.runSlots).toEqual({ Aye: 10, Bee: 4, Cee: 2 });
    expect(owners(line, res.split.owner)).toBe('AAAAAAAAAABBBBCC');
  });

  it('keeps a break inside a block with it, and gives one between blocks to the next order', () => {
    //            0123456789012345
    const line = 'SRRMRRBRRRRMRR..';
    const res = splitBatchSlots(timeline(line), [
      { job: 'Aye', good: 40, reject: 0 },
      { job: 'Bee', good: 60, reject: 0 },
    ]);
    if (!res.ok) throw new Error(res.error);
    // 10 running half-hours: 4 and 6. Startup goes with the first order; the
    // breakdown at 6 falls after A's fourth R, so it opens B's block.
    expect(res.split.runSlots).toEqual({ Aye: 4, Bee: 6 });
    expect(owners(line, res.split.owner)).toBe('AAAAAABBBBBBBB..');
  });

  it('leaves out an order that stamped nothing', () => {
    const res = splitBatchSlots(timeline('RRRR............'), [
      { job: 'Aye', good: 10, reject: 0 },
      { job: 'Bee', good: 0, reject: 0 },
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.split.jobs).toEqual(['Aye']);
    expect(res.split.skipped).toEqual(['Bee']);
    expect(owners('RRRR', res.split.owner)).toBe('AAAA');
  });

  it('refuses a batch with more orders than running half-hours, or with nothing made', () => {
    const tooMany = splitBatchSlots(timeline('RRM.............'), [
      { job: 'A', good: 1, reject: 0 },
      { job: 'B', good: 1, reject: 0 },
      { job: 'C', good: 0, reject: 1 },
    ]);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toMatch(/3 orders.*only 2 running/);
    const none = splitBatchSlots(timeline('RRRR'), [{ job: 'A', good: 0, reject: 0 }]);
    expect(none.ok).toBe(false);
  });
});
