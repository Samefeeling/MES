import { describe, expect, it, vi } from 'vitest';
import { keepShiftPlansFrom, shiftsToKeep, startShiftPlanKeeper } from '../src/ui/shift-plan-keeper';
import type { PmdDataLayer } from '../src/dal';
import { nextShift } from '../src/core/shifts';

describe('shiftsToKeep: the shift under way, and the next one in its last hour', () => {
  it('looks after the shift under way from its start', () => {
    expect(shiftsToKeep(new Date('2026-10-27T07:00:00'))).toEqual(['2026-10-27-Day']);
    expect(shiftsToKeep(new Date('2026-10-27T13:59:00'))).toEqual(['2026-10-27-Day']);
  });

  it('writes the next shift an hour before it starts', () => {
    expect(shiftsToKeep(new Date('2026-10-27T14:00:00'))).toEqual(['2026-10-27-Day', '2026-10-27-Afternoon']);
    expect(shiftsToKeep(new Date('2026-10-27T22:10:00'))).toEqual(['2026-10-27-Afternoon', '2026-10-27-Night']);
  });

  it('files the night under the date it started, and the morning after it', () => {
    expect(shiftsToKeep(new Date('2026-10-28T02:00:00'))).toEqual(['2026-10-27-Night']);
    expect(shiftsToKeep(new Date('2026-10-28T06:30:00'))).toEqual(['2026-10-27-Night', '2026-10-28-Day']);
    expect(nextShift('2026-10-31-Night')).toBe('2026-11-01-Day');
  });
});

describe('keepShiftPlansFrom: this month and the one before', () => {
  it('is the 1st of last month, across the year end', () => {
    expect(keepShiftPlansFrom(new Date('2026-11-17T10:00:00'))).toBe('2026-10-01');
    expect(keepShiftPlansFrom(new Date('2026-11-01T00:30:00'))).toBe('2026-10-01');
    expect(keepShiftPlansFrom(new Date('2027-01-05T10:00:00'))).toBe('2026-12-01');
  });
});

describe('startShiftPlanKeeper: what it asks the data layer, and when', () => {
  it('writes ahead, replans once per export, and prunes once a day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T14:05:00'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls: string[] = [];
    let version = 'v1';
    const dal = {
      keepShiftPlans: async (sid: string) => {
        calls.push(`keep ${sid}`);
        return [];
      },
      replanShiftPlans: async (sid: string, _at: Date, v: string) => {
        calls.push(`replan ${sid} ${v}`);
        return [];
      },
      planningVersion: async () => version,
      pruneShiftPlans: async (before: string) => {
        calls.push(`prune ${before}`);
        return 0;
      },
    } as unknown as PmdDataLayer;
    startShiftPlanKeeper(dal, () => true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toEqual([
      'keep 2026-11-17-Day',
      'replan 2026-11-17-Day v1',
      'keep 2026-11-17-Afternoon',
      'replan 2026-11-17-Afternoon v1',
      'prune 2026-10-01',
    ]);
    // Five minutes on, the same export: nothing.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual([]);
    // A new export: both shifts replanned, nothing kept again.
    version = 'v2';
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual(['replan 2026-11-17-Day v2', 'replan 2026-11-17-Afternoon v2']);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
