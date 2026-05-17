import { describe, it, expect } from 'vitest';
import { canLock, isShiftLocked, applyLock, applyUnlock } from '../src/core/lock';
import { rec } from './helpers';

describe('shift lock (§5.5)', () => {
  it('requires a supervisor before locking', () => {
    const r = canLock([], '');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Supervisor must be selected before locking');
  });

  it('blocks lock while conflicts exist', () => {
    const recs = [
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R' }),
      rec({ jobNumber: 'J2', slotIndex: 1, statusCode: 'B' }),
    ];
    const r = canLock(recs, 'Jeff Penn');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cannot lock: 1 time slots/);
  });

  it('allows lock when supervisor set and no conflicts', () => {
    expect(canLock([rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R' })], 'Jeff Penn').ok).toBe(
      true,
    );
  });

  it('applyLock stamps every record with lock metadata', () => {
    const recs = [rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R' })];
    const out = applyLock(recs, '125T', '2026-05-15-Day', 'Jeff Penn', 'Tin Maung');
    expect(out[0].locked).toBe(true);
    expect(out[0].lockedBy).toBe('Jeff Penn');
    expect(out[0].operator).toBe('Tin Maung');
    expect(isShiftLocked(out)).toBe(true);
  });

  it('applyLock creates a SlotIndex=0 placeholder when no records exist', () => {
    const out = applyLock([], '125T', '2026-05-15-Day', 'Jeff Penn', 'Tin Maung');
    expect(out).toHaveLength(1);
    expect(out[0].slotIndex).toBe(0);
    expect(out[0].statusCode).toBe('');
    expect(out[0].locked).toBe(true);
  });

  it('applyUnlock clears lock metadata', () => {
    const locked = applyLock([rec({ jobNumber: 'J', slotIndex: 0, statusCode: 'R' })], '125T', '2026-05-15-Day', 'Jeff Penn', 'Tin');
    const out = applyUnlock(locked);
    expect(out[0].locked).toBe(false);
    expect(out[0].lockedBy).toBe('');
    expect(isShiftLocked(out)).toBe(false);
  });
});
