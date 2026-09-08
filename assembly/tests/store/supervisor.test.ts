/**
 * The supervisor gate. See `store/supervisorStore` for why this is an
 * operational gate rather than a security boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The store reads the password at call time, so re-import per scenario. */
async function withPassword(password: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_SUPERVISOR_PASSWORD', password ?? '');
  const { useSupervisorStore } = await import('@/store/supervisorStore');
  return useSupervisorStore;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe('supervisor gate', () => {
  it('is open and hidden when no password is configured', async () => {
    const store = await withPassword('');
    expect(store.getState().required).toBe(false);
    expect(store.getState().unlocked).toBe(true);
  });

  it('cannot be locked when there is no password to reopen it with', async () => {
    const store = await withPassword('');
    store.getState().lock();
    expect(store.getState().unlocked).toBe(true);
  });

  it('starts locked once a password is set', async () => {
    const store = await withPassword('resero');
    expect(store.getState().required).toBe(true);
    expect(store.getState().unlocked).toBe(false);
  });

  it('opens on the right password and reports a wrong one', async () => {
    const store = await withPassword('resero');

    expect(store.getState().unlock('nope')).toBe(false);
    expect(store.getState().unlocked).toBe(false);
    expect(store.getState().error).toContain('Wrong');

    expect(store.getState().unlock('resero')).toBe(true);
    expect(store.getState().unlocked).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it('locks again on request', async () => {
    const store = await withPassword('resero');
    store.getState().unlock('resero');
    store.getState().lock();
    expect(store.getState().unlocked).toBe(false);
  });

  it('ignores surrounding whitespace in the configured value', async () => {
    const store = await withPassword('  resero  ');
    expect(store.getState().unlock('resero')).toBe(true);
  });
});
