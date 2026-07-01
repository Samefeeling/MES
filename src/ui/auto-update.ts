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
//   3. When they differ, a new build is live. It force-reloads via a
//      cache-busted document URL, which re-fetches index.html (now pointing at
//      the new ?v= asset URLs) → the new JS/CSS load. localStorage is never
//      touched, so the auth session (and the operator's editCache) survive.

// Baked in at build time; 'dev' under vitest / a non-defined build.
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

// How often to check for a new deploy. 3 min is frequent enough that a fresh
// build reaches the floor within a few minutes, cheap enough to be invisible.
const CHECK_MS = 3 * 60_000;

/**
 * Add/replace a `_v` cache-buster on the document URL while preserving the
 * hash route. Reloading to this URL forces the browser to re-fetch index.html
 * (a URL it hasn't cached), which carries the new ?v= asset references. Pure
 * so it can be unit-tested without a document.
 */
export function bustedReloadUrl(
  loc: { pathname: string; search: string; hash: string },
  build: string,
): string {
  const params = new URLSearchParams(loc.search);
  params.set('_v', build);
  return `${loc.pathname}?${params.toString()}${loc.hash}`;
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

/** An operator is mid-entry — don't yank the page out from under them. */
function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/** Apply a detected update, but only at a moment that won't interrupt data
 *  entry. editCache is persisted to localStorage so a reload never loses work;
 *  this guard just avoids reloading while a finger is on a field. */
function maybeReload(): void {
  if (!pendingBuild) return;
  if (!document.hidden && isTyping()) return;
  // replace() so the busted URL doesn't stack in history.
  window.location.replace(bustedReloadUrl(window.location, pendingBuild));
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
}
