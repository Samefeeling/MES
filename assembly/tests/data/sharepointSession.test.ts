import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFile, sessionRows, sessionUpdate, sessionCreate, clearSessionSchemaCache } from '@/data/sharepoint/session';
import { SharePointPlanRepository } from '@/persistence/SharePointPlanRepository';

const cfg = { siteUrl: 'https://tenant.sharepoint.com/sites/factory', filePath: '', token: '', authMode: 'session' as const };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); clearSessionSchemaCache(); });
const context = () => vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });

describe('SharePoint session transport', () => {
  it('uses decoded server-relative paths for spaces, quotes and hash characters', () => {
    expect(sessionFile(cfg, "/Shared Documents/Parts #1's.csv")).toContain("decodedurl='%2Fsites%2Ffactory%2FShared%20Documents%2FParts%20%231%27%27s.csv'");
  });
  it('reads all pages and retains IDs, versions and multi-choice values', async () => {
    context();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ value: [] }))
      .mockResolvedValueOnce(json({ value: [{ Id: 7, Title: 'Tom', Skills: { results: ['UPL_GLUING'] }, 'odata.etag': '"2"' }], 'odata.nextLink': cfg.siteUrl + '/next' }))
      .mockResolvedValueOnce(json({ value: [{ Id: 8, Title: 'Mary' }] })));
    const rows = await sessionRows(cfg, 'ASSY_Operator');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: '7', etag: '"2"', fields: { Id: 7, id: '7', Title: 'Tom', Skills: ['UPL_GLUING'], 'odata.etag': '"2"' } });
  });
  it('does not retry a stale version with a wildcard', async () => {
    context();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: [{ Title: 'Title', InternalName: 'Title' }] })).mockResolvedValueOnce(json({ FormDigestValue: 'digest', FormDigestTimeoutSeconds: 1800 }))
      .mockResolvedValueOnce(json({}, 412));
    vi.stubGlobal('fetch', fetcher);
    await expect(sessionUpdate(cfg, 'ASSY_Plans', '1', { Title: 'current' }, '"2"')).rejects.toThrow('Another session');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const headers = fetcher.mock.calls[2][1].headers as Headers;
    expect(headers.get('IF-MATCH')).toBe('"2"');
  });
  it('does not turn an unreadable plan into an empty saved plan', async () => {
    context();
    const fetcher = vi.fn().mockResolvedValue(json({}, 403));
    vi.stubGlobal('fetch', fetcher);
    const repo = new SharePointPlanRepository(cfg);
    await expect(repo.load()).rejects.toThrow();
    await expect(repo.save({ id: 'current', name: 'Working plan', savedAt: new Date().toISOString(), containers: {} })).rejects.toThrow('Reload');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it('maps imported date columns before creating production rows', async () => {
  context();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/fields?')) return json({ value: [
      { Title: 'Title', InternalName: 'Title' }, { Title: 'Date', InternalName: 'field_2' },
    ] });
    if (url.endsWith('/_api/contextinfo')) return json({ FormDigestValue: 'digest', FormDigestTimeoutSeconds: 1800 });
    expect(JSON.parse(String(init?.body))).toEqual({ Title: 'SFM1', field_2: '2026-09-10' });
    return json({ Id: 21 });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await sessionCreate(cfg, 'ASSY_Production', { Title: 'SFM1', Date: '2026-09-10' })).toBe('21');
});

it('refuses a missing column before issuing any write', async () => {
  context();
  const fetcher = vi.fn().mockResolvedValue(json({ value: [{ Title: 'Title', InternalName: 'Title' }] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(sessionCreate(cfg, 'ASSY_Production', { Date: '2026-09-10' })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
