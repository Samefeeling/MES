import { describe, it, expect } from 'vitest';
import { canSyncPlanning, SharePointDataLayer } from '../src/dal/sharepoint';
import { MemoryDataLayer } from '../src/dal/memory';

describe('SharePoint DAL surface', () => {
  it('canSyncPlanning duck-typed gate', () => {
    const sp = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/foo',
    });
    expect(canSyncPlanning(sp)).toBe(true);
    expect(canSyncPlanning(new MemoryDataLayer(new Date(2026, 0, 1)))).toBe(false);
  });

  it('accepts the string siteUrl shorthand for backwards compat', () => {
    const sp = new SharePointDataLayer('https://example.sharepoint.com/sites/foo');
    expect(sp).toBeInstanceOf(SharePointDataLayer);
  });

  it('syncPlanningFromExcel fails fast when graphToken is not configured', async () => {
    const sp = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/foo',
    });
    await expect(sp.syncPlanningFromExcel()).rejects.toThrow(/graphToken/);
  });
});
