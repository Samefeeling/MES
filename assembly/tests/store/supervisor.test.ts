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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

/**
 * There is one Supervisor button in MES and it is in the top bar, above every
 * screen. The board must not offer a second one, and — the part that actually
 * went wrong — must not send the reader to "the header" for a control that is
 * not in the header they are looking at.
 */
describe('one gate, and inside MES it belongs to the host', () => {
  it('sends a board on its own to its own header', async () => {
    const { signInAt } = await import('@/store/supervisorStore');
    expect(signInAt(false)).toContain('board header');
  });

  it('sends a hosted board up to the MES top bar', async () => {
    const { signInAt } = await import('@/store/supervisorStore');
    expect(signInAt(true)).toContain('MES top bar');
  });

  it('starts unhosted, so a board opened on its own keeps its own lock', async () => {
    const store = await withPassword('resero');
    expect(store.getState().hosted).toBe(false);
  });

  it('hands the gate to MES on connect, and shuts until MES says who is on', async () => {
    vi.resetModules();
    // No password of its own: standalone this board would be wide open.
    vi.stubEnv('VITE_SUPERVISOR_PASSWORD', '');
    const posted: unknown[] = [];
    vi.stubGlobal('document', { baseURI: 'https://mes.example/assembly/' });
    vi.stubGlobal('window', {
      parent: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: () => {},
    });

    const { useSupervisorStore } = await import('@/store/supervisorStore');
    const { connectMes } = await import('@/mesBridge');
    expect(useSupervisorStore.getState().unlocked).toBe(true);

    connectMes();

    const state = useSupervisorStore.getState();
    expect(state.hosted).toBe(true);
    expect(state.required).toBe(true);
    // Shut, not open — the host has yet to say whether anyone is signed in,
    // and an open board in the gap is a board anybody can rearrange.
    expect(state.unlocked).toBe(false);
    expect(posted).toEqual([{ type: 'assembly:ready' }]);
  });
});
