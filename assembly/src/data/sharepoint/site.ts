/**
 * Where the SharePoint site is, and the Graph addresses of it and of a file in
 * its document library — shared by the CSV exports and the list sync.
 */

export interface SharePointConfig {
  /** e.g. https://contoso.sharepoint.com/sites/PMD */
  siteUrl: string;
  /** Path within the site's default drive, e.g. /Shared Documents/Planning1.csv */
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
