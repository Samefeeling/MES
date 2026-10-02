import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalCalendar,
  readCalendarDay,
  readCalendarRows,
} from '@/data/sharepoint/factoryCalendar.list';
import { closureOn, isClosed } from '@/engine/assembly/dates';
import { useCalendarStore } from '@/store/calendarStore';

const d = (s: string) => new Date(`${s}T00:00:00`);

describe('reading the FactoryCalendar list', () => {
  it('reads a Date cell as the local day', () => {
    expect(readCalendarDay('2026-12-29')).toBe('2026-12-29');
    expect(readCalendarDay('29/12/2026')).toBe('2026-12-29');
    // SharePoint's answer for a date-only column: the site's midnight in UTC.
    const midnight = new Date(2026, 11, 29).toISOString();
    expect(readCalendarDay(midnight)).toBe('2026-12-29');
    expect(readCalendarDay('')).toBeNull();
    expect(readCalendarDay('soon')).toBeNull();
    expect(readCalendarDay(null)).toBeNull();
  });

  it('keeps one row a day, names a blank one RDO, and drops rows with no date', () => {
    expect(
      readCalendarRows([
        { id: '3', fields: { Date: '2026-11-13', Name: ' Shutdown ' } },
        { id: '1', fields: { Date: '2026-09-16', Name: '' } },
        { id: '2', fields: { Date: 'not a date', Name: 'RDO' } },
        { id: '4', fields: { Date: '2026-09-16', Name: 'RDO', Title: 'x' } },
        { id: '5', fields: { Date: '2026-10-30', Title: 'From the title' } },
      ]),
    ).toEqual([
      { id: '4', day: '2026-09-16', name: 'RDO' },
      { id: '5', day: '2026-10-30', name: 'From the title' },
      { id: '3', day: '2026-11-13', name: 'Shutdown' },
    ]);
  });
});

describe('the calendar store', () => {
  beforeEach(() => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    });
    useCalendarStore.getState().setBackend(new LocalCalendar());
  });
  afterEach(() => {
    useCalendarStore.getState().setBackend(new LocalCalendar());
    vi.unstubAllGlobals();
  });

  it('shuts the factory on a day added, keeps it across a reload, and reopens it on removal', async () => {
    const store = useCalendarStore.getState();
    expect(await store.add('2026-09-16', 'RDO')).toBe(true);
    expect(await store.add('2026-11-13', 'Day of mourning')).toBe(true);
    expect(isClosed(d('2026-09-16'))).toBe(true);
    expect(closureOn(d('2026-09-16'))).toMatchObject({ name: 'RDO', kind: 'rdo' });
    expect(closureOn(d('2026-11-13'))).toMatchObject({ name: 'Day of mourning', kind: 'holiday' });

    // A new build reloads the page: the days come back from where they are kept.
    useCalendarStore.setState({ rows: [] });
    expect(isClosed(d('2026-09-16'))).toBe(false);
    await useCalendarStore.getState().load();
    expect(useCalendarStore.getState().rows.map((r) => r.day)).toEqual(['2026-09-16', '2026-11-13']);
    expect(isClosed(d('2026-09-16'))).toBe(true);

    const rdo = useCalendarStore.getState().rows[0];
    expect(await useCalendarStore.getState().remove(rdo.id)).toBe(true);
    expect(isClosed(d('2026-09-16'))).toBe(false);
  });

  it('keeps the days it has when a read fails', async () => {
    await useCalendarStore.getState().add('2026-09-16', 'RDO');
    useCalendarStore.setState({
      backend: {
        where: 'nowhere',
        load: async () => ({ ok: false, error: 'FactoryCalendar not read: 503' }),
        add: async () => ({ ok: false, error: 'no' }),
        remove: async () => ({ ok: false, error: 'no' }),
      },
    });
    await useCalendarStore.getState().load();
    expect(useCalendarStore.getState().error).toMatch(/503/);
    expect(isClosed(d('2026-09-16'))).toBe(true);
  });
});
