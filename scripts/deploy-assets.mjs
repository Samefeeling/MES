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

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

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

// m365 CLI requires Node 20+. Bail with a clear message instead of
// letting the yargs-parser stack trace appear on every file.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(
    `[deploy] Node ${process.versions.node} is too old — m365 CLI needs Node 20+.\n` +
    `         Run: nvm install 20.18.1 && nvm use 20.18.1\n` +
    `         Then: npm i -g @pnp/cli-microsoft365 && m365 login\n` +
    `         (Global packages must be reinstalled under the new Node version.)`,
  );
  process.exit(1);
}

const env = { ...readEnvLocal(), ...process.env };
const site =
  env.VITE_SITE_URL ||
  'https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU';

// path-in-dist  ->  SiteAssets folder
// Order matters for the self-update flow: push the new JS/CSS and the
// index.html that references them FIRST, then version.json LAST. The running
// iPad clients only learn a new build exists when version.json changes, so it
// must not advertise the new build until the code it points at is already live.
function builtFiles(dir = 'dist') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = dir + '/' + entry.name;
    return entry.isDirectory() ? builtFiles(path) : [path];
  });
}
if (!existsSync('dist/assembly/assets/assembly.js')) throw new Error('Build Assembly before deploying MES.');
const files = builtFiles().filter(path => !path.endsWith('.map'));
const version = 'dist/assets/version.json';
const FILES = [...files.filter(path => path !== version), version]
  .map(path => [path, 'SiteAssets/pmd' + dirname(path).slice(4)]);


function m365(args, capture = false) {
  const options = { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' };
  // m365 on Windows is a .cmd shim. Node 18+ refuses to spawnSync a .cmd
  // directly without shell:true (CVE-2024-27980 hardening), which surfaces
  // as `spawnSync m365.cmd EINVAL`. Go through cmd.exe on Windows and quote
  // any args containing spaces or quotes.
  if (process.platform === 'win32') {
    const quoted = args
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(' ');
    return execSync(`m365.cmd ${quoted}`, options);
  }
  return execFileSync('m365', args, { stdio: 'inherit' });
}

console.log(`[deploy] site = ${site}`);
for (const folder of [...new Set(FILES.map(([, folder]) => folder))].sort((a,b) => a.length-b.length)) {
  const split = folder.lastIndexOf('/');
  const parent = folder.slice(0,split), name = folder.slice(split+1);
  const existing = JSON.parse(m365(['spo', 'folder', 'list', '--webUrl', site, '--parentFolderUrl', parent, '--output', 'json'], true));
  if (!existing.some(item => item.Name === name)) m365(['spo', 'folder', 'add', '--webUrl', site, '--parentFolderUrl', parent, '--name', name]);
}
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
