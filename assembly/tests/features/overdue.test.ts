import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import { overdueStatus, scheduleStatus } from '@/engine/assembly/dates';
import { overdueDays, overdueOrders, overdueTsv } from '@/features/assembly/overdue';

const d = (iso: string) => new Date(`${iso}T00:00:00`);
const TODAY = new Date('2026-09-24T10:30:00');

const row = (
  id: string,
  due: string | null,
  over: Partial<{ remaining: number; expect: string | null; completedToday: boolean; schedulable: boolean; operation: object }> = {},
): OrderRow =>
  ({
    job: {
      id,
      partNum: `P-${id}`,
      description: `Chair ${id}`,
      dueDate: due ? d(due) : null,
      remainingQty: over.remaining ?? 10,
      operation: over.operation,
    },
    line: { schedulable: over.schedulable ?? true, name: 'Assembly' },
    expectDate: over.expect === undefined ? d('2026-09-30') : over.expect ? d(over.expect) : null,
    completedToday: over.completedToday ?? false,
  }) as unknown as OrderRow;

describe('an order past its Due Date', () => {
  it('is overdue from the day after it was due, not on the day itself', () => {
    expect(overdueDays(row('A', '2026-09-23'), TODAY)).toBe(1);
    expect(overdueDays(row('A', '2026-09-24'), TODAY)).toBeNull();
    expect(overdueDays(row('A', '2026-09-20'), TODAY)).toBe(4);
  });

  it('is not overdue once finished, or with no Due Date', () => {
    expect(overdueDays(row('A', '2026-09-20', { completedToday: true }), TODAY)).toBeNull();
    expect(overdueDays(row('A', '2026-09-20', { remaining: 0 }), TODAY)).toBeNull();
    expect(overdueDays(row('A', null), TODAY)).toBeNull();
  });

  it('reads red and says overdue, even with no Expect Date to compare', () => {
    const job = { dueDate: d('2026-09-22'), remainingQty: 5 };
    const noCrew = overdueStatus(scheduleStatus(null, job.dueDate), job, TODAY);
    expect(noCrew.color).toBe('red');
    expect(noCrew.reason).toMatch(/^Overdue 2 days — due/);
    // Not yet due: the forecast is left alone.
    const ahead = { dueDate: d('2026-10-22'), remainingQty: 5 };
    const green = scheduleStatus(d('2026-10-01'), ahead.dueDate);
    expect(overdueStatus(green, ahead, TODAY)).toBe(green);
  });
});

describe('the overdue list for logistics', () => {
  it('lists each late assembly order once, most overdue first, with the date to rebook to', () => {
    const list = overdueOrders(
      [
        row('A', '2026-09-23'),
        row('B', '2026-09-18', { expect: null }),
        row('C', '2026-09-30'),
        row('PMD1', '2026-09-01', { schedulable: false }),
        row('D#10', '2026-09-22', { expect: '2026-09-28', operation: { index: 1, last: false } }),
        row('D#20', '2026-09-22', { expect: '2026-10-02', remaining: 4, operation: { index: 2, last: true } }),
      ],
      TODAY,
    );
    expect(list.map((o) => [o.orderNum, o.daysOver])).toEqual([
      ['B', 6],
      ['D', 2],
      ['A', 1],
    ]);
    const routed = list[1];
    // Finished when its last operation is; opened at the first.
    expect(routed.expectDate).toEqual(d('2026-10-02'));
    expect(routed.rowId).toBe('D#10');
    expect(routed.qtyLeft).toBe(10);
    expect(list[0].expectDate).toBeNull();
  });

  it('copies as tab-separated text with day-first dates', () => {
    const tsv = overdueTsv(overdueOrders([row('B', '2026-09-18', { expect: null }), row('A', '2026-09-23')], TODAY));
    expect(tsv.split('\n')).toEqual([
      'Order\tPart\tDescription\tLine\tQty left\tDue Date\tDays overdue\tExpected finish',
      'B\tP-B\tChair B\tAssembly\t10\t18/09/2026\t6\tno crew — no date',
      'A\tP-A\tChair A\tAssembly\t10\t23/09/2026\t1\t30/09/2026',
    ]);
  });
});
