// Self-update for the iPad clients.
//
// The app ships with fixed asset filenames (assets/index.js/.css) so the
// browser caches them under a stable URL forever. Manually forcing an update
// meant clearing browser data on the iPad — which also wiped the SharePoint
// auth session and forced a re-login. This module removes that chore:
//
//   1. The build bakes a unique __BUILD_ID__ into the bundle and writes the
//      same id to assets/version.json (see vite.config.ts).
//   2. The running app polls version.json (cache-busted, so it always sees the
//      freshly-deployed file) and compares it to its own baked id.
//   3. When they differ, a new build is live. It refreshes the browser's cache
//      entry for its own fixed asset URLs (fetch cache:'reload'), then reloads.
//      This works in the SPFx Web-part host too, where the shell loads
//      assets/index.js at a fixed URL baked in the .sppkg: refreshing that
//      exact cache entry means the reload's request for it gets the NEW code
//      without any .sppkg change. localStorage is never touched, so the auth
//      session (and the operator's editCache) survive.

// Baked in at build time; 'dev' under vitest / a non-defined build.
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** The build id baked into THIS running bundle. Shown in the mirror-health
 *  badge so the floor can tell at a glance whether an iPad is on the
 *  current deploy or stuck on a cached bundle. */
export function currentBuildId(): string {
  return BUILD_ID;
}

// How often to check for a new deploy. 3 min is frequent enough that a fresh
// build reaches the floor within a few minutes, cheap enough to be invisible.
const CHECK_MS = 3 * 60_000;

/** The index.css URL that sits next to a given index.js URL, preserving any
 *  query / fragment. Pure so it can be unit-tested. */
export function siblingCssUrl(jsUrl: string): string {
  return jsUrl.replace(/index\.js(\?|#|$)/, 'index.css$1');
}

/** URL of the deployed version.json, resolved next to this script (assets/).
 *  Built by string concat rather than `new URL(literal, import.meta.url)` so
 *  Vite doesn't inline it as a bundled asset — we need a live network read. */
function versionUrl(cacheBust: number): string {
  let dir = '';
  try {
    dir = import.meta.url.replace(/[^/]*$/, ''); // strip 'index.js' → assets/
  } catch {
    /* import.meta.url unavailable — fall back to a document-relative path */
  }
  return `${dir}version.json?cb=${cacheBust}`;
}

let pendingBuild: string | null = null;
let started = false;
let applying = false;

// We may auto-reload at most ONCE per target build per tab session. If the
// reload comes back still running the OLD bundle — SharePoint / the CDN is
// still serving the stale asset for its fixed URL — reloading again would
// just loop forever ("page keeps refreshing"). Remembering which build we
// last reloaded toward, in sessionStorage (survives the reload, clears when
// the tab closes), breaks that loop: we try once, and if it didn't take we
// stop and let the version badge prompt a manual refresh.
const RELOAD_KEY = 'pmd.autoUpdate.reloadedFor';

/** Whether an auto-reload should fire for `pending`, given the build we last
 *  reloaded toward this session. False once we've already reloaded for this
 *  exact build (the loop-breaker). Pure so it can be unit-tested. */
export function shouldAutoReload(
  pending: string | null,
  alreadyReloadedFor: string,
): boolean {
  return !!pending && pending !== alreadyReloadedFor;
}

function reloadedFor(): string {
  try {
    return sessionStorage.getItem(RELOAD_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberReload(build: string): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, build);
  } catch {
    /* private mode / storage disabled — the `applying` flag still guards
       against a same-load double reload; we just can't survive the reload */
  }
}

/** An operator is mid-entry — don't yank the page out from under them. */
function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/**
 * Refresh the browser's HTTP-cache entry for THIS bundle's own asset URLs.
 *
 * In the SPFx Web-part host the shell loads assets/index.js at a fixed URL
 * baked into the .sppkg — a plain reload just re-requests that cached URL and
 * gets the OLD code (why a manual cache-clear was needed). `fetch(url,
 * {cache:'reload'})` bypasses the cache for the request AND rewrites the cache
 * entry with the fresh response, so the subsequent reload's request for the
 * same fixed URL is served the NEW code. We refresh the exact URL this module
 * was loaded from (import.meta.url = the loader's cache key) plus its sibling
 * CSS, so it matches whatever URL — query or not — the shell used.
 */
async function refreshAssetCaches(): Promise<void> {
  let js = '';
  try {
    js = import.meta.url;
  } catch {
    return; // no module URL (classic script host) — nothing we can refresh
  }
  if (!js || !/^https?:/i.test(js)) return;
  await Promise.allSettled([
    fetch(js, { cache: 'reload' }),
    fetch(siblingCssUrl(js), { cache: 'reload' }),
  ]);
}

/** Apply a detected update, but only at a moment that won't interrupt data
 *  entry. editCache is persisted to localStorage so a reload never loses work;
 *  this guard just avoids reloading while a finger is on a field. */
function maybeReload(): void {
  if (applying) return;
  if (!document.hidden && isTyping()) return;
  // Already reloaded once toward this exact build and we're STILL on the old
  // one → the new asset hasn't propagated. Don't loop; wait for a manual
  // refresh (or the next, different build).
  if (!shouldAutoReload(pendingBuild, reloadedFor())) return;
  applying = true;
  rememberReload(pendingBuild!);
  // Refresh the fixed-URL asset cache entries FIRST (see refreshAssetCaches),
  // then reload — the reload's request for the same fixed URL is now served
  // the fresh code. Works for both the SPFx Web-part host (fixed URL in the
  // shell) and a plain index.html host (fixed URL in the markup).
  void refreshAssetCaches().finally(() => window.location.reload());
}

async function check(): Promise<void> {
  try {
    const res = await fetch(versionUrl(Date.now()), { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { build?: string };
    if (data.build && data.build !== BUILD_ID) {
      pendingBuild = data.build;
      maybeReload();
    }
  } catch {
    /* offline, or version.json not deployed yet — retry next tick */
  }
}

// ---- the hourly refresh ------------------------------------------------
//
// Every screen reloads itself once an hour, so a page left open all day (a
// wall screen, a supervisor's KPI tab) shows this hour's data and the
// current build without anybody pressing refresh. It waits for a quiet
// moment: not while a field has focus, a dialog is open, or someone touched
// the screen in the last two minutes — it asks again every minute until then.

/** Minutes between refreshes: `VITE_AUTO_REFRESH_MINUTES` (0 turns it off), else 60. */
export function refreshMinutes(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 60;
}

/** How long the screen must have been left alone before it may reload. */
export const QUIET_MS = 2 * 60_000;

/**
 * May the hourly refresh reload now? Pure so it can be unit-tested: due when
 * `every` ms have passed since the page loaded, and only at a quiet moment.
 */
export function refreshDue(
  now: number,
  loadedAt: number,
  lastActivity: number,
  every: number,
  busy: boolean,
  hidden: boolean,
): boolean {
  if (every <= 0 || now - loadedAt < every || busy) return false;
  return hidden || now - lastActivity >= QUIET_MS;
}

/** A field with focus or an open dialog, here or in a same-origin frame (the Assembly board). */
function busyScreen(doc: Document = document, depth = 0): boolean {
  const el = doc.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)) return true;
  if (doc.querySelector('dialog[open], [role="dialog"], [aria-modal="true"], .modal-backdrop, .modal-overlay')) return true;
  if (depth > 2) return false;
  for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
    try {
      const inner = frame.contentDocument;
      if (inner && busyScreen(inner, depth + 1)) return true;
    } catch {
      /* another origin: nothing to see */
    }
  }
  return false;
}

let lastActivity = Date.now();
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const watched = new WeakSet<Document>();

/** Count touches in the page and in any same-origin frame. */
function watchActivity(doc: Document = document): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  const mark = (): void => {
    lastActivity = Date.now();
  };
  for (const type of ACTIVITY) doc.addEventListener(type, mark, { capture: true, passive: true });
}

function startHourlyRefresh(): void {
  const every = refreshMinutes(import.meta.env?.VITE_AUTO_REFRESH_MINUTES as string | undefined) * 60_000;
  if (every <= 0) return;
  const loadedAt = Date.now();
  watchActivity();
  setInterval(() => {
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (frame.contentDocument) watchActivity(frame.contentDocument);
      } catch {
        /* another origin */
      }
    }
    if (applying || !refreshDue(Date.now(), loadedAt, lastActivity, every, busyScreen(), document.hidden)) return;
    applying = true;
    void refreshAssetCaches().finally(() => window.location.reload());
  }, 60_000);
}

/**
 * Start polling for new deploys. Safe to call once at boot. Checks on a timer,
 * whenever the tab regains focus/visibility (iPad woken / app foregrounded),
 * and applies a pending update when a field is blurred or the tab is hidden.
 */
export function startAutoUpdate(): void {
  if (started) return;
  started = true;
  setInterval(() => void check(), CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
    else maybeReload(); // tab hidden → safe moment to apply
  });
  window.addEventListener('focus', () => void check());
  window.addEventListener('focusout', () => maybeReload());
  void check();
  startHourlyRefresh();
}
