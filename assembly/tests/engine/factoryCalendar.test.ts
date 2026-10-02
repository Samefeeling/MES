import { afterEach, describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  closureOn,
  isClosed,
  nextWorkingDay,
  prevWorkingDay,
  setFactoryCalendar,
} from '@/engine/assembly/dates';
import { cleanRdo, easterSunday, nswPublicHolidays } from '@/engine/assembly/factoryCalendar';
import { toDayKey } from '@/lib/time';

const d = (s: string) => new Date(`${s}T00:00:00`);
const days = (year: number) => Object.fromEntries(nswPublicHolidays(year).map((h) => [h.day, h.name]));

describe('NSW public holidays', () => {
  it('works out Easter Sunday', () => {
    expect([2024, 2025, 2026, 2027, 2038].map((y) => toDayKey(easterSunday(y)))).toEqual([
      '2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28', '2038-04-25',
    ]);
  });

  // As NSW Industrial Relations publishes them.
  it('gives 2026 as published, the Monday after a Saturday Boxing Day included', () => {
    expect(days(2026)).toEqual({
      '2026-01-01': "New Year's Day",
      '2026-01-26': 'Australia Day',
      '2026-04-03': 'Good Friday',
      '2026-04-04': 'Easter Saturday',
      '2026-04-05': 'Easter Sunday',
      '2026-04-06': 'Easter Monday',
      // A Saturday: the factory shuts the Monday after as well.
      '2026-04-25': 'Anzac Day',
      '2026-04-27': 'Anzac Day (additional day)',
      '2026-06-08': "King's Birthday",
      '2026-10-05': 'Labour Day',
      '2026-12-25': 'Christmas Day',
      '2026-12-26': 'Boxing Day',
      '2026-12-28': 'Boxing Day (additional day)',
    });
  });

  it('adds the Monday after a weekend Anzac Day, and only then', () => {
    expect(days(2027)['2027-04-26']).toBe('Anzac Day (additional day)');
    expect(Object.values(days(2025)).filter((n) => n.startsWith('Anzac'))).toEqual(['Anzac Day']);
    // Easter Sunday is Anzac Day: Easter Monday has the Monday, so the Tuesday.
    expect(days(2038)['2038-04-27']).toBe('Anzac Day (additional day)');
  });

  it('moves Australia Day off a weekend to the Monday', () => {
    expect(days(2025)['2025-01-27']).toBe('Australia Day');
    expect(days(2025)['2025-01-26']).toBeUndefined();
  });

  it('adds the Monday after a weekend New Year’s Day', () => {
    expect(days(2022)['2022-01-03']).toBe("New Year's Day (additional day)");
    expect(days(2023)['2023-01-02']).toBe("New Year's Day (additional day)");
  });

  it('gives Christmas and Boxing Day each a weekday when they fall on a weekend', () => {
    // Sat and Sun: Monday and Tuesday.
    expect(days(2021)).toMatchObject({
      '2021-12-27': 'Christmas Day (additional day)',
      '2021-12-28': 'Boxing Day (additional day)',
    });
    // Christmas on a Sunday, Boxing Day the Monday: Christmas takes the Tuesday.
    expect(days(2022)['2022-12-27']).toBe('Christmas Day (additional day)');
    expect(days(2022)['2022-12-26']).toBe('Boxing Day');
  });

  it('leaves Bank Holiday out: it is not a factory holiday', () => {
    expect(days(2026)['2026-08-03']).toBeUndefined();
  });

  it('makes one day of two holidays that fall together', () => {
    const list = nswPublicHolidays(2038);
    expect(list.filter((h) => h.day === '2038-04-25')).toEqual([
      { day: '2038-04-25', name: 'Easter Sunday / Anzac Day', kind: 'holiday' },
    ]);
  });
});

describe('the factory calendar', () => {
  afterEach(() => setFactoryCalendar({ listed: [], holidays: true }));

  it('shuts the factory on a public holiday the way it is shut at the weekend', () => {
    expect(isClosed(d('2026-04-03'))).toBe(true);
    expect(closureOn(d('2026-04-03'))).toMatchObject({ name: 'Good Friday', kind: 'holiday' });
    // Maundy Thursday's work carries over Easter to the Tuesday.
    expect(nextWorkingDay(d('2026-04-03'))).toEqual(d('2026-04-07'));
    expect(prevWorkingDay(d('2026-04-07'))).toEqual(d('2026-04-02'));
    expect(addWorkingDays(d('2026-04-02'), 2)).toEqual(d('2026-04-08'));
    // Labour Day.
    expect(addWorkingDays(d('2026-10-02'), 1)).toEqual(d('2026-10-03'));
    expect(nextWorkingDay(d('2026-10-03'))).toEqual(d('2026-10-06'));
  });

  it('shuts it on an RDO the supervisor entered, and on nothing else', () => {
    expect(isClosed(d('2026-09-16'))).toBe(false);
    setFactoryCalendar({ listed: [{ day: '2026-09-16' }, { day: '2026-11-13', name: 'Plant shutdown' }] });
    expect(closureOn(d('2026-09-16'))).toEqual({ day: '2026-09-16', name: 'RDO', kind: 'rdo' });
    expect(closureOn(d('2026-11-13'))?.name).toBe('Plant shutdown');
    expect(nextWorkingDay(d('2026-09-16'))).toEqual(d('2026-09-17'));
    expect(addWorkingDays(d('2026-09-15'), 2)).toEqual(d('2026-09-18'));
    setFactoryCalendar({ listed: [] });
    expect(isClosed(d('2026-09-16'))).toBe(false);
  });

  it('can be told not to count public holidays', () => {
    setFactoryCalendar({ holidays: false });
    expect(isClosed(d('2026-04-03'))).toBe(false);
    expect(isClosed(d('2026-04-04'))).toBe(true);
  });

  it('takes only real dates for an RDO', () => {
    expect(cleanRdo({ day: '2026-02-30' })).toBeNull();
    expect(cleanRdo({ day: '16/09/2026' })).toBeNull();
    expect(cleanRdo({ day: ' 2026-09-16 ', name: '  ' })).toEqual({ day: '2026-09-16' });
  });
});
