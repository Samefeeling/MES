import { describe, expect, it } from 'vitest';
import { barDragLanding, type BarDragData } from '@/features/assembly/barDrag';
import { dayAxis } from '@/features/assembly/dayAxis';
import { LINES, readLineKey } from '@/domain/assembly';
const at = (hour: number, minute = 0) => new Date(2026, 8, 11, hour, minute);
// An even grid, so these cases still read as "510 px is one column".
const even = dayAxis({ widths: Array.from({ length: 10 }, () => 510), fallback: 510 });
const data: BarDragData = { jobId: 'A', startISO: at(8, 30).toISOString(), floorISO: at(7).toISOString(), axis: even, fromDay: 0, showWeekends: false };
describe('the drop and its time guide', () => {
  it('uses the visible shift clock and skips a break', () => {
    expect(barDragLanding(data, 60)).toEqual(at(9, 30));
    expect(barDragLanding(data, 35)).toEqual(at(9, 15));
  });
  it('shows the original position for a movement too small to save', () => {
    const short = { ...data, startISO: at(8, 31).toISOString() };
    expect(barDragLanding(short, 0)).toEqual(at(8, 31));
    expect(barDragLanding(short, 1)).toEqual(at(8, 31));
  });
  it('shows a predecessor floor instead of promising an impossible landing', () => {
    expect(barDragLanding({ ...data, floorISO: at(8).toISOString() }, -120)).toEqual(at(8));
  });
  it('keeps a marked set on its existing whole-column rule', () => {
    const group = { ...data, moveWith: [{ jobId: 'A', startISO: data.startISO, floorISO: data.floorISO! }, { jobId: 'B', startISO: at(10).toISOString(), floorISO: data.floorISO! }] };
    expect(barDragLanding(group, 20)).toEqual(at(8, 30));
    expect(barDragLanding(group, 510)).toEqual(new Date(2026, 8, 14, 8, 30));
  });
  /*
   * A column the reader has dragged wider is worth more pixels than its
   * neighbours, and the same pointer travel across it therefore has to be
   * worth fewer days. The drop reads the grid it is actually on.
   */
  it('reads pixels off the column the bar is standing on', () => {
    const uneven = dayAxis({ widths: [1020, 510, 510, 510], fallback: 510 });
    const wide = { ...data, axis: uneven };
    // Half of a double-width first column is still half a shift: 4h15 of the
    // 8h30 the board's day is, from the 08:30 the bar stands at.
    expect(barDragLanding(wide, 510)).toEqual(new Date(2026, 8, 11, 12, 45));
    // All of it lands on the open of the next day, as one column always did.
    expect(barDragLanding(wide, 1020)).toEqual(new Date(2026, 8, 14, 8, 30));
  });
});
it('renames the line without losing existing ASM roster and plan values', () => {
  expect(LINES.find(line => line.key === 'ASSY')?.name).toBe('Assembly');
  expect(readLineKey('ASM')).toBe('ASSY');
  // Both names the line has carried before still land on it — they are what
  // saved plans, roster Skills cells and signed-off production rows say.
  expect(readLineKey('Assembly Seats')).toBe('ASSY');
  expect(readLineKey('Assembly')).toBe('ASSY');
});
