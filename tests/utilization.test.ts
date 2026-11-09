import { describe, expect, it } from 'vitest';
import {
  availableHours,
  closedDayShiftsByMonth,
  factoryClosedDays,
  lastMonths,
  machineUtilization,
  runHoursByMonth,
} from '../src/core/utilization';
import { readCalendarDay, SharePointDataLayer } from '../src/dal/sharepoint';

describe('Machine Utilization', () => {
  // November 2026: 21 weekdays (Sun 1st → Mon 30th).
  const END_OF_NOV = new Date(2026, 10, 30, 23, 0);

  it('makes 24 h available on every weekday the FactoryCalendar does not shut', () => {
    expect(availableHours('2026-11', new Set(), END_OF_NOV)).toBe(21 * 24);
    // A closed weekday comes off; a closed weekend day changes nothing.
    expect(availableHours('2026-11', new Set(['2026-11-11', '2026-11-14']), END_OF_NOV)).toBe(20 * 24);
    // The month under way: its weekdays so far, today included (Mon 2nd–Mon 9th).
    expect(availableHours('2026-11', new Set(), new Date(2026, 10, 9, 10))).toBe(6 * 24);
    expect(availableHours('2026-12', new Set(), new Date(2026, 10, 9, 10))).toBe(0);
  });

  it('takes out every day FactoryCalendar shuts, its RDOs too', () => {
    const closed = factoryClosedDays([
      { day: '2026-12-25', name: 'Christmas Day' },
      { day: '2026-12-28', name: 'RDO' },
      { day: '2026-12-29', name: 'Rostered day off' },
      // A weekend Anzac Day shuts the Monday after (the Assembly board's rule).
      { day: '2027-04-25', name: 'Anzac Day' },
    ]);
    expect([...closed].sort()).toEqual(['2026-12-25', '2026-12-28', '2026-12-29', '2027-04-25', '2027-04-26']);
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
    // 8 h over 20 weekdays × 24 h.
    expect(charts[0].months[1]).toEqual({
      month: '2026-11', runHours: 8, availableHours: 480, weekdayHours: 480, closedShiftHours: 0, pct: 1.7,
    });
    expect(charts[1].months[1].pct).toBe(0);
  });

  it('adds 8 h for each shift a press worked on a weekend, holiday or RDO', () => {
    const timelines = [
      // Saturday 7th: Day and Afternoon run; the Night only sets up — the crew
      // was there, so it is available time too.
      { machineCode: '850T', shiftId: '2026-11-07-Day', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: '850T', shiftId: '2026-11-07-Afternoon', timeline: 'RRRRRRRR········' },
      { machineCode: '850T', shiftId: '2026-11-07-Night', timeline: 'DDDD············' },
      // Sunday: a shift marked only "No Plan" was not worked.
      { machineCode: '850T', shiftId: '2026-11-08-Day', timeline: 'OOOOOOOOOOOOOOOO' },
      // The 11th is shut in the FactoryCalendar, and 850T ran a shift.
      { machineCode: '850T', shiftId: '2026-11-11-Day', timeline: 'RRRRRRRR' },
      // Two orders on one shift are one shift.
      { machineCode: '850T', shiftId: '2026-11-11-Day', timeline: '········RRRR' },
      // A weekday shift is in the 24 h already.
      { machineCode: '850T', shiftId: '2026-11-10-Day', timeline: 'RRRRRRRRRRRRRRRR' },
    ];
    expect(closedDayShiftsByMonth(timelines, new Set(['2026-11-11'])).get('850T')?.get('2026-11')).toBe(4);
    const [c] = machineUtilization(['850T'], ['2026-11'], timelines, [{ day: '2026-11-11', name: 'Shutdown' }], END_OF_NOV);
    // R: 8 + 4 + 6 + 8 = 26 h. Available: 20 open weekdays × 24 + 4 shifts × 8.
    expect(c.months[0]).toMatchObject({ runHours: 26, weekdayHours: 480, closedShiftHours: 32, availableHours: 512 });
    expect(c.months[0].pct).toBe(5.1);
  });

  it('gives YTD as Σ R hours ÷ Σ available hours of the financial year, from April', () => {
    const timelines = [
      { machineCode: '1600T', shiftId: '2025-03-03-Day', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: '1600T', shiftId: '2025-12-01-Day', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: '1600T', shiftId: '2026-01-05-Day', timeline: 'RRRRRRRRRRRRRRRR' },
      { machineCode: '1600T', shiftId: '2026-02-02-Day', timeline: 'RRRRRRRR' },
    ];
    // Records counted from any month: FY 2025/26 runs April 2025 → March 2026,
    // so March 2025 is last year's.
    const [c] = machineUtilization(
      ['1600T'], ['2025-03', '2025-12', '2026-01', '2026-02'], timelines, [], new Date(2026, 1, 28, 12), '2000-01',
    );
    // December 23 weekdays, January 22, February 20: 65 × 24 = 1560 h.
    expect(c.ytd).toMatchObject({ month: 'YTD', runHours: 20, availableHours: 1560, fromMonth: '2025-04', excludedMonths: [] });
    expect(c.ytd.pct).toBe(1.3);
    // Counting from January: December is charted but not in YTD.
    const [d] = machineUtilization(
      ['1600T'], ['2025-12', '2026-01', '2026-02'], timelines, [], new Date(2026, 1, 28, 12), '2026-01',
    );
    expect(d.ytd).toMatchObject({ runHours: 12, availableHours: 1008, excludedMonths: ['2025-12'] });
    expect(d.months.map((m) => !!m.incomplete)).toEqual([true, false, false]);
  });

  it('starts this year\'s YTD at August 2026: MES went live over June and July', () => {
    const asOf = new Date(2026, 10, 9, 10);
    const months = lastMonths(asOf);
    const [c] = machineUtilization(
      ['1600T'],
      months,
      [
        { machineCode: '1600T', shiftId: '2026-07-06-Day', timeline: 'RRRRRRRRRRRRRRRR' },
        { machineCode: '1600T', shiftId: '2026-08-03-Day', timeline: 'RRRRRRRRRRRRRRRR' },
      ],
      [],
      asOf,
    );
    expect(c.ytd.fromMonth).toBe('2026-04');
    expect(c.ytd.excludedMonths).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
    // August 21 weekdays, September 22, October 22, November 2nd–9th 6: 71 × 24.
    expect(c.ytd).toMatchObject({ runHours: 8, availableHours: 71 * 24 });
    expect(c.months.filter((m) => m.incomplete).map((m) => m.month).at(-1)).toBe('2026-07');
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
