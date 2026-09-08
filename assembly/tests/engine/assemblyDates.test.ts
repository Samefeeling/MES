import { describe, it, expect } from 'vitest';
import {
  addWorkingDays,
  isWeekend,
  nextMidnight,
  nextWorkingDay,
  prevMidnight,
  prevWorkingDay,
  scheduleStatus,
  shiftFraction,
  wholeDaysBetween,
  workingSpans,
} from '@/engine/assembly/dates';

const d = (s: string) => new Date(`${s}T00:00:00`);

/** Tue 15 Sep 2026 is the day the customer asked for. */
const DUE = d('2026-09-15');

/**
 * An Expect Date is an *exclusive* end: work that fills Tuesday ends at
 * Wednesday midnight. So "finished on the due date" is anything up to and
 * including the moment the due date closes, and the comparison has to be
 * against that moment rather than against the due date's own midnight.
 */
describe('schedule colour bands', () => {
  it('is green with days to spare', () => {
    expect(scheduleStatus(d('2026-09-09'), DUE).color).toBe('green');
    expect(scheduleStatus(d('2026-09-14'), DUE).color).toBe('green');
  });

  it('is green when the work finishes on the due date itself', () => {
    // Part-way through the day…
    expect(
      scheduleStatus(new Date('2026-09-15T14:00:00'), DUE).color,
    ).toBe('green');
    // …and filling the whole of it, which ends at the next midnight.
    expect(scheduleStatus(d('2026-09-16'), DUE).color).toBe('green');
    // The due date's own midnight is the work of the day before ending.
    expect(scheduleStatus(DUE, DUE).color).toBe('green');
  });

  it('is red only once it runs past the due date', () => {
    expect(
      scheduleStatus(new Date('2026-09-16T07:30:00'), DUE).color,
    ).toBe('red');
    expect(scheduleStatus(d('2026-09-17'), DUE).color).toBe('red');
    expect(scheduleStatus(d('2026-09-20'), DUE).color).toBe('red');
  });

  it('bands are exhaustive and never overlap', () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 25; i++) {
      const expect_ = d(`2026-09-${String(i).padStart(2, '0')}`);
      const s = scheduleStatus(expect_, DUE);
      expect(['green', 'red']).toContain(s.color);
      seen.add(s.color);
    }
    expect(seen).toEqual(new Set(['green', 'red']));
  });

  it('reports slack against the close of the due date', () => {
    // Finishing as Sunday the 13th ends is two days clear of Tuesday's close.
    expect(scheduleStatus(d('2026-09-14'), DUE).dueSlackDays).toBe(-2);
    // Filling the due date exactly leaves none, and is still on time.
    expect(scheduleStatus(d('2026-09-16'), DUE).dueSlackDays).toBe(0);
    expect(scheduleStatus(d('2026-09-18'), DUE).dueSlackDays).toBe(2);
  });

  it('is grey when it cannot be judged', () => {
    expect(scheduleStatus(null, DUE).color).toBe('grey');
    expect(scheduleStatus(d('2026-09-12'), null).color).toBe('grey');
    expect(scheduleStatus(d('2026-09-12'), null).reason).toContain('due date');
  });

  it('counts whole days regardless of time of day', () => {
    expect(
      wholeDaysBetween(new Date('2026-09-13T23:00:00'), new Date('2026-09-11T01:00:00')),
    ).toBe(2);
  });
});

/**
 * The shift calendar. Mon 14 Sep 2026 … Fri 18, then Sat 19 / Sun 20 closed,
 * Mon 21 open again.
 */
describe('the working week', () => {
  const MON = d('2026-09-14');
  const FRI = d('2026-09-18');
  const SAT = d('2026-09-19');
  const SUN = d('2026-09-20');
  const NEXT_MON = d('2026-09-21');

  it('knows which days the factory is shut', () => {
    expect(isWeekend(FRI)).toBe(false);
    expect(isWeekend(SAT)).toBe(true);
    expect(isWeekend(SUN)).toBe(true);
    expect(isWeekend(NEXT_MON)).toBe(false);
  });

  it('leaves a weekday alone and pulls a weekend to the Monday', () => {
    expect(nextWorkingDay(FRI)).toEqual(FRI);
    expect(nextWorkingDay(SAT)).toEqual(NEXT_MON);
    expect(nextWorkingDay(SUN)).toEqual(NEXT_MON);
    // Part-way through a closed Saturday still means Monday morning.
    expect(nextWorkingDay(new Date('2026-09-19T14:30:00'))).toEqual(NEXT_MON);
  });

  it('steps a duration over the weekend', () => {
    // Five days from Monday fills the week exactly.
    expect(addWorkingDays(MON, 5)).toEqual(SAT);
    // Three days from Thursday: Thu, Fri, then Monday.
    expect(addWorkingDays(d('2026-09-17'), 3)).toEqual(d('2026-09-22'));
    // A whole week of work is seven weekdays, so it lands on the Wednesday.
    expect(addWorkingDays(MON, 7)).toEqual(d('2026-09-23'));
  });

  it('carries a part-day over the closed days rather than into them', () => {
    // Friday noon leaves half a day of Friday: work needing more than that
    // resumes on the Monday, not on the Saturday.
    const overrun = addWorkingDays(new Date('2026-09-18T12:00:00'), 0.75);
    expect(overrun).toEqual(new Date('2026-09-21T06:00:00'));
    // Work that fits in what is left of Friday ends where Friday ends.
    expect(addWorkingDays(new Date('2026-09-18T12:00:00'), 0.5)).toEqual(SAT);
    // A quarter of a day started Friday morning stays on the Friday.
    expect(addWorkingDays(FRI, 0.25)).toEqual(new Date('2026-09-18T06:00:00'));
  });

  it('treats a zero or negative duration as no time at all', () => {
    expect(addWorkingDays(SAT, 0)).toEqual(SAT);
    expect(addWorkingDays(MON, -3)).toEqual(MON);
  });
});

describe('the day before, and the hour of the day', () => {
  const MON = d('2026-09-14');
  const TUE = d('2026-09-15');
  const FRI = d('2026-09-11');
  const SAT = d('2026-09-12');
  const SUN = d('2026-09-13');

  it('steps back one day in the middle of the week', () => {
    expect(prevWorkingDay(TUE)).toEqual(MON);
  });

  it('reaches back over the weekend from a Monday', () => {
    // The shift a Monday morning is asked about is Friday's, not Sunday's.
    expect(prevWorkingDay(MON)).toEqual(FRI);
    expect(prevWorkingDay(SAT)).toEqual(FRI);
    expect(prevWorkingDay(SUN)).toEqual(FRI);
  });

  it('drops the time of day rather than carrying it back', () => {
    expect(prevWorkingDay(new Date('2026-09-15T14:30:00'))).toEqual(MON);
  });

  it('places the hour inside the shift', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 15, h, m);
    // 07:00–15:30, so 11:15 is halfway.
    expect(shiftFraction(at(11, 15), 7, 15.5)).toBeCloseTo(0.5, 6);
    expect(shiftFraction(at(7), 7, 15.5)).toBe(0);
    expect(shiftFraction(at(15, 30), 7, 15.5)).toBe(1);
  });

  it('pins to the edge outside the shift instead of running off the column', () => {
    const at = (h: number) => new Date(2026, 8, 15, h);
    // Before the crew clock on, and long after they have gone home.
    expect(shiftFraction(at(3), 7, 15.5)).toBe(0);
    expect(shiftFraction(at(22), 7, 15.5)).toBe(1);
  });
});

describe('drawing a bar across the closed days', () => {
  const THU = d('2026-09-10');
  const FRI = d('2026-09-11');
  const SAT = d('2026-09-12');
  const MON = d('2026-09-14');
  const TUE = d('2026-09-15');

  it('is one stretch when the work never reaches a weekend', () => {
    const spans = workingSpans(THU, SAT);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ from: THU, to: SAT, workedBefore: 0, worked: 2 });
  });

  it('breaks over the weekend and keeps the worked days on either side', () => {
    // Three days of work from a Thursday: Thu, Fri, then Monday.
    const spans = workingSpans(THU, TUE);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ from: THU, to: SAT, worked: 2, workedBefore: 0 });
    expect(spans[1]).toMatchObject({ from: MON, to: TUE, worked: 1, workedBefore: 2 });
    // The stretches account for the whole order, no more and no less.
    expect(spans.reduce((s, p) => s + p.worked, 0)).toBeCloseTo(3, 6);
  });

  it('keeps a part-day on the right side of the break', () => {
    // Friday noon to Monday 06:00: half of Friday, then a quarter of Monday.
    const spans = workingSpans(new Date('2026-09-11T12:00:00'), new Date('2026-09-14T06:00:00'));
    expect(spans).toHaveLength(2);
    expect(spans[0].worked).toBeCloseTo(0.5, 6);
    expect(spans[1].worked).toBeCloseTo(0.25, 6);
    expect(spans[1].workedBefore).toBeCloseTo(0.5, 6);
  });

  it('runs an approved weekend straight through as one block', () => {
    const spans = workingSpans(FRI, TUE, true);
    expect(spans).toHaveLength(1);
    expect(spans[0].worked).toBeCloseTo(4, 6);
  });

  it('draws nothing for an order with no span left', () => {
    expect(workingSpans(MON, MON)).toEqual([]);
    expect(workingSpans(TUE, MON)).toEqual([]);
  });

  it('skips a weekend it merely starts on', () => {
    // Nothing is worked on the Saturday, so the first stretch is the Monday.
    const spans = workingSpans(SAT, TUE);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ from: MON, to: TUE, worked: 1 });
  });
});

/** The same arithmetic run backwards — how a start date comes off a due date. */
/*
 * The clocks change on a Sunday, which the factory is shut for — so the shift
 * that gains or loses the hour is never worked. What used to go wrong was the
 * step *over* that Sunday: adding a flat twenty-four hours to a day the clock
 * gave twenty-five landed an hour short of midnight, and every day after it
 * inherited the hour. A week later the bar was drawn most of a column long.
 *
 * Australia and New Zealand both switch on a Sunday, and CI runs this file in
 * both zones, so the dates below are chosen to straddle each transition:
 * Sun 5 Apr 2026 (AEDT→AEST, NZDT→NZST) and Sun 4 Oct 2026 (AEST→AEDT).
 */
describe('crossing the day the clocks change', () => {
  const midnights = (from: Date, count: number): Date[] => {
    const out: Date[] = [];
    let cursor = from;
    for (let i = 0; i < count; i++) {
      out.push(cursor);
      cursor = nextMidnight(cursor);
    }
    return out;
  };

  it('steps from midnight to midnight either side of a transition', () => {
    for (const start of [d('2026-04-02'), d('2026-10-01')]) {
      for (const day of midnights(start, 10)) {
        expect(day.getHours()).toBe(0);
        expect(day.getMinutes()).toBe(0);
      }
    }
  });

  it('walks back to midnight just the same', () => {
    let cursor = d('2026-04-10');
    for (let i = 0; i < 10; i++) {
      cursor = prevMidnight(cursor);
      expect(cursor.getHours()).toBe(0);
    }
  });

  it('lands whole working days on midnight across the April change', () => {
    // Thu 2 Apr plus five open days: Fri, then Mon–Thu the week after.
    expect(addWorkingDays(d('2026-04-02'), 5)).toEqual(d('2026-04-09'));
    // And one that steps over the Sunday itself: Friday, then Monday, so it
    // ends where Monday ends. An hour adrift and this would be Monday 23:00.
    expect(addWorkingDays(d('2026-04-03'), 2)).toEqual(d('2026-04-07'));
  });

  it('lands whole working days on midnight across the October change', () => {
    expect(addWorkingDays(d('2026-10-01'), 5)).toEqual(d('2026-10-08'));
    expect(addWorkingDays(d('2026-10-02'), 2)).toEqual(d('2026-10-06'));
  });

  it('keeps a bar drawn over a transition an exact number of days long', () => {
    const spans = workingSpans(d('2026-04-03'), d('2026-04-11'));
    const worked = spans.reduce((sum, span) => sum + span.worked, 0);
    // Friday, then Monday to Friday: six open days, not six and an hour.
    expect(worked).toBeCloseTo(6, 6);
  });
});
