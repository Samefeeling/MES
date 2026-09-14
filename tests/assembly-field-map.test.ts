import { afterEach, expect, it, vi } from 'vitest';
import { createAssemblyDataLayer } from '../src/dal/sharepoint';
afterEach(() => vi.unstubAllGlobals());
it('filters and reads Assembly KPI dates using the imported internal column', async () => {
  vi.stubGlobal('window', { location: { origin: 'https://tenant.sharepoint.com' } });
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/fields?')) return new Response(JSON.stringify({ value: [
      { Title: 'Title', InternalName: 'Title' },
      { Title: 'Date', InternalName: 'field_2' },
      { Title: 'ShiftOutput', InternalName: 'field_3' },
    ] }));
    expect(decodeURIComponent(url)).toContain("field_2 ge datetime'2026-09-10");
    return new Response(JSON.stringify({ value: [{ Id: 1, Title: 'SFM1', field_2: '2026-09-10T00:00:00Z', field_3: 12 }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  const dal = createAssemblyDataLayer({ VITE_BACKEND: 'sharepoint', VITE_SITE_URL: 'https://tenant.sharepoint.com/sites/factory' });
  expect(await dal.results('2026-09-10', '2026-09-10')).toMatchObject([{ job: 'SFM1', day: '2026-09-10', output: 12 }]);
});
