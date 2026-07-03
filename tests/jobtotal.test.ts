import { describe, expect, it } from 'vitest';

import { sumGoodStartedBefore, sumOtherShiftGood } from '../src/core/jobgood';
import { rec } from './helpers';

describe('sumOtherShiftGood (cross-shift Job Left carry)', () => {
  // Regression for order 507071: Day shift produced gross 61 with 8
  // rejects across the timeline (NOT all on slot 0). When viewing the
  // Afternoon shift, the Day shift's contribution must be the NET good
  // 61 − 8 = 53, not the gross 61. Job Left = 176 − 53 = 123.
  it('subtracts rejects recorded on non-zero slots from another shift', () => {
    const all = [
      // Day shift canonical slot 0 carries Count Start / End (gross 61);
      // its own rejects JSON is empty — rejects live on later slots.
      rec({
        jobNumber: 'J', slotIndex: 0, statusCode: 'R',
        countStart: 100, countEnd: 161, rejects: '{}',
      }),
      // 8 rejects spread across two mid-shift half-hour slots.
      rec({ jobNumber: 'J', slotIndex: 2, statusCode: 'R', rejects: JSON.stringify({ D01: 5 }) }),
      rec({ jobNumber: 'J', slotIndex: 7, statusCode: 'R', rejects: JSON.stringify({ D04: 3 }) }),
    ];
    // Viewing the Afternoon shift → Day is an "other" shift.
    const good = sumOtherShiftGood(all, '125T|2026-05-15-Afternoon');
    expect(good).toBe(53); // 61 gross − 8 rejects
  });

  it('excludes the currently-viewed tuple (added separately via goodThis)', () => {
    const all = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 40 }),
      rec({ jobNumber: 'J', slotIndex: 3, statusCode: 'R', rejects: JSON.stringify({ D01: 4 }) }),
    ];
    // Same tuple as the records → contributes 0 (it's the current shift).
    expect(sumOtherShiftGood(all, '125T|2026-05-15-Day')).toBe(0);
  });

  it('sums good across multiple other shifts, each net of its own rejects', () => {
    const all = [
      // Press A, Day: gross 50, 2 rejects on slot 4 → net 48.
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', machineCode: 'A', shiftId: '2026-05-15-Day', countStart: 0, countEnd: 50 }),
      rec({ jobNumber: 'J', slotIndex: 4, statusCode: 'R', machineCode: 'A', shiftId: '2026-05-15-Day', rejects: JSON.stringify({ D01: 2 }) }),
      // Press B, Night: gross 30, 0 rejects → net 30.
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', machineCode: 'B', shiftId: '2026-05-15-Night', countStart: 5, countEnd: 35 }),
    ];
    // currentKey matches neither tuple.
    expect(sumOtherShiftGood(all, 'Z|2026-05-15-Afternoon')).toBe(78); // 48 + 30
  });

  it('never goes negative when rejects exceed gross (bad data guard)', () => {
    const all = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 3 }),
      rec({ jobNumber: 'J', slotIndex: 1, statusCode: 'R', rejects: JSON.stringify({ D01: 9 }) }),
    ];
    expect(sumOtherShiftGood(all, 'other|shift')).toBe(0);
  });

  // The SFM507147 phantom: a stale PMD_LiveStatus shadow carrying counters
  // (gross 465, 9 rejects → 456 "good") but not a single machine-status
  // letter inflated every subsequent Job Left freeze by a constant 456.
  // Counter-only tuples are mis-taps / stale mirrors, not production.
  it('ignores a counter-only tuple with no status letters (stale shadow)', () => {
    const all = [
      rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R', machineCode: 'A', shiftId: '2026-05-15-Day', countStart: 0, countEnd: 50 }),
      rec({
        jobNumber: 'J', slotIndex: 0, statusCode: '', machineCode: 'A', shiftId: '2026-05-14-Day',
        countStart: 78, countEnd: 543, rejects: JSON.stringify({ D01: 9 }),
      }),
    ];
    expect(sumOtherShiftGood(all, 'Z|2026-05-15-Afternoon')).toBe(50);
  });

  it('a signed-off tuple counts even when its slots carry no status letters', () => {
    const all = [
      rec({
        jobNumber: 'J', slotIndex: 0, statusCode: '', locked: true,
        machineCode: 'A', shiftId: '2026-05-15-Day', countStart: 0, countEnd: 50,
      }),
    ];
    expect(sumOtherShiftGood(all, 'Z|2026-05-15-Afternoon')).toBe(50);
  });
});

describe('sumGoodStartedBefore (sign-off JobLeft recompute)', () => {
  const tuple = (
    shiftId: string,
    countStart: number,
    countEnd: number,
    rejects: Record<string, number> = {},
  ) =>
    rec({
      jobNumber: 'SFM507147', slotIndex: 0, statusCode: 'R', machineCode: 'Batt2',
      shiftId, countStart, countEnd, rejects: JSON.stringify(rejects),
    });

  // The real SFM507147 history: five shifts across two days. Signing off
  // the 2/07 Night shift must see 176 + 174 + 156 + 172 = 678 already made
  // (Night dated 2/07 starts 23:00 that evening, AFTER 2/07 Day/Afternoon).
  it('sums every shift that physically started earlier, across midnight', () => {
    const all = [
      tuple('2026-07-01-Afternoon', 78, 254), // 176
      tuple('2026-07-01-Night', 254, 428), // 174
      tuple('2026-07-02-Day', 428, 593, { D01: 9 }), // 165 − 9 = 156
      tuple('2026-07-02-Afternoon', 593, 775, { D02: 10 }), // 182 − 10 = 172
      tuple('2026-07-02-Night', 775, 972), // the tuple being signed — excluded
    ];
    expect(sumGoodStartedBefore(all, 'Batt2', '2026-07-02-Night')).toBe(678);
  });

  it('excludes shifts that start later or at the same instant', () => {
    const all = [
      tuple('2026-07-02-Night', 100, 200), // later than Day
      // Same shift window on another press → concurrent, not earlier.
      rec({
        jobNumber: 'SFM507147', slotIndex: 0, statusCode: 'R', machineCode: '550T',
        shiftId: '2026-07-02-Day', countStart: 0, countEnd: 30,
      }),
      tuple('2026-07-01-Night', 0, 40), // 40 — genuinely earlier
    ];
    expect(sumGoodStartedBefore(all, 'Batt2', '2026-07-02-Day')).toBe(40);
  });

  it('ignores counter-only phantom tuples here too', () => {
    const all = [
      tuple('2026-07-01-Afternoon', 78, 254), // 176
      rec({
        jobNumber: 'SFM507147', slotIndex: 0, statusCode: '', machineCode: 'Batt2',
        shiftId: '2026-07-01-Day', countStart: 78, countEnd: 543,
      }),
    ];
    expect(sumGoodStartedBefore(all, 'Batt2', '2026-07-02-Day')).toBe(176);
  });

  it('returns null when the target shiftId cannot be ordered', () => {
    expect(sumGoodStartedBefore([], 'Batt2', 'garbage')).toBeNull();
  });
});
