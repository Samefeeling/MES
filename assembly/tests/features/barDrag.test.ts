import { describe, expect, it } from 'vitest';
import { barDragLanding, type BarDragData } from '@/features/assembly/barDrag';
import { LINES, readLineKey } from '@/domain/assembly';
const at = (hour: number, minute = 0) => new Date(2026, 8, 11, hour, minute);
const data: BarDragData = { jobId: 'A', startISO: at(8, 30).toISOString(), floorISO: at(7).toISOString(), dayWidth: 510, showWeekends: false };
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
});
it('renames the line without losing existing ASM roster and plan values', () => {
  expect(LINES.find(line => line.key === 'ASSY')?.name).toBe('Assembly Seats');
  expect(readLineKey('ASM')).toBe('ASSY');
  expect(readLineKey('Assembly Seats')).toBe('ASSY');
});
