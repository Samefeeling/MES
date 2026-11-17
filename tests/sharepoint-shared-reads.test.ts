/**
 * Reads that ask for the same rows at the same moment share one request.
 *
 * Maint asks for 400 days of shot counters and 90 days of records in one
 * breath; both read PMD_Production and PMD_LiveStatus, and the 90 days lie
 * inside the 400. The narrower read joins the wider one — and must return
 * exactly what it would have returned alone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';
import { FakeSharePoint } from './fake-sharepoint';
import { rec } from './helpers';

const NOW = new Date(2026, 10, 16, 10, 5, 0);
const PRESS = '850T';

const site = new FakeSharePoint()
  .seed('PMD_Machine', [
    { Title: PRESS, 'IsActive_x003a_Yes_x002f_No': true, DisplayOrder: 1, Status: 'In service' },
  ])
  .seed('PMD_Operator', [{ Title: 'Tony Lee', Shift: 'Day', Position: 'Operator', Supervisor: 'Jeff Penn' }])
  .seed('PMD_RejectCategories', [{ Title: 'D01', Description: 'ShortShot' }])
  .seed('PMD_Planning', [
    { JobHead_JobNum: 'J-NEAR', JobHead_PartNum: 'P1', JobHead_PartDescription: 'Near', JobHead_ProdQty: 500, Calculated_RemainingQty: 400, QTYperHour: 60, StartDateTime: '2026-11-09T07:00:00Z', Due_Date: '2026-11-20T00:00:00Z', Duration: 8 },
    { JobHead_JobNum: 'J-FAR', JobHead_PartNum: 'P2', JobHead_PartDescription: 'Far', JobHead_ProdQty: 500, Calculated_RemainingQty: 400, QTYperHour: 60, StartDateTime: '2026-11-09T07:00:00Z', Due_Date: '2026-11-20T00:00:00Z', Duration: 8 },
  ])
  .seed('PMD_ManualOrders')
  .seed('PMD_Production')
  .seed('PMD_LiveStatus')
  .seed('PMD_Rejects')
  .seed('PMD_BreakDownlog')
  .seed('PMD_ShiftPlan')
  .seed('PMD_ProductDieColor')
  .seed('PMD_DieChangeLog');

const device = (): SharePointDataLayer => new SharePointDataLayer({ siteUrl: site.siteUrl, canWrite: () => true });

/** GETs of a list's rows since `from`, as the filter each one carried. */
const reads = (list: string, from = 0): string[] =>
  site.calls
    .slice(from)
    .filter((c) => c.method === 'GET' && c.url.includes(`getbytitle('${list}')/items`))
    .map((c) => c.url.split('$filter=')[1] ?? '');

const WIDE = { shiftIdFrom: '2025-10-13-', shiftIdTo: '2026-11-16-￿' };
const NARROW = { shiftIdFrom: '2026-08-19-', shiftIdTo: '2026-11-16-￿' };

let uninstall: () => void;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  uninstall = site.install();
  const ipad = device();
  // One shift a week ago, one seven months ago: inside 400 days both,
  // inside 90 days only the first.
  for (const [shiftId, job] of [['2026-11-09-Day', 'J-NEAR'], ['2026-04-10-Day', 'J-FAR']] as const) {
    for (let slot = 0; slot < 4; slot++) {
      await ipad.upsertProductionRecord(
        rec({
          machineCode: PRESS,
          shiftId,
          jobNumber: job,
          slotIndex: slot,
          statusCode: 'R',
          operator: 'Tony Lee',
          supervisor: 'Jeff Penn',
          qcBy: 'Tony Lee',
          ...(slot === 0 ? { countStart: 0, countEnd: 120 } : {}),
          ...(slot === 1 ? { rejectCount: 2, rejects: JSON.stringify({ D01: 2 }) } : {}),
        }),
      );
    }
    await ipad.lockShift(PRESS, shiftId, 'Jeff Penn', 'Tony Lee', job);
  }
});

afterAll(() => {
  uninstall();
  vi.useRealTimers();
});

describe('a span of days inside one already being read', () => {
  it('is answered by that read: the record list is downloaded once, not twice', async () => {
    const office = device();
    const from = site.calls.length;
    const [counters, records] = await Promise.all([
      office.listProductionCounters(WIDE),
      office.listProduction(NARROW),
    ]);
    expect(reads('PMD_Production', from)).toHaveLength(1);
    expect(reads('PMD_LiveStatus', from)).toHaveLength(1);
    // The one read is the wider of the two.
    expect(reads('PMD_Production', from)[0]).toContain("ge datetime'2025-10-12T00:00:00.000Z'");
    expect(counters.map((c) => c.jobNumber).sort()).toEqual(['J-FAR', 'J-NEAR']);
    expect([...new Set(records.map((r) => r.jobNumber))]).toEqual(['J-NEAR']);
  });

  it('returns what it would have returned read alone', async () => {
    const alone = await device().listProduction(NARROW);
    const office = device();
    const [, joined] = await Promise.all([office.listProductionCounters(WIDE), office.listProduction(NARROW)]);
    expect(joined).toEqual(alone);
    expect(joined.filter((r) => r.statusCode === 'R')).toHaveLength(4);
    expect(joined.find((r) => r.slotIndex === 1)).toMatchObject({ rejectCount: 2, locked: true });
  });

  it('does not answer a wider span from a narrower one', async () => {
    const office = device();
    const from = site.calls.length;
    const [records, counters] = await Promise.all([
      office.listProduction(NARROW),
      office.listProductionCounters(WIDE),
    ]);
    expect(reads('PMD_Production', from)).toHaveLength(2);
    expect(counters.map((c) => c.jobNumber).sort()).toEqual(['J-FAR', 'J-NEAR']);
    expect([...new Set(records.map((r) => r.jobNumber))]).toEqual(['J-NEAR']);
  });

  it('is not a cache: a read after the first has finished asks again', async () => {
    const office = device();
    await office.listProductionCounters(WIDE);
    const from = site.calls.length;
    await office.listProduction(NARROW);
    expect(reads('PMD_Production', from)).toHaveLength(1);
    expect(reads('PMD_Production', from)[0]).toContain("ge datetime'2026-08-18T00:00:00.000Z'");
  });

  it('leaves a read of one press, or one shift, to make its own request', async () => {
    const office = device();
    const from = site.calls.length;
    const [, press, shift] = await Promise.all([
      office.listProductionCounters(WIDE),
      office.listProduction({ machineCode: PRESS, ...NARROW }),
      office.listProduction({ machineCode: PRESS, shiftId: '2026-11-09-Day' }),
    ]);
    expect(reads('PMD_Production', from)).toHaveLength(3);
    expect(press.filter((r) => r.statusCode)).toHaveLength(4);
    expect(shift.filter((r) => r.statusCode)).toHaveLength(4);
  });
});

describe('rows asked for alongside their columns', () => {
  it("asks for the machine register's rows without waiting for its columns", async () => {
    const office = device();
    const from = site.calls.length;
    const machines = await office.listMachineMaster!();
    expect(machines).toMatchObject([{ machineCode: PRESS, status: 'in-service' }]);
    const asked = site.calls.slice(from).map((c) => c.url);
    const rowsAt = asked.findIndex((u) => u.includes("getbytitle('PMD_Machine')/items"));
    const columnsAt = asked.findIndex((u) => u.includes("getbytitle('PMD_Machine')/fields"));
    // The rows went out first: they were not waiting on the columns.
    expect(rowsAt).toBeGreaterThanOrEqual(0);
    expect(columnsAt).toBeGreaterThan(rowsAt);
  });

  it('still fails the die-change log when its rows cannot be read', async () => {
    const office = device();
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      return url.includes("getbytitle('PMD_DieChangeLog')/items")
        ? Promise.resolve(new Response('nope', { status: 500 }))
        : real(input as string, init);
    }) as typeof fetch;
    try {
      await expect(office.listDieChangeLog!()).rejects.toThrow(/500/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
