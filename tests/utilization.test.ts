import { describe, expect, it } from 'vitest';
import {
  availableHours,
  factoryHolidays,
  lastMonths,
  machineUtilization,
  runHoursByMonth,
} from '../src/core/utilization';
import { readCalendarDay, SharePointDataLayer } from '../src/dal/sharepoint';

describe('Machine Utilization', () => {
  // November 2026: 21 weekdays (Sun 1st → Mon 30th).
  const END_OF_NOV = new Date(2026, 10, 30, 23, 0);

  it('makes 8 h available on every weekday that is not a FactoryCalendar holiday', () => {
    expect(availableHours('2026-11', new Set(), END_OF_NOV)).toBe(21 * 8);
    // A holiday on a weekday comes off; one on a weekend changes nothing.
    expect(availableHours('2026-11', new Set(['2026-11-11', '2026-11-14']), END_OF_NOV)).toBe(20 * 8);
    // The month under way: its weekdays so far, today included (Mon 2nd–Mon 9th).
    expect(availableHours('2026-11', new Set(), new Date(2026, 10, 9, 10))).toBe(6 * 8);
    expect(availableHours('2026-12', new Set(), new Date(2026, 10, 9, 10))).toBe(0);
  });

  it('takes the holidays out of FactoryCalendar, not its RDOs', () => {
    const holidays = factoryHolidays([
      { day: '2026-12-25', name: 'Christmas Day' },
      { day: '2026-12-28', name: 'RDO' },
      { day: '2026-12-29', name: 'Rostered day off' },
      // A weekend Anzac Day shuts the Monday after (the Assembly board's rule).
      { day: '2027-04-25', name: 'Anzac Day' },
    ]);
    expect([...holidays].sort()).toEqual(['2026-12-25', '2027-04-25', '2027-04-26']);
  });

  it('counts each R half-hour of a press once, by the month of its shift', () => {
    const run = runHoursByMonth([
      { machineCode: '1600T', shiftId: '2026-11-02-Day', timeline: 'RRRRDDDDDDDDRRRR' },
      // A co-run: the same half-hours on a second order are not more running.
      { machineCode: '1600T', shiftId: '2026-11-02-Day', timeline: 'RRRR············' },
      // Night of 31 October is October's, though it runs into November.
      { machineCode: '1600 T', shiftId: '2026-10-31-Night', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: 'Batt1', shiftId: '2026-11-03-Afternoon', timeline: 'BBRR' },
    ]);
    expect(run.get('1600T')?.get('2026-11')).toBe(4);
    expect(run.get('1600T')?.get('2026-10')).toBe(8);
    expect(run.get('BATT1')?.get('2026-11')).toBe(1);
  });

  it('is R hours ÷ available hours, a chart per press in floor order', () => {
    const charts = machineUtilization(
      ['1600T', '1300T'],
      ['2026-10', '2026-11'],
      [{ machineCode: '1600T', shiftId: '2026-11-02-Day', timeline: 'RRRRRRRRRRRRRRRR' }],
      [{ day: '2026-11-11', name: 'Remembrance (closed)' }],
      END_OF_NOV,
    );
    expect(charts.map((c) => c.machineCode)).toEqual(['1600T', '1300T']);
    // 8 h over 20 weekdays × 8 h.
    expect(charts[0].months[1]).toEqual({ month: '2026-11', runHours: 8, availableHours: 160, pct: 5 });
    expect(charts[1].months[1].pct).toBe(0);
  });

  it('lists the last 12 months, oldest first', () => {
    const months = lastMonths(new Date(2026, 10, 9));
    expect(months).toHaveLength(12);
    expect([months[0], months[11]]).toEqual(['2025-12', '2026-11']);
  });

  it('reads FactoryCalendar dates the way the Assembly board does', () => {
    // A date-only column comes back as the site's midnight in UTC.
    expect(readCalendarDay('2026-12-24T13:00:00Z')).toBe('2026-12-25');
    expect(readCalendarDay('2026-12-25')).toBe('2026-12-25');
    expect(readCalendarDay('25/12/2026')).toBe('2026-12-25');
    expect(readCalendarDay('')).toBeNull();
  });

  it('finds FactoryCalendar\'s Date and Name columns by what they are', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const o = dal as unknown as { getJson: (url: string) => Promise<unknown>; getAllItems: (list: string) => Promise<unknown[]> };
    o.getJson = async () => ({
      d: {
        results: [
          { Title: 'Title', InternalName: 'Title', TypeAsString: 'Text' },
          { Title: 'Date', InternalName: 'Date', TypeAsString: 'DateTime' },
          { Title: 'Name', InternalName: 'Name0', TypeAsString: 'Text' },
        ],
      },
    });
    o.getAllItems = async (list) => {
      expect(list).toBe('FactoryCalendar');
      return [
        { Id: 1, Title: 'x', Date: '2026-12-24T13:00:00Z', Name0: 'Christmas Day' },
        { Id: 2, Title: 'RDO', Date: '2026-12-28T13:00:00Z', Name0: '' },
        { Id: 3, Title: 'bad', Date: '' },
      ];
    };
    expect(await dal.listFactoryCalendar()).toEqual([
      { day: '2026-12-25', name: 'Christmas Day' },
      { day: '2026-12-29', name: 'RDO' },
    ]);
  });
});
