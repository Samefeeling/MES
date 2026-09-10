/** Cookie-authenticated REST transport for an app hosted on the SharePoint site. */
import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import type { ListItem, ListItemFields } from './lists.write';

import { readableFields, writableFields, type ListField } from './fieldMap';

const digests = new Map<string, { value: string; expires: number }>();
export const literal = (value: string): string => encodeURIComponent(value.replace(/'/g, "''")).replace(/'/g, '%27');
export const restList = (cfg: SharePointConfig, list: string): string =>
  `${cfg.siteUrl.replace(/\/$/, '')}/_api/web/lists/getbytitle('${literal(list)}')`;

export function sessionFile(cfg: SharePointConfig, path: string): string {
  const site = new URL(cfg.siteUrl);
  const root = site.pathname.replace(/\/$/, '');
  const relative = path.startsWith(`${root}/`) ? path : `${root}/${path.replace(/^\//, '')}`;
  return `${cfg.siteUrl.replace(/\/$/, '')}/_api/web/GetFileByServerRelativePath(decodedurl='${literal(relative)}')/$value`;
}

export class SharePointHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function sessionRequest(cfg: SharePointConfig, url: string, init: RequestInit = {}): Promise<Response> {
  const origin = window.location.origin === 'null' ? new URL(document.baseURI).origin : window.location.origin;
  if (new URL(cfg.siteUrl).origin !== origin || new URL(url).origin !== origin) {
    throw new SharePointHttpError(403, 'Open Assembly from the configured SharePoint site to use your signed-in session.');
  }
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json;odata=minimalmetadata');
  if (init.method && init.method !== 'GET') {
    let digest = digests.get(cfg.siteUrl);
    if (!digest || digest.expires <= Date.now()) {
      const res = await fetch(`${cfg.siteUrl.replace(/\/$/, '')}/_api/contextinfo`, {
        method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json;odata=nometadata' },
      });
      if (!res.ok) throw new SharePointHttpError(res.status, `SharePoint sign-in/write permission required (${res.status}).`);
      const info = await res.json();
      digest = { value: info.FormDigestValue, expires: Date.now() + Math.max(0, info.FormDigestTimeoutSeconds - 30) * 1000 };
      if (!digest.value) throw new SharePointHttpError(401, 'SharePoint did not return a request digest.');
      digests.set(cfg.siteUrl, digest);
    }
    headers.set('X-RequestDigest', digest.value);
    headers.set('Content-Type', 'application/json;odata=nometadata');
  }
  const res = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 403) digests.delete(cfg.siteUrl);
    throw new SharePointHttpError(res.status, res.status === 412
      ? 'Another session changed this record. Reload the saved plan before editing again.'
      : `SharePoint request failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

const schemas = new Map<string, { expires: number; promise: Promise<ListField[]> }>();
export const clearSessionSchemaCache = (): void => { schemas.clear(); };

async function listFields(cfg: SharePointConfig, list: string): Promise<ListField[]> {
  const url = restList(cfg, list) + '/fields?$select=Title,InternalName,ReadOnlyField';
  const cached = schemas.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = sessionRequest(cfg, url).then(async res => {
    const body = await res.json();
    if (!Array.isArray(body.value)) throw new Error('SharePoint did not return a column schema.');
    return body.value as ListField[];
  }).catch(error => { schemas.delete(url); throw error; });
  schemas.set(url, { expires: Date.now() + 60000, promise });
  return promise;
}

export async function sessionRows(cfg: SharePointConfig, list: string): Promise<ListItem[]> {
  const schema = await listFields(cfg, list);
  let url = `${restList(cfg, list)}/items?$top=200`;
  const rows: ListItem[] = [];
  for (let page = 0; url && page < 100; page++) {
    const res = await sessionRequest(cfg, url);
    const body = await res.json();
    for (const row of body.value ?? []) {
      const fields: ListItemFields = { ...readableFields(row, schema), id: String(row.Id) };
      for (const [key, value] of Object.entries(fields)) {
        if (value && typeof value === 'object' && 'results' in value) fields[key] = value.results;
      }
      rows.push({ id: String(row.Id), fields, etag: row['odata.etag'] ?? row['@odata.etag'] });
    }
    url = body['odata.nextLink'] ?? body['@odata.nextLink'] ?? '';
  }
  if (url) throw new SharePointHttpError(400, 'SharePoint pagination limit reached; no partial dataset has been loaded.');
  return rows;
}

async function mapWrite(cfg: SharePointConfig, list: string, fields: ListItemFields): Promise<ListItemFields> {
  const schema = await listFields(cfg, list);
  try { return writableFields(fields, schema); } catch (error) {
    throw new SharePointHttpError(400, error instanceof Error ? error.message : String(error));
  }
}

export async function sessionCreate(cfg: SharePointConfig, list: string, fields: ListItemFields): Promise<string> {
  const mapped = await mapWrite(cfg, list, fields);
  const res = await sessionRequest(cfg, `${restList(cfg, list)}/items`, { method: 'POST', body: JSON.stringify(mapped) });
  const row = await res.json();
  if (!row.Id) throw new SharePointHttpError(500, 'SharePoint did not return the created item ID.');
  return String(row.Id);
}

export async function sessionUpdate(cfg: SharePointConfig, list: string, id: string, fields: ListItemFields, etag?: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new SharePointHttpError(400, 'Invalid SharePoint item ID.');
  const mapped = await mapWrite(cfg, list, fields);
  const url = `${restList(cfg, list)}/items(${id})`;
  // Callers with a loaded plan must supply its version, never overwrite it blindly.
  if (!etag) {
    const res = await sessionRequest(cfg, url);
    const row = await res.json();
    etag = res.headers.get('ETag') ?? row['odata.etag'] ?? row['@odata.etag'];
  }
  if (!etag) throw new SharePointHttpError(409, 'SharePoint did not return a record version.');
  await sessionRequest(cfg, url, { method: 'POST', headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': etag }, body: JSON.stringify(mapped) });
}
