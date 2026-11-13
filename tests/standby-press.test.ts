import { describe, expect, it } from 'vitest';
import { attainmentOfTuples, withStandbyPress, type AttainmentTuple } from '../src/core/kpi-attainment';
import { pressOperatorsByShift } from '../src/core/crew';
import { rec } from './helpers';
import type { ProductionRecord } from '../src/types';

const SHIFT = '2026-11-16-Day';

/** One press's line for a shift: `plan` standard hours asked, `earned` made. */
const press = (machineCode: string, plan: number, earned: number, over: Partial<AttainmentTuple> = {}): AttainmentTuple => ({
  machineCode, shiftId: SHIFT, jobNumber: 'J-' + machineCode,
  planned: plan * 10, good: earned * 10, credited: earned * 10, source: 'schedule',
  plannedHrs: plan, creditedHrs: earned, ...over,
});
const operators = (n: number) => (): number => n;
const pct = (lines: AttainmentTuple[]): number | null => attainmentOfTuples(lines).pct;
const standbyOf = (lines: AttainmentTuple[]): string[] => lines.filter((l) => l.standby).map((l) => l.machineCode);

describe('the standby press of a shift is not held to its plan', () => {
  // Planning loads five presses, 7 standard hours each; one is the standby.
  const four = [press('P1', 7, 7), press('P2', 7, 7), press('P3', 7, 7), press('P4', 7, 7)];

  it('four operators, five presses planned: the one never started is the standby', () => {
    const lines = [...four, press('S', 7, 0)];
    expect(pct(lines)).toBe(80); // held to all five
    const judged = withStandbyPress(lines, operators(4));
    expect(standbyOf(judged)).toEqual(['S']);
    expect(attainmentOfTuples(judged)).toMatchObject({ pct: 100, plannedHrs: 28, creditedHrs: 28, total: 4, covered: 4 });
  });

  it('five operators for five presses: every press is held to its plan', () => {
    const lines = [...four, press('S', 7, 0)];
    const judged = withStandbyPress(lines, operators(5));
    expect(standbyOf(judged)).toEqual([]);
    expect(pct(judged)).toBe(80);
  });

  it('a press down with nobody moving to the standby still costs the shift', () => {
    // P1 made nothing and the standby was never started: one of the two is
    // let off, the other is a press the plan asked for and did not get.
    const lines = [press('P1', 7, 0), ...four.slice(1), press('S', 7, 0)];
    const judged = withStandbyPress(lines, operators(4));
    expect(standbyOf(judged)).toHaveLength(1);
    expect(pct(judged)).toBe(75);
  });

  it('the crew moved to the standby: both presses\' output counts, to 100 % and no further', () => {
    // P1 earned 2 h and stopped; its operator earned 5 h on the standby.
    const lines = [press('P1', 7, 2), ...four.slice(1), press('S', 7, 5)];
    expect(pct(lines)).toBe(80); // 28 of 35
    const judged = withStandbyPress(lines, operators(4));
    expect(standbyOf(judged)).toEqual(['P1']); // whichever made less
    expect(attainmentOfTuples(judged)).toMatchObject({ pct: 100, plannedHrs: 28, creditedHrs: 28 });
  });

  it('what the standby made counts only against what the others fell short by', () => {
    // Everybody made plan and a fifth pair of hands ran the standby for 3 h
    // without being on record as an operator: nothing to make up.
    const lines = [...four, press('S', 7, 3)];
    const judged = withStandbyPress(lines, operators(4));
    expect(attainmentOfTuples(judged)).toMatchObject({ pct: 100, plannedHrs: 28, creditedHrs: 28 });
    // P2 fell 1 h short: 1 of the standby's 3 h makes it up.
    const short = [press('P1', 7, 7), press('P2', 7, 6), press('P3', 7, 7), press('P4', 7, 7), press('S', 7, 3)];
    expect(attainmentOfTuples(withStandbyPress(short, operators(4)))).toMatchObject({ pct: 100, creditedHrs: 28 });
  });

  it('one press a shift at most: a shift two people short is short', () => {
    // Three operators for five planned presses.
    const lines = [press('P1', 7, 7), press('P2', 7, 7), press('P3', 7, 7), press('P4', 7, 0), press('S', 7, 0)];
    const judged = withStandbyPress(lines, operators(3));
    expect(standbyOf(judged)).toHaveLength(1);
    expect(pct(judged)).toBe(75); // 21 of 28
  });

  it('judges each shift on its own people', () => {
    const next = '2026-11-16-Afternoon';
    const lines = [
      ...four, press('S', 7, 0),
      ...[...four, press('S', 7, 0)].map((l) => ({ ...l, shiftId: next })),
    ];
    const judged = withStandbyPress(lines, (shiftId) => (shiftId === SHIFT ? 4 : 5));
    expect(judged.filter((l) => l.standby).map((l) => l.shiftId)).toEqual([SHIFT]);
    expect(attainmentOfTuples(judged)).toMatchObject({ plannedHrs: 63, creditedHrs: 56 });
  });

  it('leaves a shift nobody has signed alone, and a press awaiting sign-off is not the standby', () => {
    const lines = [...four, press('S', 7, 0)];
    expect(standbyOf(withStandbyPress(lines, operators(0)))).toEqual([]);
    // Three sheets signed (3 operators), P4 booked and not signed yet: it
    // has a crew, so five presses for 3 + 1 people leaves S the standby.
    const waiting = [...four.slice(0, 3), press('P4', 7, 0, { unsigned: true }), press('S', 7, 0)];
    const judged = withStandbyPress(waiting, operators(3));
    expect(standbyOf(judged)).toEqual(['S']);
    expect(pct(judged)).toBe(75); // P4 counts, nothing credited until signed
  });

  it('output on a press with nothing planned is no part of it', () => {
    const extra: AttainmentTuple = {
      machineCode: 'X', shiftId: SHIFT, jobNumber: 'J-X', planned: 0, good: 50, credited: 0, source: 'unscheduled',
    };
    const judged = withStandbyPress([...four, press('S', 7, 0), extra], operators(4));
    expect(standbyOf(judged)).toEqual(['S']);
    expect(judged.find((l) => l.machineCode === 'X')).toEqual(extra);
  });

  it('a press that ran on a plan nobody can price is never picked as the standby', () => {
    const unpriced = press('P4', 7, 0, { plannedHrs: null, creditedHrs: 0, good: 60, credited: 60 });
    const judged = withStandbyPress([...four.slice(0, 3), unpriced, press('S', 7, 0)], operators(4));
    expect(standbyOf(judged)).toEqual(['S']);
  });

  it('works in pieces where the lines carry no hours', () => {
    const pieces = (machineCode: string, planned: number, good: number): AttainmentTuple => ({
      machineCode, shiftId: SHIFT, jobNumber: 'J-' + machineCode, planned, good, credited: Math.min(good, planned), source: 'schedule',
    });
    const lines = [pieces('P1', 100, 40), pieces('P2', 100, 100), pieces('S', 100, 30)];
    const judged = withStandbyPress(lines, operators(2));
    expect(standbyOf(judged)).toEqual(['S']);
    expect(attainmentOfTuples(judged)).toMatchObject({ pct: 85, expected: 200, actual: 170 });
  });
});

describe('the people a shift had for its planned presses', () => {
  /** A signed sheet under supervisor Tin: `status` on its half-hours. */
  const sheet = (machineCode: string, operator: string, status: ProductionRecord['statusCode'] = 'R'): ProductionRecord[] =>
    [0, 2, 3].map((slotIndex) =>
      rec({
        machineCode, shiftId: SHIFT, jobNumber: 'J-' + machineCode, slotIndex, statusCode: status,
        operator: slotIndex === 0 ? operator : '', supervisor: 'Tin', lockedBy: 'Tin', qcBy: operator,
      }));
  const judge = (lines: AttainmentTuple[], records: ProductionRecord[]): AttainmentTuple[] => {
    const people = pressOperatorsByShift(records);
    return withStandbyPress(lines, (shiftId, planned) =>
      (people.get(shiftId) ?? []).filter((o) => o.presses.some((p) => planned.has(p))).length);
  };
  // Four presses planned; the hot stamp runs parts that carry no plan.
  const lines = [
    press('1600T', 6, 5.6), press('BATT1', 3, 0), press('BATT2', 8, 7.8), press('550T', 8, 3.8),
    { machineCode: 'HSTAMP', shiftId: SHIFT, jobNumber: 'J-HSTAMP', planned: 0, good: 56, credited: 0, source: 'unscheduled' } as AttainmentTuple,
  ];
  const running = [...sheet('1600T', 'Gabriel'), ...sheet('Batt2', 'Tony'), ...sheet('550T', 'Miley'), ...sheet('HStamp', 'John')];

  it('five people, one the supervisor relieving breaks: the press only he touched is the standby', () => {
    // Tin changed the die on Batt1 and ran nothing; John is on the hot stamp.
    const judged = judge(lines, [...running, ...sheet('Batt1', 'Tin', 'D')]);
    expect(pct(lines)).toBe(69); // 17.2 of 25, Batt1 held to its plan
    expect(standbyOf(judged)).toEqual(['BATT1']);
    expect(attainmentOfTuples(judged)).toMatchObject({ pct: 78, plannedHrs: 22 }); // 17.2 of 22
  });

  it('an operator of his own on that press: it had a crew, and is held to its plan', () => {
    const judged = judge(lines, [...running, ...sheet('Batt1', 'Phong', 'D')]);
    expect(standbyOf(judged)).toEqual([]);
    expect(pct(judged)).toBe(69);
  });

  it('the supervisor ran it: one more person, no standby', () => {
    const judged = judge(lines, [...running, ...sheet('Batt1', 'Tin', 'D'), ...sheet('Batt1', 'Tin').map((r) => ({ ...r, slotIndex: r.slotIndex + 8 }))]);
    expect(standbyOf(judged)).toEqual([]);
  });

  it('somebody on a press with no plan is not free for one that has', () => {
    // Nobody at Batt1 at all, and five operators on the floor: John's is the hot stamp.
    const judged = judge(lines, [...running, ...sheet('125T', 'Van')]);
    expect(standbyOf(judged)).toEqual(['BATT1']);
  });
});
