// Supervisor mode — a session-scoped auth gate for unlock + admin actions.
// Single shared password (compile-time, falls back to "pmd1234" so the
// floor can use the app without an env override; rotate by setting
// VITE_SUPERVISOR_PASSWORD and rebuilding). The "auth" is intentionally
// light — this is an internal LOB app on a trusted SharePoint site,
// the gate exists to stop operators from accidentally tapping Unlock,
// not to defend against an attacker who has the iPad and the network.

const KEY = 'pmd_supervisor_mode';
const PASSWORD =
  (import.meta.env as Record<string, string | undefined>).VITE_SUPERVISOR_PASSWORD ??
  'pmd1234';

type Listener = () => void;
const listeners = new Set<Listener>();

export function isSupervisor(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearSupervisor(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode / blocked — nothing to clear */
  }
  notify();
}

export function tryEnterSupervisor(password: string): boolean {
  if (password !== PASSWORD) return false;
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* private mode — caller will still see isSupervisor() === false next read */
  }
  notify();
  return true;
}

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onSupervisorChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of listeners) fn();
}
