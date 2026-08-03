import { describe, expect, it } from 'vitest';

import { collectChangeoverEvents } from '../src/core/changeover';
import { boxStats } from '../src/core/boxplot';
import { changeoverBoxSeries } from '../src/ui/kpi';
import { rec } from './helpers';
import type { StatusCode } from '../src/types';

/** Slots `from..to` of one status on one machine/shift/order. */
const slots = (
  code: StatusCode,
  from: number,
  to: number,
  over: Partial<ReturnType<typeof rec>> = {},
) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    rec({
      jobNumber: 'J1',
      machineCode: '125T',
      shiftId: '2026-05-15-Day',
      slotIndex: from + i,
      statusCode: code,
      ...over,
    }),
  );

const hoursOf = (evts: ReturnType<typeof collectChangeoverEvents>, kind: string) =>
  evts.filter((e) => e.kind === kind).map((e) => e.hours);

describe('collectChangeoverEvents — a changeover belongs to an order', () => {
  it('counts every D under one order as ONE die change, however scattered', () => {
    // Three D slots, a run, then two more D slots — one interrupted die
    // change, not two. Counting contiguous runs would report 1.5 h and
    // 1.0 h instead of the 2.5 h it actually cost.
    const evts = collectChangeoverEvents([
      ...slots('D', 0, 2),
      ...slots('R', 3, 5),
      ...slots('D', 6, 7),
    ]);
    expect(hoursOf(evts, 'die')).toEqual([2.5]);
  });

  it('does the same for colour and insert changes', () => {
    const evts = collectChangeoverEvents([
      ...slots('C', 0, 0),
      ...slots('R', 1, 1),
      ...slots('C', 2, 2),
      ...slots('I', 3, 3),
      ...slots('R', 4, 4),
      ...slots('I', 5, 6),
    ]);
    expect(hoursOf(evts, 'color')).toEqual([1]);
    expect(hoursOf(evts, 'insert')).toEqual([1.5]);
  });

  it('separates the same status on two different orders', () => {
    const evts = collectChangeoverEvents([
      ...slots('D', 0, 1, { jobNumber: 'A' }),
      ...slots('D', 2, 7, { jobNumber: 'B' }),
    ]);
    expect(hoursOf(evts, 'die').sort()).toEqual([1, 3]);
  });

  it('separates the same order run on two presses', () => {
    // One order, two machines: each press had its own die put in.
    const evts = collectChangeoverEvents([
      ...slots('D', 0, 1, { machineCode: '125T' }),
      ...slots('D', 0, 3, { machineCode: '550T' }),
    ]);
    expect(hoursOf(evts, 'die').sort()).toEqual([1, 2]);
    expect(evts.map((e) => e.machineCode).sort()).toEqual(['125T', '550T']);
  });

  it('keeps an order’s changeover whole across a shift boundary', () => {
    const evts = collectChangeoverEvents([
      ...slots('D', 14, 15, { shiftId: '2026-05-15-Day' }),
      ...slots('D', 0, 1, { shiftId: '2026-05-15-Afternoon' }),
    ]);
    expect(hoursOf(evts, 'die')).toEqual([2]);
  });
});

describe('collectChangeoverEvents — a breakdown is one unbroken run', () => {
  it('splits two stoppages in a shift into two events', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 0, 1),
      ...slots('R', 2, 4),
      ...slots('B', 5, 5),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([1, 0.5]);
  });

  it('joins a stoppage that carries across the shift change', () => {
    // 14:30 in Day and 15:00 in Afternoon are the same half-hour apart —
    // the press never restarted, so it is one breakdown.
    const evts = collectChangeoverEvents([
      ...slots('B', 15, 15, { shiftId: '2026-05-15-Day' }),
      ...slots('B', 0, 1, { shiftId: '2026-05-15-Afternoon' }),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([1.5]);
  });

  it('treats an unrecorded half-hour as a break in the run', () => {
    // Slot 2 has no row at all: nothing says the press was still down.
    const evts = collectChangeoverEvents([...slots('B', 0, 1), ...slots('B', 3, 3)]);
    expect(hoursOf(evts, 'down')).toEqual([1, 0.5]);
  });

  it('does not join two presses that broke down at the same moment', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 0, 1, { machineCode: '125T' }),
      ...slots('B', 0, 1, { machineCode: '550T' }),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([1, 1]);
    expect(new Set(evts.map((e) => e.machineCode)).size).toBe(2);
  });

  it('ignores the order number — a breakdown spanning two orders is one', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 0, 1, { jobNumber: 'A' }),
      ...slots('B', 2, 3, { jobNumber: 'B' }),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([2]);
  });

  it('is interrupted by a changeover, not just by production', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 0, 0),
      ...slots('D', 1, 1),
      ...slots('B', 2, 2),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([0.5, 0.5]);
  });
});

describe('collectChangeoverEvents — edges', () => {
  it('falls back to contiguous runs for a changeover with no order', () => {
    // No order to group by, so grouping them all would invent a single
    // multi-hour "die change" out of unrelated slots.
    const evts = collectChangeoverEvents([
      ...slots('D', 0, 1, { jobNumber: '' }),
      ...slots('R', 2, 3, { jobNumber: '' }),
      ...slots('D', 4, 4, { jobNumber: '' }),
    ]);
    expect(hoursOf(evts, 'die')).toEqual([1, 0.5]);
  });

  it('ignores statuses that are neither a changeover nor a breakdown', () => {
    const evts = collectChangeoverEvents([
      ...slots('R', 0, 3),
      ...slots('S', 4, 5),
      ...slots('M', 6, 6),
      ...slots('O', 7, 7),
      ...slots('P', 8, 8),
    ]);
    expect(evts).toEqual([]);
  });

  it('skips blank statuses and unparseable shift ids rather than guessing', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 0, 0),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: '' }),
      rec({ jobNumber: 'J1', slotIndex: 2, statusCode: 'B', shiftId: 'not-a-shift' }),
    ]);
    expect(hoursOf(evts, 'down')).toEqual([0.5]);
  });

  it('returns events oldest first', () => {
    const evts = collectChangeoverEvents([
      ...slots('B', 10, 10),
      ...slots('D', 0, 0, { jobNumber: 'A' }),
      ...slots('B', 4, 4),
    ]);
    expect(evts.map((e) => e.slotIndex)).toEqual([0, 4, 10]);
  });
});

describe('boxStats — Tukey five-number summary', () => {
  it('matches the spreadsheet on a known set', () => {
    // PERCENTILE.INC over 1..9 → Q1 3, median 5, Q3 7.
    const s = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9])!;
    expect([s.q1, s.median, s.q3]).toEqual([3, 5, 7]);
    expect([s.min, s.max, s.n]).toEqual([1, 9, 9]);
    expect(s.mean).toBe(5);
    expect(s.outliers).toEqual([]);
  });

  it('interpolates between order statistics', () => {
    const s = boxStats([1, 2, 3, 4])!;
    expect(s.q1).toBeCloseTo(1.75, 10);
    expect(s.median).toBeCloseTo(2.5, 10);
    expect(s.q3).toBeCloseTo(3.25, 10);
  });

  it('pulls a far point out as an outlier and stops the whisker short', () => {
    const s = boxStats([4, 4, 4.5, 4.5, 5, 5, 20])!;
    expect(s.outliers).toEqual([20]);
    expect(s.upperWhisker).toBe(5);
    // The whisker is a real data point, never the fence itself.
    expect(s.max).toBe(20);
  });

  it('handles a single event, and no events at all', () => {
    const one = boxStats([3])!;
    expect([one.q1, one.median, one.q3, one.lowerWhisker, one.upperWhisker]).toEqual([3, 3, 3, 3, 3]);
    expect(one.outliers).toEqual([]);
    expect(boxStats([])).toBeNull();
  });

  it('keeps a point sitting exactly on the fence inside the whisker', () => {
    // Q1 2, Q3 4, IQR 2 → upper fence exactly 7.
    const s = boxStats([1, 2, 3, 4, 5, 7])!;
    expect(s.outliers).toEqual([]);
    expect(s.upperWhisker).toBe(7);
  });
});

describe('changeoverBoxSeries — what the chart is handed', () => {
  const evts = collectChangeoverEvents([
    ...slots('D', 0, 7),
    ...slots('C', 8, 8),
    ...slots('I', 9, 9),
    ...slots('B', 10, 11),
  ]);

  it('always offers the four categories in cost order, with their standards', () => {
    const series = changeoverBoxSeries(evts);
    expect(series.map((s) => s.label)).toEqual([
      'Die Change',
      'Colour Change',
      'Insert Change',
      'Breakdown',
    ]);
    expect(series.map((s) => s.std)).toEqual([4, 0.5, 0.5, null]);
  });

  it('names every point by press, order and shift so an outlier is traceable', () => {
    const die = changeoverBoxSeries(evts)[0];
    expect(die.points).toEqual([{ value: 4, label: '125T · J1 · 2026-05-15-Day' }]);
  });

  it('keeps an empty category rather than dropping the box', () => {
    const series = changeoverBoxSeries(collectChangeoverEvents(slots('B', 0, 0)));
    expect(series).toHaveLength(4);
    expect(series[0].points).toEqual([]);
    expect(series[3].points).toHaveLength(1);
  });
});
