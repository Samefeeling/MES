import { describe, expect, it } from 'vitest';
import { markUnsignedLines, shiftsAwaitingSignOff, unsignedLabel, unsignedTuples } from '../src/core/unsigned';
import { rec } from './helpers';

const DAY = '2026-11-24-Day';
const AFT = '2026-11-24-Afternoon';

describe('unsigned order-shifts', () => {
  it('names an order left unsigned beside one of the same shift that was signed', () => {
    const rows = [
      rec({ machineCode: '1600T', shiftId: DAY, jobNumber: 'J1', slotIndex: 0, statusCode: 'R', locked: true }),
      rec({ machineCode: '1600T', shiftId: DAY, jobNumber: 'J2', slotIndex: 8, statusCode: 'R' }),
    ];
    expect(unsignedTuples(rows)).toEqual([{ machineCode: '1600T', shiftId: DAY, jobNumber: 'J2' }]);
    // The shift as a whole is not waiting: one of its orders is signed.
    expect([...shiftsAwaitingSignOff(rows, unsignedTuples(rows))]).toEqual([]);
  });

  it('a shift with nothing signed is waiting as a whole', () => {
    const rows = [rec({ machineCode: '1600T', shiftId: AFT, jobNumber: 'J3', slotIndex: 0, statusCode: '', countStart: 5 })];
    expect([...shiftsAwaitingSignOff(rows, unsignedTuples(rows))]).toEqual([AFT]);
  });

  it('a sheet with a name and no production is not unsigned work', () => {
    const rows = [rec({ shiftId: DAY, jobNumber: 'J4', slotIndex: 0, statusCode: '', operator: 'Joe' })];
    expect(unsignedTuples(rows)).toEqual([]);
  });

  it('keeps only the shifts asked for (the finished ones)', () => {
    const rows = [
      rec({ shiftId: DAY, jobNumber: 'J5', slotIndex: 0, statusCode: 'R' }),
      rec({ shiftId: AFT, jobNumber: 'J6', slotIndex: 0, statusCode: 'R' }),
    ];
    expect(unsignedTuples(rows, (sid) => sid === DAY).map((t) => t.jobNumber)).toEqual(['J5']);
  });

  it('marks the plan line of the unsigned order only', () => {
    const lines = [
      { machineCode: '1600T', shiftId: DAY, jobNumber: 'J1' },
      { machineCode: '1600T', shiftId: DAY, jobNumber: 'j2' },
    ];
    const marked = markUnsignedLines(lines, [{ machineCode: '1600T', shiftId: DAY, jobNumber: 'J2' }]);
    expect(marked.map((l) => !!(l as { unsigned?: boolean }).unsigned)).toEqual([false, true]);
  });

  it('labels a tuple for the tooltip', () => {
    expect(unsignedLabel({ machineCode: '1600T', shiftId: DAY, jobNumber: 'J2' })).toBe('24/11 Day · 1600T · J2');
    expect(unsignedLabel({ machineCode: '1600T', shiftId: DAY, jobNumber: 'J2' }, false)).toBe('24/11 Day · J2');
  });
});
