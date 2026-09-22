/**
 * Two benches of one order, on one day, in the production record.
 *
 * `ASSY_Production` is one row per order per day — except where a route puts
 * two benches on the same order on the same day. Gluing foams and sews side by
 * side, and each bench gets its own row: one carries the hours as work in
 * progress, the other receives the units.
 *
 * The reader used to key on the day alone and refuse the whole range on
 * finding two, so a record written exactly as designed reported nothing at
 * all. It now asks which operation as well — and still refuses a real
 * duplicate, which is two rows for one operation.
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

it('still refuses two rows for the same operation', async () => {
  stub([
    row({ Id: 1, WorkDescription: 'Op 10 foaming', ShiftOutput: 2 }),
    row({ Id: 2, WorkDescription: 'Op 10 foaming', ShiftOutput: 5 }),
  ]);
  await expect(dal().results('2026-09-21', '2026-09-21')).rejects.toThrow(
    'Duplicate Assembly result: ASM8001 2026-09-21 (Op 10 foaming)',
  );
});

it('refuses two rows of an order that is worked at one place', async () => {
  // No operation on either: an ordinary order, booked twice for one day.
  stub([row({ Id: 1, ShiftOutput: 2 }), row({ Id: 2, ShiftOutput: 5 })]);
  await expect(dal().results('2026-09-21', '2026-09-21')).rejects.toThrow(
    'Duplicate Assembly result: ASM8001 2026-09-21.',
  );
});

it('guards a list that has no operation column exactly as it used to', async () => {
  // Written before the column existed, so no row carries one and every row
  // answers blank — which is the day-only rule again.
  stub([row({ Id: 1 }), row({ Id: 2 })], ['Title', 'Date', 'ShiftOutput']);
  await expect(dal().results('2026-09-21', '2026-09-21')).rejects.toThrow(
    'Duplicate Assembly result: ASM8001 2026-09-21.',
  );
});
