// One-command upload of the built app to SharePoint SiteAssets/pmd/.
//
// Usage:
//   1. npm i -g @pnp/cli-microsoft365        (once)
//   2. m365 login                            (once per machine, device code)
//   3. npm run deploy                         (build + upload, every release)
//
// No IT, no App Catalog, no .sppkg — this only touches the app's JS/CSS in
// SiteAssets, which the SPFx web part loads by URL. Site URL is read from
// VITE_SITE_URL (env or .env.local), falling back to the Resero AU site.
//
// Requires: a successful `npm run build` first (the `deploy` npm script
// chains it) and the m365 CLI on PATH and logged in.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readEnvLocal() {
  const out = {};
  const p = resolve(process.cwd(), '.env.local');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const site =
  env.VITE_SITE_URL ||
  'https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU';

// path-in-dist  ->  SiteAssets folder
const FILES = [
  ['dist/index.html', 'SiteAssets/pmd'],
  ['dist/resero-logo.svg', 'SiteAssets/pmd'],
  ['dist/assets/index.js', 'SiteAssets/pmd/assets'],
  ['dist/assets/index.css', 'SiteAssets/pmd/assets'],
];

function m365(args) {
  // Use cmd-friendly invocation on Windows (m365 is a .cmd shim).
  const bin = process.platform === 'win32' ? 'm365.cmd' : 'm365';
  return execFileSync(bin, args, { stdio: 'inherit' });
}

console.log(`[deploy] site = ${site}`);
for (const [path, folder] of FILES) {
  if (!existsSync(path)) {
    console.error(`[deploy] missing ${path} — run "npm run build" first.`);
    process.exit(1);
  }
  console.log(`[deploy] ${path} -> ${folder}`);
  m365([
    'spo',
    'file',
    'add',
    '--webUrl',
    site,
    '--folder',
    folder,
    '--path',
    path,
    '--overwrite',
  ]);
}
console.log('[deploy] done. Hard-refresh the page (Ctrl+F5) if the cache is sticky.');
