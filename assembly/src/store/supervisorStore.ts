/**
 * The supervisor gate on crew allocation.
 *
 * Only a supervisor decides who works an order, so allocating and removing
 * people is behind a password. Booking the shift's output is not — that is the
 * shift's own number to report.
 *
 * ## What this is, and what it is not
 *
 * `VITE_SUPERVISOR_PASSWORD` is compiled into the JavaScript bundle, so anyone
 * who opens the browser's dev tools can read it. This is an **operational
 * gate** — it stops the board being changed by whoever happens to be standing
 * at the terminal — not a security boundary. Nothing here protects the
 * SharePoint list: that is done by the Graph token and the list's own
 * permissions.
 *
 * Making it a real check means moving the comparison to a server that holds
 * the secret and hands back a session, which is a backend change. Until then,
 * do not reuse this password anywhere it would matter.
 *
 * Leaving the variable unset opens the gate, so the mock demo and a fresh
 * checkout work with no configuration.
 */

import { create } from 'zustand';

interface SupervisorState {
  /** True when allocation is permitted: unlocked, or no password configured. */
  unlocked: boolean;
  /** False when no password is set — the UI hides the lock entirely. */
  required: boolean;
  /**
   * True once MES has claimed this board (see `mesBridge`).
   *
   * The gate is then the host's own top-bar button, which is on every screen
   * of the application rather than only this one — there is one place to sign
   * in and one place to sign out. This board must therefore not offer a
   * second lock of its own, and must not tell the reader to use "the header",
   * because the header they are looking at has no such control on it.
   */
  hosted: boolean;
  /** Set after a wrong attempt, cleared on the next try. */
  error: string | null;

  /** Returns true when the password matched. */
  unlock: (password: string) => boolean;
  lock: () => void;
  clearError: () => void;
}

/**
 * Where the reader has to go to sign in, named for the screen they are on.
 *
 * Inside MES that is the top bar above this board; standalone — the demo and
 * the dev server — the board carries its own lock. Every "you need to be
 * signed in" line on the board is built from this, so none of them can drift
 * into pointing at a control that is not there.
 */
export const signInAt = (hosted: boolean): string =>
  hosted ? 'Supervisor in the MES top bar' : 'Supervisor in the board header';

const configured = (): string =>
  (import.meta.env.VITE_SUPERVISOR_PASSWORD ?? '').trim();

export const useSupervisorStore = create<SupervisorState>((set) => ({
  unlocked: configured() === '',
  required: configured() !== '',
  hosted: false,
  error: null,

  unlock(password) {
    const expected = configured();
    if (expected === '' || password === expected) {
      set({ unlocked: true, error: null });
      return true;
    }
    set({ error: 'Wrong supervisor password' });
    return false;
  },

  lock() {
    // Only meaningful when a password is configured; without one there is
    // nothing to unlock with afterwards.
    if (configured() !== '') set({ unlocked: false, error: null });
  },

  clearError() {
    set({ error: null });
  },
}));
