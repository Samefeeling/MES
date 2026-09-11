import { describe, it, expect } from 'vitest';
import {
  ASSEMBLY_THRESHOLDS,
  assemblyByLine,
  assemblyMetrics,
  colourClass,
  crewSize,
  efficiencyPct,
  emptyAssemblyAgg,
  onTimePct,
  plannedPct,
  yieldPct,
} from '../src/core/assembly-metrics';
import type { AssemblyResult } from '../src/types/assembly';

/** One booked day. Two people, an order worth half an hour a unit. */
const day = (over: Partial<AssemblyResult> = {}): AssemblyResult => ({
  id: '1',
  job: 'ASM8001',
  day: '2026-09-08',
  line: 'ASM',
  operators: 'Tom, Bo',
  plannedHours: 30,
  orderQty: 60,
  output: 10,
  complete: 10,
  reject: 0,
  rework: 0,
  completed: false,
  due: null,
  completedAt: null,
  ...over,
});

describe('Assembly metrics', () => {
  it('adds daily quantities but counts the same order once', () => {
    const agg = assemblyMetrics([
      day(),
      day({ id: '2', day: '2026-09-09', output: 5, complete: 4, reject: 1 }),
    ]);
    expect(agg.orders).toBe(1);
    expect(agg.bookings).toBe(2);
    expect(agg.output).toBe(15);
    expect(agg.complete).toBe(14);
    expect(agg.reject).toBe(1);
  });

  it('has nothing at all in an empty period', () => {
    expect(assemblyMetrics([])).toEqual(emptyAssemblyAgg());
    expect(yieldPct(emptyAssemblyAgg())).toBeNull();
    expect(efficiencyPct(emptyAssemblyAgg())).toBeNull();
    expect(onTimePct(emptyAssemblyAgg())).toBeNull();
  });

  it('keeps support work out of manufactured order and quantity totals', () => {
    const support = day({
      id: 's1',
      job: 'FG-one',
      day: '2026-09-09',
      line: 'General',
      operators: 'Alex',
      workType: 'Support',
      laborHours: 7.5,
      plannedHours: 7.5,
      orderQty: 0,
      output: 0,
      complete: 0,
      completed: true,
    });
    const agg = assemblyMetrics([support, { ...support, id: 's2', day: '2026-09-10', laborHours: 2 }]);
    expect(agg.supportHours).toBe(9.5);
    expect(agg.supportOrders).toBe(1);
    // Support has no output, so it is in none of the production figures — a
    // line's support hours would otherwise read as a week spent making nothing.
    expect(agg.orders).toBe(0);
    expect(agg.completedOrders).toBe(0);
    expect(agg.output).toBe(0);
    expect(agg.bookings).toBe(0);
    expect(agg.crewHours).toBe(0);
    expect(efficiencyPct(agg)).toBeNull();
  });
});

describe('yield', () => {
  it('is good work as a share of what was made', () => {
    expect(yieldPct(assemblyMetrics([day({ complete: 96, reject: 4 })]))).toBe(96);
  });

  it('says nothing rather than 100% when nothing was made', () => {
    expect(yieldPct(assemblyMetrics([day({ output: 0, complete: 0 })]))).toBeNull();
  });
});

describe('efficiency', () => {
  it('is the standard the units earned against the hours that earned them', () => {
    // Two people for a day is 15 crew hours; 30 units at half an hour each is
    // 15 standard hours earned. Exactly on plan.
    expect(efficiencyPct(assemblyMetrics([day({ complete: 30 })]))).toBe(100);
    expect(efficiencyPct(assemblyMetrics([day({ complete: 15 })]))).toBe(50);
  });

  it('counts nobody on the order as no crew hours, not as a division by zero', () => {
    const agg = assemblyMetrics([day({ operators: '', complete: 30 })]);
    expect(agg.crewHours).toBe(0);
    expect(efficiencyPct(agg)).toBeNull();
  });

  /*
   * The rule that keeps the number honest. A record written before the board
   * started sending PlannedHours carries no standard, and neither does an
   * order Epicor never gave one. Scoring those zero would report a floor
   * working at half speed because half its orders were never costed.
   */
  it('leaves a day with no standard out of both sides, rather than scoring it zero', () => {
    const priced = day({ complete: 30 });
    const unpriced = day({ id: '2', job: 'ASM8002', day: '2026-09-09', plannedHours: undefined, complete: 30 });
    const agg = assemblyMetrics([priced, unpriced]);
    expect(efficiencyPct(agg)).toBe(100);
    // The crew hours themselves are still reported: the time was spent.
    expect(agg.crewHours).toBe(30);
    expect(agg.judgedHours).toBe(15);
  });

  it('is also blind to an order with a standard but no quantity', () => {
    expect(efficiencyPct(assemblyMetrics([day({ orderQty: 0 })]))).toBeNull();
  });
});

describe('output against plan', () => {
  /*
   * Assembly keeps no separate daily schedule, so the plan is what the people
   * who were actually on the order were capable of at its own standard. Two
   * people for a day is 15 crew hours; at half an hour a unit the plan is 30.
   */
  it('is what came off the line over what the crew were planned to make', () => {
    expect(plannedPct(assemblyMetrics([day({ output: 30 })]))).toBe(100);
    expect(plannedPct(assemblyMetrics([day({ output: 24 })]))).toBe(80);
    expect(assemblyMetrics([day({ output: 24 })]).plannedOutput).toBe(30);
  });

  it('says nothing when the order carried no standard to plan against', () => {
    const agg = assemblyMetrics([day({ plannedHours: undefined, output: 30 })]);
    expect(agg.plannedOutput).toBe(0);
    expect(plannedPct(agg)).toBeNull();
    // The output itself is still reported — the pieces were made.
    expect(agg.output).toBe(30);
  });
});

describe('booked hours', () => {
  it('value everything that came off the line, good or not', () => {
    // 30 output at half an hour each, of which 28 were good.
    const agg = assemblyMetrics([day({ output: 30, complete: 28, reject: 2 })]);
    expect(agg.bookedHours).toBe(15);
    expect(agg.earnedHours).toBe(14);
    // The gap between the two is what the rejects cost in time.
    expect(agg.bookedHours - agg.earnedHours).toBe(1);
  });

  it('are left out with the rest when there is no standard', () => {
    expect(assemblyMetrics([day({ orderQty: 0, output: 30 })]).bookedHours).toBe(0);
  });
});

describe('on time', () => {
  const finished = (over: Partial<AssemblyResult>) =>
    day({ completed: true, ...over });

  it('judges a finished order against its due date', () => {
    const agg = assemblyMetrics([
      finished({ job: 'A', due: '2026-09-10', completedAt: '2026-09-09T15:00:00' }),
      finished({ id: '2', job: 'B', due: '2026-09-08', completedAt: '2026-09-09T15:00:00' }),
    ]);
    expect(agg.completedOrders).toBe(2);
    expect(agg.onTimeOrders).toBe(1);
    expect(onTimePct(agg)).toBe(50);
  });

  it('counts the day it landed on when there is no completion stamp', () => {
    const agg = assemblyMetrics([finished({ job: 'A', day: '2026-09-08', due: '2026-09-08' })]);
    expect(agg.onTimeOrders).toBe(1);
  });

  it('leaves an order with no due date out of the percentage entirely', () => {
    const agg = assemblyMetrics([finished({ job: 'A', due: null })]);
    expect(agg.completedOrders).toBe(1);
    expect(agg.datedCompletions).toBe(0);
    expect(onTimePct(agg)).toBeNull();
  });

  /*
   * An order finishes once. A later day's row restating JobCompleted must not
   * move the date it finished on, or an order closed on Friday and touched
   * again the next week reads as late.
   */
  it('takes the first day the order was called finished', () => {
    const agg = assemblyMetrics([
      finished({ id: '2', job: 'A', day: '2026-09-14', due: '2026-09-10' }),
      finished({ id: '1', job: 'A', day: '2026-09-09', due: '2026-09-10' }),
    ]);
    expect(agg.completedOrders).toBe(1);
    expect(agg.onTimeOrders).toBe(1);
  });
});

describe('by line', () => {
  it('splits the window per line, in the order the floor is laid out', () => {
    const rows = [
      day({ id: '1', job: 'A', line: 'ASM' }),
      day({ id: '2', job: 'B', line: 'UPL-CUT' }),
      day({ id: '3', job: 'C', line: 'Laser' }),
    ];
    const lines = assemblyByLine(rows, ['UPL-CUT', 'ASM']);
    // Anything the board does not run still gets a row — after the ones it does.
    expect(lines.map((l) => l.line)).toEqual(['UPL-CUT', 'Assembly Seats', 'Laser']);
    expect(lines[0].agg.orders).toBe(1);
  });

  it('names a row that carries no line rather than dropping it', () => {
    const lines = assemblyByLine([day({ line: '  ' })], ['ASM']);
    expect(lines[0].line).toBe('(no line)');
  });

  it('rolls each line up into its orders, and an order across its days', () => {
    const lines = assemblyByLine(
      [
        day({ id: '1', job: 'A', day: '2026-09-08', complete: 10 }),
        day({ id: '2', job: 'A', day: '2026-09-09', complete: 20, completed: true, due: '2026-09-09' }),
        day({ id: '3', job: 'B', day: '2026-09-09', complete: 5 }),
      ],
      ['ASM'],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].agg.orders).toBe(2);
    const [a, b] = lines[0].orders;
    expect(a.job).toBe('A');
    expect(a.days).toBe(2);
    expect(a.agg.complete).toBe(30);
    expect(a.completed).toBe(true);
    expect(a.completedOn).toBe('2026-09-09');
    expect(b.days).toBe(1);
  });
});

describe('crew size', () => {
  it('counts the names on the row, however they are spaced', () => {
    expect(crewSize('Tom, Bo,  Alex')).toBe(3);
    expect(crewSize('')).toBe(0);
    expect(crewSize(undefined)).toBe(0);
  });
});

describe('the traffic light', () => {
  it('speaks PMD’s own language', () => {
    const { yieldGreen, yieldAmber } = ASSEMBLY_THRESHOLDS;
    expect(colourClass(99, yieldGreen, yieldAmber)).toBe('green');
    expect(colourClass(96, yieldGreen, yieldAmber)).toBe('amber');
    expect(colourClass(90, yieldGreen, yieldAmber)).toBe('red');
    // Nothing to judge is not a red light.
    expect(colourClass(null, yieldGreen, yieldAmber)).toBe('');
  });
});


it('combines legacy ASM and Assembly Seats records without losing output', () => {
  const rows = [day({ id: '1', job: 'A', line: 'ASM', complete: 10 }), day({ id: '2', job: 'B', line: 'Assembly Seats', complete: 20 })];
  const lines = assemblyByLine(rows, ['Assembly Seats']);
  expect(lines).toHaveLength(1);
  expect(lines[0].line).toBe('Assembly Seats');
  expect(lines[0].agg.complete).toBe(30);
  expect(lines[0].orders.map(order => order.line)).toEqual(['Assembly Seats', 'Assembly Seats']);
  expect(rows[0].line).toBe('ASM');
});
