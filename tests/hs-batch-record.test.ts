/**
 * The hot stamp batch on the record: PMD_Production / PMD_LiveStatus.BatchJobs.
 * Read back onto the canonical slot, so any device that opens HS sees the
 * batch; and optional — a tenant without the column still signs off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';

const realFetch = globalThis.fetch;
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
    clear: (): void => store.clear(),
    key: (): string | null => null,
    length: 0,
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('BatchJobs', () => {
  it('rides on the canonical slot when read', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const json = (v: unknown): Response =>
        ({ ok: true, status: 200, json: async () => v, text: async () => '' }) as unknown as Response;
      if (String(url).includes("getbytitle('PMD_Production')/items")) {
        return json({
          d: {
            results: [
              {
                ID: 1,
                Title: 'HS',
                MachineCode: '····RRRR········',
                'SlotStart_x003a_': '2026-11-27T07:00:00Z',
                ShiftId: 'Day',
                JobNumber: 'SFM600001',
                CountStart: 0,
                CountEnd: 40,
                Reject: 0,
                BatchJobs: 'SFM600001,SFM600002,SFM600003',
              },
            ],
          },
        });
      }
      return json({ d: { results: [] } });
    }) as unknown as typeof fetch;
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const rows = await dal.listProduction({ machineCode: 'HS', shiftId: '2026-11-27-Day' });
    expect(rows.find((r) => r.slotIndex === 0)?.batchJobs).toBe('SFM600001,SFM600002,SFM600003');
  });

  it('is dropped, not fatal, on a list without the column', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x', canWrite: () => true });
    const posts: Record<string, unknown>[] = [];
    const o = dal as unknown as {
      post: (url: string, body: Record<string, unknown>, ifMatch?: string) => Promise<void>;
      postWithFieldRetry: (list: string, url: string, body: Record<string, unknown>, ifMatch?: string) => Promise<void>;
    };
    o.post = async (_url, body) => {
      posts.push(body);
      if ('BatchJobs' in body) {
        throw new Error("POST 400 The property 'BatchJobs' does not exist on type 'SP.Data.PMD_ProductionListItem'.");
      }
    };
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', { Title: 'HS', CountEnd: 40, BatchJobs: 'A,B' });
    const last = posts[posts.length - 1];
    expect('BatchJobs' in last).toBe(false);
    expect(last.CountEnd).toBe(40);
  });
});
