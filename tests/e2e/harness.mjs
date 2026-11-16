// End-to-end harness: the built page in a real browser, on the demo
// (in-memory) backend, with the clock held still so every run sees the same
// shift and the same seeded data.
//
// Not part of `npm test` (Vitest, no browser). Run with `npm run test:e2e`.
// Needs the `playwright` package and a Chromium it can launch:
//   npm install --no-save playwright && npx playwright install chromium
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The supervisor password the E2E build is given. */
export const SUPERVISOR_PASSWORD = 'e2e-supervisor';

/** Monday 16 Nov 2026, 10:05 — five minutes into the Day shift's 7th half-hour. */
export const NOW = new Date(2026, 10, 16, 10, 5, 0);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error(
      'The end-to-end tests need Playwright, which this project does not install by default.\n' +
        '  npm install --no-save playwright\n  npx playwright install chromium',
    );
    process.exit(2);
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Start the dev server on the demo backend; resolves once it answers. */
export async function startApp() {
  const port = await freePort();
  const vite = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      env: { ...process.env, VITE_BACKEND: 'memory', VITE_SUPERVISOR_PASSWORD: SUPERVISOR_PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  vite.stdout.on('data', (d) => (log += d));
  vite.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    if (vite.exitCode !== null || Date.now() > deadline) {
      vite.kill();
      throw new Error(`The dev server did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { url, stop: () => vite.kill() };
}

/** The floor's data-entry device. Anything else is a read-only viewer until a
 *  supervisor signs in (`core/device`). */
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/**
 * A page on the app with the clock fixed at `NOW`. Page errors are collected.
 * `device: 'ipad'` is the operator's tablet; `'viewer'` an office PC.
 */
export async function openPage(appUrl, hash = '#/', device = 'ipad') {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    ...(device === 'ipad' ? { userAgent: IPAD_UA } : {}),
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(appUrl + hash);
  return { browser, page, errors };
}

/** Collects named checks; a failure is recorded and the run goes on, so one
 *  broken step does not hide the ones after it. */
export function checker() {
  const failures = [];
  let count = 0;
  return {
    ok(condition, what) {
      count++;
      if (!condition) failures.push(what);
    },
    equal(actual, expected, what) {
      count++;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${what}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
      }
    },
    get count() {
      return count;
    },
    failures,
  };
}
