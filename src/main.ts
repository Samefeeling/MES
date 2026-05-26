import { canSyncPlanning, createDataLayer, type PmdDataLayer } from './dal';
import { renderOperator, operatorPollTick } from './ui/operator';
import { renderTrace } from './ui/trace';

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

// Dev convenience: expose the DAL so the smoke-test snippets in
// docs/LOCAL_DEV_WITH_SHAREPOINT.md and `diagnoseFields()` work without
// editing the source. Stripped in production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __pmdDal: PmdDataLayer }).__pmdDal = dal;
}

const POLL_MS = 60_000; // §6.2 — active shift refresh
let pollTimer: ReturnType<typeof setInterval> | undefined;

// Daily auto-sync: every operator who opens the app triggers a fresh
// Excel → PMD_Planning pull if the last one was more than this old.
// 6 h means even mid-shift edits to the workbook land within one shift.
// The manual ⟳ Refresh button still works for "I just edited it, pull now."
const AUTO_SYNC_AFTER_MS = 6 * 60 * 60 * 1000;
const LAST_SYNC_KEY = 'pmd:lastPlanningSync';

interface Route {
  view: 'operator' | 'trace';
  machineCode?: string;
}

function parseRoute(): Route {
  const h = window.location.hash || '#/';
  if (h.startsWith('#/trace')) return { view: 'trace' };
  const m = /^#\/op\/(.+)$/.exec(h);
  if (m) return { view: 'operator', machineCode: decodeURIComponent(m[1]) };
  return { view: 'operator' };
}

function setStatus(text: string): void {
  const el = document.getElementById('ss');
  if (el) el.textContent = text;
}

async function route(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  try {
    setStatus('☁ syncing');
    const r = parseRoute();
    if (r.view === 'trace') {
      await renderTrace(dal);
    } else {
      let mc = r.machineCode ?? '';
      if (!mc) {
        const machines = await dal.listMachines();
        mc = machines[0]?.machineCode ?? '';
        if (mc) {
          window.location.hash = `#/op/${encodeURIComponent(mc)}`;
          return; // hashchange re-enters route()
        }
      }
      await renderOperator(dal, mc);
      pollTimer = setInterval(operatorPollTick, POLL_MS);
    }
    setStatus('☁ ready');
  } catch (e) {
    setStatus('☁ offline');
    console.error(e);
  }
}

/**
 * In-browser fallback for the daily Excel → PMD_Planning refresh.
 * Triggered on first load of each operator's browser, gated by a 6 h
 * localStorage cookie so we don't hammer Graph on every navigation.
 * The proper scheduled job lives outside the app (Power Automate flow,
 * see docs/DEPLOYMENT.md).
 */
async function autoSyncPlanningIfStale(): Promise<void> {
  if (!canSyncPlanning(dal)) return; // memory backend / adapter without Graph
  const last = Number(localStorage.getItem(LAST_SYNC_KEY) ?? 0);
  if (last && Date.now() - last < AUTO_SYNC_AFTER_MS) return;
  try {
    setStatus('☁ syncing planning…');
    const { inserted, skipped } = await dal.syncPlanningFromExcel();
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    console.info(`[planning] auto-sync ok · ${inserted} in, ${skipped} skipped`);
    // Re-render so the freshly-pulled orders show up in the Job# dropdown.
    await route();
  } catch (e) {
    // Don't surface a red toast — the operator may not have a Graph token
    // yet (e.g. MSAL still resolving), and the Refresh button is right there.
    console.warn('[planning] auto-sync skipped:', (e as Error).message);
  }
}

window.addEventListener('hashchange', () => void route());
document.getElementById('refreshBtn')?.addEventListener('click', () => void route());

void route();
void autoSyncPlanningIfStale();
