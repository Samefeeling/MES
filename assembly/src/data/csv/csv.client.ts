/**
 * Fetches Epicor CSV exports as text: `Planning1.csv` (orders),
 * `JobMaterialReq.csv` (material demand and dependencies), and optional
 * `OnHandInventory.csv` (calculated on-hand quantity by part).
 *
 * Two paths each, in order: a plain URL (an export dropped on a share or
 * served by the task schedule), else the SharePoint document library through
 * the session or Microsoft Graph.
 *
 * The orders are required; the material links are not. A site that has not
 * exported them simply gets a board where every order stands on its own.
 */

import { ok, err, type Result } from '@/lib/result';
import { sessionFile } from '@/data/sharepoint/session';
import {
  graphFile,
  type SharePointConfig,
} from '@/data/sharepoint/site';

export interface CsvSourceConfig {
  /** Direct URL to the order export, if it is served over plain HTTP. */
  url: string;
  /** Path in the SharePoint drive, used when no URL is set. */
  filePath: string;
  /** Direct URL to the material-link export. */
  linksUrl?: string;
  /** Drive path for the material-link export; empty disables the fetch. */
  linksFilePath?: string;
  /** Direct URL to OnHandInventory.csv. */
  inventoryUrl?: string;
  /** SharePoint drive path for OnHandInventory.csv; empty disables the fetch. */
  inventoryFilePath?: string;
  /** Direct URL to product-lines.v3.json. */
  productLinesUrl?: string;
  /** Drive path for product-lines.v3.json; empty disables the fetch. It sits
   *  in the same folder as JobMaterialReq.csv. */
  productLinesFilePath?: string;
  /** Direct URL to PODetail.csv. */
  poDetailUrl?: string;
  /** Drive path for PODetail.csv; empty disables the fetch. It sits in the
   *  same folder as Planning1.csv. */
  poDetailFilePath?: string;
  /** Direct URL to the PMD dashboard's Planning.csv. */
  pressUrl?: string;
  /** Path of the PMD dashboard's Planning.csv — the press plan, one row per
   *  press order with its Machine and No of shift; empty disables the fetch. */
  pressFilePath?: string;
  /** Direct URL to the dispatch waybill export. */
  waybillUrl?: string;
  /** Drive path for `Waybill.csv`; it sits in the same folder as Planning1.csv. */
  waybillFilePath?: string;
  /** Direct URL to the cubics sheet. */
  cubicsUrl?: string;
  /** Drive path for `Cubics.csv` (Drews Cubics and Freight Calc as CSV), in the same folder. */
  cubicsFilePath?: string;
}

/** The folder a drive path is in, with its trailing slash. */
const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);

export function readCsvConfigFromEnv(): CsvSourceConfig {
  const env = import.meta.env;
  const filePath = env.VITE_ASSEMBLY_PLANNING_CSV_PATH ?? (env.VITE_BACKEND === 'sharepoint' ? '/Shared Documents/Planning1.csv' : env.VITE_PLANNING_CSV_PATH ?? '/Shared Documents/Planning1.csv');
  return {
    url: env.VITE_PLANNING_CSV_URL ?? '',
    filePath,
    poDetailUrl: env.VITE_PO_DETAIL_CSV_URL ?? '',
    waybillUrl: env.VITE_WAYBILL_CSV_URL ?? '',
    waybillFilePath: env.VITE_WAYBILL_CSV_PATH ?? `${folderOf(filePath) || '/Shared Documents/'}Waybill.csv`,
    cubicsUrl: env.VITE_CUBICS_CSV_URL ?? '',
    cubicsFilePath: env.VITE_CUBICS_CSV_PATH ?? `${folderOf(filePath) || '/Shared Documents/'}Cubics.csv`,
    poDetailFilePath: env.VITE_PO_DETAIL_CSV_PATH ?? `${folderOf(filePath) || '/Shared Documents/'}PODetail.csv`,
    linksUrl: env.VITE_JOB_MATERIAL_CSV_URL ?? '',
    linksFilePath:
      env.VITE_JOB_MATERIAL_CSV_PATH ?? '/Shared Documents/JobMaterialReq.csv',
    inventoryUrl: env.VITE_ON_HAND_INVENTORY_CSV_URL ?? '',
    inventoryFilePath:
      env.VITE_ON_HAND_INVENTORY_CSV_PATH ?? '/Shared Documents/OnHandInventory.csv',
    productLinesUrl: env.VITE_PRODUCT_LINES_URL ?? '',
    productLinesFilePath:
      env.VITE_PRODUCT_LINES_PATH ?? '/Shared Documents/product-lines.v3.json',
    pressUrl: env.VITE_PMD_PLANNING_CSV_URL ?? '',
    // The PMD dashboard's own file, by default from the setting it is read
    // with — both builds share one .env.local. Never Planning1.csv itself,
    // which a development build without the Assembly path falls back to.
    pressFilePath: (() => {
      const path = env.VITE_PMD_PLANNING_CSV_PATH ?? env.VITE_PLANNING_CSV_PATH ?? '';
      return path === filePath ? '' : path;
    })(),
  };
}

/** GET a file as text, naming it in any error so the banner is actionable. */
async function fetchText(
  label: string,
  url: string,
  token: string | null,
): Promise<Result<string, string>> {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      return err(`${label} fetch failed: ${res.status} ${res.statusText}`);
    }
    return ok(await res.text());
  } catch (e) {
    return err(
      `${label} fetch error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function fetchPlanningCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string, string>> {
  const viaGraph = !cfg.url;
  if (viaGraph && !sp.siteUrl) {
    return err(
      'No Planning1.csv available: set VITE_PLANNING_CSV_URL or configure SharePoint.',
    );
  }
  if (viaGraph && !sp.token && sp.authMode !== 'session') {
    return err('Missing Graph access token (VITE_GRAPH_TOKEN).');
  }

  const url = viaGraph ? (sp.authMode === 'session' ? sessionFile(sp, cfg.filePath) : graphFile(sp, cfg.filePath)) : cfg.url;
  return fetchText('Planning1.csv', url, viaGraph ? sp.token : null);
}

/**
 * The material-link export, or `ok(null)` when the site has not configured
 * one. Missing links are not an error — they only mean no order is held
 * behind another.
 */
export async function fetchJobMaterialCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.linksUrl) return fetchText('JobMaterialReq.csv', cfg.linksUrl, null);
  if (!cfg.linksFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);

  return fetchText(
    'JobMaterialReq.csv',
    sp.authMode === 'session' ? sessionFile(sp, cfg.linksFilePath) : graphFile(sp, cfg.linksFilePath),
    sp.token,
  );
}


/**
 * The reviewed routing table, or `ok(null)` when the site has not put one
 * beside the other exports. Optional in exactly the way the material links
 * are: without it every order is classified from its BOM instead, which is a
 * worse answer but never a failed load.
 */
export async function fetchProductLinesJson(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.productLinesUrl) return fetchText('product-lines.v3.json', cfg.productLinesUrl, null);
  if (!cfg.productLinesFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);

  return fetchText(
    'product-lines.v3.json',
    sp.authMode === 'session'
      ? sessionFile(sp, cfg.productLinesFilePath)
      : graphFile(sp, cfg.productLinesFilePath),
    sp.token,
  );
}

/** Optional on-hand export, read the same way as the other files. */
export async function fetchOnHandInventoryCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.inventoryUrl) return fetchText('OnHandInventory.csv', cfg.inventoryUrl, null);
  if (!cfg.inventoryFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);
  return fetchText(
    'OnHandInventory.csv',
    sp.authMode === 'session' ? sessionFile(sp, cfg.inventoryFilePath) : graphFile(sp, cfg.inventoryFilePath),
    sp.token,
  );
}

/**
 * Open purchase-order releases, or `ok(null)` when the site has not put the
 * export beside Planning1.csv. Optional: without it a short pick line simply
 * has no arrival date to show.
 */
export async function fetchPoDetailCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.poDetailUrl) return fetchText('PODetail.csv', cfg.poDetailUrl, null);
  if (!cfg.poDetailFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);
  return fetchText(
    'PODetail.csv',
    sp.authMode === 'session' ? sessionFile(sp, cfg.poDetailFilePath) : graphFile(sp, cfg.poDetailFilePath),
    sp.token,
  );
}

/**
 * The PMD press plan, or `ok(null)` when this build has no path for it.
 * Optional: without it the PMD lane is the press orders Planning1.csv carries,
 * on one line, as before.
 */
export async function fetchPressPlanningCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.pressUrl) return fetchText('Planning.csv', cfg.pressUrl, null);
  if (!cfg.pressFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);
  return fetchText(
    'Planning.csv',
    sp.authMode === 'session' ? sessionFile(sp, cfg.pressFilePath) : graphFile(sp, cfg.pressFilePath),
    sp.token,
  );
}

/** Is a scheduled waybill export configured, so dispatch can refresh on its own? */
export function hasWaybillSource(cfg: CsvSourceConfig, sp: SharePointConfig): boolean {
  if (cfg.waybillUrl) return true;
  return Boolean(cfg.waybillFilePath && sp.siteUrl && (sp.token || sp.authMode === 'session'));
}

/**
 * The dispatch waybill export, or `ok(null)` when none is configured. The
 * dispatch page also takes the file from disk, which needs no configuration.
 */
export async function fetchWaybillCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.waybillUrl) return fetchText('Waybill CSV', cfg.waybillUrl, null);
  if (!hasWaybillSource(cfg, sp)) return ok(null);
  return fetchText(
    'Waybill CSV',
    sp.authMode === 'session' ? sessionFile(sp, cfg.waybillFilePath!) : graphFile(sp, cfg.waybillFilePath!),
    sp.token,
  );
}

/**
 * The cubics sheet, or `ok(null)` when there is nowhere to read it from.
 * Optional: without it orders are sized from their freight CBM lines.
 */
export async function fetchCubicsCsv(
  cfg: CsvSourceConfig,
  sp: SharePointConfig,
): Promise<Result<string | null, string>> {
  if (cfg.cubicsUrl) return fetchText('Cubics.csv', cfg.cubicsUrl, null);
  if (!cfg.cubicsFilePath || !sp.siteUrl || (!sp.token && sp.authMode !== 'session')) return ok(null);
  return fetchText(
    'Cubics.csv',
    sp.authMode === 'session' ? sessionFile(sp, cfg.cubicsFilePath) : graphFile(sp, cfg.cubicsFilePath),
    sp.token,
  );
}
