import type { PmdDataLayer, BackendKind } from './types';
import { MemoryDataLayer } from './memory';
import { SharePointDataLayer } from './sharepoint';
import { SqlDataLayer } from './sql';
import { AzureDataLayer } from './azure';

export type { PmdDataLayer, BackendKind } from './types';
export { MemoryDataLayer } from './memory';

// §12.3 — a single feature flag swaps the backend with zero UI changes.
// Set VITE_BACKEND=sharepoint|sql|azure (and VITE_API_BASE / VITE_SITE_URL).
export function createDataLayer(env: Record<string, string | undefined> = {}): PmdDataLayer {
  const backend = (env.VITE_BACKEND ?? 'memory') as BackendKind;
  switch (backend) {
    case 'sharepoint':
      return new SharePointDataLayer(env.VITE_SITE_URL ?? '');
    case 'sql':
      return new SqlDataLayer(env.VITE_API_BASE ?? '/api');
    case 'azure':
      return new AzureDataLayer(env.VITE_API_BASE ?? '/api');
    case 'memory':
    default:
      return new MemoryDataLayer();
  }
}
