import { describe, it, expect } from 'vitest';
import { detectConflicts, hasConflicts, slotGuard } from '../src/core/conflicts';
import { rec } from './helpers';

describe('conflict detection (§5.4)', () => {
  it('flags the same SlotIndex held by two different orders', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'R' }),
      rec({ jobNumber: 'J2', slotIndex: 3, statusCode: 'B' }),
      rec({ jobNumber: 'J1', slotIndex: 4, statusCode: 'R' }),
    ];
    const c = detectConflicts(recs);
    expect(c).toEqual([{ slotIndex: 3, jobNumbers: ['J1', 'J2'] }]);
    expect(hasConflicts(recs)).toBe(true);
  });

  it('same order multiple slots is not a conflict', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R' }),
    ];
    expect(detectConflicts(recs)).toEqual([]);
  });

  it('empty status does not participate in conflicts', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 2, statusCode: 'R' }),
      rec({ jobNumber: 'J2', slotIndex: 2, statusCode: '' }),
    ];
    expect(hasConflicts(recs)).toBe(false);
  });

  it('real-time guard blocks a slot another order owns', () => {
    const recs = [rec({ jobNumber: 'J2', slotIndex: 5, statusCode: 'D' })];
    const blocker = slotGuard(recs, 5, 'J1');
    expect(blocker?.jobNumber).toBe('J2');
    expect(slotGuard(recs, 5, 'J2')).toBeNull(); // same order is fine
    expect(slotGuard(recs, 6, 'J1')).toBeNull(); // free slot
  });
});
