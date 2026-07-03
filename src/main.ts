import { createDataLayer, type PmdDataLayer } from './dal';
import { renderOperator, operatorPollTick, loadSavedOperatorView } from './ui/operator';
import { renderTrace } from './ui/trace';
import { renderKpi } from './ui/kpi';
import { closeModal, openModal } from './ui/modal';
import {
  clearSupervisor,
  isSupervisor,
  onSupervisorChange,
  tryEnterSupervisor,
} from './ui/supervisor-auth';
import { toast } from './ui/toast';
import { maybeAutoStartTutorial, startTutorial } from './ui/tutorial';
import { startAutoUpdate } from './ui/auto-update';

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

// Which backend got baked in at build time. If this logs "memory" on a
// deployed page, the build was missing VITE_BACKEND=sharepoint — rebuild
// with .env.local set (see docs/known-issues.md).
console.info(
  `[pmd] backend = ${import.meta.env.VITE_BACKEND ?? 'memory'} · site = ${
    import.meta.env.VITE_SITE_URL ?? '(none)'
  }`,
);

// Expose the DAL on window so the smoke-test / diagnoseFields() snippets in
// docs/ work from the browser console — including on the deployed SPFx page,
// which is exactly where field-name mismatches need diagnosing. Internal LOB
// app; callers already have their own SharePoint permissions.
(window as unknown as { __pmdDal: PmdDataLayer }).__pmdDal = dal;


const POLL_MS = 60_000; // §6.2 — active shift refresh
let pollTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------
// PMD_LiveStatus mirror — app-lifetime, independent of the active view.
// It used to ride the operator page's poll timer, which route() clears:
// an iPad parked on KPIs/Trace (or mid-navigation) silently stopped
// mirroring its editCache and every other device read stale data. The
// DAL's pushLiveSnapshot no-ops on read-only devices, skips non-authored
// tuples, and carries its own stuck-guard watchdog, so an unconditional
// tick here is safe and cheap.
const MIRROR_MS = 60_000;
setInterval(() => {
  if (dal.pushLiveSnapshot) void dal.pushLiveSnapshot().catch(() => {});
}, MIRROR_MS);
// Immediate catch-up push when the iPad wakes / the tab regains focus —
// Safari throttles or suspends interval timers in the background, so the
// first tick after a wake could otherwise be a minute away.
let lastWakePushMs = 0;
function pushMirrorOnWake(): void {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastWakePushMs < 10_000) return;
  lastWakePushMs = Date.now();
  if (dal.pushLiveSnapshot) void dal.pushLiveSnapshot().catch(() => {});
}
document.addEventListener('visibilitychange', pushMirrorOnWake);
window.addEventListener('focus', pushMirrorOnWake);
window.addEventListener('pageshow', pushMirrorOnWake);

interface Route {
  view: 'operator' | 'trace' | 'kpi';
  machineCode?: string;
}

function parseRoute(): Route {
  const h = window.location.hash || '#/';
  if (h.startsWith('#/trace')) return { view: 'trace' };
  if (h.startsWith('#/kpi')) return { view: 'kpi' };
  const m = /^#\/op\/(.+)$/.exec(h);
  if (m) return { view: 'operator', machineCode: decodeURIComponent(m[1]) };
  return { view: 'operator' };
}

function setStatus(text: string): void {
  const el = document.getElementById('ss');
  if (el) el.textContent = text;
}

// The top-nav links are baked into the SPFx shell's static HTML (in the
// .sppkg), so a shell packaged before a view was added (e.g. KPIs) won't
// show its link. Re-render the nav from the app on boot so new views are
// reachable after `npm run deploy` alone — no .sppkg rebuild / IT needed.
function ensureNav(): void {
  const nav = document.querySelector('.top-nav');
  if (!nav) return;
  const sv = isSupervisor();
  nav.innerHTML =
    // Each nav link gets a leading glyph so the row reads as a
    // consistent icon column on the SPFx top bar. Operator was a bare
    // word — visually shorter and lower, which made the icons of the
    // other links land below its baseline. ✏️ matches the "filling in
    // the sheet" mental model the operator already has.
    '<a href="#/" data-nav>\u{270F}\u{FE0F} Operator</a>' +
    '<a href="#/trace" data-nav>\u{1F50D} Trace</a>' +
    '<a href="#/kpi" data-nav>\u{1F4CA} KPIs</a>' +
    '<button type="button" class="tut-launch" data-tut="operator" title="Walk me through filling a shift from start to Sign Off">\u{1F4D8} Tutorial</button>' +
    `<button type="button" class="tut-launch sv-toggle${sv ? ' on' : ''}" data-supervisor title="${
      sv ? 'Supervisor mode is on — tap to sign out' : 'Sign in as supervisor to unlock signed-off shifts'
    }">${sv ? '🔒 Supervisor (on)' : '🔓 Supervisor'}</button>`;
  nav.querySelectorAll<HTMLButtonElement>('[data-tut]').forEach((b) =>
    b.addEventListener('click', (e) => {
      // Log so an operator can confirm the click is reaching JS even on
      // an iPad without DevTools (Safari macOS → Develop → iPad shows it).
      console.info('[pmd] Tutorial click', b.dataset.tut);
      e.preventDefault();
      startTutorial(b.dataset.tut as 'operator' | 'supervisor');
    }),
  );
  nav
    .querySelector<HTMLButtonElement>('[data-supervisor]')
    ?.addEventListener('click', onSupervisorClick);
}

function onSupervisorClick(): void {
  if (isSupervisor()) {
    // Already signed in — confirm sign-out (cheap one-liner, no full modal).
    if (window.confirm('Sign out of Supervisor mode?')) {
      clearSupervisor();
      toast('Signed out of Supervisor mode', 'ok');
    }
    return;
  }
  promptSupervisorPassword((pwd) => {
    if (tryEnterSupervisor(pwd)) {
      toast('Supervisor mode on. Walking you through unlock…', 'ok');
      // The supervisor walkthrough is the natural follow-on action after
      // sign-in, so launch it inline. They can dismiss with Skip.
      startTutorial('supervisor');
    } else {
      toast('Wrong password', 'err');
    }
  });
}

function promptSupervisorPassword(cb: (password: string) => void): void {
  openModal(`<div class="bd-modal sv-login">
    <h3 class="bd-title">🔒 Supervisor sign-in</h3>
    <p class="bd-sub">Enter the supervisor password to enable Unlock and other supervisor actions for this session. You will be signed out automatically after the next Sign Off &amp; Save.</p>
    <input type="password" data-pwd class="sv-pwd-input" placeholder="Password" autofocus autocomplete="off">
    <div class="bd-actions">
      <button type="button" class="btn-ghost-big" data-mod="cancel">Cancel</button>
      <button type="button" class="btn-primary-big" data-mod="ok">Sign in</button>
    </div>
  </div>`);
  const inp = document.querySelector<HTMLInputElement>('[data-pwd]')!;
  const submit = (): void => {
    const value = inp.value;
    closeModal();
    cb(value);
  };
  document
    .querySelector<HTMLButtonElement>('[data-mod="cancel"]')!
    .addEventListener('click', () => closeModal());
  document
    .querySelector<HTMLButtonElement>('[data-mod="ok"]')!
    .addEventListener('click', submit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// Re-render the nav (and any operator-view chrome that depends on the
// mode flag) whenever supervisor mode toggles, so the button label and
// the lock-banner Unlock visibility stay in sync.
onSupervisorChange(() => {
  ensureNav();
  // The lock banner inside the operator view caches its render decision
  // on the supervisor state too. Re-route to re-render the active view.
  void route();
});

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
    } else if (r.view === 'kpi') {
      await renderKpi(dal);
    } else {
      let mc = r.machineCode ?? '';
      if (!mc) {
        // Operator nav link is bare `#/`. Prefer the machine the user
        // was on last (from sessionStorage) so a KPI→Operator round-trip
        // doesn't drop them on machines[0]. Falls back to the first
        // machine when there's no saved state (fresh tab).
        const saved = loadSavedOperatorView();
        const machines = await dal.listMachines();
        const savedStillValid =
          saved?.mc && machines.some((m) => m.machineCode === saved.mc);
        mc = savedStillValid ? saved!.mc : machines[0]?.machineCode ?? '';
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

// Excel→Planning sync runs server-side via Power Automate now —
// PMD_Schedule_master is too heavy for in-browser Graph reads
// (10MB+, VLOOKUPs, macros → 504 every time). The flow keeps
// PMD_Planning fresh on a schedule; the app just reads it.
// See docs/DEPLOYMENT.md § C.

window.addEventListener('hashchange', () => void route());
document.getElementById('refreshBtn')?.addEventListener('click', () => void route());

ensureNav();
void route().then(() => maybeAutoStartTutorial());

// Poll for new deploys and self-update the iPad clients without a manual
// cache clear (which was wiping the SharePoint auth session).
startAutoUpdate();
