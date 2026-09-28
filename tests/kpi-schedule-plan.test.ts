import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  scheduleTuplesForShift,
  targetAttainmentForRecords,
} from '../src/core/kpi-attainment';
import { crewedWindowHoursBefore, orderCrewedForShift, plannedOrdersForShift, weekendDaysWorked } from '../src/core/schedule';
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
    const afternoon = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Afternoon', AFTER);
    const night = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', AFTER);

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
      scheduleTuplesForShift([], orders, '850T', `2026-09-22-${code}`, AFTER),
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
    const lines = scheduleTuplesForShift(records, orders, '850T', '2026-09-22-Afternoon', AFTER);
    expect(attainmentOfTuples(lines)).toEqual({
      actual: 30, expected: 124, pct: 24, covered: 3, total: 3,
    });
  });

  it('leaves a shift still waiting for sign-off out on both sides', () => {
    const lines = scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', AFTER, true);
    expect(lines.every((l) => l.source === 'pending')).toBe(true);
    expect(attainmentOfTuples(lines)).toEqual({ actual: 0, expected: 0, pct: null, covered: 0, total: 0 });
  });

  it('does not judge a shift that has not started', () => {
    expect(
      scheduleTuplesForShift([], orders, '850T', '2026-09-22-Night', new Date('2026-09-22T22:00:00')),
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
    const lines = scheduleTuplesForShift(records, orders, '850T', '2026-09-22-Afternoon', AFTER);
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
    const lines = scheduleTuplesForShift(records, orders, '320T', '2026-09-22-Day', AFTER);
    expect(lines).toEqual([
      expect.objectContaining({ jobNumber: 'SFM507587', source: 'shiftTarget', planned: 300, credited: 300 }),
    ]);
    // …and, with nothing saved either, reports the gap rather than a number.
    const unsaved = scheduleTuplesForShift(
      records.map((r) => ({ ...r, shiftTarget: -1 })), orders, '320T', '2026-09-22-Day', AFTER,
    );
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
    const lines = scheduleTuplesForShift([], [...orders, rateless], '850T', '2026-09-22-Afternoon', AFTER);
    expect(lines.find((l) => l.jobNumber === 'NORATE')).toMatchObject({ planned: null });
    expect(attainmentOfTuples(lines)).toMatchObject({ covered: 3, total: 4 });
  });

  it('plans the hot-stamp press under its Planning.csv name', () => {
    const lines = scheduleTuplesForShift([], orders, 'Hstamp', '2026-09-22-Afternoon', AFTER);
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
      scheduleTuplesForShift([], orders, '320T', shiftId, MONDAY).map((l) => l.jobNumber);
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
