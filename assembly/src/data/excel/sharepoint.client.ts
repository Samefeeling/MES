/**
 * Fetches the PMD master workbook as raw bytes.
 *
 * Primary path: Microsoft Graph (the workbook lives in a SharePoint document
 * library, refreshed from Epicor hourly). Fallback path: a workbook the planner
 * uploaded by hand in the browser — handy when Graph auth isn't wired up yet.
 *
 * This module deliberately knows nothing about sheet contents; it only returns
 * an `ArrayBuffer` for `SharePointExcelSource` to parse.
 */

import { ok, err, type Result } from '@/lib/result';

export interface SharePointConfig {
  /** e.g. https://contoso.sharepoint.com/sites/PMD */
  siteUrl: string;
  /** Path within the site's default drive, e.g. /Shared Documents/file.xlsm */
  filePath: string;
  /** OAuth bearer token for Graph (dev only; use a broker in production). */
  token: string;
  authMode?: 'graph' | 'session';
}

export function readConfigFromEnv(): SharePointConfig {
  const env = import.meta.env;
  return {
    siteUrl: env.VITE_SHAREPOINT_SITE_URL ?? env.VITE_SITE_URL ?? '',
    authMode: env.VITE_SHAREPOINT_AUTH === 'session' || env.VITE_BACKEND === 'sharepoint' ? 'session' : 'graph',
    filePath: env.VITE_SHAREPOINT_FILE_PATH ?? '',
    token: env.VITE_GRAPH_TOKEN ?? '',
  };
}

// --- manual upload fallback ------------------------------------------------

let manualWorkbook: ArrayBuffer | null = null;

/** Stash a workbook the user picked from disk; used when Graph is unavailable. */
export function setManualWorkbook(buffer: ArrayBuffer): void {
  manualWorkbook = buffer;
}

export function getManualWorkbook(): ArrayBuffer | null {
  return manualWorkbook;
}

/** Read a `File` (from an <input type=file>) into an ArrayBuffer. */
export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

// --- Microsoft Graph -------------------------------------------------------

/**
 * The Graph address of a site, in the `:/path:` form, so nothing has to
 * pre-resolve an id: `…/sites/contoso.sharepoint.com:/sites/PMD:`.
 *
 * Every module that talked to Graph had built this for itself — four copies
 * of two lines, which is three chances for one of them to keep a trailing
 * slash the others strip.
 */
export function graphSite(cfg: SharePointConfig): string {
  const u = new URL(cfg.siteUrl);
  return `https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname.replace(/\/$/, '')}:`;
}

/** A file in the site's default drive, by its library path. */
export const graphFile = (cfg: SharePointConfig, filePath: string): string =>
  `${graphSite(cfg)}/drive/root:${encodeURI(
    filePath.startsWith('/') ? filePath : `/${filePath}`,
  )}:/content`;

/**
 * Resolve the workbook bytes. Prefers a manually-uploaded workbook, then falls
 * back to Graph. Returns an error result rather than throwing so the UI can
 * prompt for a manual upload.
 */
export async function fetchWorkbook(
  cfg: SharePointConfig,
): Promise<Result<ArrayBuffer, string>> {
  const manual = getManualWorkbook();
  if (manual) return ok(manual);

  if (!cfg.siteUrl || !cfg.filePath) {
    return err(
      'No workbook available: SharePoint not configured and no manual upload.',
    );
  }
  if (!cfg.token) {
    return err('Missing Graph access token (VITE_GRAPH_TOKEN).');
  }

  try {
    const res = await fetch(graphFile(cfg, cfg.filePath), {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) {
      return err(`Graph request failed: ${res.status} ${res.statusText}`);
    }
    return ok(await res.arrayBuffer());
  } catch (e) {
    return err(`Graph request error: ${e instanceof Error ? e.message : e}`);
  }
}
