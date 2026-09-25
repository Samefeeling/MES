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
import { zoomIn, zoomOut } from '@/store/uiStore';

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

  it('splits the drawn days into their weeks, folded only in week view', () => {
    const spans = weekSpans(weekdays(17), true);
    expect(spans.map((s) => [s.label, s.to - s.from, s.folded])).toEqual([
      ['W39', 2, true],
      ['W40', 5, true],
      ['W41', 5, true],
      ['W42', 5, true],
    ]);
    expect(weekSpans(weekdays(17), false).every((s) => !s.folded)).toBe(true);
  });

  it('lets one week be folded or opened from its heading, over the zoom', () => {
    expect(weekSpans(weekdays(12), false, { '2026-09-28': true }).map((s) => s.folded)).toEqual([false, true, false]);
    expect(weekSpans(weekdays(12), true, { '2026-09-21': false }).map((s) => s.folded)).toEqual([false, true, true]);
  });

  it('gives a folded week one column’s width, shared by its days', () => {
    const widths = foldedWidths(weekSpans(weekdays(12), true), () => 160);
    expect(widths.slice(2, 7).reduce((a, b) => a + b, 0)).toBeCloseTo(FOLDED_WEEK_PX, 6);
    expect(foldedWidths(weekSpans(weekdays(12), false), () => 160)).toEqual(Array(12).fill(160));
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

describe('the timeline zoom', () => {
  it('steps from weeks through 44 px up to 200 px, and back down to weeks', () => {
    let state = { dayWidth: 44, weekView: false };
    const seen: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      state = zoomIn(state);
      seen.push(state.weekView ? 'weeks' : String(state.dayWidth));
    }
    expect(seen).toEqual(['64', '88', '120', '160', '200', '200', '200']);
    seen.length = 0;
    for (let i = 0; i < 8; i += 1) {
      state = zoomOut(state);
      seen.push(state.weekView ? 'weeks' : String(state.dayWidth));
    }
    expect(seen).toEqual(['160', '120', '88', '64', '44', 'weeks', 'weeks', 'weeks']);
    expect(zoomIn(state)).toEqual({ dayWidth: 44, weekView: false });
  });

  it('snaps a width dragged off the ladder to the next step', () => {
    expect(zoomIn({ dayWidth: 100, weekView: false }).dayWidth).toBe(120);
    expect(zoomOut({ dayWidth: 100, weekView: false }).dayWidth).toBe(88);
  });
});
