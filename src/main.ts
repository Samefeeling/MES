import { createDataLayer, type PmdDataLayer } from './dal';
import { renderOperator, operatorPollTick } from './ui/operator';

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

const POLL_MS = 60_000; // §6.2 — active shift refresh
let pollTimer: ReturnType<typeof setInterval> | undefined;

function parseMachineFromHash(): string {
  const h = window.location.hash || '#/';
  const m = /^#\/op\/(.+)$/.exec(h);
  return m ? decodeURIComponent(m[1]) : '';
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
    let mc = parseMachineFromHash();
    if (!mc) {
      const machines = await dal.listMachines();
      mc = machines[0]?.machineCode ?? '';
      if (mc) {
        // Stamp the hash so a refresh keeps the same machine.
        window.location.hash = `#/op/${encodeURIComponent(mc)}`;
        return; // hashchange will re-enter route()
      }
    }
    await renderOperator(dal, mc);
    pollTimer = setInterval(operatorPollTick, POLL_MS);
    setStatus('☁ ready');
  } catch (e) {
    setStatus('☁ offline');
    console.error(e);
  }
}

window.addEventListener('hashchange', () => void route());
document.getElementById('refreshBtn')?.addEventListener('click', () => void route());

void route();
