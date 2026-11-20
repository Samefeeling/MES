/**
 * Reading `ASSY_CompletedJobs` for KPIs · Assembly.
 *
 * One row per order per day — an order finished over several days has a row
 * for each, and every one counts. Two rows for one order on one day (one
 * operation) are one completion written twice: the newer stands rather than
 * the whole range being refused, which is what the reader used to do.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createAssemblyDataLayer } from '../src/dal/sharepoint';

afterEach(() => vi.unstubAllGlobals());

const COLUMNS = ['Title', 'Date', 'ShiftOutput', 'WorkDescription', 'WorkType'];

/** Stub the list: its columns, then one page of rows. */
function stub(rows: Record<string, unknown>[], columns = COLUMNS): void {
  vi.stubGlobal('window', {
    location: { origin: 'https://tenant.sharepoint.com' },
  });
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/fields?')) {
      return new Response(
        JSON.stringify({
          value: columns.map((name) => ({ Title: name, InternalName: name })),
        }),
      );
    }
    return new Response(JSON.stringify({ value: rows }));
  });
}

const dal = () =>
  createAssemblyDataLayer({
    VITE_BACKEND: 'sharepoint',
    VITE_SITE_URL: 'https://tenant.sharepoint.com/sites/factory',
  });

const row = (over: Record<string, unknown>) => ({
  Id: 1,
  Title: 'ASM8001',
  Date: '2026-09-21T00:00:00Z',
  ShiftOutput: 0,
  ...over,
});

it('reports both benches of an order worked at two of them in a day', async () => {
  stub([
    // Sewing hands its covers on; stapling receives the units.
    row({ Id: 1, WorkDescription: 'Op 20 sewing', WorkType: 'WIP' }),
    row({ Id: 2, WorkDescription: 'Op 30 stapling', ShiftOutput: 9 }),
  ]);
  const read = await dal().results('2026-09-21', '2026-09-21');
  expect(read.map((r) => r.description)).toEqual([
    'Op 20 sewing',
    'Op 30 stapling',
  ]);
  expect(read.map((r) => r.output)).toEqual([0, 9]);
});

it('keeps the newer of two rows for the same operation on one day', async () => {
  stub([
    row({ Id: 2, WorkDescription: 'Op 10 foaming', ShiftOutput: 5 }),
    row({ Id: 1, WorkDescription: 'Op 10 foaming', ShiftOutput: 2 }),
  ]);
  const read = await dal().results('2026-09-21', '2026-09-21');
  expect(read.map((r) => [r.id, r.output])).toEqual([['2', 5]]);
});

it('keeps the newer of two rows of an order worked at one place', async () => {
  stub([row({ Id: 1, ShiftOutput: 2 }), row({ Id: 2, ShiftOutput: 5 })], ['Title', 'Date', 'ShiftOutput']);
  const read = await dal().results('2026-09-21', '2026-09-21');
  expect(read.map((r) => [r.id, r.output])).toEqual([['2', 5]]);
});

it('counts every day of an order finished over several days', async () => {
  stub([
    row({ Id: 1, ShiftOutput: 2 }),
    row({ Id: 2, Date: '2026-09-22T00:00:00Z', ShiftOutput: 5 }),
    row({ Id: 3, Date: '2026-09-23T00:00:00Z', ShiftOutput: 1 }),
  ]);
  const read = await dal().results('2026-09-21', '2026-09-23');
  expect(read.map((r) => r.day)).toEqual(['2026-09-23', '2026-09-22', '2026-09-21']);
});

it('reads ASSY_CompletedJobs unless told otherwise', async () => {
  const seen: string[] = [];
  vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });
  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    if (url.includes('/fields?')) return new Response(JSON.stringify({ value: COLUMNS.map((name) => ({ Title: name, InternalName: name })) }));
    return new Response(JSON.stringify({ value: [] }));
  });
  await dal().results('2026-09-21', '2026-09-21');
  const lists = seen.filter((u) => u.includes('/lists/'));
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.every((u) => u.includes("getbytitle('ASSY_CompletedJobs')"))).toBe(true);
});

/**
 * The tenant's regional setting is Auckland: a date-only Date cell for
 * 19 November comes back as 2026-11-18T11:00:00Z (NZDT, UTC+13). Two orders
 * confirmed for the 19th went missing from "Last 24h": the filter asked for
 * the UTC day and the reader took the first ten characters.
 */
function stubAuckland(rows: Record<string, unknown>[], seen: string[] = [], zone = true): void {
  vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });
  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    if (url.includes('/RegionalSettings/TimeZone')) {
      return zone
        ? new Response(JSON.stringify({ Information: { Bias: -720, StandardBias: 0, DaylightBias: -60 } }))
        : new Response('', { status: 403 });
    }
    if (url.includes('/fields?')) {
      return new Response(JSON.stringify({ value: [...COLUMNS, 'RecordKey', 'DueDate'].map((name) => ({ Title: name, InternalName: name })) }));
    }
    return new Response(JSON.stringify({ value: rows }));
  });
}

it("reads a day in the site's zone, not the UTC day", async () => {
  const seen: string[] = [];
  stubAuckland(
    [
      row({ Id: 1, Title: '018451-2-1', Date: '2026-11-18T11:00:00Z', RecordKey: '018451-2-1|2026-11-19', DueDate: '2026-11-19T11:00:00Z' }),
      row({ Id: 2, Title: '018474-5-1', Date: '2026-11-18T11:00:00Z', RecordKey: '018474-5-1|2026-11-19' }),
      // The day before and the day after, inside the wider ask, outside the window.
      row({ Id: 3, Title: 'ASM1', Date: '2026-11-17T11:00:00Z', RecordKey: 'ASM1|2026-11-18' }),
      row({ Id: 4, Title: 'ASM2', Date: '2026-11-19T11:00:00Z', RecordKey: 'ASM2|2026-11-20' }),
    ],
    seen,
  );
  const read = await dal().results('2026-11-19', '2026-11-19');
  expect(read.map((r) => [r.job, r.day])).toEqual([
    ['018451-2-1', '2026-11-19'],
    ['018474-5-1', '2026-11-19'],
  ]);
  expect(read[0].due).toBe('2026-11-20');
  const items = decodeURIComponent(seen.find((u) => u.includes('/items?'))!);
  expect(items).toContain("Date ge datetime'2026-11-18T00:00:00Z'");
  expect(items).toContain("Date lt datetime'2026-11-21T00:00:00Z'");
});

it('takes the day from the Date cell in the site zone when a row has no RecordKey', async () => {
  stubAuckland([row({ Id: 1, Title: 'ASM9', Date: '2026-11-18T11:00:00Z' })]);
  const read = await dal().results('2026-11-19', '2026-11-19');
  expect(read.map((r) => r.day)).toEqual(['2026-11-19']);
});

it("still finds the day by RecordKey when the site's zone cannot be read", async () => {
  stubAuckland([row({ Id: 1, Title: '018451-2-1', Date: '2026-11-18T11:00:00Z', RecordKey: '018451-2-1|2026-11-19' })], [], false);
  const read = await dal().results('2026-11-19', '2026-11-19');
  expect(read.map((r) => r.day)).toEqual(['2026-11-19']);
});

it('reads a Sydney site’s date column by its local day, the first day asked for included', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try {
    const seen: string[] = [];
    vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(decodeURIComponent(url));
      if (url.includes('/fields?')) return new Response(JSON.stringify({ value: COLUMNS.map((name) => ({ Title: name, InternalName: name })) }));
      return new Response(JSON.stringify({ value: [
        // 19/11 and 20/11 as the site stores them: its own midnight, in UTC.
        row({ Id: 1, Date: '2026-11-18T13:00:00Z', ShiftOutput: 150 }),
        row({ Id: 2, Date: '2026-11-19T13:00:00Z', ShiftOutput: 9 }),
        row({ Id: 3, Date: '2026-11-17T13:00:00Z', ShiftOutput: 4 }),
      ] }));
    });
    const read = await dal().results('2026-11-19', '2026-11-19');
    expect(read.map((r) => [r.day, r.output])).toEqual([['2026-11-19', 150]]);
    expect(seen.find((u) => u.includes('$filter'))).toContain("ge datetime'2026-11-18T00:00:00");
  } finally {
    process.env.TZ = tz;
  }
});

it('takes a row’s day from its RecordKey, whatever its Date column reads', async () => {
  stub([
    // A Date the site and browser read as the 18th; the key says the 19th.
    row({ Id: 1, Date: '2026-11-18T00:00:00Z', RecordKey: '018451-2-1|2026-11-19', ShiftOutput: 150 }),
    row({ Id: 2, Date: '2026-11-18T00:00:00Z', RecordKey: '018474-5-1|2026-11-18', ShiftOutput: 26 }),
  ], [...COLUMNS, 'RecordKey']);
  const read = await dal().results('2026-11-19', '2026-11-19');
  expect(read.map((r) => [r.day, r.output])).toEqual([['2026-11-19', 150]]);
});
