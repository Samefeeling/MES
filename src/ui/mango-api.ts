import {
  describeImpwApiFailure,
  extractImpwTicketId,
  impwApiPayload,
  impwEndpoint,
  type ImpwDraft,
} from '../core/impw';

// Mango's REST API for Improvement Workflow tickets.
//
// The sign-in is entered ON SITE rather than compiled in: the Mango account
// password is rotated periodically, and a build-time env var would mean a
// rebuild-and-redeploy every time it changed. So the base URL, the path and
// the credentials all live in browser storage, set once from the KPI page's
// 🥭 Mango connection dialog.
//
// Nothing here is a hard dependency: when the API is not configured, or the
// call fails for any reason, the KPI page falls back to the clipboard + open
// the IMPW form — the way it worked before there was an API at all. Filing
// the ticket must never depend on this succeeding.

const DEFAULT_BASE = 'https://api.mangolive.com';
const DEFAULT_PATH = '/api/v4/improvement/new';

const CONN_KEY = 'pmd.mangoApi';

export interface MangoConnection {
  baseUrl: string;
  path: string;
  username: string;
  password: string;
}

export const DEFAULT_MANGO_CONNECTION: MangoConnection = {
  baseUrl: DEFAULT_BASE,
  path: DEFAULT_PATH,
  username: '',
  password: '',
};

export function loadMangoConnection(): MangoConnection {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (!raw) return { ...DEFAULT_MANGO_CONNECTION };
    const parsed = JSON.parse(raw) as Partial<MangoConnection>;
    return { ...DEFAULT_MANGO_CONNECTION, ...parsed };
  } catch {
    return { ...DEFAULT_MANGO_CONNECTION };
  }
}

export function saveMangoConnection(c: MangoConnection): void {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* private mode — this device files by clipboard instead */
  }
}

export function clearMangoConnection(): void {
  try {
    localStorage.removeItem(CONN_KEY);
  } catch {
    /* nothing stored */
  }
}

/** Configured = both halves of the sign-in are present. A half-filled
 *  connection is treated as absent so the clipboard path stays in charge
 *  rather than every ticket failing on a 401. */
export function isMangoConfigured(c = loadMangoConnection()): boolean {
  return !!(c.baseUrl.trim() && c.path.trim() && c.username.trim() && c.password);
}

export interface MangoSubmitResult {
  ok: boolean;
  /** Mango's id for the new ticket, when the response carried one. */
  ticketId: string;
  /** Human sentence — what happened and, on failure, what to do. */
  message: string;
  /** HTTP status; 0 when the request never reached Mango (offline, DNS,
   *  CORS — the browser reports them all the same way). */
  status: number;
}

/**
 * POST one ticket. Basic auth: a username and a password is what the site
 * has, and it is what Mango's own API docs use for this endpoint family. If
 * the live API turns out to want a token exchange instead, this is the only
 * function that changes — the failure message quotes Mango's own response
 * so the answer is visible from the floor rather than needing a debugger.
 */
export async function submitImpwToMango(
  draft: ImpwDraft,
  conn = loadMangoConnection(),
): Promise<MangoSubmitResult> {
  const url = impwEndpoint(conn.baseUrl, conn.path);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // btoa is Latin-1 only; encode first so a non-ASCII password does
        // not throw before the request is even made.
        Authorization: `Basic ${latin1Base64(`${conn.username}:${conn.password}`)}`,
      },
      body: JSON.stringify(impwApiPayload(draft)),
    });
  } catch (e) {
    // Never log the credentials — only what went wrong.
    console.warn('[pmd] Mango IMPW request failed', (e as Error).message);
    return { ok: false, ticketId: '', status: 0, message: describeImpwApiFailure(0, '') };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    console.warn(`[pmd] Mango IMPW ${res.status}`, text.slice(0, 500));
    return {
      ok: false,
      ticketId: '',
      status: res.status,
      message: describeImpwApiFailure(res.status, text),
    };
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* a 2xx with a non-JSON body is still a filed ticket */
  }
  const ticketId = extractImpwTicketId(parsed);
  return {
    ok: true,
    ticketId,
    status: res.status,
    message: ticketId ? `Raised in Mango — ticket ${ticketId}` : 'Raised in Mango',
  };
}

/** UTF-8 → Latin-1 → base64, so btoa never sees a character it can't take. */
function latin1Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
