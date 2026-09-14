import { describe, expect, it } from 'vitest';
import { dayAxis, dragColumns } from '@/features/assembly/dayAxis';
import { DAY_COLUMN_LIMITS, useUiStore } from '@/store/uiStore';

const even = dayAxis({ widths: [100, 100, 100], fallback: 100 });
const uneven = dayAxis({ widths: [100, 300, 50], fallback: 100 });

describe('the day grid, when the columns are not the same width', () => {
  it('places a day at the sum of the ones before it', () => {
    expect(uneven.offsets).toEqual([0, 100, 400, 450]);
    expect(uneven.total).toBe(450);
    expect(uneven.x(0)).toBe(0);
    expect(uneven.x(1)).toBe(100);
    expect(uneven.x(3)).toBe(450);
  });

  it('places a part-way point across the column it is actually in', () => {
    // Half of the wide middle day is 150 px, not half of the default width.
    expect(uneven.x(1.5)).toBe(250);
    expect(uneven.x(2.5)).toBe(425);
    expect(even.x(1.5)).toBe(150);
  });

  it('reads a pixel back as the day it lands in', () => {
    for (const day of [0, 0.25, 1, 1.75, 2, 2.5, 3]) {
      expect(uneven.day(uneven.x(day))).toBeCloseTo(day, 9);
    }
  });

  /*
   * A bar can be dragged past the end of the horizon, and the day it lands on
   * still has to be a number: a wall at the last column would pile every such
   * drag onto the same day, which is the one answer that is certainly wrong.
   */
  it('keeps going past both ends at the end column’s width', () => {
    expect(uneven.x(-1)).toBe(-100);
    expect(uneven.x(4)).toBe(500);
    expect(uneven.day(-100)).toBe(-1);
    expect(uneven.day(500)).toBe(4);
  });

  it('still answers on a board with no days on it', () => {
    const empty = dayAxis({ widths: [], fallback: 80 });
    expect(empty.total).toBe(0);
    expect(empty.x(2)).toBe(160);
    expect(empty.day(160)).toBe(2);
  });

  /*
   * The whole point of the axis: the same pointer travel is worth a different
   * number of days depending on which column it started on.
   */
  it('turns pointer travel into days from where the bar stands', () => {
    expect(dragColumns(uneven, 0, 100)).toBeCloseTo(1, 9);
    // 100 px across the 300 px-wide second day is a third of it.
    expect(dragColumns(uneven, 1, 100)).toBeCloseTo(1 / 3, 9);
    expect(dragColumns(uneven, 2, 50)).toBeCloseTo(1, 9);
    expect(dragColumns(uneven, 1, 0)).toBe(0);
  });
});

describe('a day column dragged off the zoom', () => {
  it('keeps the width against its own day, and clamps it', () => {
    const ui = useUiStore.getState();
    ui.setDayColumnWidth('2026-09-14', 300);
    expect(useUiStore.getState().dayWidths['2026-09-14']).toBe(300);
    ui.setDayColumnWidth('2026-09-15', 5);
    expect(useUiStore.getState().dayWidths['2026-09-15']).toBe(DAY_COLUMN_LIMITS.min);
    ui.setDayColumnWidth('2026-09-16', 9999);
    expect(useUiStore.getState().dayWidths['2026-09-16']).toBe(DAY_COLUMN_LIMITS.max);
  });

  it('gives one day back to the zoom without disturbing the others', () => {
    useUiStore.getState().clearDayColumnWidth('2026-09-15');
    const { dayWidths } = useUiStore.getState();
    expect(dayWidths['2026-09-15']).toBeUndefined();
    expect(dayWidths['2026-09-14']).toBe(300);
  });

  // A zoom that left half the board where it was would be a zoom that visibly
  // does nothing, so it takes every dragged column back with it.
  it('is cleared by the timeline zoom', () => {
    useUiStore.getState().setDayWidth(96);
    expect(useUiStore.getState().dayWidth).toBe(96);
    expect(useUiStore.getState().dayWidths).toEqual({});
  });
});
