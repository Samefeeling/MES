import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  keptPlanTuples,
  shiftPlanChanges,
  shiftPlanFor,
} from '../src/core/kpi-attainment';
import { leftAtShiftStart } from '../src/core/jobgood';
import { isHotStampPress } from '../src/core/die-match';
import { lastJobsBefore, ordersOpenAtShiftStart, pressPlanFromShiftStart } from '../src/core/schedule';
import { parsePlanningCsv } from '../src/dal/sharepoint';
import type { PlanningOrder, ProductionRecord, StatusCode } from '../src/types';
import { rec } from './helpers';

const HEAD =
  'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift';

// The hot-stamp press on Thursday 12 Nov 2026, as planned that morning.
const PLAN = parsePlanningCsv([
  HEAD,
  'HS,12/11/2026 7:30,24.00000384,12/11/2026 19:30,SFM508005,PJSC03314,Progress Chair Stamped,288,710,MAN',
  'HS,12/11/2026 19:30,30.000003,13/11/2026 9:36,SFM508226,V8351STMPG001,Viva Seat Stamped,168,168,MA',
].join('\n'));

/** Where the press stands: what is left of each order, and the order(s) it
 *  was last running (the first named, unless said otherwise). */
const left = (byJob: Record<string, number>, lastJobs: string[] = Object.keys(byJob).slice(0, 1)) => ({
  leftOf: (o: PlanningOrder): number | undefined => byJob[o.jobNumber],
  lastJobs: (): string[] => lastJobs,
});
const jobsOf = (plan: ReturnType<typeof shiftPlanFor>): Record<string, number> =>
  Object.fromEntries((plan?.jobs ?? []).map((j) => [j.jobNumber, j.pieces]));

/** A press-shift's 16 half-hours for one order: its statuses, and the good
 *  on the canonical slot. */
function shift(shiftId: string, jobNumber: string, timeline: string, good: number): ProductionRecord[] {
  return [...timeline].map((statusCode, slotIndex) =>
    rec({
      machineCode: 'HStamp', shiftId, jobNumber, slotIndex, statusCode: statusCode as StatusCode,
      countStart: slotIndex === 0 ? 0 : null, countEnd: slotIndex === 0 ? good : null, locked: true,
    }));
}

describe('a shift is planned from where the press stands when it starts', () => {
  const AFTERNOON = '2026-11-12-Afternoon';
  // The Day lost five hours to startup, a breakdown and waiting and made 56;
  // the Afternoon ran the same order all shift and finished it.
  const afternoonRan = shift(AFTERNOON, 'SFM508005', 'RRRRRRMRRRRRRMRR', 209);

  it('Planning.csv alone charges the Day\'s shortfall to the Afternoon', () => {
    const plan = shiftPlanFor(PLAN, 'HStamp', AFTERNOON)!;
    expect(jobsOf(plan)).toEqual({ SFM508005: 108, SFM508226: 105 });
    // 209 made and half of it credited; the order it could not start at 0.
    expect(attainmentOfTuples(keptPlanTuples(plan, afternoonRan)).pct).toBe(51);
  });

  it('the order under way runs for what is left of it, and the next one waits', () => {
    // 265 at the start of the day, 56 made: 209 left = 8.7 h at 24 an hour.
    const plan = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({ SFM508005: 209 }))!;
    expect(jobsOf(plan)).toEqual({ SFM508005: 192 });
    const lines = keptPlanTuples(plan, afternoonRan);
    // An hour of smoko off the eight: 168 asked, 209 made.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobNumber: 'SFM508005', planned: 168, good: 209, credited: 168 });
    expect(attainmentOfTuples(lines).pct).toBe(100);
  });

  it('the shift that lost the time is the one that shows it', () => {
    const DAY = '2026-11-12-Day';
    const plan = shiftPlanFor(PLAN, 'HStamp', DAY, undefined, {}, [], left({ SFM508005: 265 }))!;
    // Not open at 07:00: the window is the file's, 07:30 to the end of the shift.
    expect(jobsOf(plan)).toEqual({ SFM508005: 180 });
    const dayRan = shift(DAY, 'SFM508005', 'SSBBMMSSSMMRRRMR', 56);
    const a = attainmentOfTuples(keptPlanTuples(plan, dayRan));
    expect(a.actual).toBe(56);
    expect(a.pct).toBeLessThan(50);
  });

  it('an order ahead of the file is asked only for what it still holds, and nothing is pulled forward', () => {
    const plan = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({ SFM508005: 20 }))!;
    expect(jobsOf(plan)).toEqual({ SFM508005: 20, SFM508226: 105 });
  });

  it('an order with nothing left asks for nothing', () => {
    const plan = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({ SFM508005: 0 }))!;
    expect(jobsOf(plan)).toEqual({ SFM508226: 105 });
  });

  it('an order whose remaining quantity is not known keeps the file\'s window', () => {
    const plan = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({}))!;
    expect(jobsOf(plan)).toEqual({ SFM508005: 108, SFM508226: 105 });
    expect(pressPlanFromShiftStart(PLAN, 'HStamp', AFTERNOON, left({}))).toEqual(PLAN);
  });

  it('an order the press is not on is shortened to what is left, never run on', () => {
    // Behind, but another order was the last one running: not carried.
    const behind = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({ SFM508005: 209 }, ['OTHER']))!;
    expect(jobsOf(behind)).toEqual({ SFM508005: 108, SFM508226: 105 });
    const ahead = shiftPlanFor(PLAN, 'HStamp', AFTERNOON, undefined, {}, [], left({ SFM508005: 20 }, ['OTHER']))!;
    expect(jobsOf(ahead)).toEqual({ SFM508005: 20, SFM508226: 105 });
  });

  it('other presses are left as they are', () => {
    const out = pressPlanFromShiftStart(PLAN, '1600T', AFTERNOON, left({ SFM508005: 209 }));
    expect(out).toEqual(PLAN);
  });

  it('is what every press of the shift is kept by', () => {
    const { save } = shiftPlanChanges(['HStamp'], [], PLAN, AFTERNOON, undefined, {}, [], left({ SFM508005: 209 }));
    expect(save).toHaveLength(1);
    expect(save[0].plan).toBe(192);
  });
});

describe('a Planning.csv from before the shift', () => {
  // Yesterday's file: the order was to be finished last night, and was not.
  const STALE = parsePlanningCsv([
    HEAD,
    'HS,11/11/2026 8:00,24.00000384,11/11/2026 20:00,SFM508005,PJSC03314,Progress Chair Stamped,288,710,MAN',
    'HS,11/11/2026 20:00,30.000003,11/11/2026 23:00,SFM508226,V8351STMPG001,Viva Seat Stamped,90,168,MA',
  ].join('\n'));
  const DAY = '2026-11-12-Day';

  it('by its windows alone has nothing for the press today', () => {
    expect(shiftPlanFor(STALE, 'HStamp', DAY)!.plan).toBe(0);
  });

  it('still has the order nobody finished, first in the queue', () => {
    const plan = shiftPlanFor(STALE, 'HStamp', DAY, undefined, {}, [], left({ SFM508005: 265, SFM508226: 168 }))!;
    // 265 left is 11 hours: the whole Day, and the next order behind it.
    expect(jobsOf(plan)).toEqual({ SFM508005: 192 });
  });

  it('asks only for what is left of it, and not for the order behind it that never started', () => {
    const plan = shiftPlanFor(STALE, 'HStamp', DAY, undefined, {}, [], left({ SFM508005: 48, SFM508226: 168 }))!;
    expect(jobsOf(plan)).toEqual({ SFM508005: 48 });
  });

  it('does not carry an order the press never ran into later shifts', () => {
    // Planned for yesterday and not started (no material, say): the press is
    // not on it, and a shift following the plan is not charged with it.
    const plan = shiftPlanFor(STALE, 'HStamp', DAY, undefined, {}, [], left({ SFM508005: 265, SFM508226: 168 }, []))!;
    expect(plan.plan).toBe(0);
  });

  it('drops an order finished since', () => {
    expect(shiftPlanFor(STALE, 'HStamp', DAY, undefined, {}, [], left({ SFM508005: 0, SFM508226: 0 }))!.plan).toBe(0);
  });

  it('asks for the records of the orders still open, and of the one on the press', () => {
    const NIGHT = '2026-11-11-Night';
    expect(ordersOpenAtShiftStart(STALE, NIGHT).map((o) => o.jobNumber)).toEqual([]); // both over by 23:00
    expect(ordersOpenAtShiftStart(STALE, '2026-11-11-Afternoon').map((o) => o.jobNumber)).toEqual(['SFM508005']);
    expect(ordersOpenAtShiftStart(STALE, DAY, (o) => o.jobNumber === 'SFM508005').map((o) => o.jobNumber))
      .toEqual(['SFM508005']);
    expect(ordersOpenAtShiftStart(STALE, '2026-11-11-Day')).toEqual([]); // not open at 07:00 yet
  });
});

describe('the order a press was last running', () => {
  const day = shift('2026-11-12-Day', 'SFM508005', 'SSBBMMSSSMMRRRMR', 56);
  const at = (h: number): number => new Date(2026, 10, 12, h).getTime();

  it('is the order of its latest running half-hour before the moment', () => {
    const last = lastJobsBefore(day);
    expect(last('HSTAMP', at(15))).toEqual(['SFM508005']);
    expect(last('HStamp', at(12))).toEqual([]); // nothing had run yet: startup and a breakdown
    expect(last('1600T', at(15))).toEqual([]);
  });

  it('reads the days before off the shift headers, and names both parts of a co-run', () => {
    const last = lastJobsBefore([], [
      { machineCode: 'HStamp', shiftId: '2026-11-10-Day', jobNumber: 'OLD', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: 'HStamp', shiftId: '2026-11-11-Day', jobNumber: 'A', timeline: 'RRRRRRRRRRRRRRRD' },
      { machineCode: 'HStamp', shiftId: '2026-11-11-Day', jobNumber: 'B', timeline: 'RRRRRRRRRRRRRRRD' },
    ]);
    expect(last('HStamp', at(7)).sort()).toEqual(['A', 'B']);
  });
});

describe('what is left of an order when a shift starts', () => {
  const day = shift('2026-11-12-Day', 'SFM508005', 'SSBBMMSSSMMRRRMR', 56);
  const afternoon = shift('2026-11-12-Afternoon', 'SFM508005', 'RRRRRRMRRRRRRMRR', 209);

  it('is the quantity less the good of the shifts before, signed or not', () => {
    const unsigned = day.map((r) => ({ ...r, locked: false }));
    const order = { orderQty: 265, jobRequired: 0 };
    expect(leftAtShiftStart(order, [...unsigned, ...afternoon], '2026-11-12-Afternoon')).toBe(209);
    expect(leftAtShiftStart(order, [...day, ...afternoon], '2026-11-12-Night')).toBe(0);
    expect(leftAtShiftStart(order, [], '2026-11-12-Day')).toBe(265);
  });

  it('is capped by what Epicor still has to make, and unknown without a quantity', () => {
    // 710 ordered, 445 made before these records began: Epicor says 265.
    expect(leftAtShiftStart({ orderQty: 710, jobRequired: 265 }, [], '2026-11-12-Day')).toBe(265);
    expect(leftAtShiftStart({ orderQty: 0, jobRequired: 100 }, day, '2026-11-12-Afternoon')).toBeUndefined();
  });
});

describe('a press-shift kept with nothing planned', () => {
  it('reports what it made against each order, not as a nameless line', () => {
    const row = { machineCode: 'HStamp', shiftId: '2026-11-12-Day', plan: 0, jobs: [] };
    const lines = keptPlanTuples(row, shift('2026-11-12-Day', 'SFM508005', 'SSBBMMSSSMMRRRMR', 56));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobNumber: 'SFM508005', good: 56, credited: 0, source: 'unscheduled' });
    expect(keptPlanTuples(row, [])).toEqual([]);
  });
});

describe('the hot-stamp press', () => {
  it('is known by any of its names, and no other press is', () => {
    for (const code of ['HS', 'hs', 'HStamp', 'Hstamp', 'Hot Stamp', 'HOT-STAMP']) expect(isHotStampPress(code)).toBe(true);
    for (const code of ['1600T', 'Batt1', 'HS2', '', undefined]) expect(isHotStampPress(code)).toBe(false);
  });
});
