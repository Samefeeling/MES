import { afterAll, beforeAll } from 'vitest';

// Unit tests must never depend on SharePoint or any other live endpoint.
// A missed DAL stub fails immediately with the URL in the message, rather
// than leaking network traffic or hanging. Restore Node's native fetch after
// the file so Vitest/Vite can tear its worker down normally.
const nativeFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`Unexpected network request in test: ${url}`);
  };
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
});
