import { describe, expect, it } from 'vitest';
import {
  completedOrderDays,
  completionSummary,
  completionsByLine,
  completionsByPerson,
  filterCompletions,
} from '../src/core/assembly-completions';
import { epicorOf } from '../src/dal/sharepoint/assembly';
import type { AssemblyResult, EpicorCompletion } from '../src/types/assembly';

const epicor = (over: Partial<EpicorCompletion> = {}): EpicorCompletion => ({
  qty: 10, hours: 6, partNum: 'P1', at: null, people: ['Ana', 'Bo'], confirmedBy: 'Jeff', confirmedAt: '2026-11-18T07:00:00Z', ...over,
});

const row = (over: Partial<AssemblyResult> = {}): AssemblyResult => ({
  id: '1', job: 'J1', day: '2026-11-17', line: 'Assembly', operators: '', output: 0, complete: 0, reject: 0, rework: 0,
  completed: false, due: '2026-11-20T00:00:00Z', completedAt: null, epicor: null, ...over,
});

describe('Epicor completions on KPIs · Assembly', () => {
  it('reads a row added by hand without Epicor’s columns from its own figures', () => {
    const [d] = completedOrderDays([
      row({ complete: 20, plannedHours: 10, orderQty: 40, operators: 'Ana, Bo', completed: true }),
      row({ id: '2', job: 'J9' }),
    ]);
    expect(d).toMatchObject({ job: 'J1', qty: 20, stdHours: 5, people: ['Ana', 'Bo'], finished: true });
  });

  it('counts person-days once per person per day, and efficiency over them', () => {
    const done = completedOrderDays([
      row({ epicor: epicor({ hours: 6, people: ['Ana', 'Bo'] }) }),
      row({ id: '2', job: 'J2', epicor: epicor({ hours: 9, people: ['ana'] }) }),
      row({ id: '3', job: 'J3', line: 'Table', day: '2026-11-18', epicor: epicor({ hours: 7.5, people: ['Ana'] }) }),
    ]);
    const sum = completionSummary(done);
    // Ana 17th, Bo 17th, Ana 18th: 22.5 h over three person-days.
    expect(sum).toMatchObject({ personDays: 3, perPersonDay: 7.5, efficiency: 100 });
    const lines = completionsByLine(done, ['Table', 'Assembly']);
    expect(lines.map((l) => [l.line, l.summary.orders, l.summary.personDays])).toEqual([
      ['Table', 1, 1],
      ['Assembly', 2, 2],
    ]);
    expect(lines[1].orders.map((o) => o.job)).toEqual(['J1', 'J2']);
  });

  it('judges On time per order: the day it was finished in full against its Due Date', () => {
    // Due 20/11. J1 part on the 17th, finished on the 21st: late. J4 finished
    // on the 19th: on time. J5 part on the 18th, not finished: not judged.
    const done = completedOrderDays([
      row({ epicor: epicor() }),
      row({ id: '2', day: '2026-11-21', completed: true, epicor: epicor({ qty: 5, hours: 3 }) }),
      row({ id: '3', job: 'J2', due: null, completed: true, epicor: epicor({ people: ['Cy'] }) }),
      row({ id: '4', job: 'J3' }),
      row({ id: '5', job: 'J4', day: '2026-11-19', completed: true, epicor: epicor() }),
      row({ id: '6', job: 'J5', day: '2026-11-18', epicor: epicor() }),
    ]);
    expect(done.map((d) => [d.job, d.day, d.onTime])).toEqual([
      ['J1', '2026-11-21', false],
      ['J4', '2026-11-19', true],
      ['J5', '2026-11-18', null],
      ['J1', '2026-11-17', null],
      ['J2', '2026-11-17', null],
    ]);
    // Judged: J1 (late) and J4 (on time). J2 has no Due Date, J5 is not finished.
    expect(completionSummary(done)).toMatchObject({ orders: 4, datedOrders: 2, onTimeOrders: 1 });
  });

  it('counts a part delivered after the Due Date as late before the order is finished', () => {
    const [d] = completedOrderDays([row({ day: '2026-11-23', epicor: epicor() })]);
    expect(d.onTime).toBe(false);
    expect(completionSummary([d])).toMatchObject({ datedOrders: 0 });
  });

  it('shares an order’s standard hours among the people who finished it', () => {
    const done = completedOrderDays([
      row({ epicor: epicor({ hours: 6, people: ['Ana', 'Bo'] }) }),
      row({ id: '2', job: 'J2', epicor: epicor({ hours: 4.5, people: ['ana'] }) }),
      row({ id: '3', job: 'J3', day: '2026-11-18', epicor: epicor({ hours: 9, people: ['Ana', 'Bo', 'Cy'] }) }),
    ]);
    expect(completionsByPerson(done)).toEqual([
      { name: 'Ana', orders: 3, stdHours: 10.5, days: 2, perDay: 5.25, efficiency: 70 },
      { name: 'Bo', orders: 2, stdHours: 6, days: 2, perDay: 3, efficiency: 40 },
      { name: 'Cy', orders: 1, stdHours: 3, days: 1, perDay: 3, efficiency: 40 },
    ]);
  });

  it('reads a completion off the list only once it is confirmed', () => {
    const f = { epicorQty: 'EpicorQty', epicorHours: 'EpicorHours', epicorPartNum: 'EpicorPartNum', epicorCompletedAt: 'EpicorCompletedAt', completedBy: 'CompletedBy', confirmedBy: 'CompletionConfirmedBy', confirmedAt: 'CompletionConfirmedAt' };
    expect(epicorOf({ EpicorQty: 12, EpicorHours: 3.5, EpicorPartNum: 'P', CompletedBy: 'Ana, Bo', CompletionConfirmedBy: 'Jeff', CompletionConfirmedAt: '2026-11-18T07:00:00Z' }, f))
      .toMatchObject({ qty: 12, hours: 3.5, people: ['Ana', 'Bo'], confirmedBy: 'Jeff' });
    expect(epicorOf({ EpicorQty: 12 }, f)).toBeNull();
    expect(epicorOf({ CompletionConfirmedAt: 'x' }, f)).toBeNull();
  });
});

describe('the last month, week by week', () => {
  it('takes the week yesterday is in and the four before it', async () => {
    const { trendWeeks, mondayOf } = await import('../src/core/assembly-completions');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
    expect(trendWeeks('2026-11-21')).toEqual({
      weeks: ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'],
      from: '2026-10-19',
      to: '2026-11-21',
    });
  });

  it('gives each line and each person a week’s efficiency, null for a week with nothing', async () => {
    const { weeklyLineEfficiency, weeklyPersonEfficiency, weeklyEfficiency } = await import('../src/core/assembly-completions');
    const done = completedOrderDays([
      row({ day: '2026-11-17', epicor: epicor({ hours: 15, people: ['Ana', 'Bo'] }) }),
      row({ id: '2', job: 'J2', day: '2026-11-10', line: 'Table', epicor: epicor({ hours: 7.5, people: ['Ana'] }) }),
    ]);
    const weeks = ['2026-11-09', '2026-11-16'];
    expect(weeklyLineEfficiency(done, weeks, ['Table', 'Assembly'])).toEqual([
      { name: 'Table', values: [100, null] },
      { name: 'Assembly', values: [null, 100] },
    ]);
    expect(weeklyPersonEfficiency(done, weeks, 'ana')).toEqual([100, 100]);
    expect(weeklyPersonEfficiency(done, weeks, 'Bo')).toEqual([null, 100]);
    expect(weeklyEfficiency(done, weeks)).toEqual([100, 100]);
  });
});

describe('who, on KPIs · Assembly', () => {
  const done = completedOrderDays([
    row({ epicor: epicor({ hours: 9, people: ['Billy', 'Husham', 'Malcom'] }) }),
    row({ id: '2', job: 'J2', epicor: epicor({ hours: 3, people: ['billy', 'Luis'] }) }),
    row({ id: '3', job: 'J3', line: 'Table', epicor: epicor({ hours: 6, people: ['Yen'] }) }),
  ]);

  it('shares each order equally: every person\'s Std h adds up to the total, never more', () => {
    const people = completionsByPerson(done);
    expect(people.map((p) => [p.name, p.orders, p.stdHours])).toEqual([
      ['Yen', 1, 6],
      ['Billy', 2, 4.5],
      ['Husham', 1, 3],
      ['Malcom', 1, 3],
      ['Luis', 1, 1.5],
    ]);
    const shared = people.reduce((a, p) => a + p.stdHours, 0);
    expect(shared).toBeCloseTo(completionSummary(done).stdHours);
  });

  it('names the people on a line, once each whatever their case', () => {
    const [assembly, table] = completionsByLine(done, ['Assembly', 'Table']);
    expect(assembly.summary.names).toEqual(['Billy', 'Husham', 'Luis', 'Malcom']);
    expect(assembly.orders.find((o) => o.job === 'J2')!.summary.names).toEqual(['billy', 'Luis']);
    expect(table.summary.names).toEqual(['Yen']);
  });

  it('narrows the completions to a person, an order, or both', () => {
    expect(filterCompletions(done, { person: 'BILLY' }).map((d) => d.job)).toEqual(['J1', 'J2']);
    expect(filterCompletions(done, { job: 'J3' }).map((d) => d.job)).toEqual(['J3']);
    expect(filterCompletions(done, { person: 'Billy', job: 'J3' })).toEqual([]);
    expect(filterCompletions(done, {})).toHaveLength(3);
  });
});
