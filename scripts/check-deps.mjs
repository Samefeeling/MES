// MES is two npm packages in one repository: the PMD dashboard at the root
// and the Assembly board under assembly/. They have separate package.json
// files, separate lockfiles and separate node_modules, so ONE `npm install`
// does not set the repository up — and pulling a commit that adds a
// dependency to either half leaves a tree that looks installed and is not.
//
// What that failure looks like is the problem this script exists for. A
// missing @types/node surfaces as
//   vite.config.ts:2 - error TS2307: Cannot find module 'node:url'
// and missing Assembly dependencies surface as a wall of
//   react (imported by .../WorkerLoadChip.tsx) ... Are they installed?
// Neither says "run npm install", and both read like broken code rather
// than a stale checkout. So check first and print the command.
//
// Deliberately NOT a postinstall that installs the other half: that couples
// every `npm install` (and CI, and the web session hook) to the Assembly
// registry being reachable, and one 403 from cdn.sheetjs.com would then
// break installing the dashboard at all.
//
// `--strict` exits 1 — for `npm run build`, which cannot succeed without
// both halves. Without it this only warns, so someone working on PMD alone
// can still `npm run dev` with Assembly uninstalled.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

/** Declared dependencies of one package that have no folder in node_modules.
 *  Names only — the check is "was this ever installed", not a version audit;
 *  npm itself owns that and says so far more precisely. */
function missingFrom(pkgDir, fallbackDir) {
  const manifest = join(root, pkgDir, 'package.json');
  if (!existsSync(manifest)) return [];
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return names.filter((name) => {
    // A nested package may be hoisted to the root tree, so both count.
    const here = join(root, pkgDir, 'node_modules', name);
    const up = fallbackDir == null ? null : join(root, fallbackDir, 'node_modules', name);
    return !existsSync(here) && !(up && existsSync(up));
  });
}

const stale = [
  { label: 'PMD dashboard', missing: missingFrom('.', null), fix: 'npm install' },
  { label: 'Assembly board', missing: missingFrom('assembly', '.'), fix: 'npm run setup:assembly' },
].filter((p) => p.missing.length > 0);

if (stale.length > 0) {
  const lines = stale.map(
    (p) => `  • ${p.label}: ${p.missing.slice(0, 6).join(', ')}${
      p.missing.length > 6 ? `, +${p.missing.length - 6} more` : ''
    }\n      fix: ${p.fix}`,
  );
  console.error(
    `\nDependencies are not installed for ${stale.length === 1 ? 'one half' : 'both halves'} of this repository:\n\n${lines.join(
      '\n',
    )}\n`,
  );
  if (strict) process.exit(1);
  console.error('Continuing anyway — the parts that need them will fail.\n');
}
