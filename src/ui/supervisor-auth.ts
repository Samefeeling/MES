// Supervisor mode — a session-scoped auth gate for unlock + admin actions.
// The shared password is compile-time configuration. There is deliberately
// no fallback: deployments must set VITE_SUPERVISOR_PASSWORD and rebuild.
// The "auth" is intentionally light — this is an internal LOB app on a
// trusted SharePoint site, and the gate exists to stop operators from
// accidentally tapping Unlock rather than to replace server-side access
// control.

const KEY = 'pmd_supervisor_mode';

function configuredPassword(): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)
    .VITE_SUPERVISOR_PASSWORD;
  return value && value.trim() ? value : undefined;
}

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

/** Whether this build has a usable supervisor password configured. */
export function isSupervisorConfigured(): boolean {
  return configuredPassword() !== undefined;
}

export function tryEnterSupervisor(password: string): boolean {
  const expected = configuredPassword();
  if (!expected || password !== expected) return false;
  try {
    sessionStorage.setItem(KEY, '1');
    // Storage can be blocked (private mode / policy) or can silently refuse
    // the write. Never report a successful login when the very next
    // isSupervisor() check remains false.
    if (sessionStorage.getItem(KEY) !== '1') return false;
  } catch {
    return false;
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
