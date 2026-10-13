/**
 * No two source files may differ only in letter case.
 *
 * The board is built on Windows, whose file system does not tell `orderFinder.ts`
 * from `OrderFinder.tsx`: an import of `./OrderFinder` there resolves to the
 * `.ts` first and the build fails with "differs only in casing". Linux keeps
 * them apart, so nothing developed or tested here would ever notice — this does.
 *
 * Compared by path with the extension an import leaves off taken away, since
 * that is what an import names.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const TREES = ['src', 'tests', 'scripts', 'assembly/src', 'assembly/tests', 'assembly/scripts'];
const RESOLVED = /\.(d\.ts|tsx|ts|mts|cts|jsx|js|mjs|cjs|json|css)$/;

function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(root, path).replace(/\\/g, '/')];
  });
}

describe('file names', () => {
  it('has no two files an import could not tell apart on Windows', () => {
    const byKey = new Map<string, string[]>();
    for (const file of TREES.flatMap((tree) => filesUnder(join(root, tree)))) {
      const key = file.replace(RESOLVED, '').toLowerCase();
      byKey.set(key, [...(byKey.get(key) ?? []), file]);
    }
    // The same stem in the same case with two extensions is ordinary (`foo.ts`
    // beside `foo.css`); the same stem spelt in two cases is the clash.
    const clashes = [...byKey.values()].filter(
      (files) => new Set(files.map((f) => f.replace(RESOLVED, ''))).size > 1,
    );
    expect(clashes).toEqual([]);
  });
});
