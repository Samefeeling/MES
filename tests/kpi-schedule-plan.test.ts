import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  scheduleTuplesForShift,
  shiftPlanFor,
  targetAttainmentForRecords,
  type PlanContext,
} from '../src/core/kpi-attainment';
import {
  crewedWindowHoursBefore,
  orderCrewedForShift,
  plannedOrdersForShift,
  pressRunsAfterDieChanges,
  weekendDaysWorked,
} from '../src/core/schedule';
import { parseShiftPattern } from '../src/core/shifts';
import { parsePlanningCsv } from '../src/dal/sharepoint';
import { order, rec } from './helpers';

// 850T as Planning.csv had it for 22 Sept 2026 — planned from the afternoon
// through the night, and never run for want of a crew.
const PLANNING_850T = [
  'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
  '"850T","2026-09-22 18:14:00","33.00000066","2026-09-22 19:38:00","SFM507787","P1","Part","30","30","MAN"',
  '"850T","2026-09-22 19:38:00","33.00000066","2026-09-22 21:58:00","SFM507834","P2","Part","60","60","MAN"',
  '"850T","2026-09-22 21:58:00","33.00000066","2026-09-23 01:29:00","SFM507835","P3","Part","100","100","MAN"',
  '"850T","2026-09-23 01:29:00","33.00000066","2026-09-23 05:01:00","SFM507836","P4","Part","100","100","MAN"',
  '"850T","2026-09-23 05:01:00","33.00000066","2026-09-23 08:33:00","SFM507837","P5","Part","60","60","MAN"',
  '"HS","2026-09-22 15:00:00","22","2026-09-22 18:14:00","018562-1-1","P6","Part","0","60",""',
].join('\n');

const AFTER = new Date('2026-09-23T08:00:00');

// The tests below are about how a plan is shared out, not about die changes:
// every part here is taken to run on the one tool the press already has on,
// so no order waits for a die change (core/schedule pressRunsAfterDieChanges).
const ON_THE_PRESS: PlanContext = { dieOf: () => 'D-1', partBefore: () => 'P1' };

describe('Planning.csv "no of shift"', () => {
  it('reads one letter per crewed shift, M for the morning (Day) shift', () => {
    expect(parseShiftPattern('MAN')).toEqual(['Day', 'Afternoon', 'Night']);
    expect(parseShiftPattern('MA')).toEqual(['Day', 'Afternoon']);
    expect(parseShiftPattern('n/m')).toEqual(['Day', 'Night']);
    expect(parseShiftPattern('D, A')).toEqual(['Day', 'Afternoon']);
  });

  it('answers "no restriction" rather than guessing at a value it cannot read', () => {
    expect(parseShiftPattern('')).toBeUndefined();
    expect(parseShiftPattern(undefined)).toBeUndefined();
    expect(parseShiftPattern('3')).toBeUndefined();
    expect(parseShiftPattern('MXN')).toBeUndefined();
  });

  it('is carried onto each planning order, and left off a blank cell', () => {
    const orders = parsePlanningCsv(PLANNING_850T);
    expect(orders[0].shifts).toEqual(['Day', 'Afternoon', 'Night']);
    expect(orders.find((o) => o.machineCode === 'HS')?.shifts).toBeUndefined();
  });

  it('keeps an order off a shift the press is not crewed for', () => {
    // Day + Afternoon only, planned 15:00 → 11:00 next day: Epicor's window
    // runs through the night, but nobody is there to run it.
    const twoShift = order({
      jobNumber: 'A',
      plannedStart: '2026-09-22T15:00:00',
      plannedEnd: '2026-09-23T11:00:00',
      shifts: ['Day', 'Afternoon'],
    });
    expect(plannedOrdersForShift([twoShift], '125T', '2026-09-22-Afternoon')).toHaveLength(1);
    expect(plannedOrdersForShift([twoShift], '125T', '2026-09-22-Night')).toHaveLength(0);
    expect(plannedOrdersForShift([twoShift], '125T', '2026-09-23-Day')).toHaveLength(1);
    // Only the afternoon counts before the next morning.
    expect(crewedWindowHoursBefore(twoShift, new Date('2026-09-23T07:00:00'))).toBe(8);
    expect(crewedWindowHoursBefore({ ...twoShift, shifts: undefined }, new Date('2026-09-23T07:00:00'))).toBe(16);
  });
});

describe('Schedule Adherence plans from Planning.csv, run or not', () => {
  const orders = parsePlanningCsv(PLANNING_850T);

  it('asks an idle press for its plan, so a shift nobody ran reads 0%', () => {
    const afternoon = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Afternoon', AFTER, false, ON_THE_PRESS);
    const night = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', AFTER, false, ON_THE_PRESS);

    expect(afternoon.map((l) => [l.jobNumber, l.planned, l.good])).toEqual([
      ['SFM507787', 30, 0],
      ['SFM507834', 60, 0],
      ['SFM507835', 34, 0],
    ]);
    expect(night.map((l) => [l.jobNumber, l.planned])).toEqual([
      ['SFM507835', 66],
      ['SFM507836', 100],
      ['SFM507837', 60],
    ]);
    expect(attainmentOfTuples([...afternoon, ...night])).toEqual({
      actual: 0, expected: 350, pct: 0, covered: 6, total: 6,
    });
  });

  it('never asks an order for more than it holds, however its window is split', () => {
    // SFM507835: 100 pieces across 21:58 → 01:29. 33/h would ask 34 in the
    // afternoon and 81 in the night; the night only gets what is left.
    const lines = ['Afternoon', 'Night'].flatMap((code) =>
      scheduleTuplesForShift([], orders, '850T', `2026-09-22-${code}`, AFTER, false, ON_THE_PRESS),
    );
    const planned = lines
      .filter((l) => l.jobNumber === 'SFM507835')
      .reduce((sum, l) => sum + (l.planned ?? 0), 0);
    expect(planned).toBe(100);
  });

  it('credits Good up to each order\'s plan, so one order cannot cover another', () => {
    const records = [
      rec({
        machineCode: '850T', shiftId: '2026-09-22-Afternoon', jobNumber: 'SFM507787',
        slotIndex: 7, statusCode: 'R', countStart: 0, countEnd: 90, locked: true,
      }),
    ];
    const lines = scheduleTuplesForShift(records, orders, '850T', '2026-09-22-Afternoon', AFTER, false, ON_THE_PRESS);
    expect(attainmentOfTuples(lines)).toEqual({
      actual: 30, expected: 124, pct: 24, covered: 3, total: 3,
    });
  });

  it('counts the plan of a shift still waiting for sign-off, crediting nothing until it is signed', () => {
    // Leaving it out let an unsigned shift take its plan out of the
    // denominator with it: a press nobody signed read as a press with no plan.
    const lines = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', AFTER, true, ON_THE_PRESS);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.source === 'schedule' && l.unsigned)).toBe(true);
    expect(attainmentOfTuples(lines)).toEqual({ actual: 0, expected: 226, pct: 0, covered: 3, total: 3 });
  });

  it('does not judge a shift that has not started', () => {
    expect(
      scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', new Date('2026-09-22T22:00:00'), false, ON_THE_PRESS),
    ).toEqual([]);
  });

  it('does not credit output of an order planned somewhere else', () => {
    // SFM507836 belongs to the night; making it in the afternoon is off-plan.
    const records = [
      rec({
        machineCode: '850T', shiftId: '2026-09-22-Afternoon', jobNumber: 'SFM507836',
        slotIndex: 7, statusCode: 'R', countStart: 0, countEnd: 40, locked: true,
      }),
    ];
    const lines = scheduleTuplesForShift(records, orders, '850T', '2026-09-22-Afternoon', AFTER, false, ON_THE_PRESS);
    expect(lines.find((l) => l.jobNumber === 'SFM507836')).toMatchObject({
      source: 'unscheduled', good: 40, credited: 0,
    });
    expect(attainmentOfTuples(lines)).toMatchObject({ actual: 0, expected: 124, covered: 3, total: 3 });
  });

  it('falls back to the saved ShiftTarget for an order Epicor has already dropped', () => {
    const records = [
      rec({
        machineCode: '320T', shiftId: '2026-09-22-Day', jobNumber: 'SFM507587',
        slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 313, shiftTarget: 300, locked: true,
      }),
    ];
    const lines = scheduleTuplesForShift(records, orders, '320T', '2026-09-22-Day', AFTER, false, ON_THE_PRESS);
    expect(lines).toEqual([
      expect.objectContaining({ jobNumber: 'SFM507587', source: 'shiftTarget', planned: 300, credited: 300 }),
    ]);
    // …and, with nothing saved either, reports the gap rather than a number.
    const unsaved = scheduleTuplesForShift(
      records.map((r) => ({ ...r, shiftTarget: -1 })), orders, '320T', '2026-09-22-Day', AFTER, false, ON_THE_PRESS);
    expect(attainmentOfTuples(unsaved)).toMatchObject({ covered: 0, total: 1 });
  });

  it('reports a planned order with no rate as a gap in coverage, not a zero', () => {
    const rateless = order({
      jobNumber: 'NORATE',
      machineCode: '850T',
      plannedStart: '2026-09-22T15:00:00',
      plannedEnd: '2026-09-22T17:00:00',
      qtyPerHr: 0,
    });
    const lines = scheduleTuplesForShift([], [...orders, rateless], '850T', '2026-09-22-Afternoon', AFTER, false, ON_THE_PRESS);
    expect(lines.find((l) => l.jobNumber === 'NORATE')).toMatchObject({ planned: null });
    expect(attainmentOfTuples(lines)).toMatchObject({ covered: 3, total: 4 });
  });

  it('plans the hot-stamp press under its Planning.csv name', () => {
    const lines = scheduleTuplesForShift([], orders, 'Hstamp', '2026-09-22-Afternoon', AFTER, false, ON_THE_PRESS);
    expect(lines.map((l) => [l.jobNumber, l.planned])).toEqual([['018562-1-1', 60]]);
  });
});

describe('Vs Target is unchanged', () => {
  it('still sums Good against the saved ShiftTarget of what ran, uncapped', () => {
    const records = [
      rec({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 120, shiftTarget: 100 }),
      rec({ jobNumber: 'B', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 50, shiftTarget: 100 }),
    ];
    expect(targetAttainmentForRecords(records)).toEqual({
      actual: 170, expected: 200, pct: 85, covered: 2, total: 2,
    });
    expect(targetAttainmentForRecords(records, true)).toMatchObject({ actual: 150 });
  });
});

describe('weekend overtime, read off the order\'s own schedule', () => {
  // 320T as Planning.csv had it on 25 Sept 2026 (a Friday).
  const PLANNING_320T = [
    'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
    '320T,25/09/2026 14:49,42.00000672,25/09/2026 16:39,507822,G06021000,Cosmic Seat,56,56,MAN',
    '320T,26/09/2026 3:00,45.0000045,30/09/2026 5:21,SFM507827,7416-BLACK,Progress Link Male Black,1500,1500,MN',
    '320T,26/09/2026 3:00,116.9999801,30/09/2026 5:21,SFM507828,7417-BLACK,Progress Link Female Black,1500,1500,MN',
  ].join('\n');
  const MONDAY = new Date('2026-09-28T08:00:00');

  it('keeps an order Epicor ran straight over an idle weekend off the weekend shifts', () => {
    const orders = parsePlanningCsv(PLANNING_320T);
    // SFM507827: 1500 at 45/h is 33.3 h; the weekday M and N shifts in its
    // window (Fri night from 03:00, Monday, Tuesday to 05:21) hold 34.4 h.
    expect([...weekendDaysWorked(orders[1])!]).toEqual([]);
    const planned = (shiftId: string) =>
      scheduleTuplesForShift([], orders, '320T', shiftId, MONDAY, false, ON_THE_PRESS).map((l) => l.jobNumber);
    // Friday's night, which runs to 07:00 Saturday, is a weekday shift.
    expect(planned('2026-09-25-Night')).toEqual(['SFM507827', 'SFM507828']);
    expect(planned('2026-09-25-Day')).toEqual(['507822']);
    for (const shift of ['Day', 'Afternoon', 'Night']) {
      expect(planned(`2026-09-26-${shift}`)).toEqual([]);
      expect(planned(`2026-09-27-${shift}`)).toEqual([]);
    }
  });

  // Friday 07:00 to Monday 07:00 at 10 an hour on every shift: 72 h of
  // window, 24 of them Friday's.
  const across = (remaining: number, shifts?: ('Day' | 'Afternoon' | 'Night')[]) =>
    order({
      jobNumber: 'W',
      plannedStart: '2026-09-25T07:00:00',
      plannedEnd: '2026-09-28T07:00:00',
      qtyPerHr: 1 / 10,
      jobRequired: remaining,
      ...(shifts ? { shifts } : {}),
    });

  it('reads the gap between the window and the work as the weekend days not worked', () => {
    // 48 h short of the window: neither day.
    expect([...weekendDaysWorked(across(240))!]).toEqual([]);
    // 24 h short: one day, the Saturday.
    expect([...weekendDaysWorked(across(480))!]).toEqual(['2026-09-26']);
    // The whole window: both.
    expect([...weekendDaysWorked(across(720))!]).toEqual(['2026-09-26', '2026-09-27']);
  });

  it('reads up to two hours over as the planner\'s changeover allowance, not overtime', () => {
    // Friday 07:00 to Saturday 10:00: Friday's 24 h, and 3 h of Saturday.
    const clipped = (remaining: number) =>
      order({
        jobNumber: 'C',
        plannedStart: '2026-09-25T07:00:00',
        plannedEnd: '2026-09-26T10:00:00',
        qtyPerHr: 1 / 10,
        jobRequired: remaining,
      });
    // 1.5 h more than Friday holds: an insert and a colour change.
    expect([...weekendDaysWorked(clipped(255))!]).toEqual([]);
    // 2.5 h more: Saturday morning was worked.
    expect([...weekendDaysWorked(clipped(265))!]).toEqual(['2026-09-26']);
    // A two-day weekend with an hour of allowance on top is still both days.
    expect([...weekendDaysWorked(across(710))!]).toEqual(['2026-09-26', '2026-09-27']);
  });

  it('works an overtime day round the clock, whatever the weekday pattern', () => {
    // Day + Night on weekdays (16 h Friday), and 40 h of work.
    const twoShift = across(400, ['Day', 'Night']);
    expect([...weekendDaysWorked(twoShift)!]).toEqual(['2026-09-26']);
    expect(orderCrewedForShift(twoShift, '2026-09-25-Afternoon')).toBe(false);
    expect(orderCrewedForShift(twoShift, '2026-09-26-Afternoon')).toBe(true);
    expect(orderCrewedForShift(twoShift, '2026-09-27-Day')).toBe(false);
    // Asked before Sunday: Friday's 16 h and all 24 of Saturday's.
    expect(crewedWindowHoursBefore(twoShift, new Date('2026-09-27T07:00:00'))).toBe(40);
  });

  it('falls back to "no of shift" when there is no rate to tell from', () => {
    const unrated = { ...across(480), qtyPerHr: 0 };
    expect(weekendDaysWorked(unrated)).toBeNull();
    expect(orderCrewedForShift(unrated, '2026-09-27-Day')).toBe(true);
  });
});

describe('a die change at the head of a press plan (Planning.csv, 26 Oct 2026)', () => {
  // The rows of the export that matter: 850T's and 320T's first orders sit
  // well after the export's 07:30 "now", with the orders before them already
  // finished and gone from the file.
  const PLAN_26_OCT = [
    'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
    '"Batt1","2026-10-26 07:30:00","24.0000038400006","2026-10-26 19:15:00","SFM508036","POPL01034","Postura Max","560","640","MAN"',
    '"850T","2026-10-27 11:00:00","54.5464462990236","2026-10-27 18:06:00","SFM507987","17705-BLK","Bodyfurn Chair Seat Medium - Black","360","360","MAN"',
    '"850T","2026-10-27 18:06:00","54.5464462990236","2026-10-28 15:52:00","SFM507986","17705-GRY","Bodyfurn Chair Seat Medium - Grey","1160","1160","MAN"',
    '"850T","2026-10-28 15:52:00","54.5464462990236","2026-10-29 10:42:00","SFM507985","17705-DB","Bodyfurn Chair Seat Medium - Deep Blue","1000","1000","MAN"',
    '"850T","2026-10-29 14:42:00","71.999424004608","2026-10-30 14:19:00","SFM507997","17723-DB","Bodyfurn Chair Back Large - Deep Blue","1700","1700","MAN"',
    '"320T","2026-10-27 03:05:00","423.549343498518","2026-10-27 16:16:00","SFM507991","17735-GRY","Bodyfurn Seat Cover - Grey","5376","5376","MAN"',
    '"320T","2026-10-28 12:53:00","205.761316872428","2026-10-28 15:53:00","SFM508043","V11581-CHARCOAL","Lumba Linking Block Charcoal","500","500","MAN"',
    '"550T","2026-10-26 07:30:00","33.00000033","2026-10-26 13:00:00","SFM507948","G02550051","Proteus Seat Light Grey","398","398","MAN"',
    '"550T","2026-11-05 22:08:00","120.000048000019","2026-11-06 06:58:00","SFM508040","V11307-PINELI","Leg Castor - Pinelime","1000","1000","MAN"',
    '"550T","2026-11-05 22:08:00","120.000048000019","2026-11-06 06:58:00","SFM508039","V11308-PINELI","Leg Glides - Pinelime","1000","1000","MAN"',
    '"1600T","2026-10-26 11:30:00","20.8000013312001","2026-11-04 01:36:00","SFM507844","POPL00123","Postura Plus","3696","4176","MAN"',
  ].join('\n');
  const orders = parsePlanningCsv(PLAN_26_OCT);
  const DIES: Record<string, string> = {
    '17705-BLK': 'D-SEAT-M', '17705-GRY': 'D-SEAT-M', '17705-DB': 'D-SEAT-M',
    '17723-DB': 'D-BACK-L', '17735-GRY': 'D-COVER',
    'V11307-PINELI': 'D-LEG', 'V11308-PINELI': 'D-LEG',
  };
  const ctx: PlanContext = { dieOf: (part) => DIES[part.toUpperCase()] };
  const LATER = new Date('2026-11-30T00:00:00');
  const plan = (press: string, shiftId: string, c: PlanContext = ctx): Record<string, number | null> =>
    Object.fromEntries(
      scheduleTuplesForShift([], orders, press, shiftId, LATER, false, c).map((l) => [l.jobNumber, l.planned]),
    );
  const runOf = (job: string, press: string, c: PlanContext = ctx) => {
    const o = orders.find((x) => x.jobNumber === job)!;
    return pressRunsAfterDieChanges(orders, press, c).get(o)!;
  };

  it('asks 320T for nothing on the Night its first order only put the die on', () => {
    // 03:05 → 07:05 is the die change; the old plan asked for 1,658.
    expect(plan('320T', '2026-10-26-Night')).toEqual({});
    expect(new Date(runOf('SFM507991', '320T').plannedStart)).toEqual(new Date('2026-10-27T07:05:00'));
    // 07:05 → 15:00 at 423.5 an hour.
    expect(plan('320T', '2026-10-27-Day')).toEqual({ SFM507991: 3353 });
  });

  it('asks 850T for nothing on the Day its die went on, and keeps every window where Epicor put it', () => {
    // 11:00 → 15:00 is the die change, inside Black's 11:00 → 18:06 window.
    expect(plan('850T', '2026-10-27-Day')).toEqual({});
    expect(new Date(runOf('SFM507987', '850T').plannedStart)).toEqual(new Date('2026-10-27T15:00:00'));
    expect(runOf('SFM507987', '850T').plannedEnd).toBe(orders.find((o) => o.jobNumber === 'SFM507987')!.plannedEnd);
    // Black runs 15:00 → 18:06, still its Due, then Grey from 18:06 on the
    // same die with no change: 3.1 h and 4.9 h at 54.5 an hour.
    expect(plan('850T', '2026-10-27-Afternoon')).toEqual({ SFM507987: 169, SFM507986: 267 });
    // The planner left four hours before the Back Large (10:42 → 14:42): it
    // starts where Epicor put it.
    expect(runOf('SFM507997', '850T')).toBe(orders.find((o) => o.jobNumber === 'SFM507997'));
  });

  it('takes from the next order only what the planner left short of four hours, and never moves its Due', () => {
    const first = order({ jobNumber: 'A', machineCode: '125T', partNumber: 'X', plannedStart: '2026-10-27T08:00:00', plannedEnd: '2026-10-27T10:00:00' });
    const next = order({ jobNumber: 'B', machineCode: '125T', partNumber: 'Y', plannedStart: '2026-10-27T13:00:00', plannedEnd: '2026-10-27T15:00:00' });
    const runs = pressRunsAfterDieChanges([first, next], '125T', { dieOf: (p) => (p === 'X' ? 'D1' : 'D2'), partBefore: () => 'X' });
    expect(runs.get(first)).toBe(first);
    // Three hours left for a four-hour change: it starts an hour late and
    // still ends at its Due.
    expect(new Date(runs.get(next)!.plannedStart)).toEqual(new Date('2026-10-27T14:00:00'));
    expect(new Date(runs.get(next)!.plannedEnd)).toEqual(new Date('2026-10-27T15:00:00'));
    // A die nobody has recorded is a die change too.
    const unknown = pressRunsAfterDieChanges([first, next], '125T', { partBefore: () => 'X' });
    expect(new Date(unknown.get(next)!.plannedStart)).toEqual(new Date('2026-10-27T14:00:00'));
    // The same die is a colour change, inside the window already.
    const same = pressRunsAfterDieChanges([first, next], '125T', { dieOf: () => 'D1', partBefore: () => 'X' });
    expect(same.get(next)).toBe(next);
  });

  it('leaves a press carrying on as it is', () => {
    // Already under way.
    expect(runOf('SFM507844', '1600T').plannedStart).toBe(orders.find((o) => o.jobNumber === 'SFM507844')!.plannedStart);
    // Put on at the export's "now".
    expect(plan('550T', '2026-10-26-Day').SFM507948).toBe(181);
    // The press was last running a part of the same die.
    const onIt = { ...ctx, partBefore: () => '17705-GRY' };
    expect(plan('850T', '2026-10-27-Day', onIt)).toEqual({ SFM507987: 218 });
  });

  it('moves a co-run together, and never touches the hot-stamp press', () => {
    const a = runOf('SFM508040', '550T');
    const b = runOf('SFM508039', '550T');
    expect(a.plannedStart).toBe(b.plannedStart);
    // Proteus before it is another die: the legs wait for the change.
    expect(new Date(a.plannedStart).getTime()).toBeGreaterThanOrEqual(new Date('2026-11-05T22:08:00').getTime());
    const hs = order({ jobNumber: 'HS1', machineCode: 'HS', plannedStart: '2026-10-27T12:00:00', plannedEnd: '2026-10-27T15:00:00' });
    expect(pressRunsAfterDieChanges([...orders, hs], 'Hstamp').get(hs)).toBe(hs);
  });
});

describe('Planning.csv Start–Due cut into shifts as they stand (125T, 9 Nov 2026)', () => {
  // The export scheduled from 07:30; 125T's order starts at 11:00, and
  // nothing says what the press ran before: its die goes on first.
  const PLAN_9_NOV = [
    'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
    'Batt1,9/11/2026 7:30,24,9/11/2026 19:00,SFM508000,POPL01034,Postura Max,200,200,MAN',
    '125T,9/11/2026 11:00,858.000858,10/11/2026 0:19,SFM508014,G04160002,Enc Screw Cap Black,11000,11000,MAN',
  ].join('\n');
  const orders = parsePlanningCsv(PLAN_9_NOV);
  const LATER = new Date('2026-11-12T00:00:00');
  const kept = (shift: string) => shiftPlanFor(orders, '125T', `2026-11-09-${shift}`, LATER, {});

  it('keeps the order to its window: the die change takes its first 4 h, and it still ends at 00:19', () => {
    const run = pressRunsAfterDieChanges(orders, '125T', {}).get(orders[1])!;
    expect(new Date(run.plannedStart)).toEqual(new Date('2026-11-09T15:00:00'));
    expect(new Date(run.plannedEnd)).toEqual(new Date('2026-11-10T00:19:00'));
    // Day 07:00–15:00: the change, 11:00–15:00; nothing to make.
    expect(kept('Day')).toMatchObject({ plan: 0, jobs: [] });
    expect(kept('Day')!.bar!.map((b) => `${b.kind} ${new Date(b.start).getHours()}–${new Date(b.end).getHours()}`)).toEqual(['change 11–15']);
    // Afternoon 15:00–23:00: 8 h at 858 an hour.
    expect(kept('Afternoon')).toMatchObject({ plan: 6864, jobs: [{ jobNumber: 'SFM508014', pieces: 6864, hours: 8 }] });
    // Night 23:00 9 Nov → 07:00 10 Nov: the order runs 23:00–00:19, 1.32 h.
    const night = kept('Night')!;
    expect(night.jobs).toEqual([{ jobNumber: 'SFM508014', partNumber: 'G04160002', pieces: 1129, hours: 1.32 }]);
    expect(new Date(night.bar![0].end)).toEqual(new Date('2026-11-10T00:19:00'));
  });

  it('asks a window too short for its die change for nothing', () => {
    const short = parsePlanningCsv(PLAN_9_NOV.replace('10/11/2026 0:19', '9/11/2026 14:00'));
    expect(new Date(pressRunsAfterDieChanges(short, '125T', {}).get(short[1])!.plannedStart)).toEqual(new Date(short[1].plannedEnd));
    expect(shiftPlanFor(short, '125T', '2026-11-09-Day', LATER, {})).toMatchObject({ plan: 0, jobs: [] });
  });
});
