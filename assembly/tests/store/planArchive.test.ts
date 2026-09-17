/**
 * A day of the plan, kept.
 *
 * The working plan is one row that every save overwrites, so the board had no
 * history at all: nothing to compare this morning's allocation with, and no way
 * back from a mis-drag somebody noticed a day later. Each day the board is used
 * now leaves a row of its own, holding that day's last saved state — which is
 * also, exactly, what the next day opened on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharePointPlanRepository } from '@/persistence/SharePointPlanRepository';
import { LocalStoragePlanRepository } from '@/persistence/LocalStoragePlanRepository';
import {
  CURRENT_PLAN_ID,
  dailyPlanId,
  isDailyPlanId,
  type PersistedPlan,
} from '@/persistence/PlanRepository';
import { clearSessionSchemaCache } from '@/data/sharepoint/session';

const cfg = {
  siteUrl: 'https://tenant.sharepoint.com/sites/factory',
  filePath: '',
  token: '',
  authMode: 'session' as const,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const plan = (id: string, at: string): PersistedPlan => ({
  id,
  name: 'Working plan',
  savedAt: at,
  containers: { __pool__: [] },
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionSchemaCache();
});

describe('the day plan a board leaves behind', () => {
  it('names one row per day, apart from the working plan', () => {
    expect(dailyPlanId('2026-09-15')).toBe('day-2026-09-15');
    expect(isDailyPlanId('day-2026-09-15')).toBe(true);
    expect(isDailyPlanId(CURRENT_PLAN_ID)).toBe(false);
  });

  it('files it beside the working plan, never over it', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });
    const rows = [
      {
        Id: 1,
        'odata.etag': '"4"',
        Title: CURRENT_PLAN_ID,
        PlanJson: JSON.stringify(plan(CURRENT_PLAN_ID, '2026-09-15T06:00:00.000Z')),
        SavedAt: '2026-09-15T06:00:00.000Z',
      },
    ];
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/fields?')) {
        return json({
          value: ['Title', 'PlanJson', 'SavedAt'].map((name) => ({
            Title: name,
            InternalName: name,
          })),
        });
      }
      if (url.endsWith('/_api/contextinfo')) {
        return json({ FormDigestValue: 'd', FormDigestTimeoutSeconds: 1800 });
      }
      if ((init?.method ?? 'GET') === 'GET') return json({ value: rows });
      const body = JSON.parse(String(init?.body));
      posted.push({ url, body });
      // A create adds a row; a MERGE rewrites the one it is addressed to.
      if (url.endsWith('/items')) rows.push({ Id: rows.length + 1, 'odata.etag': '"1"', ...body } as never);
      else Object.assign(rows.find((row) => url.endsWith(`items(${row.Id})`))!, body);
      return json({ Id: rows.length });
    });

    const repo = new SharePointPlanRepository(cfg);
    await repo.load();
    const yesterday = plan(dailyPlanId('2026-09-15'), '2026-09-15T06:00:00.000Z');
    await repo.saveSnapshot(yesterday);

    expect(posted).toHaveLength(1);
    // A new row, not a write to the working plan's item…
    expect(posted[0].url).toMatch(/\/items$/);
    expect(posted[0].body).toMatchObject({ Title: 'day-2026-09-15' });

    // …and filed once: a second board opening later, or a tab that was open
    // across midnight, must not overwrite the history with a staler copy.
    await repo.saveSnapshot(yesterday);
    expect(posted).toHaveLength(1);

    // The working plan is still addressed by its own version.
    await repo.save(plan(CURRENT_PLAN_ID, '2026-09-16T01:00:00.000Z'));
    expect(posted[1].url).toMatch(/items\(1\)$/);
  });

  it('keeps the first copy of a day in the browser store too', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
    });
    const repo = new LocalStoragePlanRepository();
    const day = dailyPlanId('2026-09-15');
    await repo.saveSnapshot(plan(day, '2026-09-15T06:00:00.000Z'));
    await repo.saveSnapshot(plan(day, '2026-09-15T23:00:00.000Z'));
    expect((await repo.load(day))?.savedAt).toBe('2026-09-15T06:00:00.000Z');
  });
});
