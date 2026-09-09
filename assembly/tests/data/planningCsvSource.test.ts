/**
 * `PlanningCsvSource` end to end with the network stubbed: the CSV fetch, the
 * Graph call for `ASSY_Operator`, and the dataset they combine into.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlanningCsvSource } from '@/data/csv/PlanningCsvSource';
import type { SharePointConfig } from '@/data/excel/sharepoint.client';

const CSV = [
  'JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,JobHead_Department,JobHead_ProdQty,Calculated_RemainingQty,JobHead_StartDate,JobHead_ReqDueDate,Calculated_LaborHrs,JobOper_ProdStandard',
  'SFM507615,7911FR,Encore,1300T,34,34,2026-09-29T00:00:00,2026-09-30T00:00:00,0.77,0.022727',
  '018140-1-1,CSSL01436,"Cosmic Stool, walnut",ASSY,30,18,2026-09-10T00:00:00,2026-09-11T00:00:00,2.1,0.07',
].join('\n');

const ROSTER = {
  value: [
    { fields: { id: '1', Operator: 'Aroha T.', Position: 'Sewer', Skills: 'Cutting/Sewing' } },
    { fields: { id: '2', Operator: 'Ben K.', Position: 'Assembler', Skills: ['ASSY'] } },
  ],
};

const LINKS = [
  'JobMtl_JobNum,JobHead_PartNum,JobMtl_PartNum,JobMtl_RequiredQty',
  '018140-1-1,CSSL01436,7911FR,30',
].join('\n');

const CSV_URL = 'https://example.test/Planning1.csv';
const LINKS_URL = 'https://example.test/JobMaterialReq.csv';
const INVENTORY_URL = 'https://example.test/OnHandInventory.csv';
const INVENTORY = 'Part_PartNum,Calculated_OnHand\n7911FR,42';
const SP: SharePointConfig = {
  siteUrl: 'https://contoso.sharepoint.com/sites/PMD',
  filePath: '',
  token: 'test-token',
};

/** Serve the CSV on its URL and the roster on any Graph list URL. */
function stubNetwork(roster: unknown = ROSTER) {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === CSV_URL) {
      return new Response(CSV, { status: 200 });
    }
    if (url === LINKS_URL) {
      return new Response(LINKS, { status: 200 });
    }
    if (url === INVENTORY_URL) {
      return new Response(INVENTORY, { status: 200 });
    }
    if (url.includes('/lists/')) {
      return new Response(JSON.stringify(roster), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

const source = () =>
  new PlanningCsvSource({ url: CSV_URL, filePath: '' }, SP);

afterEach(() => vi.unstubAllGlobals());

describe('PlanningCsvSource', () => {
  it('loads orders and people into one dataset', async () => {
    stubNetwork();
    const res = await source().loadAll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.jobs.map((j) => String(j.id))).toEqual([
      'SFM507615',
      '018140-1-1',
    ]);
    expect(res.value.workers.map((w) => w.name)).toEqual([
      'Aroha T.',
      'Ben K.',
    ]);
  });

  it('asks Graph for the ASSY_Operator list on the configured site', async () => {
    const calls = stubNetwork();
    await source().loadAll();
    const listCall = calls.find((u) => u.includes('/lists/'));
    expect(listCall).toContain('contoso.sharepoint.com:/sites/PMD:');
    expect(listCall).toContain('/lists/ASSY_Operator/items');
    expect(listCall).toContain('expand=fields');
  });

  it('fetches the CSV once even though two methods need it', async () => {
    const calls = stubNetwork();
    await source().loadAll();
    expect(calls.filter((u) => u === CSV_URL)).toHaveLength(1);
  });

  it('re-fetches on the next load, so the hourly refresh sees new rows', async () => {
    const calls = stubNetwork();
    const s = source();
    await s.loadAll();
    await s.loadAll();
    expect(calls.filter((u) => u === CSV_URL)).toHaveLength(2);
  });

  it('offers the presses named in the CSV as work centres, plus all operational groups', async () => {
    stubNetwork();
    const res = await source().loadAll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workCenters.map((w) => String(w.id))).toEqual([
      '1300T',
      'PMD',
      'UPL_CUT_SEW',
      'UPL_GLUING',
      'UPL',
      'UPL_SOFTIE',
      'ASSY_STOOL',
      'ASSY',
      'TABLE',
      'FACTORY_GENERAL',
    ]);
  });

  it('carries the CSV’s progress through to the dataset', async () => {
    stubNetwork();
    const res = await source().loadAll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stool = res.value.jobs.find((j) => String(j.id) === '018140-1-1')!;
    expect(stool.completedQty).toBe(12); // 30 ordered − 18 remaining
    expect(stool.remainingQty).toBe(18);
  });

  it('keeps the real roster empty when SharePoint cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === CSV_URL
          ? new Response(CSV, { status: 200 })
          : new Response('nope', { status: 403 }),
      ),
    );
    const s = source();
    const res = await s.loadAll();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.jobs).toHaveLength(2); // orders still schedule
    expect(res.value.workers).toEqual([]);
    expect(s.warnings.join(' ')).toContain('403');
    expect(s.warnings.join(' ')).toMatch(/no crew will be allocated/);
  });

  it('leaves jobLinks empty when no material export is configured', async () => {
    const calls = stubNetwork();
    const res = await source().loadAll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.jobLinks).toEqual([]);
    // And it does not go looking for one.
    expect(calls.some((u) => u.includes('JobMaterialReq'))).toBe(false);
  });

  it('reads JobMaterialReq.csv when it is configured', async () => {
    stubNetwork();
    const s = new PlanningCsvSource(
      { url: CSV_URL, filePath: '', linksUrl: LINKS_URL },
      SP,
    );
    const res = await s.loadAll();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.jobLinks).toHaveLength(1);
    expect(res.value.jobLinks[0]).toMatchObject({
      jobNum: '018140-1-1',
      childPart: '7911FR',
      requiredQty: 30,
    });
  });

  it('reads OnHandInventory.csv when configured and indexes its on-hand value', async () => {
    stubNetwork();
    const s = new PlanningCsvSource(
      { url: CSV_URL, filePath: '', inventoryUrl: INVENTORY_URL },
      SP,
    );
    const res = await s.loadAll();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.inventory).toHaveLength(1);
    expect(res.value.inventory[0]).toMatchObject({ onHand: 42, freeOnHand: 42 });
    expect(String(res.value.inventory[0].partNum)).toBe('7911FR');
  });

  it('still schedules when the material export is unreachable', async () => {
    // Losing the dependencies costs the chain, not the board.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === CSV_URL
          ? new Response(CSV, { status: 200 })
          : new Response('nope', { status: 404 }),
      ),
    );
    const s = new PlanningCsvSource(
      { url: CSV_URL, filePath: '', linksUrl: LINKS_URL },
      SP,
    );
    const res = await s.loadAll();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.jobs).toHaveLength(2);
    expect(res.value.jobLinks).toEqual([]);
    expect(s.warnings.join(' ')).toContain('JobMaterialReq.csv');
  });

  it('fails the load when the CSV itself cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })),
    );
    const res = await source().loadAll();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('404');
  });
});
