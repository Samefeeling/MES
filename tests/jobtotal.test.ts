import { describe, expect, it } from 'vitest';

import { sumOtherShiftGood } from '../src/ui/operator';
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
});
