import { describe, it, expect } from 'vitest';
import {
  monthOf,
  monthLabel,
  monthsIn,
  spansMonths,
  rollUpByMonth,
  type ChartBucket,
  type ChartShiftCell,
} from '../src/core/chartrollup';

const cell = (o: Partial<ChartShiftCell> = {}): ChartShiftCell => ({
  good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null, exp: null, ...o,
});

/** One day where only the Day shift worked — enough for the sums. */
const day = (key: string, o: Partial<ChartShiftCell> = {}): ChartBucket => ({
  key,
  label: key.slice(5),
  byShift: { Day: cell(o), Afternoon: cell(), Night: cell() },
});

describe('monthOf / monthsIn / spansMonths', () => {
  it('reads the calendar month off a date key', () => {
    expect(monthOf('2026-08-07')).toBe('2026-08');
  });

  it('lists the months present, oldest first, without duplicates', () => {
    expect(monthsIn([day('2026-08-01'), day('2026-06-30'), day('2026-06-01')]))
      .toEqual(['2026-06', '2026-08']);
  });

  it('only spans months when there is more than one', () => {
    expect(spansMonths([day('2026-08-01'), day('2026-08-31')])).toBe(false);
    expect(spansMonths([day('2026-07-31'), day('2026-08-01')])).toBe(true);
    expect(spansMonths([])).toBe(false);
  });
});

describe('monthLabel', () => {
  it('leaves the year off when the range stays inside one', () => {
    expect(monthLabel('2026-08', false)).toBe('Aug');
  });

  it('puts the year back when the range straddles New Year', () => {
    // "Dec" next to "Jan" is genuinely ambiguous about which comes first.
    expect(monthLabel('2025-12', true)).toBe('Dec 25');
    expect(monthLabel('2026-01', true)).toBe('Jan 26');
  });
});

describe('rollUpByMonth', () => {
  it('leaves a single-month range alone, sorted by date', () => {
    const out = rollUpByMonth([day('2026-08-03'), day('2026-08-01')]);
    expect(out.map((b) => b.key)).toEqual(['2026-08-01', '2026-08-03']);
    expect(out.every((b) => !b.isMonth && b.days === 1)).toBe(true);
  });

  it('sums earlier months into one bar and keeps the newest month daily', () => {
    const out = rollUpByMonth([
      day('2026-06-01', { good: 100 }),
      day('2026-06-02', { good: 50 }),
      day('2026-07-01', { good: 10 }),
      day('2026-08-01', { good: 7 }),
      day('2026-08-02', { good: 3 }),
    ]);
    expect(out.map((b) => `${b.label}${b.isMonth ? '*' : ''}`))
      .toEqual(['Jun*', 'Jul*', '08-01', '08-02']);
    expect(out[0].byShift.Day.good).toBe(150);
    expect(out[0].days).toBe(2);
  });

  it('opens just the month asked for', () => {
    const src = [
      day('2026-06-01', { good: 1 }),
      day('2026-06-02', { good: 2 }),
      day('2026-07-01', { good: 4 }),
      day('2026-08-01', { good: 8 }),
    ];
    const out = rollUpByMonth(src, new Set(['2026-06']));
    expect(out.map((b) => b.label)).toEqual(['06-01', '06-02', 'Jul', '08-01']);
    expect(out.find((b) => b.label === 'Jul')!.isMonth).toBe(true);
  });

  it('sums every field a chart plots, across all three shifts', () => {
    const two: ChartBucket[] = [
      {
        key: '2026-06-01',
        label: '06-01',
        byShift: {
          Day: cell({ good: 10, reject: 1, runHrs: 5, downHrs: 2, setupHrs: 1, exp: 20 }),
          Afternoon: cell({ good: 5, runHrs: 3 }),
          Night: cell({ downHrs: 8 }),
        },
      },
      {
        key: '2026-06-02',
        label: '06-02',
        byShift: {
          Day: cell({ good: 30, reject: 4, runHrs: 6, downHrs: 1, setupHrs: 1, exp: 40 }),
          Afternoon: cell({ good: 5, runHrs: 3 }),
          Night: cell({ downHrs: 8 }),
        },
      },
      day('2026-07-01'),
    ];
    const jun = rollUpByMonth(two)[0];
    expect(jun.byShift.Day).toMatchObject({
      good: 40, reject: 5, runHrs: 11, downHrs: 3, setupHrs: 2, exp: 60,
    });
    expect(jun.byShift.Afternoon.good).toBe(10);
    expect(jun.byShift.Night.downHrs).toBe(16);
  });

  it('gives a month efficiency that is the ratio of the sums, not the mean of the ratios', () => {
    // One busy day at 90% run and one nearly-idle day at 10% must not
    // average to 50% — the month ran 91 of its 110 logged hours.
    const out = rollUpByMonth([
      { key: '2026-06-01', label: '06-01',
        byShift: { Day: cell({ runHrs: 90, downHrs: 10 }), Afternoon: cell(), Night: cell() } },
      { key: '2026-06-02', label: '06-02',
        byShift: { Day: cell({ runHrs: 1, downHrs: 9 }), Afternoon: cell(), Night: cell() } },
      day('2026-07-01'),
    ]);
    const d = out[0].byShift.Day;
    const logged = d.runHrs + d.downHrs + d.setupHrs;
    expect(Math.round((d.runHrs / logged) * 100)).toBe(83); // not 50
  });

  it('keeps a month with no planning expectation at null rather than 0', () => {
    // exp 0 would render as "0% of plan"; null renders as no expectation.
    const out = rollUpByMonth([day('2026-06-01', { good: 5 }), day('2026-07-01')]);
    expect(out[0].byShift.Day.exp).toBeNull();
  });

  it('sums the expectation over only the days that had one', () => {
    const out = rollUpByMonth([
      day('2026-06-01', { good: 5, exp: 10 }),
      day('2026-06-02', { good: 5 }),
      day('2026-07-01'),
    ]);
    expect(out[0].byShift.Day.exp).toBe(10);
  });

  it('labels months with the year when the range crosses one', () => {
    const out = rollUpByMonth([
      day('2025-12-31', { good: 1 }),
      day('2026-01-15', { good: 2 }),
      day('2026-02-01', { good: 3 }),
    ]);
    expect(out.map((b) => b.label)).toEqual(['Dec 25', 'Jan 26', '02-01']);
  });

  it('gives a month bar its first day as key so it still sorts with the days', () => {
    const out = rollUpByMonth([day('2026-06-11'), day('2026-06-04'), day('2026-07-01')]);
    expect(out[0].key).toBe('2026-06-04');
    expect(out[0].month).toBe('2026-06');
  });

  it('ignores an expansion for the newest month — it is already daily', () => {
    const src = [day('2026-06-01'), day('2026-07-01'), day('2026-07-02')];
    const plain = rollUpByMonth(src);
    const withNewest = rollUpByMonth(src, new Set(['2026-07']));
    expect(withNewest.map((b) => b.label)).toEqual(plain.map((b) => b.label));
  });

  it('handles an empty range', () => {
    expect(rollUpByMonth([])).toEqual([]);
  });

  it('does not mutate the buckets it was given', () => {
    const src = [day('2026-06-01', { good: 10 }), day('2026-06-02', { good: 5 }), day('2026-07-01')];
    rollUpByMonth(src);
    expect(src[0].byShift.Day.good).toBe(10);
    expect(src.map((b) => b.key)).toEqual(['2026-06-01', '2026-06-02', '2026-07-01']);
  });
});
