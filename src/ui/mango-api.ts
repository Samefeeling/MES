import {
  describeImpwApiFailure,
  describeMangoAuthFailure,
  impwApiPayload,
  impwEndpoint,
  impwTicketRef,
  parseImpwCreated,
  parseImpwOptions,
  type ImpwDraft,
  type MangoOption,
} from '../core/impw';

// Mango's Public API v4 — the only place PMD talks to Mango.
//
// Transcribed from Mango's own developer document; docs/mango-api-v4.md is
// the authority for every path, header, field and status code here. Three
// calls are used, in this order:
//
//   POST /api/auth/authenticate     username + password  → bearer token
//   GET  /api/v4/improvement/new    the tenant's Type of Improvement and
//                                   Coordinator lists (a GET — despite the
//                                   name it creates nothing)
//   POST /api/v4/improvement        the ticket
//
// The sign-in is entered ON SITE rather than compiled in: the Mango account
// password is rotated periodically, and a build-time env var would mean a
// rebuild-and-redeploy every time it changed. So the base URL and the
// credentials live in browser storage, set once from the KPI page's
// ⚙ Mango connection dialog.
//
// Nothing here is a hard dependency: when the API is not configured, or any
// call fails for any reason, the KPI page falls back to copying the filled
// form and opening IMPW to paste into — the way it worked before there was
// an API at all. Filing a ticket must never depend on this succeeding.

const DEFAULT_BASE = 'https://api.mangolive.com';

/** Fixed by Mango, so not user-editable — only the host is a real choice
 *  (api.mangolive.com vs api-uk.mangolive.com, per the API document). */
const AUTH_PATH = '/api/auth/authenticate';
const OPTIONS_PATH = '/api/v4/improvement/new';
const CREATE_PATH = '/api/v4/improvement';

const CONN_KEY = 'pmd.mangoApi';

export interface MangoConnection {
  baseUrl: string;
  username: string;
  password: string;
}

export const DEFAULT_MANGO_CONNECTION: MangoConnection = {
  baseUrl: DEFAULT_BASE,
  username: '',
  password: '',
};

export function loadMangoConnection(): MangoConnection {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (!raw) return { ...DEFAULT_MANGO_CONNECTION };
    const parsed = JSON.parse(raw) as Partial<MangoConnection>;
    return {
      baseUrl: (parsed.baseUrl || DEFAULT_BASE).trim(),
      username: parsed.username ?? '',
      password: parsed.password ?? '',
    };
  } catch {
    return { ...DEFAULT_MANGO_CONNECTION };
  }
}

export function saveMangoConnection(c: MangoConnection): void {
  resetMangoToken();
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* private mode — this device files by clipboard instead */
  }
}

export function clearMangoConnection(): void {
  resetMangoToken();
  try {
    localStorage.removeItem(CONN_KEY);
  } catch {
    /* nothing stored */
  }
}

/** Configured = every part of the sign-in is present. A half-filled
 *  connection is treated as absent so the clipboard path stays in charge
 *  rather than every ticket failing on a 400. */
export function isMangoConfigured(c = loadMangoConnection()): boolean {
  return !!(c.baseUrl.trim() && c.username.trim() && c.password);
}

/** Where a ticket actually goes — for the connection dialog and the panel's
 *  tooltip, so "filing directly" can be checked rather than believed. */
export function mangoCreateUrl(c: MangoConnection): string {
  return impwEndpoint(c.baseUrl, CREATE_PATH);
}

// ---------------------------------------------------------------------------
// Bearer token
// ---------------------------------------------------------------------------

// Held in memory only, never in storage: Mango ties a token to the IP that
// acquired it, so a cached one outlives neither a reload nor a move from
// Wi-Fi to mobile data, and a token in localStorage would just be a second
// secret to leak. Cheap to re-acquire — one POST.
let tokenCache: { key: string; token: string } | null = null;

/** Drop any cached token — called whenever the sign-in changes. */
export function resetMangoToken(): void {
  tokenCache = null;
}

function connKey(c: MangoConnection): string {
  return `${c.baseUrl.trim()}|${c.username.trim()}`;
}

export interface MangoAuthResult {
  ok: boolean;
  /** The signed-in user's own name, as Mango knows it. */
  name: string;
  email: string;
  message: string;
  status: number;
}

/**
 * Sign in and cache the token. Exposed on its own so the connection dialog
 * can offer a "Test sign-in" — finding out the password is wrong while
 * standing at the settings screen beats finding out three fields into a
 * ticket.
 */
export async function mangoSignIn(conn = loadMangoConnection()): Promise<MangoAuthResult> {
  const res = await mangoFetch(impwEndpoint(conn.baseUrl, AUTH_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: conn.username, password: conn.password }),
  });
  if (res.status !== 200 && res.status !== 201) {
    return {
      ok: false,
      name: '',
      email: '',
      status: res.status,
      message: describeMangoAuthFailure(res.status, res.text),
    };
  }
  const body = parseJson(res.text) as Record<string, unknown> | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) {
    return {
      ok: false,
      name: '',
      email: '',
      status: res.status,
      message: 'Mango accepted the sign-in but returned no token.',
    };
  }
  tokenCache = { key: connKey(conn), token };
  const first = typeof body?.firstName === 'string' ? body.firstName : '';
  const last = typeof body?.lastName === 'string' ? body.lastName : '';
  return {
    ok: true,
    name: [first, last].filter(Boolean).join(' ').trim(),
    email: typeof body?.emailAddress === 'string' ? body.emailAddress : '',
    status: res.status,
    message: 'Signed in to Mango.',
  };
}

/**
 * Run an authorised call, signing in first if there is no usable token and
 * once more if Mango says the token is stale. One retry only — a second 401
 * is the credentials, not the token, and looping on it would lock the
 * account out.
 */
async function withToken(
  conn: MangoConnection,
  call: (token: string) => Promise<FetchResult>,
): Promise<FetchResult | { authFailure: MangoAuthResult }> {
  let token = tokenCache?.key === connKey(conn) ? tokenCache.token : '';
  if (!token) {
    const auth = await mangoSignIn(conn);
    if (!auth.ok) return { authFailure: auth };
    token = tokenCache?.token ?? '';
  }
  const first = await call(token);
  if (first.status !== 401) return first;
  resetMangoToken();
  const auth = await mangoSignIn(conn);
  if (!auth.ok) return { authFailure: auth };
  return call(tokenCache?.token ?? '');
}

function isAuthFailure(
  r: FetchResult | { authFailure: MangoAuthResult },
): r is { authFailure: MangoAuthResult } {
  return 'authFailure' in r;
}

// ---------------------------------------------------------------------------
// The two Improvement calls
// ---------------------------------------------------------------------------

export interface MangoOptionsResult {
  ok: boolean;
  typeOfImprovement: MangoOption[];
  coordinator: MangoOption[];
  message: string;
  status: number;
}

/**
 * The tenant's own Type of Improvement and Coordinator lists. Mango wants
 * the {id, name} it issued, so these are the only valid answers — which is
 * why PMD asks rather than offering a text box that would 422.
 */
export async function fetchImpwOptions(
  conn = loadMangoConnection(),
): Promise<MangoOptionsResult> {
  const res = await withToken(conn, (token) =>
    mangoFetch(impwEndpoint(conn.baseUrl, OPTIONS_PATH), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    }),
  );
  if (isAuthFailure(res)) {
    return {
      ok: false,
      typeOfImprovement: [],
      coordinator: [],
      status: res.authFailure.status,
      message: res.authFailure.message,
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      typeOfImprovement: [],
      coordinator: [],
      status: res.status,
      message: describeImpwApiFailure(res.status, res.text),
    };
  }
  const body = parseJson(res.text);
  return {
    ok: true,
    typeOfImprovement: parseImpwOptions(body, 'typeOfImprovement'),
    coordinator: parseImpwOptions(body, 'coordinator'),
    status: res.status,
    message: '',
  };
}

export interface MangoSubmitResult {
  ok: boolean;
  /** 'IMP 0123' — what the floor calls it. */
  ticketRef: string;
  /** Mango's opaque record id, for anything that needs to address it. */
  ticketId: string;
  /** Human sentence — what happened and, on failure, what to do. */
  message: string;
  /** HTTP status; 0 when the request never reached Mango (offline, DNS,
   *  CORS — the browser reports them all the same way). */
  status: number;
}

/** POST one ticket to /api/v4/improvement. */
export async function submitImpwToMango(
  draft: ImpwDraft,
  conn = loadMangoConnection(),
): Promise<MangoSubmitResult> {
  const body = JSON.stringify(impwApiPayload(draft));
  const res = await withToken(conn, (token) =>
    mangoFetch(impwEndpoint(conn.baseUrl, CREATE_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
    }),
  );
  if (isAuthFailure(res)) {
    return {
      ok: false,
      ticketRef: '',
      ticketId: '',
      status: res.authFailure.status,
      message: res.authFailure.message,
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      ticketRef: '',
      ticketId: '',
      status: res.status,
      message: describeImpwApiFailure(res.status, res.text),
    };
  }
  const created = parseImpwCreated(parseJson(res.text));
  const ref = impwTicketRef(created);
  return {
    ok: true,
    ticketRef: ref,
    ticketId: created.id,
    status: res.status,
    message: ref ? `Raised in Mango — ${ref}` : 'Raised in Mango',
  };
}

// ---------------------------------------------------------------------------
// fetch, with the failures the floor actually hits
// ---------------------------------------------------------------------------

interface FetchResult {
  /** 0 = the request never reached Mango. A browser cannot tell a CORS
   *  refusal from being offline, so both land here. */
  status: number;
  text: string;
}

async function mangoFetch(url: string, init: RequestInit): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Never log the credentials — only what went wrong.
    console.warn('[pmd] Mango request failed', (e as Error).message);
    return { status: 0, text: '' };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) console.warn(`[pmd] Mango ${res.status}`, text.slice(0, 500));
  return { status: res.status, text };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
