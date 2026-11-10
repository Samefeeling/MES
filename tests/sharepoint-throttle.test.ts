import { afterEach, describe, expect, it } from 'vitest';
import { fetchThroughThrottle, SharePointDataLayer, throttleWaitMs } from '../src/dal/sharepoint';

// SharePoint Online answers a busy tenant with 429, or 503 + Retry-After,
// and has not run the request. One of those in the dozen calls a sign-off
// makes used to fail the whole sign-off.

type Answer = { status: number; retryAfter?: string; body?: unknown };

function serve(answers: Answer[]): { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      headers: { get: (h: string) => (h === 'Retry-After' ? a.retryAfter ?? null : null) },
      json: async () => a.body ?? {},
      text: async () => JSON.stringify(a.body ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

describe('SharePoint throttling', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  const waits: number[] = [];
  const noWait = async (ms: number): Promise<void> => {
    waits.push(ms);
  };

  it('waits as long as SharePoint asks, within bounds', () => {
    expect(throttleWaitMs('3', 0)).toBe(3000);
    expect(throttleWaitMs('120', 0)).toBe(15_000); // never longer than 15 s
    expect(throttleWaitMs('0', 0)).toBe(250); // never a busy loop
    const now = Date.parse('2026-11-10T00:00:00Z');
    expect(throttleWaitMs('Tue, 10 Nov 2026 00:00:05 GMT', 0, now)).toBe(5000);
    // No header, or one that cannot be read: 1 s, 2 s, 4 s.
    expect([0, 1, 2].map((n) => throttleWaitMs(null, n))).toEqual([1000, 2000, 4000]);
    expect(throttleWaitMs('soon', 1)).toBe(2000);
  });

  it('sends a throttled request again and returns the answer that follows', async () => {
    waits.length = 0;
    const { calls } = serve([{ status: 429, retryAfter: '2' }, { status: 503, retryAfter: '1' }, { status: 200 }]);
    const res = await fetchThroughThrottle('https://x/_api/a', { method: 'POST' }, noWait);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 1000]);
  });

  it('gives up after three more tries and hands back the throttle answer', async () => {
    waits.length = 0;
    const { calls } = serve([{ status: 429 }]);
    const res = await fetchThroughThrottle('https://x/_api/a', undefined, noWait);
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(4);
  });

  it('does not resend anything that may have been run', async () => {
    for (const status of [400, 403, 404, 409, 500]) {
      const { calls } = serve([{ status }]);
      expect((await fetchThroughThrottle('https://x/_api/a', undefined, noWait)).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
    // A 503 that does not say when to come back is not a throttle: a gateway
    // may have passed the write on before it failed.
    const { calls } = serve([{ status: 503 }]);
    expect((await fetchThroughThrottle('https://x/_api/a', { method: 'POST' }, noWait)).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('a list write that is throttled once still lands, once', async () => {
    const { calls } = serve([
      { status: 200, body: { d: { GetContextWebInformation: { FormDigestValue: 'D', FormDigestTimeoutSeconds: 1800 } } } },
      { status: 429, retryAfter: '0' },
      { status: 201, body: { d: { ID: 7 } } },
    ]);
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const post = (dal as unknown as { post: (url: string, body: unknown) => Promise<Response> }).post.bind(dal);
    const res = await post("https://example.sharepoint.com/sites/x/_api/web/lists/getbytitle('L')/items", { Title: 'a' });
    expect(res.status).toBe(201);
    // digest, the throttled create, the create again — and no third create.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(calls.filter((c) => c.url.endsWith('/items'))).toHaveLength(2);
  });
});
