import { describe, expect, it } from 'vitest';
import {
  completedOrderDays,
  completionSummary,
  completionsByPerson,
  isCompletionOnly,
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
  it('keeps a row opened only to hold a completion out of the board’s figures', () => {
    expect(isCompletionOnly(row({ epicor: epicor() }))).toBe(true);
    expect(isCompletionOnly(row({ epicor: epicor(), operators: 'Ana', complete: 4 }))).toBe(false);
    expect(isCompletionOnly(row())).toBe(false);
  });

  it('judges an order on time by its Due Date, once however many days it took', () => {
    const done = completedOrderDays([
      row({ epicor: epicor() }),
      row({ id: '2', day: '2026-11-21', epicor: epicor({ qty: 5, hours: 3 }) }),
      row({ id: '3', job: 'J2', due: null, epicor: epicor({ people: ['Cy'] }) }),
      row({ id: '4', job: 'J3' }),
    ]);
    expect(done.map((d) => [d.job, d.day, d.onTime])).toEqual([
      ['J1', '2026-11-21', false],
      ['J1', '2026-11-17', true],
      ['J2', '2026-11-17', null],
    ]);
    expect(completionSummary(done)).toEqual({ orders: 2, qty: 25, stdHours: 15, people: 3, datedOrders: 1, onTimeOrders: 0 });
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
