import type { PmdDataLayer, BackendKind } from './types';
import { isIpadDevice } from '../core/device';
import { MemoryDataLayer } from './memory';
import { SharePointDataLayer } from './sharepoint';
import { isSupervisor } from '../ui/supervisor-auth';

export type { PmdDataLayer } from './types';

/** The Mango work-order CSV lives next to the Planning CSV in the same
 *  OneDrive-synced folder. When VITE_MANGO_CSV_PATH isn't set explicitly,
 *  derive it from the planning path's directory so the Die tab's work-order
 *  mirror lights up from one env var — swap the planning file name for
 *  MangoWorkOrders.csv. Returns '' when there's nothing to derive from. */
export function deriveMangoCsvPath(planningPath?: string): string {
  if (!planningPath) return '';
  const slash = planningPath.lastIndexOf('/');
  const dir = slash >= 0 ? planningPath.slice(0, slash) : '';
  return `${dir}/MangoWorkOrders.csv`;
}

/** Resolve the Mango work-order CSV path from the environment, tolerating
 *  the few names it's been configured under in the field
 *  (VITE_MANGO_CSV_PATH / VITE_MANGOWORKORDERS_CSV_PATH / VITE_MANGO_WORKORDERS_CSV_PATH).
 *  Falls back to MangoWorkOrders.csv beside the Planning CSV. */
export function resolveMangoCsvPath(env: Record<string, string | undefined>): string {
  return (
    env.VITE_MANGO_CSV_PATH ||
    env.VITE_MANGOWORKORDERS_CSV_PATH ||
    env.VITE_MANGO_WORKORDERS_CSV_PATH ||
    deriveMangoCsvPath(env.VITE_PLANNING_CSV_PATH)
  );
}

// §12.3 — a single feature flag swaps the backend with zero UI changes.
// Set VITE_BACKEND=sharepoint (and VITE_SITE_URL / VITE_PLANNING_CSV_PATH).
export function createDataLayer(env: Record<string, string | undefined> = {}): PmdDataLayer {
  const backend = (env.VITE_BACKEND ?? 'memory') as BackendKind;
  switch (backend) {
    case 'sharepoint':
      return new SharePointDataLayer({
        siteUrl: env.VITE_SITE_URL ?? '',
        planningCsvPath: env.VITE_PLANNING_CSV_PATH,
        // Mango work-order report mirror (Die Management tab). Accepts the
        // env var under any of its field names, else auto-resolves
        // MangoWorkOrders.csv beside the Planning CSV. See
        // scripts/sync-mango-csv.mjs + DEPLOYMENT.md.
        mangoCsvPath: resolveMangoCsvPath(env),
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
