import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';

// PMD_Production.Reopened = Yes opens a signed row for correction on EVERY
// device, but the rehydrate + unlock flag that make an edit stick only ever
// ran on the device that pressed Unlock. On any other device the sheet
// rendered as open, an edit snapped back on the next read, and Sign Off
// found nothing to write and still reported success — leaving the row
// Reopened, which the KPI page (signed rows only) then left out.

const KEY = '1300T|2026-06-13-Day|SFM507068';
const SHIFT = { machineCode: '1300T', shiftId: '2026-06-13-Day' };

/** One PMD_Production row both "devices" read, with the server's flag. */
function server(reopened: boolean) {
  const state = { reopened, columnWrites: [] as Array<{ field: string; value: unknown }> };
  const row = () => ({
    machineCode: '1300T',
    date: '2026-06-13',
    shift: 'Day',
    jobNumber: 'SFM507068',
    partNumber: 'V11690',
    partDescription: 'Ned Stool - Slate',
    timeline: 'SSRRRRRRRR······',
    countStart: 100,
    countEnd: 200,
    reject: 0,
    operator: 'Heng Ong',
    supervisor: 'Bounpanh Wa',
    runTime: 4,
    downTime: 0,
    handover: '',
    qcChecks: '',
    rejectsBySlot: '',
    reopened: state.reopened,
    jobLeft: -1,
    shiftTarget: -1,
    vsPlan: -1,
    scheduleAttain: -1,
    schedulePlan: -1,
    plannedStart: '',
    signOff: '2026-06-13T05:00:00Z',
    modified: '2026-06-13T05:00:00Z',
  });
  return { state, row };
}

/** A device: its own DAL (and so its own cache) over the shared server row. */
function device(srv: ReturnType<typeof server>): SharePointDataLayer {
  const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
  const o = dal as unknown as {
    fetchHeaders: (list: string) => Promise<unknown[]>;
    fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
    fetchBreakdownDetailsByKey: () => Promise<Map<string, unknown>>;
    deleteLiveRow: () => Promise<void>;
    setProductionColumn: (
      mc: string,
      sid: string,
      job: string,
      field: string,
      value: unknown,
    ) => Promise<void>;
  };
  o.fetchHeaders = async (list) => (list === 'PMD_Production' ? [srv.row()] : []);
  o.fetchRejectsByKey = async () => new Map();
  o.fetchBreakdownDetailsByKey = async () => new Map();
  o.deleteLiveRow = async () => {};
  o.setProductionColumn = async (_mc, _sid, _job, field, value) => {
    srv.state.columnWrites.push({ field, value });
    if (field === 'Reopened') srv.state.reopened = value === true;
  };
  return dal;
}

const internals = (dal: SharePointDataLayer) =>
  dal as unknown as {
    editCache: Map<string, Array<{ slotIndex: number; statusCode: string }>>;
    unlockedTuples: Set<string>;
    dirtyTuples: Set<string>;
  };

describe('a re-opened order on a device that did not unlock it', () => {
  // Each device is its own browser: the localStorage shim is cleared between
  // them so one DAL never rehydrates the other's cache.
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
      clear: (): void => {
        store.clear();
      },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => store.clear());

  it('keeps an edit across the next read, on the whole tuple', async () => {
    const srv = server(true);
    const dal = device(srv);
    const before = await dal.listProduction(SHIFT);
    expect(before.every((r) => !r.locked)).toBe(true);
    expect(before.find((r) => r.slotIndex === 0)?.reopened).toBe(true);

    const slot3 = before.find((r) => r.slotIndex === 3)!;
    await dal.upsertProductionRecord({ ...slot3, statusCode: 'B' });
    const after = await dal.listProduction(SHIFT);

    // It used to read back 'R': the edit was purged as a stale copy.
    expect(after.find((r) => r.slotIndex === 3)?.statusCode).toBe('B');
    // And the tuple is whole — the signed slots came with it, so a sign-off
    // from here writes the full timeline and the counts, not one slot.
    expect(after.filter((r) => r.statusCode).length).toBe(10);
    expect(after.find((r) => r.slotIndex === 0)?.countStart).toBe(100);
    expect(after.find((r) => r.slotIndex === 0)?.countEnd).toBe(200);
    expect(internals(dal).unlockedTuples.has(KEY)).toBe(true);
  });

  it('does not adopt a signed row the server has NOT reopened', async () => {
    const srv = server(false);
    const dal = device(srv);
    const before = await dal.listProduction(SHIFT);
    expect(before.every((r) => r.locked)).toBe(true);

    // A stray tap on a locked sheet: still discarded on the next read.
    await dal.upsertProductionRecord({ ...before.find((r) => r.slotIndex === 3)!, statusCode: 'B' });
    const after = await dal.listProduction(SHIFT);

    expect(after.find((r) => r.slotIndex === 3)?.statusCode).toBe('R');
    expect(after.every((r) => r.locked)).toBe(true);
    expect(internals(dal).unlockedTuples.has(KEY)).toBe(false);
    // The purge takes the authorship mark with the copy.
    expect(internals(dal).dirtyTuples.has(KEY)).toBe(false);
  });

  it('a sign-off with nothing changed still closes the row on the server', async () => {
    const srv = server(true);
    const dal = device(srv);
    await dal.listProduction(SHIFT);

    // Nothing was edited here, so there is nothing in the cache to write.
    await dal.lockShift('1300T', '2026-06-13-Day', 'Bounpanh Wa', 'Heng Ong', 'SFM507068');

    // It used to return with no write at all and the row stayed Reopened.
    expect(srv.state.columnWrites).toEqual([{ field: 'Reopened', value: false }]);
    const after = await dal.listProduction(SHIFT);
    expect(after.every((r) => r.locked)).toBe(true);
  });

  it('a failed re-lock is reported, not swallowed', async () => {
    const srv = server(true);
    const dal = device(srv);
    await dal.listProduction(SHIFT);
    (dal as unknown as { setProductionColumn: () => Promise<void> }).setProductionColumn =
      async () => {
        throw new Error('POST 403 Access denied');
      };

    await expect(
      dal.lockShift('1300T', '2026-06-13-Day', 'Bounpanh Wa', 'Heng Ong', 'SFM507068'),
    ).rejects.toThrow(/403/);
    expect(srv.state.reopened).toBe(true);
  });

  it('ends the correction on every device once one of them signs it off', async () => {
    const srv = server(false);

    // Device A unlocks: the server row is reopened and A holds the copy.
    const a = device(srv);
    await a.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');
    expect(srv.state.reopened).toBe(true);
    const onA = await a.listProduction(SHIFT);
    await a.upsertProductionRecord({ ...onA.find((r) => r.slotIndex === 4)!, statusCode: 'M' });
    expect((await a.listProduction(SHIFT)).find((r) => r.slotIndex === 4)?.statusCode).toBe('M');

    // Device B (its own storage) signs the row off again.
    store.clear();
    srv.state.reopened = false;

    // A's next read: the window is over. Its copy must not shadow the row
    // B signed, and its edit — never signed — goes with it.
    const after = await a.listProduction(SHIFT);
    expect(after.every((r) => r.locked)).toBe(true);
    expect(after.find((r) => r.slotIndex === 4)?.statusCode).toBe('R');
    expect(internals(a).unlockedTuples.has(KEY)).toBe(false);
    expect(internals(a).editCache.has(KEY)).toBe(false);
  });

  it('keeps a device-local unlock on a tenant with no Reopened column', async () => {
    const srv = server(false);
    const dal = device(srv);
    // The column write is refused, so the server row never reads reopened.
    (dal as unknown as { setProductionColumn: () => Promise<void> }).setProductionColumn =
      async () => {
        throw new Error("POST 400 The property 'Reopened' does not exist");
      };

    await dal.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');
    const rows = await dal.listProduction(SHIFT);
    await dal.upsertProductionRecord({ ...rows.find((r) => r.slotIndex === 4)!, statusCode: 'M' });

    // Read after read, the local flag is all there is — and it holds.
    await dal.listProduction(SHIFT);
    const after = await dal.listProduction(SHIFT);
    expect(after.find((r) => r.slotIndex === 4)?.statusCode).toBe('M');
    expect(internals(dal).unlockedTuples.has(KEY)).toBe(true);
  });
});
