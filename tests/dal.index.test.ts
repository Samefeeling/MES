import { describe, it, expect } from 'vitest';
import { deriveMangoCsvPath } from '../src/dal/index';

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
