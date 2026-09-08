import { describe, expect, it } from 'vitest';
import { PRODUCTIVE_HOURS_PER_PERSON } from '@/domain/assembly';
import { planVariableCrew } from '@/engine/assembly/crewSchedule';

describe('date-bounded crew capacity', () => {
  it('lets Bill help an earlier order for 2/9–3/9, then leave for the next job', () => {
    const plan = planVariableCrew(
      new Date('2026-09-02T00:00:00'),
      58,
      [
        { workerId: 'Mary', fromDay: null, toDayExclusive: null },
        {
          workerId: 'Bill',
          fromDay: '2026-09-02',
          toDayExclusive: '2026-09-04',
        },
        {
          workerId: 'Jones',
          fromDay: '2026-09-04',
          toDayExclusive: null,
        },
      ],
      false,
    );

    expect(plan.expectDate).not.toBeNull();
    expect(
      plan.crewDays
        .filter((day) => day.workerIds.includes('Bill'))
        .map((day) => day.day),
    ).toEqual(['2026-09-02', '2026-09-03']);
    expect(
      plan.crewDays
        .filter((day) => day.workerIds.includes('Jones'))
        .map((day) => day.day),
    ).toContain('2026-09-04');
    expect(plan.uncoveredHours).toBe(0);
  });

  it('pauses with no Expect Date when a bounded helper leaves work uncovered', () => {
    const plan = planVariableCrew(
      new Date('2026-09-02T00:00:00'),
      20,
      [
        {
          workerId: 'Bill',
          fromDay: '2026-09-02',
          toDayExclusive: '2026-09-04',
        },
      ],
      false,
    );

    expect(plan.crewDays.map((day) => day.day)).toEqual([
      '2026-09-02',
      '2026-09-03',
    ]);
    expect(plan.expectDate).toBeNull();
    // Two covered days of the twenty hours; the rest has nobody on it.
    expect(plan.uncoveredHours).toBeCloseTo(
      20 - 2 * PRODUCTIVE_HOURS_PER_PERSON,
      6,
    );
    expect(plan.coveredUntil).toEqual(new Date('2026-09-04T00:00:00'));
  });
});

/*
 * The clocks change on a Sunday and the factory is shut for it, so no shift
 * ever gains or loses the hour. What the plan used to lose was the step over
 * that Sunday: every day after it came out an hour short of midnight, and the
 * Expect Date — and with it the moment the crew came free — drifted with them.
 */
describe('planning across the day the clocks change', () => {
  const crewOf = (...ids: string[]) =>
    ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null }));

  const runs = (from: string, shifts: number) =>
    planVariableCrew(
      new Date(`${from}T00:00:00`),
      PRODUCTIVE_HOURS_PER_PERSON * 3 * shifts,
      crewOf('a', 'b', 'c'),
      false,
    );

  it('opens every shift at midnight either side of the April change', () => {
    const plan = runs('2026-04-03', 6);
    expect(plan.crewDays.map((day) => day.day)).toEqual([
      '2026-04-03',
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
      '2026-04-09',
      '2026-04-10',
    ]);
    for (const day of plan.crewDays) {
      expect(day.date.getHours()).toBe(0);
      expect(day.date.getMinutes()).toBe(0);
    }
  });

  it('finishes on the midnight that ends the last shift, not an hour before', () => {
    // Six full shifts from Friday 3 April end where Friday 10 April ends.
    expect(runs('2026-04-03', 6).expectDate).toEqual(
      new Date('2026-04-11T00:00:00'),
    );
    // And the same across October, when the hour goes the other way.
    expect(runs('2026-10-02', 6).expectDate).toEqual(
      new Date('2026-10-10T00:00:00'),
    );
  });

  it('opens every shift at midnight either side of the October change', () => {
    const plan = runs('2026-10-02', 6);
    expect(plan.crewDays.map((day) => day.day)).toEqual([
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    for (const day of plan.crewDays) expect(day.date.getHours()).toBe(0);
  });
});
