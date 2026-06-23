import type { PmdDataLayer, BackendKind } from './types';
import { isIpadDevice } from '../core/device';
import { MemoryDataLayer } from './memory';
import { SharePointDataLayer } from './sharepoint';
import { isSupervisor } from '../ui/supervisor-auth';

export type { PmdDataLayer } from './types';

// §12.3 — a single feature flag swaps the backend with zero UI changes.
// Set VITE_BACKEND=sharepoint (and VITE_SITE_URL / VITE_PLANNING_CSV_PATH).
export function createDataLayer(env: Record<string, string | undefined> = {}): PmdDataLayer {
  const backend = (env.VITE_BACKEND ?? 'memory') as BackendKind;
  switch (backend) {
    case 'sharepoint':
      return new SharePointDataLayer({
        siteUrl: env.VITE_SITE_URL ?? '',
        planningCsvPath: env.VITE_PLANNING_CSV_PATH,
        // Device-class write rule: iPad writes freely; anything else is
        // read-only unless a supervisor is signed in. Replaces the old
        // per-device OwnerDevice claim arbitration that caused fights
        // between iPads on the floor.
        canWrite: () => isIpadDevice() || isSupervisor(),
      });
    case 'memory':
    default:
      return new MemoryDataLayer();
  }
}
