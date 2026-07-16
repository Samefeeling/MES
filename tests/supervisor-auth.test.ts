import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSupervisor,
  isSupervisorConfigured,
  tryEnterSupervisor,
} from '../src/ui/supervisor-auth';

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  vi.unstubAllEnvs();
});

describe('supervisor session gate', () => {
  it('is disabled when the build has no configured password', () => {
    vi.stubEnv('VITE_SUPERVISOR_PASSWORD', '');
    expect(isSupervisorConfigured()).toBe(false);
    expect(tryEnterSupervisor('any-value')).toBe(false);
  });

  it('returns false when browser storage refuses the session', () => {
    vi.stubEnv('VITE_SUPERVISOR_PASSWORD', 'test-supervisor-password');
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (): null => null,
      setItem: (): never => {
        throw new Error('storage blocked');
      },
      removeItem: (): void => {},
    };
    expect(tryEnterSupervisor('test-supervisor-password')).toBe(false);
    expect(isSupervisor()).toBe(false);
  });

  it('reports success only after the session marker round-trips', () => {
    vi.stubEnv('VITE_SUPERVISOR_PASSWORD', 'test-supervisor-password');
    let value: string | null = null;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (): string | null => value,
      setItem: (_key: string, next: string): void => {
        value = next;
      },
      removeItem: (): void => {
        value = null;
      },
    };
    expect(isSupervisorConfigured()).toBe(true);
    expect(tryEnterSupervisor('wrong-password')).toBe(false);
    expect(tryEnterSupervisor('test-supervisor-password')).toBe(true);
    expect(isSupervisor()).toBe(true);
  });
});
