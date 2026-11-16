// SharePoint data layer — the wire: throttled fetch, undoing a half-made
// write, and server-relative paths.


export type RollbackAction = () => Promise<void>;

// ---- helpers ---------------------------------------------------------

/** How often a throttled request is sent again, and the longest single wait. */
const THROTTLE_RETRIES = 3;

const THROTTLE_MAX_WAIT_MS = 15_000;

/**
 * How long to stand off after a throttled answer: SharePoint's own
 * Retry-After (seconds, or an HTTP date) when it gives one, else 1 s, 2 s,
 * 4 s. Never less than a quarter of a second nor more than fifteen — a
 * supervisor is watching a "Saving…" button.
 */
export function throttleWaitMs(
  retryAfter: string | null | undefined,
  attempt: number,
  now: number = Date.now(),
): number {
  const raw = (retryAfter ?? '').trim();
  let ms = NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw) ms = Date.parse(raw) - now;
  if (!Number.isFinite(ms) || ms < 0) ms = 1000 * 2 ** attempt;
  return Math.min(Math.max(ms, 250), THROTTLE_MAX_WAIT_MS);
}

/**
 * `fetch`, sent again when SharePoint Online throttles it.
 *
 * A busy tenant answers 429, or 503 with a Retry-After, and has NOT run the
 * request — that is what makes sending it again safe for a write as well as
 * a read, a create included. Without this one throttled call in the dozen a
 * sign-off makes failed the whole sign-off, and one in a page load left the
 * page blank. A 503 with no Retry-After is not a throttle (a gateway may
 * have passed the request on before failing) and is returned as it is, as
 * is every other answer; after THROTTLE_RETRIES the last answer stands and
 * the caller reports it.
 */
export async function fetchThroughThrottle(
  url: string,
  init?: RequestInit,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    const retryAfter = res?.headers?.get?.('Retry-After') ?? null;
    const throttled = res?.status === 429 || (res?.status === 503 && retryAfter != null);
    if (!throttled || attempt >= THROTTLE_RETRIES) return res;
    const ms = throttleWaitMs(retryAfter, attempt);
    console.warn(`[sp] throttled (${res.status}) — sending again in ${ms} ms: ${url.split('?')[0]}`);
    await wait(ms);
  }
}

export async function runRollback(action: RollbackAction): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (e) {
    return (e as Error).message || String(e);
  }
}

/**
 * Take whatever the operator put in VITE_PLANNING_CSV_PATH and reduce it
 * to a clean server-relative path (`/sites/…/file.csv`, spaces unencoded).
 * Tolerates: a full URL, a leading-slash path, a no-leading-slash path,
 * already %-encoded characters, and trailing slashes.
 */
export function toServerRelativePath(input: string): string {
  let p = (input ?? '').trim();
  if (!p) return p;
  // Full URL → take the pathname (URL.pathname drops query/fragment but
  // does NOT decode percent-encoding, so the decode below still applies).
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      // malformed URL — fall through and treat as a raw path
    }
  } else {
    const q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    const h = p.indexOf('#');
    if (h >= 0) p = p.slice(0, h);
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // input wasn't percent-encoded — leave as is
  }
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}
