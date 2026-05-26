import { createDataLayer, type PmdDataLayer } from './dal';
import { renderOperator, operatorPollTick } from './ui/operator';
import { renderTrace } from './ui/trace';

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

const POLL_MS = 60_000; // §6.2 — active shift refresh
let pollTimer: ReturnType<typeof setInterval> | undefined;

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

window.addEventListener('hashchange', () => void route());
document.getElementById('refreshBtn')?.addEventListener('click', () => void route());

void route();
