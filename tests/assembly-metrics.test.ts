import { describe, it, expect } from 'vitest';
import { assemblyMetrics } from '../src/core/assembly-metrics';
import type { AssemblyResult } from '../src/types/assembly';

describe('Assembly metrics', () => {
  it('adds daily quantities but counts the same order once', () => {
    const row: AssemblyResult = { id: '1', job: 'J1', day: '2026-09-08', line: 'UPL', operators: 'Tom', output: 10,
      complete: 8, reject: 1, rework: 1, completed: true, due: null, completedAt: null };
    expect(assemblyMetrics([row, { ...row, id: '2', day: '2026-09-09', output: 5 }])).toEqual({
      supportHours: 0, supportOrders: 0, orders: 1, output: 15, complete: 16, reject: 2, rework: 2, completedOrders: 1,
    });
  });
  it('has no manufactured production in an empty period', () => {
    expect(assemblyMetrics([])).toEqual({ supportHours: 0, supportOrders: 0, orders: 0, output: 0, complete: 0, reject: 0, rework: 0, completedOrders: 0 });
  });
});

it('keeps support work out of manufactured order and quantity totals', () => {
  const row: AssemblyResult = { id: 's1', job: 'FG-one', day: '2026-09-09', line: 'Factory General',
    operators: 'Alex', output: 0, complete: 0, reject: 0, rework: 0, completed: true, due: null,
    completedAt: null, workType: 'Support', laborHours: 7.5 };
  const result = assemblyMetrics([row, { ...row, id: 's2', day: '2026-09-10', laborHours: 2 }]);
  expect(result.supportHours).toBe(9.5);
  expect(result.supportOrders).toBe(1);
  expect(result.orders).toBe(0);
  expect(result.completedOrders).toBe(0);
  expect(result.output).toBe(0);
});
