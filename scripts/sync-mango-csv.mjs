// Mango -> CSV sync, same shape as the Epicor one (sync-epicor-to-sp.ps1):
// runs on the always-on Windows PC via Task Scheduler, downloads Mango's
// plant-equipment work-order report as CSV, and writes it into a folder
// OneDrive is syncing with the PMD SharePoint site. No SharePoint
// credentials in this script — OneDrive does the upload; the MES app reads
// the file via VITE_MANGO_CSV_PATH (see docs/DEPLOYMENT.md).
//
// Mango has no API for the Plant/Equipment module (checked 2026-07), so
// this drives the real web UI with Playwright. That makes it sensitive to
// Mango page changes: when the report page moves or the export button is
// renamed, update ReportUrl / ExportSelector in the config — the code
// shouldn't need touching.
//
// Browser: drives the machine's own Microsoft Edge by default
// (BrowserChannel "msedge") — corporate PCs have Edge and IT policy often
// blocks unsigned downloaded browsers, so nothing extra to install or
// whitelist. Set BrowserChannel to "chrome" for installed Chrome, or ""
// to use Playwright's bundled Chromium (then also run
// `npx playwright install chromium`).
//
// One-time setup on the PC:
//   npm i playwright
//   copy scripts/sync-mango-csv.config.example.json C:\PMDSync\mango-sync.config.json  (fill it in)
//   node sync-mango-csv.mjs --login    <- log into Mango by hand ONCE (handles MFA);
//                                         the session is stored in StorageStatePath
//                                         and reused by every scheduled run.
//   node sync-mango-csv.mjs --probe    <- optional: screenshots the report page and
//                                         lists clickable controls, to help pick
//                                         ExportSelector if the auto-guess misses.
// Scheduled run (every 15-30 min):
//   node C:\PMDSync\sync-mango-csv.mjs
//
// Exit codes: 0 ok · 1 config/infra error · 2 session expired (re-run --login).

import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const log = (msg) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
const fail = (code, msg) => {
  console.error(`[sync-mango] ${msg}`);
  process.exit(code);
};

// ---- 1. config ---------------------------------------------------------
const cfgPath = process.env.PMD_MANGO_CONFIG ?? 'C:\\PMDSync\\mango-sync.config.json';
if (!existsSync(cfgPath)) {
  fail(1, `Missing config file at ${cfgPath}. Copy scripts/sync-mango-csv.config.example.json there and fill in values.`);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
for (const key of ['ReportUrl', 'OutputCsvPath', 'StorageStatePath']) {
  if (!cfg[key]) fail(1, `Config ${cfgPath} missing required key: ${key}`);
}
const headless = cfg.Headless !== false;
const timeout = Number(cfg.TimeoutMs) || 60_000;
const mode = process.argv.includes('--login') ? 'login' : process.argv.includes('--probe') ? 'probe' : 'sync';

// ---- 2. browser --------------------------------------------------------
// "msedge" (default) / "chrome" run the browser already installed on the
// PC; "" falls back to Playwright's bundled Chromium.
const channel = cfg.BrowserChannel === undefined ? 'msedge' : cfg.BrowserChannel;
const launchOpts = { headless: mode === 'sync' ? headless : false };
let browser;
try {
  browser = await chromium.launch(channel ? { ...launchOpts, channel } : launchOpts);
  log(`Browser: ${channel || "Playwright's bundled Chromium"}`);
} catch (e) {
  if (!channel) throw e;
  log(`Could not launch channel "${channel}" (${e.message.split('\n')[0]}) — falling back to bundled Chromium.`);
  browser = await chromium.launch(launchOpts);
}
const haveState = existsSync(cfg.StorageStatePath);
if (mode === 'sync' && !haveState) {
  await browser.close();
  fail(2, `No saved Mango session at ${cfg.StorageStatePath}. Run:  node sync-mango-csv.mjs --login`);
}
const context = await browser.newContext({
  ...(haveState ? { storageState: cfg.StorageStatePath } : {}),
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(timeout);

// ---- login mode: human signs in once, we keep the cookies ---------------
if (mode === 'login') {
  log(`Opening ${cfg.ReportUrl} — log into Mango in the browser window (MFA and all).`);
  await page.goto(cfg.ReportUrl).catch(() => {});
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((res) => rl.question('When the report page is fully visible, press Enter here to save the session… ', res));
  rl.close();
  mkdirSync(dirname(resolve(cfg.StorageStatePath)), { recursive: true });
  await context.storageState({ path: cfg.StorageStatePath });
  log(`Session saved to ${cfg.StorageStatePath}. Scheduled runs will reuse it.`);
  await browser.close();
  process.exit(0);
}

// ---- 3. open the report ------------------------------------------------
log(`GET ${cfg.ReportUrl}`);
await page.goto(cfg.ReportUrl, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

// Landed on a login screen instead of the report? Session expired.
const loginish = await page
  .locator('input[type="password"], form[action*="login" i], [id*="login" i][type="submit"]')
  .first()
  .isVisible()
  .catch(() => false);
if (loginish) {
  await browser.close();
  fail(2, 'Mango session has expired (login page shown). Re-run:  node sync-mango-csv.mjs --login');
}

// ---- probe mode: help pick the export control ---------------------------
if (mode === 'probe') {
  const shot = resolve(dirname(cfgPath), 'mango-probe.png');
  await page.screenshot({ path: shot, fullPage: true });
  const controls = await page
    .locator('a, button, [role="button"], [role="menuitem"]')
    .evaluateAll((els) =>
      els
        .map((e) => (e.textContent || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim())
        .filter((t) => t && t.length < 60),
    );
  log(`Screenshot: ${shot}`);
  log(`Clickable controls on the page:\n  - ${[...new Set(controls)].join('\n  - ')}`);
  log('Put the export control into the config as ExportSelector, e.g. "text=Export to CSV".');
  await browser.close();
  process.exit(0);
}

// ---- 4. trigger the CSV download ----------------------------------------
// ExportSelector from the config wins; otherwise try the usual suspects.
const candidates = cfg.ExportSelector
  ? [cfg.ExportSelector]
  : [
      'text=/export.*csv/i',
      'text=/download.*csv/i',
      '[aria-label*="export" i]',
      'text=/^export$/i',
      'text=/^download$/i',
      'text=/csv/i',
    ];
let download = null;
for (const sel of candidates) {
  const el = page.locator(sel).first();
  if (!(await el.isVisible().catch(() => false))) continue;
  log(`Clicking ${sel}`);
  try {
    [download] = await Promise.all([page.waitForEvent('download', { timeout }), el.click()]);
    break;
  } catch {
    log(`  …no download started from ${sel}, trying next`);
  }
}
if (!download) {
  const shot = resolve(dirname(cfgPath), 'mango-sync-fail.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  await browser.close();
  fail(1, `Could not find/trigger the CSV export on ${cfg.ReportUrl}. Screenshot: ${shot}. Run --probe and set ExportSelector in ${cfgPath}.`);
}

// ---- 5. land the file atomically where OneDrive picks it up --------------
const outPath = resolve(cfg.OutputCsvPath);
mkdirSync(dirname(outPath), { recursive: true });
const tmpPath = `${outPath}.downloading`;
await download.saveAs(tmpPath);
const size = statSync(tmpPath).size;
if (size < 10) {
  await browser.close();
  fail(1, `Downloaded file is ${size} bytes — Mango likely returned an empty/error report. Kept at ${tmpPath} for inspection.`);
}
try {
  renameSync(tmpPath, outPath); // atomic on the same volume
} catch {
  copyFileSync(tmpPath, outPath); // fall back across volumes
}
log(`Saved ${size.toLocaleString()} bytes to ${outPath} (OneDrive syncs it to SharePoint).`);

// Refresh the stored session so it keeps rolling forward.
await context.storageState({ path: cfg.StorageStatePath }).catch(() => {});
await browser.close();
log('Done.');
