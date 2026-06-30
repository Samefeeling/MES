import { describe, it, expect } from 'vitest';
import {
  buildShiftId,
  parseShiftId,
  previousShift,
  shiftBounds,
  slotTimeRange,
  slotClock,
  slotLabel,
  currentShift,
  currentSlotIndex,
  SLOTS_PER_SHIFT,
} from '../src/core/shifts';

describe('shift id / bounds (§2.3)', () => {
  it('builds and parses a shift id from local date parts', () => {
    const d = new Date(2026, 4, 15, 10, 0, 0); // 15 May 2026 local
    expect(buildShiftId(d, 'Day')).toBe('2026-05-15-Day');
    expect(parseShiftId('2026-05-15-Night')).toEqual({
      year: 2026,
      month: 5,
      day: 15,
      code: 'Night',
    });
  });

  it('rejects malformed shift ids', () => {
    expect(parseShiftId('2026-5-15-Day')).toBeNull();
    expect(parseShiftId('garbage')).toBeNull();
  });

  it('Day shift = 07:00–15:00', () => {
    const b = shiftBounds('2026-05-15-Day')!;
    expect(b.start.getHours()).toBe(7);
    expect(b.end.getHours()).toBe(15);
  });

  it('Night shift spans midnight, dated by its start day (§2.3)', () => {
    const b = shiftBounds('2026-05-15-Night')!;
    expect(b.start.getHours()).toBe(23);
    expect(b.start.getDate()).toBe(15);
    expect(b.end.getHours()).toBe(7);
    expect(b.end.getDate()).toBe(16);
  });
});

describe('slots (§5.1)', () => {
  it('has exactly 16 slots of 30 minutes', () => {
    expect(SLOTS_PER_SHIFT).toBe(16);
    const s0 = slotTimeRange('2026-05-15-Day', 0)!;
    expect(s0.start.getHours()).toBe(7);
    expect(s0.end.getMinutes()).toBe(30);
    const s15 = slotTimeRange('2026-05-15-Day', 15)!;
    expect(s15.end.getHours()).toBe(15); // last slot ends at shift end
  });

  it('rejects out-of-range slot indices', () => {
    expect(slotTimeRange('2026-05-15-Day', -1)).toBeNull();
    expect(slotTimeRange('2026-05-15-Day', 16)).toBeNull();
  });

  it('formats slot clock and label', () => {
    expect(slotClock('2026-05-15-Day', 4)).toBe('09:00–09:30');
    expect(slotLabel('2026-05-15-Day', 4)).toBe('Slot 5/16 · 09:00–09:30');
  });
});

describe('current shift (§2.3)', () => {
  it('maps clock hour to the right shift', () => {
    expect(currentShift(new Date(2026, 4, 15, 9)).code).toBe('Day');
    expect(currentShift(new Date(2026, 4, 15, 18)).code).toBe('Afternoon');
    expect(currentShift(new Date(2026, 4, 15, 23, 30)).code).toBe('Night');
  });

  it('after-midnight Night belongs to the previous calendar day', () => {
    const cs = currentShift(new Date(2026, 4, 16, 2, 0));
    expect(cs.code).toBe('Night');
    expect(cs.shiftId).toBe('2026-05-15-Night');
  });

  it('a Night shift dated "today" is in the future before its 23:00 start', () => {
    // The mis-date trap powering isFutureShift(): at 06:00 on 16 May the
    // running Night is 15-May-Night, but a supervisor who leaves the date on
    // "today" picks 16-May-Night — which doesn't start until 23:00 that day,
    // so its bounds begin AFTER the current 06:00 clock (a future shift).
    const now = new Date(2026, 4, 16, 6, 0);
    expect(currentShift(now).shiftId).toBe('2026-05-15-Night');
    const wronglyPicked = shiftBounds('2026-05-16-Night')!;
    expect(now < wronglyPicked.start).toBe(true);
    // The correct shift's window has already started (not future).
    const running = shiftBounds('2026-05-15-Night')!;
    expect(now < running.start).toBe(false);
  });

  it('locates the active slot index, null when outside the shift', () => {
    expect(currentSlotIndex('2026-05-15-Day', new Date(2026, 4, 15, 7, 15))).toBe(0);
    expect(currentSlotIndex('2026-05-15-Day', new Date(2026, 4, 15, 9, 0))).toBe(4);
    expect(currentSlotIndex('2026-05-15-Day', new Date(2026, 4, 15, 18, 0))).toBeNull();
  });
});

describe('previousShift', () => {
  it('walks Night → Afternoon → Day within one date', () => {
    expect(previousShift('2026-06-02-Night')).toBe('2026-06-02-Afternoon');
    expect(previousShift('2026-06-02-Afternoon')).toBe('2026-06-02-Day');
  });
  it('wraps Day to previous date Night', () => {
    expect(previousShift('2026-06-02-Day')).toBe('2026-06-01-Night');
  });
  it('crosses month boundary correctly', () => {
    expect(previousShift('2026-07-01-Day')).toBe('2026-06-30-Night');
  });
  it('returns null on garbage input', () => {
    expect(previousShift('not-a-shift')).toBeNull();
  });
});
