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
  return siblingOf(planningPath, 'MangoWorkOrders.csv');
}

/** `file` in the same folder as the Planning CSV; '' with no planning path. */
function siblingOf(planningPath: string | undefined, file: string): string {
  if (!planningPath) return '';
  const slash = planningPath.lastIndexOf('/');
  const dir = slash >= 0 ? planningPath.slice(0, slash) : '';
  return `${dir}/${file}`;
}

/** MachinePM.csv — VITE_MACHINE_PM_CSV_PATH, else beside the Planning CSV. */
export function resolveMachinePmCsvPath(env: Record<string, string | undefined>): string {
  return env.VITE_MACHINE_PM_CSV_PATH || siblingOf(env.VITE_PLANNING_CSV_PATH, 'MachinePM.csv');
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

/** The backend a build runs on, and what is wrong with how it was asked for. */
export interface BackendChoice {
  kind: BackendKind;
  /** Why this is not the backend the build meant to have; null when it is. */
  problem: string | null;
}

/**
 * Which backend the build's environment asks for.
 *
 * Vite bakes VITE_BACKEND in at build time, and anything this did not
 * recognise used to fall through to the in-memory demo backend without a
 * word: a typo ("SharePoint"), a backend the README still names ("sql"),
 * or a missing .env.local all produced a page that looks right, takes a
 * shift's entries, and keeps none of them. The value is matched without
 * regard to case, and whatever cannot be honoured is said in `problem` so
 * the page can say so (main.ts) instead of looking healthy.
 */
export function resolveBackend(env: Record<string, string | undefined> = {}): BackendChoice {
  const asked = (env.VITE_BACKEND ?? '').trim();
  const name = asked.toLowerCase();
  if (name === 'sharepoint') {
    return (env.VITE_SITE_URL ?? '').trim()
      ? { kind: 'sharepoint', problem: null }
      : { kind: 'sharepoint', problem: 'VITE_BACKEND=sharepoint was built without VITE_SITE_URL' };
  }
  if (name === 'memory') return { kind: 'memory', problem: null };
  return {
    kind: 'memory',
    problem: asked
      ? `VITE_BACKEND="${asked}" is not a backend this build has (memory, sharepoint)`
      : 'built without VITE_BACKEND',
  };
}

/**
 * What the page has to tell whoever is looking at it about its backend, or
 * null when there is nothing to say. `production` is a built bundle
 * (`import.meta.env.PROD`): there, the demo data is never what a floor iPad
 * should be showing, whatever asked for it. Under `npm run dev` the demo
 * data with nothing set is the documented default and passes in silence;
 * only a value that was set and could not be honoured is called out.
 */
export function backendWarning(
  env: Record<string, string | undefined> = {},
  production = false,
): string | null {
  const choice = resolveBackend(env);
  if (choice.kind === 'sharepoint') {
    return choice.problem ? `SharePoint is not configured — ${choice.problem}.` : null;
  }
  const asked = (env.VITE_BACKEND ?? '').trim();
  if (!production && (!asked || !choice.problem)) return null;
  return `Demo data — this page is not connected to SharePoint and nothing entered here is saved${
    choice.problem ? ` (${choice.problem})` : ''
  }.`;
}

// §12.3 — a single feature flag swaps the backend with zero UI changes.
// Set VITE_BACKEND=sharepoint (and VITE_SITE_URL / VITE_PLANNING_CSV_PATH).
export function createDataLayer(env: Record<string, string | undefined> = {}): PmdDataLayer {
  const backend = resolveBackend(env).kind;
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
        // Mango's equipment register + PM events, same folder (Maint →
        // Machine / Team).
        machinePmCsvPath: resolveMachinePmCsvPath(env),
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
