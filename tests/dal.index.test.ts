import { describe, it, expect } from 'vitest';
import { backendWarning, deriveMangoCsvPath, resolveBackend, resolveMangoCsvPath } from '../src/dal/index';

describe('deriveMangoCsvPath', () => {
  it('swaps the planning file name for MangoWorkOrders.csv in the same folder', () => {
    expect(
      deriveMangoCsvPath(
        '/sites/ReseroOperationsAU/Shared Documents/General/Planning/Data/Planning.csv',
      ),
    ).toBe('/sites/ReseroOperationsAU/Shared Documents/General/Planning/Data/MangoWorkOrders.csv');
  });

  it('is idempotent when the planning path already points at the Mango file', () => {
    const p = '/sites/x/Data/MangoWorkOrders.csv';
    expect(deriveMangoCsvPath(p)).toBe('/sites/x/Data/MangoWorkOrders.csv');
  });

  it('returns empty when there is no planning path to derive from', () => {
    expect(deriveMangoCsvPath(undefined)).toBe('');
    expect(deriveMangoCsvPath('')).toBe('');
  });
});

describe('resolveMangoCsvPath (tolerant env var names)', () => {
  const P = '/sites/x/Data/MangoWorkOrders.csv';
  it('accepts the canonical VITE_MANGO_CSV_PATH', () => {
    expect(resolveMangoCsvPath({ VITE_MANGO_CSV_PATH: P })).toBe(P);
  });
  it('accepts the field name VITE_MANGOWORKORDERS_CSV_PATH', () => {
    expect(resolveMangoCsvPath({ VITE_MANGOWORKORDERS_CSV_PATH: P })).toBe(P);
  });
  it('accepts VITE_MANGO_WORKORDERS_CSV_PATH', () => {
    expect(resolveMangoCsvPath({ VITE_MANGO_WORKORDERS_CSV_PATH: P })).toBe(P);
  });
  it('falls back to MangoWorkOrders.csv beside the Planning CSV', () => {
    expect(resolveMangoCsvPath({ VITE_PLANNING_CSV_PATH: '/sites/x/Data/Planning.csv' })).toBe(P);
  });
  it('is empty when nothing is configured', () => {
    expect(resolveMangoCsvPath({})).toBe('');
  });
});

// A build that cannot have the backend it asked for used to run on the
// in-memory demo data without a word.
describe('resolveBackend', () => {
  const SITE = { VITE_SITE_URL: 'https://example.sharepoint.com/sites/x' };

  it('takes sharepoint however it is capitalised', () => {
    for (const asked of ['sharepoint', 'SharePoint', ' SHAREPOINT ']) {
      expect(resolveBackend({ VITE_BACKEND: asked, ...SITE })).toEqual({ kind: 'sharepoint', problem: null });
    }
  });

  it('says so when sharepoint has no site to talk to', () => {
    const choice = resolveBackend({ VITE_BACKEND: 'sharepoint' });
    expect(choice.kind).toBe('sharepoint');
    expect(choice.problem).toMatch(/VITE_SITE_URL/);
  });

  it('runs the demo data only without complaint when asked for it by name', () => {
    expect(resolveBackend({ VITE_BACKEND: 'memory' })).toEqual({ kind: 'memory', problem: null });
  });

  it('falls back to the demo data for anything else, and says why', () => {
    expect(resolveBackend({})).toEqual({ kind: 'memory', problem: 'built without VITE_BACKEND' });
    for (const asked of ['sql', 'azure', 'sharepiont']) {
      const choice = resolveBackend({ VITE_BACKEND: asked, ...SITE });
      expect(choice.kind).toBe('memory');
      expect(choice.problem).toContain(asked);
    }
  });
});

describe('backendWarning', () => {
  const SITE = { VITE_SITE_URL: 'https://example.sharepoint.com/sites/x' };

  it('has nothing to say about a SharePoint build that is configured', () => {
    expect(backendWarning({ VITE_BACKEND: 'sharepoint', ...SITE }, true)).toBeNull();
  });

  it('never lets a deployed build show demo data unannounced', () => {
    expect(backendWarning({}, true)).toMatch(/Demo data.*nothing entered here is saved.*VITE_BACKEND/);
    expect(backendWarning({ VITE_BACKEND: 'sql', ...SITE }, true)).toMatch(/Demo data.*"sql"/);
    // Even a demo deployed on purpose says what it is.
    expect(backendWarning({ VITE_BACKEND: 'memory' }, true)).toMatch(/^Demo data/);
  });

  it('leaves `npm run dev` on the demo data alone, but not a mistyped backend', () => {
    expect(backendWarning({}, false)).toBeNull();
    expect(backendWarning({ VITE_BACKEND: 'memory' }, false)).toBeNull();
    expect(backendWarning({ VITE_BACKEND: 'sharepiont', ...SITE }, false)).toMatch(/Demo data.*sharepiont/);
  });

  it('says when SharePoint was asked for without a site', () => {
    expect(backendWarning({ VITE_BACKEND: 'sharepoint' }, false)).toMatch(/not configured.*VITE_SITE_URL/);
  });
});
