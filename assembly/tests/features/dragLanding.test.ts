/**
 * Where a dragged bar comes to rest.
 *
 * The floor's report: "I moved it once and can never move it back." A pin could
 * only name a day, so every dragged order restarted at 07:00 — a bar drawn at a
 * quarter to three, because that is when its crew came off the last order, went
 * to the open of the shift the moment anybody touched it, and dragging it home
 * only ever offered 07:00 on the day it came from. The move was never
 * reversible.
 *
 * So a drag is measured along the column — which is the shift as the floor
 * stands in it — and lands on five minutes.
 */

import { describe, expect, it } from 'vitest';
import { landAfterDrag, shiftTimelineKeepingClock } from '@/features/assembly/boardView';
import { DRAG_STEP_MINUTES, SHIFT_SPAN_MINUTES } from '@/engine/assembly/shift';

/** Thursday 10 Sep 2026, and the Friday and Monday either side of its weekend. */
const on = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute);
/** Day of the month and the 24-hour clock — the way the floor reads a shift. */
const say = (at: Date) =>
  `${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:` +
  String(at.getMinutes()).padStart(2, '0');

/** One column, as a fraction, is the whole shift. */
const minutes = (n: number) => n / SHIFT_SPAN_MINUTES;

describe('a bar dragged along its own row', () => {
  it('moves by the part of a column the pointer moved, not by a whole one', () => {
    // An hour is an hour, not "no move" and not "a day".
    expect(say(landAfterDrag(on(10, 10), minutes(60), false))).toBe('10 11:00');
    expect(say(landAfterDrag(on(10, 10), minutes(-60), false))).toBe('10 09:15');
  });

  it('lands on five minutes, so the same drag twice writes the same time', () => {
    const drift = landAfterDrag(on(10, 10), minutes(63.7), false);
    expect(drift.getMinutes() % DRAG_STEP_MINUTES).toBe(0);
    expect(say(drift)).toBe('10 11:05');
  });

  /*
   * The one the floor reported. Out and back has to be where it started —
   * anything else is a board that cannot be undone by hand.
   */
  it('comes home when it is dragged back', () => {
    const drawn = on(10, 14, 45);
    const out = landAfterDrag(drawn, 1, false);
    expect(say(out)).toBe('11 14:45');
    expect(landAfterDrag(out, -1, false)).toEqual(drawn);
  });

  it('and comes home from a move that was never a whole column', () => {
    const drawn = on(10, 9, 30);
    for (const move of [0.25, 0.5, 1.75, -0.5, -2.25]) {
      const out = landAfterDrag(drawn, move, false);
      expect(landAfterDrag(out, -move, false), `${move}`).toEqual(drawn);
    }
  });

  it('carries into the next column rather than piling up at 15:30', () => {
    // 15:00 plus two hours is not 17:00; it is the next morning at 08:30.
    expect(say(landAfterDrag(on(10, 15), minutes(120), false))).toBe('11 08:30');
  });

  it('and backwards into the previous one', () => {
    // A column is the 8.5 hours the crew are on the floor, so an hour into
    // Thursday less two is 450 minutes into Wednesday: half past two.
    expect(say(landAfterDrag(on(10, 8), minutes(-120), false))).toBe('9 14:30');
  });

  /*
   * The compact working week. Friday's next column is Monday, so a drag that
   * runs off the end of Friday lands on Monday morning — not on a Saturday the
   * reader cannot even see.
   */
  it('steps over a weekend the axis is not drawing', () => {
    // Friday 11 Sep 2026 → Monday 14th.
    expect(say(landAfterDrag(on(11, 14), 1, false))).toBe('14 14:00');
    // 15:00 is 480 minutes into Friday's column; an hour more runs 30 past its
    // end, and the end of Friday is the start of Monday.
    expect(say(landAfterDrag(on(11, 15), minutes(60), false))).toBe('14 07:30');
  });

  it('but lands on the Saturday when Saturday is on screen', () => {
    expect(say(landAfterDrag(on(11, 14), 1, true))).toBe('12 14:00');
  });

  it('never comes to rest during a break', () => {
    // 11:50 plus a quarter of an hour is inside lunch, so it waits for 12:30.
    expect(say(landAfterDrag(on(10, 11, 50), minutes(15), false))).toBe('10 12:30');
    // …and the morning one.
    expect(say(landAfterDrag(on(10, 8, 55), minutes(10), false))).toBe('10 09:15');
  });

  it('nor before the crew are in', () => {
    // Half an hour into Thursday less an hour is half an hour before Thursday
    // opens, which is the last half hour of Wednesday.
    expect(say(landAfterDrag(on(10, 7, 30), minutes(-60), false))).toBe('9 15:00');
  });
});

describe('moving a whole column but keeping the clock', () => {
  it('is the same time of day, one column over', () => {
    expect(say(shiftTimelineKeepingClock(on(10, 13, 20), 1, false))).toBe('11 13:20');
    expect(say(shiftTimelineKeepingClock(on(11, 13, 20), 1, false))).toBe('14 13:20');
  });

  // A start stored before pins carried a time is a midnight, and midnight is
  // not a moment on this shift.
  it('reads a midnight as the open of the shift', () => {
    expect(say(shiftTimelineKeepingClock(on(10, 0), 0, false))).toBe('10 07:00');
  });
});
