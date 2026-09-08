/**
 * Write-back to the `ASSY_Production` SharePoint list.
 *
 * The rules that matter here are about what must *not* happen: a drag must
 * never move Epicor's Due Date, a refresh with nothing changed must not write,
 * a read failure must not half-apply a plan, and the row an order opens with
 * must not drift to a new day on every refresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PRODUCTION_COLUMNS as C,
  orderFactsFromBoard,
  syncProduction,
  type OrderFacts,
} from '@/data/sharepoint/production.sync';
import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import type { ProductionEntry } from '@/store/planStore';
import { MockSource } from '@/data/mock/MockSource';
import { buildIndexes } from '@/engine/indexes';
import { computeAssemblyGantt } from '@/engine/assembly/board';
import { usePlanStore } from '@/store/planStore';

const CFG: SharePointConfig = {
  siteUrl: 'https://contoso.sharepoint.com/sites/PMD',
  filePath: '',
  token: 'test-token',
};

const shift = (over: Partial<ProductionEntry> = {}): ProductionEntry => ({
  date: '2026-09-14',
  complete: 0,
  reject: 0,
  rework: 0,
  shiftOutput: 0,
  paused: false,
  pauseReason: null,
  jobCompleted: false,
  notes: '',
  ...over,
});

const order = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  jobNum: 'ASM8001',
  line: 'UPL',
  operatorIds: ['W02'],
  operatorNames: ['Gate'],
  startDate: '2026-09-14T00:00:00.000Z',
  dueDate: '2026-09-22T00:00:00.000Z',
  expectDate: '2026-09-16T00:00:00.000Z',
  orderQty: 60,
  remainingQty: 60,
  anchorDay: '2026-09-14',
  shifts: [],
  ...over,
});

/** A stored row matching `order()` with an empty shift on the anchor day. */
const stored = (over: Record<string, unknown> = {}, id = '1') => ({
  id,
  fields: {
    [C.jobNum]: 'ASM8001',
    [C.date]: '2026-09-14',
    [C.line]: 'UPL',
    [C.operators]: 'Gate',
    [C.operatorIds]: 'W02',
    // Graph echoes dates back without the milliseconds we sent.
    [C.startDate]: '2026-09-14T00:00:00Z',
    [C.dueDate]: '2026-09-22T00:00:00Z',
    [C.expectDate]: '2026-09-16T00:00:00Z',
    [C.orderQty]: 60,
    [C.remainingQty]: 60,
    [C.shiftOutput]: 0,
    [C.complete]: 0,
    [C.reject]: 0,
    [C.rework]: 0,
    [C.jobCompleted]: false,
    [C.paused]: false,
    [C.pauseReason]: '',
    [C.notes]: '',
    ...over,
  },
});

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Stub Graph: one page of `items`, then record every write. */
function stubGraph(
  items: ReturnType<typeof stored>[],
  readOk: boolean | number = true,
): Call[] {
  const calls: Call[] = [];
  const status = readOk === true ? 200 : readOk === false ? 503 : readOk;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === 'GET') {
      return status === 200
        ? new Response(JSON.stringify({ value: items }), { status: 200 })
        : new Response('nope', { status, statusText: 'Refused' });
    }
    return new Response(JSON.stringify({ id: '99' }), { status: 200 });
  });
  return calls;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

beforeEach(() => usePlanStore.setState({ initialized: false }));
afterEach(() => vi.unstubAllGlobals());

describe('syncProduction', () => {
  it('opens one row for an order the list has never seen', async () => {
    const calls = stubGraph([]);
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);

    expect(out).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(out.errors).toEqual([]);

    const [write] = writes(calls);
    expect(write.method).toBe('POST');
    expect(write.body).toEqual({
      fields: {
        [C.jobNum]: 'ASM8001',
        [C.date]: '2026-09-14',
        [C.recordKey]: 'ASM8001|2026-09-14',
        [C.line]: 'UPL',
        [C.operators]: 'Gate',
        [C.operatorIds]: 'W02',
        [C.startDate]: '2026-09-14T00:00:00.000Z',
        [C.actualStartAt]: null,
        [C.startOverrideReason]: '',
        [C.dueDate]: '2026-09-22T00:00:00.000Z',
        [C.expectDate]: '2026-09-16T00:00:00.000Z',
        [C.orderQty]: 60,
        [C.remainingQty]: 60,
        [C.shiftOutput]: 0,
        [C.complete]: 0,
        [C.reject]: 0,
        [C.rework]: 0,
        [C.jobCompleted]: false,
        [C.completedAt]: null,
        [C.paused]: false,
        [C.pauseReason]: '',
        [C.notes]: '',
      },
    });
  });

  it('writes nothing when the list already says this', async () => {
    const calls = stubGraph([stored()]);
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);

    expect(out).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(writes(calls)).toEqual([]);
  });

  it('does not open a second row once the order has one', async () => {
    // The anchor day would move with the bar; the guard is that an order with
    // any existing row never opens another empty one.
    const calls = stubGraph([stored()]);
    const out = await syncProduction(CFG, 'ASSY_Production', [
      order({ anchorDay: '2026-09-20' }),
    ]);

    expect(out.created).toBe(0);
    expect(writes(calls).filter((w) => w.method === 'POST')).toEqual([]);
  });

  it('records the crew when the supervisor allocates', async () => {
    const calls = stubGraph([stored()]);
    const out = await syncProduction(CFG, 'ASSY_Production', [
      order({ operatorIds: ['W02', 'W07'], operatorNames: ['Gate', 'Jones'] }),
    ]);

    expect(out.updated).toBe(1);
    const [write] = writes(calls);
    expect(write.method).toBe('PATCH');
    expect(write.url).toContain('/items/1/fields');
    expect(write.body).toMatchObject({
      [C.operators]: 'Gate, Jones',
      [C.operatorIds]: 'W02,W07',
    });
  });

  it('moves the start day on a drag and does not send the due date at all', async () => {
    const calls = stubGraph([stored()]);
    await syncProduction(CFG, 'ASSY_Production', [
      order({ startDate: '2026-09-17T00:00:00.000Z' }),
    ]);

    // Only what drifted is patched, so Epicor's due date is not merely
    // unchanged — it never appears in the request.
    const [write] = writes(calls);
    expect(write.body).toEqual({ [C.startDate]: '2026-09-17T00:00:00.000Z' });
  });

  it('keeps the export’s due date when a drag rewrites the whole row', async () => {
    // With a booked shift on that day the full row is written, so the due date
    // does travel — as the value the CSV gave, never one derived from the drag.
    const calls = stubGraph([stored()]);
    await syncProduction(CFG, 'ASSY_Production', [
      order({
        startDate: '2026-09-17T00:00:00.000Z',
        shifts: [shift({ date: '2026-09-14', shiftOutput: 5 })],
      }),
    ]);

    const [write] = writes(calls);
    expect(write.body?.[C.startDate]).toBe('2026-09-17T00:00:00.000Z');
    expect(write.body?.[C.dueDate]).toBe('2026-09-22T00:00:00.000Z');
  });

  it('pushes a changed due date onto every row of the job', async () => {
    const rows = [
      stored({}, '1'),
      stored({ [C.date]: '2026-09-15' }, '2'),
      stored({ [C.date]: '2026-09-16' }, '3'),
    ];
    const calls = stubGraph(rows);
    const out = await syncProduction(CFG, 'ASSY_Production', [
      order({ dueDate: '2026-09-25T00:00:00.000Z', remainingQty: 42 }),
    ]);

    expect(out.updated).toBe(3);
    const patched = writes(calls);
    expect(patched).toHaveLength(3);
    for (const w of patched) {
      expect(w.method).toBe('PATCH');
      expect(w.body?.[C.dueDate]).toBe('2026-09-25T00:00:00.000Z');
      expect(w.body?.[C.remainingQty]).toBe(42);
    }
  });

  it('leaves another day’s production figures alone when only the plan moved', async () => {
    const older = stored(
      { [C.date]: '2026-09-12', [C.shiftOutput]: 18, [C.complete]: 16 },
      '2',
    );
    const calls = stubGraph([stored(), older]);
    await syncProduction(CFG, 'ASSY_Production', [
      order({ dueDate: '2026-09-25T00:00:00.000Z' }),
    ]);

    const onOlder = writes(calls).find((w) => w.url.includes('/items/2/'));
    expect(onOlder?.body).toEqual({ [C.dueDate]: '2026-09-25T00:00:00.000Z' });
    expect(onOlder?.body).not.toHaveProperty(C.shiftOutput);
    expect(onOlder?.body).not.toHaveProperty(C.complete);
  });

  it('books what the shift entered, one row per day', async () => {
    const calls = stubGraph([stored()]);
    const out = await syncProduction(CFG, 'ASSY_Production', [
      order({
        shifts: [
          shift({ date: '2026-09-14', shiftOutput: 12, complete: 10, reject: 2 }),
          shift({ date: '2026-09-15', shiftOutput: 9, complete: 9, jobCompleted: true }),
        ],
      }),
    ]);

    expect(out).toMatchObject({ created: 1, updated: 1 });
    const patch = writes(calls).find((w) => w.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      [C.date]: '2026-09-14',
      [C.shiftOutput]: 12,
      [C.complete]: 10,
      [C.reject]: 2,
    });
    const post = writes(calls).find((w) => w.method === 'POST');
    expect(post?.body).toMatchObject({
      fields: expect.objectContaining({
        [C.date]: '2026-09-15',
        [C.jobCompleted]: true,
      }),
    });
  });

  it('keeps each shift crew snapshot after the active crew changes', async () => {
    const calls = stubGraph([stored({ [C.operators]: 'Gate', [C.operatorIds]: 'W02' })]);
    await syncProduction(CFG, 'ASSY_Production', [
      order({
        operatorIds: [],
        operatorNames: [],
        shifts: [
          shift({
            operatorIds: ['W02'],
            operatorNames: ['Gate'],
            complete: 10,
            jobCompleted: true,
            completedAt: '2026-09-14T05:00:00.000Z',
          }),
        ],
      }),
    ]);

    const [write] = writes(calls);
    expect(write.body).toMatchObject({
      [C.operators]: 'Gate',
      [C.operatorIds]: 'W02',
      [C.completedAt]: '2026-09-14T05:00:00.000Z',
    });
  });

  it('refuses ambiguous duplicate rows for the same order and day', async () => {
    const calls = stubGraph([stored({}, '1'), stored({}, '2')]);
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);

    expect(out.errors[0]).toContain('duplicate SharePoint rows');
    expect(writes(calls)).toEqual([]);
  });

  it('never writes fallback demo employee ids', async () => {
    const calls = stubGraph([]);
    const out = await syncProduction(CFG, 'ASSY_Production', [
      order({ hasSyntheticCrew: true }),
    ]);

    expect(out.errors[0]).toContain('fallback demo employees');
    expect(writes(calls)).toEqual([]);
  });

  it('leaves rows for orders that are no longer in the export', async () => {
    const calls = stubGraph([stored(), stored({ Title: 'ASM9999' }, '2')]);
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);

    expect(out).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(writes(calls)).toEqual([]);
  });

  it('writes nothing at all when the list cannot be read', async () => {
    const calls = stubGraph([], false);
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);

    expect(out.errors[0]).toContain('503');
    expect(out).toMatchObject({ created: 0, updated: 0 });
    expect(writes(calls)).toEqual([]);
  });

  it('refuses to write without a Graph token', async () => {
    const calls = stubGraph([]);
    const out = await syncProduction({ ...CFG, token: '' }, 'ASSY_Production', [
      order(),
    ]);

    expect(out.errors[0]).toContain('token');
    expect(calls).toEqual([]);
  });
});

describe('orderFactsFromBoard', () => {
  it('mirrors the schedulable lines only, never the PMD context lane', async () => {
    const loaded = await new MockSource().loadAll();
    if (!loaded.ok) throw new Error(loaded.error);
    const dataset = loaded.value;

    usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs);
    const state = usePlanStore.getState();
    const board = computeAssemblyGantt({
      dataset,
      indexes: buildIndexes(dataset),
      containers: state.containers,
      orderCrewAssignments: state.orderCrewAssignments,
      orderStarts: {},
      progress: {},
      production: {},
      workers: dataset.workers,
      today: new Date('2026-09-11T00:00:00'),
    });

    const facts = orderFactsFromBoard(board, {});
    const mouldingIds = new Set(
      dataset.jobs.filter((j) => j.department === 'moulding').map((j) => String(j.id)),
    );

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => mouldingIds.has(f.jobNum))).toBe(false);
    for (const f of facts) {
      expect(['UPL', 'ASSY', 'TABLE']).toContain(f.line);
      expect(f.orderQty).toBeGreaterThanOrEqual(f.remainingQty);
      // Every order can open a row, even one with nobody on it yet.
      expect(f.anchorDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

/**
 * Which failures are worth trying again.
 *
 * The retry used to be decided by matching the error text, and every message
 * out of the Graph client contains the word "fetch" — so a bad token was
 * retried every minute for as long as the tab stayed open, and the banner
 * never stopped saying the same thing.
 */
describe('what a failed sync asks for', () => {
  const failWith = async (status: number) => {
    stubGraph([], status);
    return syncProduction(CFG, 'ASSY_Production', [order()]);
  };

  it('asks to try again when the far end had a bad moment', async () => {
    for (const status of [500, 502, 503, 429]) {
      const out = await failWith(status);
      expect(out.retryable, `status ${status}`).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it('does not ask again for an answer that will not change', async () => {
    for (const status of [400, 401, 403, 404]) {
      const out = await failWith(status);
      expect(out.retryable, `status ${status}`).toBe(false);
      expect(out.errors[0]).toContain(String(status));
      vi.unstubAllGlobals();
    }
  });

  it('does not ask again when nothing is configured to try', async () => {
    const out = await syncProduction(
      { ...CFG, token: '' },
      'ASSY_Production',
      [order()],
    );
    expect(out.retryable).toBe(false);
    expect(out.errors[0]).toContain('token');
  });

  it('asks again when the request never got an answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const out = await syncProduction(CFG, 'ASSY_Production', [order()]);
    expect(out.retryable).toBe(true);
  });
});

/**
 * The Date column names a shift, not a moment. What SharePoint hands back
 * depends on how the column was made: date-only gives midnight UTC, datetime
 * gives the site's own midnight, which is the previous day in UTC. Reading it
 * with the UTC getters answered a day early for the second, so every refresh
 * opened the row again and then refused to write, having made the duplicate it
 * was complaining about.
 */
describe('matching a stored row to its shift', () => {
  const dayOnly = '2026-09-14T00:00:00Z';
  // Sydney's own midnight on the 14th, which is the 13th in UTC.
  const siteMidnight = '2026-09-13T14:00:00Z';

  it('recognises its own row however the column stores the day', async () => {
    for (const value of ['2026-09-14', dayOnly, siteMidnight]) {
      const calls = stubGraph([stored({ [C.date]: value })]);
      const out = await syncProduction(CFG, 'ASSY_Production', [order()]);
      expect(writes(calls), `date stored as ${value}`).toEqual([]);
      expect(out.unchanged, `date stored as ${value}`).toBe(1);
      expect(out.created).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it('does not read a note with a weekday in it as a date', async () => {
    // "Tue" parses on its own in some engines; the Notes column is text and
    // must be compared as text whatever it happens to contain.
    const calls = stubGraph([stored({ [C.notes]: 'Tue: waiting on trim' })]);
    await syncProduction(CFG, 'ASSY_Production', [
      order({ shifts: [shift({ notes: 'Wed: trim arrived' })] }),
    ]);
    // An update patches the fields directly, so the note is at the top level.
    const written = writes(calls);
    expect(written).toHaveLength(1);
    expect(written[0].method).toBe('PATCH');
    expect(written[0].body).toMatchObject({ [C.notes]: 'Wed: trim arrived' });
  });
});
