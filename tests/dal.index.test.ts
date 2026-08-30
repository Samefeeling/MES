import { describe, it, expect } from 'vitest';
import { deriveMangoCsvPath, resolveMangoCsvPath } from '../src/dal/index';

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
