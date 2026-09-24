import { describe, expect, it } from 'vitest';
import {
  FOLDED_WEEK_PX,
  foldedWidths,
  isoWeek,
  mergeEntries,
  weekKeyOf,
  weekLoad,
  weekSpans,
} from '@/features/assembly/weekFold';

const d = (iso: string) => new Date(`${iso}T00:00:00`);
/** Weekdays from Thursday 24 Sep 2026, weekends left out as the board draws them. */
const weekdays = (count: number): Date[] => {
  const out: Date[] = [];
  for (let day = d('2026-09-24'); out.length < count; day = new Date(day.getTime() + 86_400_000)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) out.push(new Date(day));
  }
  return out;
};

describe('weeks on the timeline', () => {
  it('names a week by its Monday and its ISO number', () => {
    expect(weekKeyOf(d('2026-09-24'))).toBe('2026-09-21');
    expect(weekKeyOf(d('2026-09-27'))).toBe('2026-09-21'); // Sunday
    expect(isoWeek(d('2026-09-24'))).toBe(39);
    expect(isoWeek(d('2026-01-01'))).toBe(1);
    expect(isoWeek(d('2027-01-01'))).toBe(53);
  });

  it('opens this week and next, and folds every week after', () => {
    const spans = weekSpans(weekdays(17), d('2026-09-24'), {});
    expect(spans.map((s) => [s.label, s.to - s.from, s.folded])).toEqual([
      ['W39', 2, false],
      ['W40', 5, false],
      ['W41', 5, true],
      ['W42', 5, true],
    ]);
  });

  it('keeps what the reader chose for a week', () => {
    const spans = weekSpans(weekdays(12), d('2026-09-24'), { '2026-09-21': true, '2026-10-05': false });
    expect(spans.map((s) => s.folded)).toEqual([true, false, false]);
  });

  it('gives a folded week one column’s width, shared by its days', () => {
    const spans = weekSpans(weekdays(12), d('2026-09-24'), {});
    const widths = foldedWidths(spans, () => 160);
    expect(widths.slice(0, 7)).toEqual(Array(7).fill(160));
    expect(widths.slice(7).reduce((a, b) => a + b, 0)).toBeCloseTo(FOLDED_WEEK_PX, 6);
  });

  it('sums a week’s load before banding it', () => {
    const week = weekLoad([
      { crewed: 30, waiting: 0, capacity: 30 },
      { crewed: 0, waiting: 0, capacity: 30 },
    ]);
    expect(week.pct).toBe(50);
    expect(week.band).toBe('green');
  });

  it('lists an order worked on several days of the week once', () => {
    const merged = mergeEntries([
      [{ jobId: 'A', kind: 'crewed', hours: 7.5 }],
      [{ jobId: 'A', kind: 'crewed', hours: 7.5 }, { jobId: 'B', kind: 'waiting', hours: 3 }],
    ]);
    expect(merged).toEqual([
      { jobId: 'A', kind: 'crewed', hours: 15 },
      { jobId: 'B', kind: 'waiting', hours: 3 },
    ]);
  });
});
