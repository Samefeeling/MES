/**
 * Work laid onto the clock. See `engine/assembly/shift` for why the two are
 * not the same measure.
 */

import { describe, it, expect } from 'vitest';
import {
  BREAKS,
  PRODUCTIVE_MINUTES,
  SHIFT_CLOSE_MINUTE,
  SHIFT_OPEN_MINUTE,
  SHIFT_SPAN_MINUTES,
  WORK_SEGMENTS,
  breakAt,
  clockAtWorkMinutes,
  nextWorkingMoment,
  shiftClockAt,
  shiftColumnFraction,
  shiftStartAt,
  workFractionAt,
  workMinutesAtClock,
} from '@/engine/assembly/shift';
import { PRODUCTIVE_HOURS_PER_PERSON } from '@/domain/assembly';
import { formatTime } from '@/lib/time';

/** Thursday 10 Sep 2026. */
const DAY = new Date(2026, 8, 10);
const on = (hour: number, minute = 0) => new Date(2026, 8, 10, hour, minute);
/** Minutes past midnight, as the module counts them. */
const at = (hour: number, minute = 0) => hour * 60 + minute;

describe('the shape of the day', () => {
  it('is 07:00 to 15:30', () => {
    expect(SHIFT_OPEN_MINUTE).toBe(at(7));
    expect(SHIFT_CLOSE_MINUTE).toBe(at(15, 30));
    expect(SHIFT_SPAN_MINUTES).toBe(510);
  });

  it('breaks at the quarter past nine, half twelve and quarter past three', () => {
    expect(BREAKS.map((b) => [b.from, b.to])).toEqual([
      [at(9), at(9, 15)],
      [at(12), at(12, 30)],
      [at(15, 15), at(15, 30)],
    ]);
  });

  it('leaves three stretches of work with nothing listed twice', () => {
    expect(WORK_SEGMENTS.map((s) => [s.from, s.to])).toEqual([
      [at(7), at(9)],
      [at(9, 15), at(12)],
      [at(12, 30), at(15, 15)],
    ]);
  });

  /*
   * The load-bearing one. Every duration on this board divides an order's
   * standard hours by PRODUCTIVE_HOURS_PER_PERSON, and every bar is drawn from
   * the clock. Move a break without this holding and the board plans to a
   * different day than it draws.
   */
  it('and they add up to the 7.5 hours the rest of the board plans with', () => {
    expect(PRODUCTIVE_MINUTES).toBe(450);
    expect(PRODUCTIVE_MINUTES).toBe(PRODUCTIVE_HOURS_PER_PERSON * 60);
  });
});

describe('what time it is after so much work', () => {
  const clock = (worked: number) => {
    const m = clockAtWorkMinutes(worked);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  it('starts at 07:00', () => expect(clock(0)).toBe('07:00'));

  it('runs straight to morning tea', () => {
    expect(clock(60)).toBe('08:00');
    // Two hours of work ends when they stop, not when they come back.
    expect(clock(120)).toBe('09:00');
  });

  it('steps over the break rather than through it', () => {
    // A quarter of an hour past the two is 09:30: the urn took the first one.
    expect(clock(135)).toBe('09:30');
  });

  it('steps over lunch too', () => {
    // 07:00–09:00 and 09:15–12:00 is 285 minutes of work, ending at noon.
    expect(clock(285)).toBe('12:00');
    expect(clock(286)).toBe('12:31');
  });

  it('ends the day at 15:15, never at 15:30', () => {
    expect(clock(PRODUCTIVE_MINUTES)).toBe('15:15');
    // Nothing can be worked past the end of the shift.
    expect(clock(PRODUCTIVE_MINUTES + 90)).toBe('15:15');
  });

  it('and refuses to run backwards out of the morning', () => {
    expect(clock(-30)).toBe('07:00');
  });
});

describe('how much work an instant has behind it', () => {
  it('is nothing before the crew clock on', () => {
    expect(workMinutesAtClock(at(6))).toBe(0);
    expect(workMinutesAtClock(at(7))).toBe(0);
  });

  it('counts only the stretches they were on the job', () => {
    expect(workMinutesAtClock(at(9))).toBe(120);
    // Standing at the urn buys no capacity.
    expect(workMinutesAtClock(at(9, 10))).toBe(120);
    expect(workMinutesAtClock(at(9, 15))).toBe(120);
    expect(workMinutesAtClock(at(10))).toBe(165);
  });

  it('is a full day by the time the shift closes', () => {
    expect(workMinutesAtClock(at(15, 15))).toBe(PRODUCTIVE_MINUTES);
    expect(workMinutesAtClock(at(23))).toBe(PRODUCTIVE_MINUTES);
  });

  it('and is the exact inverse of the clock, break for break', () => {
    for (let worked = 0; worked <= PRODUCTIVE_MINUTES; worked += 5) {
      expect(workMinutesAtClock(clockAtWorkMinutes(worked)), `${worked} min`)
        .toBe(worked);
    }
  });
});

describe('a day plan turned into a time', () => {
  it('reads off a fraction of the shift the way the planner writes one', () => {
    expect(formatTime(shiftClockAt(DAY, 0))).toBe(formatTime(on(7)));
    // Half a day's work is 225 minutes: two hours to morning tea, then an
    // hour and three quarters of the long stretch after it.
    expect(formatTime(shiftClockAt(DAY, 0.5))).toBe(formatTime(on(11)));
    expect(formatTime(shiftClockAt(DAY, 1))).toBe(formatTime(on(15, 15)));
  });

  it('and comes back as the same fraction', () => {
    for (const fraction of [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1]) {
      expect(workFractionAt(shiftClockAt(DAY, fraction)), `${fraction}`)
        .toBeCloseTo(fraction, 2);
    }
  });

  it('gives a moment in a break the work before it and no more', () => {
    expect(workFractionAt(on(12, 20))).toBeCloseTo(285 / PRODUCTIVE_MINUTES, 6);
  });
});

describe('where that lands in the column', () => {
  it('is 0 when the crew clock on and 1 when they leave', () => {
    expect(shiftColumnFraction(on(7))).toBe(0);
    expect(shiftColumnFraction(on(15, 30))).toBe(1);
  });

  it('pins to the edges rather than wandering into the night', () => {
    expect(shiftColumnFraction(on(3))).toBe(0);
    expect(shiftColumnFraction(on(22))).toBe(1);
  });

  /*
   * The measure is the shift as the floor stands in it, not the work in it: an
   * order that stops for lunch still occupies the half hour lunch takes, so
   * the two bars either side of it do not close up over a break nobody worked.
   */
  it('keeps the width a break takes', () => {
    expect(shiftColumnFraction(on(12))).toBeCloseTo(300 / 510, 6);
    expect(shiftColumnFraction(on(12, 30))).toBeCloseTo(330 / 510, 6);
  });

  it('leaves the last quarter of an hour outside the work', () => {
    // Work ends at 15:15 and the column runs to 15:30.
    expect(shiftColumnFraction(on(15, 15))).toBeCloseTo(495 / 510, 6);
  });
});

describe('naming the break a bar is sitting in', () => {
  it('names the one covering the moment', () => {
    expect(breakAt(on(9, 5))?.name).toBe('Morning tea');
    expect(breakAt(on(12, 29))?.name).toBe('Lunch');
    expect(breakAt(on(15, 20))?.name).toBe('Afternoon tea');
  });

  it('and nothing while they are working', () => {
    expect(breakAt(on(8))).toBeNull();
    // The moment a break ends they are back on the job.
    expect(breakAt(on(9, 15))).toBeNull();
  });
});

/**
 * The same fraction, asked the other way round.
 *
 * A capacity measure cannot tell the moment they put their tools down from the
 * moment they pick them up again, and on a break boundary those are half an
 * hour apart. Ends ask when work reached the fraction; starts ask when it
 * resumes there.
 */
describe('when work can start again', () => {
  it('is the moment itself while they are on the job', () => {
    expect(nextWorkingMoment(on(10, 30))).toEqual(on(10, 30));
  });

  it('is the end of the break they are standing in', () => {
    expect(nextWorkingMoment(on(9, 1))).toEqual(on(9, 15));
    expect(nextWorkingMoment(on(12, 11))).toEqual(on(12, 30));
  });

  it('is seven in the morning before anybody is in', () => {
    expect(nextWorkingMoment(on(4))).toEqual(on(7));
    expect(nextWorkingMoment(on(7))).toEqual(on(7));
  });

  it('is the end of the day once the day is over', () => {
    expect(nextWorkingMoment(on(15, 20))).toEqual(on(15, 15));
    expect(nextWorkingMoment(on(20))).toEqual(on(15, 15));
  });

  it('parts from the finishing time on a break boundary and nowhere else', () => {
    // Two hours in: they stop at 09:00, and the next order has 09:15.
    expect(formatTime(shiftClockAt(DAY, 120 / PRODUCTIVE_MINUTES))).toBe(formatTime(on(9)));
    expect(formatTime(shiftStartAt(DAY, 120 / PRODUCTIVE_MINUTES))).toBe(formatTime(on(9, 15)));
    // Mid-stretch the two are the same moment, which is what a hand-over is.
    expect(shiftStartAt(DAY, 0.5)).toEqual(shiftClockAt(DAY, 0.5));
  });
});
