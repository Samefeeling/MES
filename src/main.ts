import { createDataLayer, resolveMangoCsvPath, type PmdDataLayer } from './dal';
import {
  renderOperator,
  operatorPollTick,
  loadSavedOperatorView,
  loadDeviceMachine,
} from './ui/operator';
import { unmountTracePanel } from './ui/trace';
import { createAssemblyDataLayer } from './dal/assembly';
import { showAssembly } from './ui/assembly';
import { renderKpi, unmountKpi } from './ui/kpi';
import { mountDieTab } from './ui/die';
import { closeModal, openModal } from './ui/modal';
import {
  clearSupervisor,
  isSupervisor,
  isSupervisorConfigured,
  onSupervisorChange,
  tryEnterSupervisor,
} from './ui/supervisor-auth';
import { toast } from './ui/toast';
import { currentBuildId, startAutoUpdate } from './ui/auto-update';
import { isTupleConfirmed } from './core/confirm';

const assemblyDal = createAssemblyDataLayer(import.meta.env as Record<string, string>);

const dal: PmdDataLayer = createDataLayer(import.meta.env as Record<string, string>);

// Live-mirror gate: only tuples the worker CONFIRMED on this device
// ("this order runs on this press, by these people" — the ✅ button on
// the operator sheet) are broadcast to PMD_LiveStatus. Wired here, at
// DAL creation, so the gate also covers app start on a non-operator
// page with a stale edit cache.
dal.setLiveGate?.(isTupleConfirmed);

// Which backend got baked in at build time. If this logs "memory" on a
// deployed page, the build was missing VITE_BACKEND=sharepoint — rebuild
// with .env.local set (see docs/known-issues.md).
console.info(
  `[pmd] backend = ${import.meta.env.VITE_BACKEND ?? 'memory'} · site = ${
    import.meta.env.VITE_SITE_URL ?? '(none)'
  } · mango WO CSV = ${
    resolveMangoCsvPath(import.meta.env as Record<string, string>) || '(none)'
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
function mirrorTick(): void {
  if (!dal.pushLiveSnapshot) return;
  void dal.pushLiveSnapshot()
    .catch(() => {})
    .finally(updateMirrorBadge);
}
setInterval(mirrorTick, MIRROR_MS);
// Immediate catch-up push when the iPad wakes / the tab regains focus —
// Safari throttles or suspends interval timers in the background, so the
// first tick after a wake could otherwise be a minute away.
let lastWakePushMs = 0;
function pushMirrorOnWake(): void {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastWakePushMs < 10_000) return;
  lastWakePushMs = Date.now();
  mirrorTick();
}
document.addEventListener('visibilitychange', pushMirrorOnWake);
window.addEventListener('focus', pushMirrorOnWake);
window.addEventListener('pageshow', pushMirrorOnWake);

/**
 * Mirror-health badge: build id + this device's last successful
 * live-mirror push (or its failure). "One iPad never gets its data onto
 * SharePoint" was invisible on the device itself — an old build id, a
 * 👁 view-only tag, or a red ⚠ each name the problem directly. Lives as
 * a small FIXED pill in the bottom-right corner and only while
 * supervisor mode is on: it's an admin diagnostic, not something the
 * operators should be reading (they used to ask what "synchronising"
 * meant on the old top-bar status).
 */
function updateMirrorBadge(): void {
  let el = document.getElementById('mirrorBadge');
  if (!el) {
    el = document.createElement('span');
    el.id = 'mirrorBadge';
    document.body.appendChild(el);
  }
  el.style.display = isSupervisor() ? '' : 'none';
  if (!isSupervisor()) return;
  const build = currentBuildId().slice(-5);
  const h = dal.mirrorHealth ? dal.mirrorHealth() : null;
  const hhmm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!h) {
    el.textContent = `${build}`;
    el.className = 'mb-idle';
    el.title = `Build ${currentBuildId()}`;
    return;
  }
  if (!h.writable) {
    el.textContent = `${build} 👁`;
    el.className = 'mb-idle';
    el.title = `Build ${currentBuildId()} · view-only device (no supervisor signed in) — never mirrors`;
  } else if (h.failAt != null && (h.okAt == null || h.failAt > h.okAt)) {
    el.textContent = `${build} ⚠ ${hhmm(h.failAt)}`;
    el.className = 'mb-bad';
    el.title = `Build ${currentBuildId()} · live-mirror push FAILED at ${hhmm(h.failAt)}: ${h.error}`;
  } else if (h.okAt != null) {
    el.textContent = `${build} ⇅ ${hhmm(h.okAt)}`;
    el.className = 'mb-ok';
    el.title = `Build ${currentBuildId()} · live mirror last pushed ${hhmm(h.okAt)}`;
  } else {
    el.textContent = `${build} ⇅ —`;
    el.className = 'mb-idle';
    el.title = `Build ${currentBuildId()} · no mirror push yet this session`;
  }
}
updateMirrorBadge();

interface Route {
  view: 'operator' | 'tool' | 'kpi' | 'assembly';
  machineCode?: string;
  /** Die to auto-open in the Tool board's drilldown, from a
   *  `#/tool/die/<dieNumber>` deep link (the operator sheet's Die# pill). */
  openDie?: string;
}

function parseRoute(): Route {
  const h = window.location.hash || '#/';
  // Keep the old #/trace URL working for saved bookmarks, but the page is
  // now the dedicated Tool board rather than a three-view Trace shell.
  if (h.startsWith('#/tool') || h.startsWith('#/trace')) {
    // Deep link from the operator sheet: open this die's drilldown once the
    // board has loaded.
    const d = /^#\/tool\/die\/(.+)$/.exec(h);
    return { view: 'tool', openDie: d ? decodeURIComponent(d[1]) : undefined };
  }
  if (h.startsWith('#/assembly')) return { view: 'assembly' };
  if (h.startsWith('#/kpi')) return { view: 'kpi' };
  const m = /^#\/op\/(.+)$/.exec(h);
  if (m) return { view: 'operator', machineCode: decodeURIComponent(m[1]) };
  return { view: 'operator' };
}

// The top-nav links are baked into the SPFx shell's static HTML (in the
// .sppkg), so a shell packaged before a view was added (e.g. KPIs) won't
// show its link. Re-render the nav from the app on boot so new views are
// reachable after `npm run deploy` alone — no .sppkg rebuild / IT needed.
// The same boot pass also strips chrome an OLD shell may still carry
// (the retired ☁ status pill lives in already-deployed static HTML).
function ensureNav(): void {
  document.getElementById('ss')?.remove();
  // Short title — the full "PMD Operator Sheet" ate half a phone's top
  // bar. Set from JS so the already-deployed SPFx shell (which bakes the
  // long title into its static HTML) shortens without an .sppkg rebuild.
  const pt = document.getElementById('pt');
  if (pt) pt.textContent = 'MES';
  const nav = document.querySelector('.top-nav');
  if (!nav) return;
  const sv = isSupervisor();
  nav.innerHTML =
    // Each nav link gets a leading glyph so the row reads as a
    // consistent icon column on the SPFx top bar. Operator was a bare
    // word — visually shorter and lower, which made the icons of the
    // other links land below its baseline. ✏️ matches the "filling in
    // the sheet" mental model the operator already has.
    '<a href="#/" data-nav>\u{270F}\u{FE0F} PMD</a>' +
    '<a href="#/assembly" data-nav>Assembly</a>' +
    '<a href="#/tool" data-nav>\u{1F6E0}Tool</a>' +
    '<a href="#/kpi" data-nav>\u{1F4CA} KPIs</a>' +
    `<button type="button" class="nav-btn sv-toggle${sv ? ' on' : ''}" data-supervisor title="${
      sv ? 'Supervisor mode is on — tap to sign out' : 'Sign in as supervisor to unlock signed-off shifts'
    }">${sv ? '🔒 Supervisor (on)' : '🔓 Supervisor'}</button>`;
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
  if (!isSupervisorConfigured()) {
    toast(
      'Supervisor sign-in is unavailable — set VITE_SUPERVISOR_PASSWORD and rebuild',
      'err',
    );
    return;
  }
  promptSupervisorPassword((pwd) => {
    if (tryEnterSupervisor(pwd)) {
      toast('Supervisor mode on', 'ok');
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
  // The bottom-right mirror-health pill is supervisor-only diagnostics —
  // show/hide it with the mode.
  updateMirrorBadge();
  // The lock banner inside the operator view caches its render decision
  // on the supervisor state too. Re-route to re-render the active view.
  void route();
});

// True only for the very first route() of this page load. A hash present
// THEN is whatever URL the page was (re)opened with — a stale bookmark,
// the SPFx wrapper's baked link, or a pre-switch URL — not a press the
// worker just tapped, so the device's own memory may override it. Every
// later route() is user navigation and the hash is honoured as-is.
let initialNav = true;

async function route(): Promise<void> {
  const firstNav = initialNav;
  initialNav = false;
  // Stop an embedded KPI Live Status poll before replacing #app. KPI will
  // mount a fresh panel if the destination is #/kpi/live.
  unmountTracePanel();
  unmountKpi();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  try {
    const r = parseRoute();
    document.getElementById('kpi-departments')?.remove();
    showAssembly(r.view === 'assembly');
    if (r.view === 'assembly') {
      document.body.className = 'shift-day';
      return;
    }
    if (r.view === 'tool') {
      document.body.className = 'shift-day';
      const app = document.getElementById('app')!;
      app.innerHTML = '<div class="die-host"></div>';
      await mountDieTab(dal, app.querySelector<HTMLElement>('.die-host')!, r.openDie);
    } else if (r.view === 'kpi') {
      await renderKpi(dal, assemblyDal);
    } else {
      let mc = r.machineCode ?? '';
      // The press this device was last WORKING on: the per-tab state
      // (exact, survives an in-tab reload) first, then the per-device
      // localStorage memory (survives Safari killing the tab and asset
      // redeploys — the auto-updater never touches localStorage).
      const remembered = loadSavedOperatorView()?.mc || loadDeviceMachine();
      if (!mc) {
        // Operator nav link is bare `#/`. Prefer the remembered press so
        // a KPI→Operator round-trip (or a fresh tab on a floor iPad)
        // doesn't drop the worker on machines[0]. First machine only
        // when this device has no memory at all (fresh device).
        const machines = await dal.listMachines();
        const rememberedValid =
          !!remembered && machines.some((m) => m.machineCode === remembered);
        mc = rememberedValid ? remembered : machines[0]?.machineCode ?? '';
        if (mc) {
          window.location.hash = `#/op/${encodeURIComponent(mc)}`;
          return; // hashchange re-enters route()
        }
      } else if (firstNav && remembered && remembered !== mc) {
        // Page (re)opened with an explicit #/op/<press> that is NOT the
        // press this device last worked on — a stale bookmark or the URL
        // from before a dropdown switch. The device's memory wins so a
        // redeploy/reload can never flip a floor iPad onto the wrong
        // press mid-shift; tapping the Machine dropdown still switches
        // freely (that path is user navigation and updates the memory).
        const machines = await dal.listMachines();
        if (machines.some((m) => m.machineCode === remembered)) {
          window.location.hash = `#/op/${encodeURIComponent(remembered)}`;
          return; // hashchange re-enters route()
        }
      }
      await renderOperator(dal, mc);
      pollTimer = setInterval(operatorPollTick, POLL_MS);
    }
  } catch (e) {
    // No top-bar status pill any more (operators kept asking what
    // "synchronising" meant); comms health is the supervisor-only
    // bottom-right mirror badge, and route failures land here.
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
void route();

// Poll for new deploys and self-update the iPad clients without a manual
// cache clear (which was wiping the SharePoint auth session).
startAutoUpdate();
