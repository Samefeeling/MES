import { createDataLayer, type PmdDataLayer } from './dal';
import { renderDashboard } from './ui/dashboard';
import { renderMachine, machinePollTick } from './ui/machine';

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

const POLL_MS = 60_000; // §6.2 — active shift polls every 60s
let pollTimer: ReturnType<typeof setInterval> | undefined;

interface Route {
  view: 'dashboard' | 'machine';
  machineCode?: string;
}

function parseRoute(): Route {
  const h = window.location.hash || '#/';
  const m = /^#\/machine\/(.+)$/.exec(h);
  if (m) return { view: 'machine', machineCode: decodeURIComponent(m[1]) };
  return { view: 'dashboard' };
}

function setStatus(text: string): void {
  const el = document.getElementById('ss');
  if (el) el.textContent = text;
}

async function route(): Promise<void> {
  const r = parseRoute();
  const back = document.getElementById('bk');
  const title = document.getElementById('pt');
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  try {
    setStatus('☁ syncing');
    if (r.view === 'machine' && r.machineCode) {
      back?.classList.remove('hidden');
      if (title) title.textContent = r.machineCode;
      await renderMachine(dal, r.machineCode);
      pollTimer = setInterval(machinePollTick, POLL_MS);
    } else {
      back?.classList.add('hidden');
      if (title) title.textContent = 'PMD Dashboard';
      await renderDashboard(dal);
    }
    setStatus('☁ ready');
  } catch (e) {
    setStatus('☁ offline');
    console.error(e);
  }
}

window.addEventListener('hashchange', () => void route());
document.getElementById('bk')?.addEventListener('click', () => {
  window.location.hash = '#/';
});
document.getElementById('refreshBtn')?.addEventListener('click', () => void route());

void route();
