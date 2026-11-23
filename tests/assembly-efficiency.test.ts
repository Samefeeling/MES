import { describe, expect, it } from 'vitest';
import { chartBuckets, efficiencySeries, personEfficiency } from '../src/core/assembly-efficiency';
import { historyGroup, type HistoryRow } from '../src/core/assembly-history';
import type { CompletedOrderDay } from '../src/core/assembly-completions';
import type { AttendanceEntry } from '../src/core/attendance';
import { QUIET_MS, refreshDue, refreshMinutes } from '../src/ui/auto-update';

describe('chartBuckets', () => {
  it('days for a fortnight or less, a weekend day only when something happened on it', () => {
    const { grain, buckets } = chartBuckets('2026-11-20', '2026-11-23', (d) => d === '2026-11-21');
    expect(grain).toBe('day');
    expect(buckets.map((b) => b.label)).toEqual(['Fri 20/11', 'Sat 21/11', 'Mon 23/11']);
  });

  it('weeks up to half a year, the part weeks marked', () => {
    const { grain, buckets } = chartBuckets('2026-10-28', '2026-11-16');
    expect(grain).toBe('week');
    expect(buckets.map((b) => [b.key, b.from, b.to, b.partial])).toEqual([
      ['2026-10-26', '2026-10-28', '2026-11-01', true],
      ['2026-11-02', '2026-11-02', '2026-11-08', false],
      ['2026-11-09', '2026-11-09', '2026-11-15', false],
      ['2026-11-16', '2026-11-16', '2026-11-16', true],
    ]);
  });

  it('months beyond, across the turn of a year', () => {
    const { grain, buckets } = chartBuckets('2026-05-04', '2027-01-10');
    expect(grain).toBe('month');
    expect(buckets.map((b) => b.label)).toEqual(['May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26', 'Oct 26', 'Nov 26', 'Dec 26', 'Jan 27']);
    expect(buckets[0]).toMatchObject({ from: '2026-05-04', to: '2026-05-31', partial: true });
    expect(buckets[8]).toMatchObject({ from: '2027-01-01', to: '2027-01-10', partial: true });
    expect(buckets[7].partial).toBe(false);
  });

  it('nothing for a range that is not one', () => {
    expect(chartBuckets('2026-11-22', '2026-11-01').buckets).toEqual([]);
  });
});

describe('efficiency: timesheet hours where there are timesheets, people × 7.5 h where not', () => {
  const csv = (day: string, planner: string, stdHours: number): HistoryRow => ({ day, planner, stdHours, group: historyGroup(planner) });
  const done = (day: string, line: string, people: string[], stdHours = 10): CompletedOrderDay => ({
    job: `J-${day}-${line}`, day, line, partNum: '', description: '', qty: 1, stdHours, due: null, onTime: null, finished: true, people, confirmedBy: '',
  });
  const att = (employeeId: string, day: string, hours: number): AttendanceEntry => ({ employeeId, name: employeeId, day, hours, kind: 'direct', workType: 'Ordinary', location: 'x / Assembly Direct' });
  const groups: Record<string, ReturnType<typeof historyGroup>> = { a: 'Assembly', t: 'Table' };
  // Week of 2 Nov has a timesheet; the week of 9 Nov has none.
  const input = {
    rows: [csv('2026-11-03', 'ASSY', 15), csv('2026-11-03', 'TABLE', 6), csv('2026-11-10', 'ASSY', 12), csv('2026-11-10', 'PMD', 99)],
    done: [done('2026-11-03', 'Assembly', ['Ana', 'Bo']), done('2026-11-10', 'Assembly', ['Ana', 'Bo']), done('2026-11-10', 'UPL-Gluing', ['Cy'])],
    attendance: [att('a', '2026-11-03', 7.6), att('a', '2026-11-03', 7.6), att('t', '2026-11-03', 7.6), att('a', '2026-11-10', 99)],
    covered: new Set(['2026-11-02']),
    groupOf: (id: string) => groups[id] ?? null,
  };

  it('by week', () => {
    const buckets = chartBuckets('2026-11-01', '2026-11-15').buckets.slice(1); // 15 days → weeks; drop the Sunday-only one
    // 15 days → weeks.
    const out = efficiencySeries(input, buckets);
    const assy = out.lines.find((l) => l.name === 'Assembly')!.points;
    expect(assy[0]).toEqual({ stdHours: 15, timesheetHours: 15.2, estimatedHours: 0, efficiency: 99, basis: 'timesheet' });
    // No timesheet: Ana and Bo confirmed that day → 2 × 7.5 h; the timesheet line of an uncovered week is ignored.
    expect(assy[1]).toEqual({ stdHours: 12, timesheetHours: 0, estimatedHours: 15, efficiency: 80, basis: 'estimate' });
    // UPL: hours (Cy × 7.5) but no Std h in the export.
    expect(out.lines.find((l) => l.name === 'UPL')!.points[1]).toMatchObject({ stdHours: 0, estimatedHours: 7.5, efficiency: 0 });
    // The floor: PMD out; 3 people on the 10th.
    expect(out.floor.map((p) => [p.stdHours, p.timesheetHours + p.estimatedHours, p.basis])).toEqual([
      [21, 22.8, 'timesheet'],
      [12, 22.5, 'estimate'],
    ]);
  });

  it('a bucket across both kinds of day says it is mixed', () => {
    const month = chartBuckets('2026-05-01', '2026-11-30').buckets.find((b) => b.key === '2026-11-01')!;
    const p = efficiencySeries(input, [month]).floor[0];
    expect(p).toMatchObject({ stdHours: 33, timesheetHours: 22.8, estimatedHours: 22.5, basis: 'mixed', efficiency: 73 });
  });

  it('without the export, the standard hours of the confirmed completions', () => {
    const buckets = chartBuckets('2026-11-01', '2026-11-15').buckets.slice(1); // 15 days → weeks; drop the Sunday-only one
    const out = efficiencySeries({ ...input, rows: null }, buckets);
    expect(out.floor.map((p) => p.stdHours)).toEqual([10, 20]);
  });

  it("a person: their share over their timesheet hours, else 7.5 h a day they are named", () => {
    const buckets = chartBuckets('2026-11-01', '2026-11-15').buckets.slice(1); // 15 days → weeks; drop the Sunday-only one
    expect(personEfficiency(input, buckets, 'ana', 'a').map((p) => [p.stdHours, p.timesheetHours, p.estimatedHours, p.basis])).toEqual([
      [5, 15.2, 0, 'timesheet'],
      [5, 0, 7.5, 'estimate'],
    ]);
    // No payroll id: always the estimate.
    expect(personEfficiency(input, buckets, 'Bo', '').map((p) => p.efficiency)).toEqual([67, 67]);
  });
});

describe('the hourly refresh', () => {
  const H = 60 * 60_000;
  it('reloads an hour after loading, at a quiet moment only', () => {
    expect(refreshDue(H - 1, 0, 0, H, false, false)).toBe(false);
    expect(refreshDue(H, 0, 0, H, false, false)).toBe(true);
    expect(refreshDue(H, 0, H - QUIET_MS + 1, H, false, false)).toBe(false); // touched a moment ago
    expect(refreshDue(H, 0, H - 1000, H, false, true)).toBe(true); // tab hidden: nobody is looking
    expect(refreshDue(2 * H, 0, 0, H, true, true)).toBe(false); // a field or dialog open
    expect(refreshDue(2 * H, 0, 0, 0, false, false)).toBe(false); // turned off
  });
  it('every 60 minutes unless set otherwise', () => {
    expect(refreshMinutes(undefined)).toBe(60);
    expect(refreshMinutes('')).toBe(60);
    expect(refreshMinutes('30')).toBe(30);
    expect(refreshMinutes('0')).toBe(0);
    expect(refreshMinutes('soon')).toBe(60);
  });
});
