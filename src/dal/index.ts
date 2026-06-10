import type { PmdDataLayer, BackendKind } from './types';
import { MemoryDataLayer } from './memory';
import { SharePointDataLayer } from './sharepoint';

export type { PmdDataLayer, BackendKind } from './types';
export { MemoryDataLayer } from './memory';
export { SharePointDataLayer } from './sharepoint';

// §12.3 — a single feature flag swaps the backend with zero UI changes.
// Set VITE_BACKEND=sharepoint (and VITE_SITE_URL / VITE_PLANNING_CSV_PATH).
export function createDataLayer(env: Record<string, string | undefined> = {}): PmdDataLayer {
  const backend = (env.VITE_BACKEND ?? 'memory') as BackendKind;
  switch (backend) {
    case 'sharepoint':
      return new SharePointDataLayer({
        siteUrl: env.VITE_SITE_URL ?? '',
        planningCsvPath: env.VITE_PLANNING_CSV_PATH,
      });
    case 'memory':
    default:
      return new MemoryDataLayer();
  }
}
