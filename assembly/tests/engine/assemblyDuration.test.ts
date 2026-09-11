import { describe, it, expect } from 'vitest';
import {
  completedFraction,
  crewNeededFor,
  dailyTargetQty,
  durationDays,
  latestStart,
  remainingHours,
} from '@/engine/assembly/duration';
import {
  MAX_WORKERS_PER_ORDER,
  PRODUCTIVE_HOURS_PER_PERSON,
  SHIFT_END_HOUR,
  SHIFT_START_HOUR,
} from '@/domain/assembly';
import { JobId, PartId } from '@/domain/ids';
import type { Job } from '@/domain/types';

const job = (laborHrs: number, remaining: number, done = 0): Job => ({
  id: JobId('ASM1'),
  department: 'assembly',
  partNum: PartId('X'),
  description: '',
  remainingQty: remaining,
  qtyPerHr: null,
  laborHrs,
  dueDate: null,
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'upholstery',
  line: null,
  completedQty: done,
  predecessors: [],
  assignedWorkers: [],
});

describe('assembly duration', () => {
  it('halves the duration when the crew doubles', () => {
    const j = job(29, 60);
    const one = durationDays(j, 1)!;
    const two = durationDays(j, 2)!;
    expect(two).toBeCloseTo(one / 2);
    expect(one).toBeCloseTo(29 / PRODUCTIVE_HOURS_PER_PERSON);
  });

  it('cannot be scheduled with nobody on it', () => {
    expect(durationDays(job(29, 60), 0)).toBeNull();
  });

  it('ignores crew beyond the four-person cap', () => {
    const j = job(40, 100);
    expect(durationDays(j, 9)).toBeCloseTo(
      durationDays(j, MAX_WORKERS_PER_ORDER)!,
    );
  });

  it('shrinks the remaining work as output is booked', () => {
    // 40 of 100 done → 60% of the hours left.
    const j = job(50, 60, 40);
    expect(completedFraction(j)).toBeCloseTo(0.4);
    expect(remainingHours(j)).toBeCloseTo(30);
  });

  it('is finished when nothing is left', () => {
    const j = job(50, 0, 100);
    expect(remainingHours(j)).toBe(0);
    expect(durationDays(j, 2)).toBe(0);
  });

  it('derives the daily target from the crew', () => {
    const j = job(29, 60);
    const perDay = dailyTargetQty(j, 2);
    const days = durationDays(j, 2)!;
    expect(perDay * days).toBeCloseTo(60);
  });

  it('says how many people would hit a deadline', () => {
    const j = job(29, 60); // ~4 person-days of work
    expect(crewNeededFor(j, 4)).toBe(1);
    expect(crewNeededFor(j, 1)).toBe(4);
    // Not reachable inside the cap.
    expect(crewNeededFor(job(200, 400), 1)).toBeNull();
  });
});

/**
 * The board's own Start Date: the due date less the work, counted back over
 * open days at 7.5 productive hours a person a day — and landing on the shift
 * clock, because a start nobody can be on the floor for is not a start.
 *
 * The due date's own shift is the last one the work may run on: finishing
 * during the day the customer asked for is on time. An order due on a weekend
 * has to be finished by the Friday, there being no shift to use.
 */
describe('latestStart', () => {
  const due = (n: number) => new Date(2026, 8, n);
  /** A moment on 8 Sep + `n` days, at `h` o'clock. */
  const at = (n: number, h: number, m = 0) => new Date(2026, 8, n, h, m);
  /** Ten units carrying `hours` of work, none of it done. */
  const order = (hours: number) => job(hours, 10);

  it('counts back a whole number of days, to the top of a shift', () => {
    // Three days of work for one person, due Thursday 10 Sep. Thursday is
    // itself the last day it can run on — Tue, Wed, Thu.
    const j = order(3 * PRODUCTIVE_HOURS_PER_PERSON);
    expect(latestStart(j, 1, due(10))).toEqual(at(8, SHIFT_START_HOUR));
  });

  it('steps over the weekend on the way back', () => {
    // Two days of work due Tuesday 8 Sep: the Tuesday itself and the Monday.
    const j = order(2 * PRODUCTIVE_HOURS_PER_PERSON);
    expect(latestStart(j, 1, due(8))).toEqual(at(7, SHIFT_START_HOUR));

    // Due on the Sunday, though, there is no shift to finish on: the last one
    // going is the Friday, so two days back is the Thursday.
    expect(latestStart(j, 1, due(13))).toEqual(at(10, SHIFT_START_HOUR));
  });

  it('halves the wait when a second person is on it', () => {
    const j = order(4 * PRODUCTIVE_HOURS_PER_PERSON);
    expect(latestStart(j, 1, due(11))).toEqual(at(8, SHIFT_START_HOUR));
    expect(latestStart(j, 2, due(11))).toEqual(at(10, SHIFT_START_HOUR));
  });

  it('counts only the work still to do', () => {
    // Half the units finished, so half the hours are behind us.
    const half = {
      ...order(4 * PRODUCTIVE_HOURS_PER_PERSON),
      remainingQty: 5,
      completedQty: 5,
    };
    expect(latestStart(half, 1, due(11))).toEqual(at(10, SHIFT_START_HOUR));
  });

  it('puts part of a day at the hour it has to begin', () => {
    // Three productive hours — 0.4 of a day — due Thursday 10 Sep. It has to
    // be on the bench with three working hours of Thursday left, and the clock
    // is what says when that is: a quarter of an hour before lunch, then the
    // two and three quarters after it. Spread evenly across the shift instead
    // the answer was 12:06, which is in the middle of lunch and leaves 2.75 h.
    const j = order(0.4 * PRODUCTIVE_HOURS_PER_PERSON);
    expect(latestStart(j, 1, due(10))).toEqual(at(10, 11, 45));
  });

  it('never lands outside the shift, whatever the work comes to', () => {
    for (const hours of [0.1, 1, 3.3, 7.4, 7.5, 12, 30, 61.7]) {
      const when = latestStart(order(hours), 1, due(30))!;
      const clock = when.getHours() + when.getMinutes() / 60;
      expect(clock, `${hours} h`).toBeGreaterThanOrEqual(SHIFT_START_HOUR);
      expect(clock, `${hours} h`).toBeLessThanOrEqual(SHIFT_END_HOUR);
    }
  });

  it('has no answer with nobody on the order', () => {
    // No crew, no rate to count back at.
    expect(latestStart(order(20), 0, due(10))).toBeNull();
  });

  it('leaves an order with no work left until its due date closes', () => {
    const done = { ...order(20), remainingQty: 0, completedQty: 10 };
    // The last moment work can be booked, which is when the crew stop rather
    // than when they walk out — the quarter to four is putting the bench away.
    expect(latestStart(done, 1, due(10))).toEqual(at(10, 15, 15));
  });
});
