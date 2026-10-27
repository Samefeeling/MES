import { describe, expect, it } from 'vitest';
import { shiftToKeep } from '../src/ui/shift-plan-keeper';

describe('shiftToKeep: a shift is kept once it is under way', () => {
  it('waits out the first half hour, for an export made at the shift change', () => {
    expect(shiftToKeep(new Date('2026-10-27T07:10:00'))).toBeNull();
    expect(shiftToKeep(new Date('2026-10-27T07:30:00'))).toBe('2026-10-27-Day');
    expect(shiftToKeep(new Date('2026-10-27T14:59:00'))).toBe('2026-10-27-Day');
  });

  it('keeps the night under the date it started', () => {
    expect(shiftToKeep(new Date('2026-10-27T23:20:00'))).toBeNull();
    expect(shiftToKeep(new Date('2026-10-28T02:00:00'))).toBe('2026-10-27-Night');
  });
});
