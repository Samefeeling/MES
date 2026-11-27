// SharePoint data layer — talking to the site: the form digest, reads that
// page and share a request, writes, and what to do when the site refuses a
// column. Everything above this asks through here.
import {
  type SharePointFieldMap,
  type SharePointOptions,
  mergeFieldMap,
  DEFAULT_FIELDS,
  LISTS,
} from './schema';
import type { UserContext } from '../../types';
import {
  fetchThroughThrottle,
  toServerRelativePath,
  type RollbackAction,
  runRollback,
} from './http';
import { dateOnly, responseItemId, sharePointItemId } from './values';

/**
 * The bottom of the data layer. The classes above it each add one concern —
 * reference lists, maintenance, planning, reading production, writing the
 * record — and `SharePointDataLayer` (data-layer.ts) is the one the app makes.
 * They are one object: a layer calls down through `this`, never up.
 */
export class SharePointRest {
  protected digest: { value: string; expires: number } | null = null;

  protected readonly siteUrl: string;

  protected readonly planningCsvPath?: string;

  protected readonly mangoCsvPath?: string;

  protected readonly machinePmCsvPath?: string;

  protected readonly canWriteHook: () => boolean;

  protected readonly F: SharePointFieldMap;

  /**
   * Cache of `ListItemEntityTypeFullName` per list title. Encoding a list
   * title to that string by hand (`SP.Data.${encoded}ListItem`) is unreliable
   * — when a list has been renamed since creation, the entity type still
   * reflects the original title and SP rejects POSTs with "type … could not
   * be resolved by the model". One round-trip to read it cures that.
   */
  protected entityTypeCache = new Map<string, string>();

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.planningCsvPath = o.planningCsvPath;
    this.mangoCsvPath = o.mangoCsvPath;
    this.machinePmCsvPath = o.machinePmCsvPath;
    this.canWriteHook = o.canWrite ?? ((): boolean => true);
    // Merge user overrides into the defaults.
    this.F = mergeFieldMap(DEFAULT_FIELDS, o.fieldMap);
  }

  // ---- low-level helpers ----------------------------------------------

  protected listUrl(title: string): string {
    return `${this.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(title)}')`;
  }

  protected async getDigest(): Promise<string> {
    if (this.digest && this.digest.expires > Date.now() + 5_000) return this.digest.value;
    const res = await fetchThroughThrottle(`${this.siteUrl}/_api/contextinfo`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose' },
    });
    if (!res.ok) throw new Error(`Digest failed: ${res.status}`);
    const j = (await res.json()) as {
      d: { GetContextWebInformation: { FormDigestValue: string; FormDigestTimeoutSeconds: number } };
    };
    const info = j.d.GetContextWebInformation;
    this.digest = {
      value: info.FormDigestValue,
      expires: Date.now() + (info.FormDigestTimeoutSeconds - 300) * 1000,
    };
    return this.digest.value;
  }

  protected async getJson<T>(url: string): Promise<T> {
    const res = await fetchThroughThrottle(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose' },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return (await res.json()) as T;
  }

  protected getAllItems<T = Record<string, unknown>>(list: string, qs = ''): Promise<T[]> {
    const first = `${this.listUrl(list)}/items?$top=5000${qs ? '&' + qs : ''}`;
    return this.shareRead(first, async () => {
      const out: T[] = [];
      let url = first;
      while (url) {
        const env = await this.getJson<{ d: { results: T[]; __next?: string } }>(url);
        out.push(...env.d.results);
        url = env.d.__next ?? '';
      }
      return out;
    }).then((rows) => rows.slice());
  }

  /** Lists that refused a read naming its columns, this session. */
  protected columnsRefused = new Set<string>();

  /**
   * getAllItems, asking SharePoint for these columns only.
   *
   * Asked for everything, each row comes back with every column of the list
   * and a dozen links to things nobody follows — several times the size of
   * what a history read uses, on reads of thousands of rows. `columns` is
   * every column the caller's field map names, so anything read through the
   * map is there; `Id` is always asked for.
   *
   * A tenant whose list lacks one of them answers 400. The read is then made
   * again the old way, for every column, and the list is read that way for
   * the rest of the session: slower, never wrong.
   */
  protected getColumnItems<T = Record<string, unknown>>(
    list: string,
    columns: readonly string[],
    qs = '',
  ): Promise<T[]> {
    if (this.columnsRefused.has(list)) return this.getAllItems<T>(list, qs);
    const select = `$select=${[...new Set(['Id', ...columns.filter(Boolean)])].join(',')}`;
    return this.getAllItems<T>(list, qs ? `${select}&${qs}` : select).catch((e) => {
      if (!/→ 400$/.test((e as Error).message || '')) throw e;
      this.columnsRefused.add(list);
      console.warn(
        `[pmd] ${list}: SharePoint refused a read naming its columns — one of them is not on the list. Reading every column instead (slower). Columns asked for: ${columns.filter(Boolean).join(', ')}`,
      );
      return this.getAllItems<T>(list, qs);
    });
  }

  /** Reads on the wire, by URL. Two callers asking for the same thing at
   *  once (the roster and its supervisors; the Die and Machine halves of
   *  the Mango report) share one request. A read only joins one that
   *  started after the last write, so nothing reads back stale data, and
   *  each is dropped once it settles: this is not a cache. */
  protected readsInFlight = new Map<string, { writes: number; read: Promise<unknown> }>();

  protected writesStarted = 0;

  protected shareRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.readsInFlight.get(key);
    if (hit && hit.writes === this.writesStarted) return hit.read as Promise<T>;
    const entry = { writes: this.writesStarted, read: read() };
    const settled = (): void => {
      if (this.readsInFlight.get(key) === entry) this.readsInFlight.delete(key);
    };
    entry.read.then(settled, settled);
    this.readsInFlight.set(key, entry);
    return entry.read as Promise<T>;
  }

  protected async post(url: string, body: unknown, ifMatch?: string): Promise<Response> {
    this.writesStarted++;
    const digest = await this.getDigest();
    const res = await fetchThroughThrottle(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json;odata=verbose',
        'Content-Type': 'application/json;odata=verbose',
        'X-RequestDigest': digest,
        ...(ifMatch ? { 'IF-MATCH': ifMatch, 'X-HTTP-Method': 'MERGE' } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = await res.text();
      // Try to surface SharePoint's actual "this column doesn't exist" /
      // "wrong type" message — the verbose envelope is hard to read raw.
      let msg = respBody;
      try {
        const j = JSON.parse(respBody) as {
          error?: { message?: string | { value?: string }; code?: string };
        };
        const m = j.error?.message;
        if (typeof m === 'string') msg = m;
        else if (m && typeof m.value === 'string') msg = m.value;
        if (j.error?.code) msg = `${msg} [${j.error.code}]`;
      } catch {
        /* not JSON, keep raw body */
      }
      // Dump everything to console — request body included — so a 400 tells
      // us which field's value/type SP didn't like, not just the message.
      console.error('[sp] POST failed', {
        url,
        status: res.status,
        sent: body,
        sentTypes: Object.fromEntries(
          Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, typeof v]),
        ),
        respBody,
      });
      throw new Error(`POST ${res.status} ${msg}`);
    }
    return res;
  }

  protected async del(url: string): Promise<void> {
    this.writesStarted++;
    const digest = await this.getDigest();
    const res = await fetchThroughThrottle(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-RequestDigest': digest, 'IF-MATCH': '*', 'X-HTTP-Method': 'DELETE' },
    });
    if (!res.ok) throw new Error(`DELETE ${url} → ${res.status}`);
  }

  /**
   * Look up the real ListItemEntityTypeFullName from SP and cache it. Cheap
   * (one extra GET on the first POST per list per page load) and resilient
   * to list renames / unusual title characters.
   */
  protected async itemType(list: string): Promise<string> {
    const cached = this.entityTypeCache.get(list);
    if (cached) return cached;
    try {
      const res = await this.getJson<{ d: { ListItemEntityTypeFullName: string } }>(
        `${this.listUrl(list)}?$select=ListItemEntityTypeFullName`,
      );
      const name = res.d?.ListItemEntityTypeFullName;
      if (name) {
        this.entityTypeCache.set(list, name);
        return name;
      }
    } catch {
      /* fall through to the encoded guess */
    }
    // Fallback: encode underscores/non-alphanumerics ourselves. Works for
    // lists whose title hasn't drifted from creation.
    const safe = list.replace(/[^A-Za-z0-9]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);
    const guess = `SP.Data.${safe}ListItem`;
    this.entityTypeCache.set(list, guess);
    return guess;
  }

  /** Fetch a doc-library file's raw text. Accepts a full https://… URL
   *  or a server-relative path with or without percent-encoded spaces —
   *  normalise once, encode per segment so '/' separators survive,
   *  double single quotes for OData. Cache-busts per request so OneDrive
   *  uploads show up immediately. */
  protected fetchSiteFile(rawPath: string, what: string): Promise<string> {
    return this.shareRead(`file:${rawPath}`, () => this.readSiteFile(rawPath, what));
  }

  /** A doc-library file's TimeLastModified (ISO), path as fetchSiteFile
   *  takes it — a few bytes, to tell whether the file changed. */
  protected async siteFileModified(rawPath: string): Promise<string | null> {
    const encodedPath = toServerRelativePath(rawPath)
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
      .replace(/'/g, "''");
    const res = await this.getJson<{ d: { TimeLastModified?: string } }>(
      `${this.siteUrl}/_api/web/getFileByServerRelativeUrl('${encodedPath}')?$select=TimeLastModified&_t=${Date.now()}`,
    );
    return res.d?.TimeLastModified || null;
  }

  protected async readSiteFile(rawPath: string, what: string): Promise<string> {
    const serverRelative = toServerRelativePath(rawPath);
    const encodedPath = serverRelative
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
      .replace(/'/g, "''");
    const url = `${this.siteUrl}/_api/web/getFileByServerRelativeUrl('${encodedPath}')/$value?_t=${Date.now()}`;
    const res = await fetchThroughThrottle(url, {
      credentials: 'include',
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!res.ok) {
      throw new Error(`${what} fetch failed (${res.status}) for ${serverRelative}`);
    }
    return res.text();
  }

  /** Per-list cache of column internal names that SP has already
   *  rejected with "property X does not exist". upsertHeaderInto strips
   *  these before posting so a missing column on the broker list
   *  doesn't doom every snapshot. */
  protected rejectedFields = new Map<string, Set<string>>();

  /**
   * Values a sign-off had and PMD_Production would not take, since the last
   * takeWriteWarnings(). The row is still written without them — losing the
   * whole shift over one column would be worse — but that used to be said
   * only in the console, so a shift's Quality Check sign-offs or handover
   * note could vanish behind a "Signed off" toast. The sheet now reads
   * these back and shows them to whoever signed.
   */
  protected writeWarnings: string[] = [];

  /** `list|field` → why its value is refused, for a column banned from
   *  later writes: every sign-off that drops it says so, not only the first. */
  protected lostReasons = new Map<string, string>();

  protected noteLostValue(list: string, field: string, why: string): void {
    // The live mirror repeats every minute and is not the record.
    if (list !== LISTS.production) return;
    const line = `${field} — ${why}`;
    if (!this.writeWarnings.includes(line)) this.writeWarnings.push(line);
  }

  takeWriteWarnings(): string[] {
    const out = this.writeWarnings;
    this.writeWarnings = [];
    return out;
  }

  /** Fields that are denormalised conveniences or backwards-compatible
   *  extensions. These may be omitted on an older tenant without changing
   *  the tuple's identity or its authoritative counts. Core key/count fields
   *  are intentionally absent: silently dropping one of those would turn a
   *  successful-looking sign-off into corrupted production data. */
  protected isFailSoftHeaderField(list: string, field: string): boolean {
    if (list !== LISTS.production && list !== LISTS.liveStatus) return false;
    const F = this.F.production;
    return new Set<string>([
      F.machineCodeAlt,
      F.timeline,
      F.partNum,
      F.partDesc,
      F.jobRequired,
      F.cycleTime,
      F.shiftTarget,
      F.vsPlan,
      F.scheduleAttain,
      F.schedulePlan,
      F.cavities,
      F.runTime,
      F.downTime,
      F.handover,
      F.totalGood,
      F.qcChecks,
      F.rejectsBySlot,
      F.ownerDevice,
      F.signOff,
      F.jobLeft,
      F.reopened,
      F.plannedStart,
      F.batchJobs,
    ].filter(Boolean)).has(field);
  }

  protected stripRejectedFields(list: string, body: Record<string, unknown>): void {
    const banned = this.rejectedFields.get(list);
    if (!banned) return;
    for (const k of banned) {
      if (!this.isFailSoftHeaderField(list, k)) continue;
      const why = this.lostReasons.get(`${list}|${k}`);
      if (why && k in body) this.noteLostValue(list, k, why);
      delete body[k];
    }
  }

  /** POST that retries on two SP errors we can recover from:
   *   - 400 "property X does not exist" — column missing on tenant; remember
   *     it so future writes to this list skip it.
   *   - 500 "Invalid text value. A text field contains invalid data." — SP
   *     doesn't say WHICH column. Bisect by retrying without each text
   *     field one at a time so the next sign-off doesn't see the same
   *     blocking failure, and log the offender so the operator can clean
   *     up the source value (usually a stray paste into a handover note).
   *     The retry without the offender lets the rest of the row land.
   */
  protected async postWithFieldRetry(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch?: string,
  ): Promise<void> {
    // Iterative, NOT single-shot: one sign-off body can carry SEVERAL broken
    // fields at once (reported on 550T: a missing Cavities column AND a
    // mistyped Reopened column in the same POST). The old code stripped one
    // offender then bare-posted — the second error escaped and failed the
    // whole sign-off. Loop instead, handling one offender per pass; the bound
    // is the theoretical max of strippable fields, and any non-recoverable
    // error still throws immediately.
    const work = { ...body };
    // Strip a missing-property offender named in an SP error message.
    // Returns true when a field was stripped (caller loops for another pass).
    const stripMissing = (msg: string): boolean => {
      const missing = /property\s+'?([A-Za-z0-9_]+)'?\s+does not exist/i.exec(msg);
      if (!missing || !(missing[1] in work)) return false;
      const field = missing[1];
      if (!this.isFailSoftHeaderField(list, field)) return false;
      const banned = this.rejectedFields.get(list) ?? new Set<string>();
      banned.add(field);
      this.rejectedFields.set(list, banned);
      console.warn(
        '[pmd] SP rejected column',
        field,
        'on',
        list,
        '— stripping it from future writes. Add the column in SharePoint to persist this value.',
      );
      delete work[field];
      return true;
    };
    const maxPasses = Object.keys(work).length;
    for (let pass = 0; pass < maxPasses; pass++) {
      try {
        await this.post(url, work, ifMatch);
        return;
      } catch (e) {
        const msg = (e as Error).message || '';
        if (stripMissing(msg)) continue;
        try {
          if (/Invalid text value/i.test(msg)) {
            // The bisect posts the winning trial itself — on success the row
            // has already landed, so return rather than posting again (a
            // second POST on the create path would make a duplicate row).
            const culprit = await this.findInvalidTextField(list, url, work, ifMatch);
            if (culprit) return;
          }
          // 400 "Cannot convert a primitive value to the expected type
          // 'Edm.String'" — a boolean/number written to a column SharePoint
          // has typed as text (e.g. a Reopened column created as Single line
          // of text / Choice instead of Yes/No). Same bisect-and-land pattern.
          if (/convert a primitive value to the expected type/i.test(msg)) {
            const culprit = await this.findMistypedPrimitiveField(list, url, work, ifMatch);
            if (culprit !== null) return;
          }
        } catch (inner) {
          // A bisect trial hit a DIFFERENT error class. If it named a missing
          // property, strip it and take another pass (one body can carry a
          // missing column AND a mistyped column at once — the 550T case);
          // anything else is non-recoverable.
          if (stripMissing((inner as Error).message || '')) continue;
          throw inner;
        }
        throw e;
      }
    }
    throw new Error(`${list}: POST kept failing after stripping every strippable field`);
  }

  /** Bisect the boolean/number fields to find the one whose SharePoint column
   *  is typed as text (Edm.String) — usually a Yes/No column accidentally
   *  provisioned as Single line of text / Choice. Bans it (future writes skip
   *  it) and posts the row without it so the sign-off lands. Booleans first —
   *  they're the newest, rarest columns (Reopened) and the most likely victim
   *  of a wrong type pick; numeric columns have been written for ages. Returns
   *  the offender, or null if removing none helps (caller re-throws). */
  protected async findMistypedPrimitiveField(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch: string | undefined,
  ): Promise<string | null> {
    const keys = Object.keys(body)
      .filter(
        (k) =>
          k !== '__metadata' &&
          this.isFailSoftHeaderField(list, k) &&
          (typeof body[k] === 'boolean' || typeof body[k] === 'number'),
      )
      .sort((a, b) => Number(typeof body[b] === 'boolean') - Number(typeof body[a] === 'boolean'));
    for (const k of keys) {
      const trial = { ...body };
      delete trial[k];
      try {
        await this.post(url, trial, ifMatch);
        const banned = this.rejectedFields.get(list) ?? new Set<string>();
        banned.add(k);
        this.rejectedFields.set(list, banned);
        console.warn(
          `[pmd] SP rejected a ${typeof body[k]} written to column '${k}' on ${list} — that column is typed as text, not ${typeof body[k] === 'boolean' ? 'Yes/No' : 'Number'}. Fix the '${k}' column type in SharePoint. Posted the row without it so the sign-off lands.`,
        );
        const why = `the column is typed as text, not ${typeof body[k] === 'boolean' ? 'Yes/No' : 'Number'}`;
        this.lostReasons.set(`${list}|${k}`, why);
        this.noteLostValue(list, k, why);
        return k;
      } catch (e) {
        if (!/convert a primitive value to the expected type/i.test((e as Error).message || '')) throw e;
      }
    }
    return null;
  }

  /** Bisect the string-valued fields of a SP body to find the one that
   *  triggers "Invalid text value". Returns the offending field name and
   *  leaves the row written (minus that field) on success — or null if
   *  removing none of them helps (in which case the caller re-throws the
   *  original error). Stops as soon as one removal succeeds. Order:
   *  longest values first, since the most common cause is a JSON payload
   *  (QualityChecks, RejectsBySlot) overflowing a column that was
   *  accidentally provisioned as Single line text (255-char limit). */
  protected async findInvalidTextField(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch: string | undefined,
  ): Promise<string | null> {
    const textKeys = Object.keys(body)
      .filter(
        (k) =>
          k !== '__metadata' &&
          this.isFailSoftHeaderField(list, k) &&
          typeof body[k] === 'string' &&
          (body[k] as string).length > 0,
      )
      .sort((a, b) => (body[b] as string).length - (body[a] as string).length);
    for (const k of textKeys) {
      const trial = { ...body };
      delete trial[k];
      try {
        await this.post(url, trial, ifMatch);
        const val = body[k] as string;
        const lengthHint =
          val.length > 255
            ? ` — value is ${val.length} chars, which exceeds SharePoint's Single line text 255-char limit. Change the '${k}' column to "Multiple lines of text" in SharePoint to persist this.`
            : ` — value contains a character SharePoint refuses (control char / line separator). Clear and retype this field.`;
        console.warn(
          `[pmd] SP rejected text value in column '${k}' on ${list}${lengthHint} Posted the row without it so the rest of the sign-off lands. value=${JSON.stringify(val)}`,
        );
        this.noteLostValue(
          list,
          k,
          val.length > 255
            ? `its ${val.length} characters do not fit: the column must be "Multiple lines of text"`
            : 'it holds a character SharePoint refuses: clear the field and type it again',
        );
        return k;
      } catch (e) {
        if (!/Invalid text value/i.test((e as Error).message || '')) throw e;
      }
    }
    return null;
  }

  /**
   * Replace a tuple's child rows without the old delete-first data-loss
   * window. New rows are fully inserted before any old row is removed.
   * The returned compensating action restores the original snapshot, which
   * lets lockShift emulate an atomic multi-list sign-off around SharePoint's
   * otherwise independent REST writes.
   */
  protected async replaceRowsWithRollback(
    list: string,
    filterClause: string,
    exactDate: { field: string; date: string },
    bodies: Record<string, unknown>[],
    restoreFields: string[],
  ): Promise<RollbackAction> {
    const readExactRows = async (): Promise<Record<string, unknown>[]> => {
      const rows = await this.getAllItems<Record<string, unknown>>(
        list,
        '$filter=' + encodeURIComponent(filterClause),
      );
      return rows.filter((r) => dateOnly(r[exactDate.field]) === exactDate.date);
    };
    const oldRows = await readExactRows();
    const oldIds = new Set(oldRows.map(sharePointItemId).filter((id): id is number => id != null));
    const createdIds: number[] = [];
    const deletedOldRows: Record<string, unknown>[] = [];
    const type = await this.itemType(list);
    const itemsUrl = `${this.listUrl(list)}/items`;

    const createAndRemember = async (body: Record<string, unknown>): Promise<void> => {
      const response = await this.post(itemsUrl, { __metadata: { type }, ...body });
      let id = await responseItemId(response);
      // Verbose OData normally returns d.ID. Some SharePoint proxies strip
      // the response body; in that case re-read the tuple and identify the
      // newly-created ID so rollback remains possible.
      if (id == null) {
        const known = new Set([...oldIds, ...createdIds]);
        const candidates = (await readExactRows())
          .map(sharePointItemId)
          .filter((candidate): candidate is number => candidate != null && !known.has(candidate))
          .sort((a, b) => b - a);
        id = candidates[0];
      }
      if (id == null) {
        throw new Error(`${list}: create succeeded but SharePoint returned no item ID for rollback`);
      }
      createdIds.push(id);
    };

    const restore = async (rows: Record<string, unknown>[]): Promise<void> => {
      const failures: string[] = [];
      for (const row of rows) {
        const body: Record<string, unknown> = { __metadata: { type } };
        for (const field of restoreFields) {
          if (field && Object.prototype.hasOwnProperty.call(row, field)) body[field] = row[field];
        }
        try {
          await this.post(itemsUrl, body);
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
      if (failures.length) throw new Error(failures.join('; '));
    };

    const compensate = async (rowsToRestore: Record<string, unknown>[]): Promise<void> => {
      const failures: string[] = [];
      for (const id of createdIds) {
        try {
          await this.del(`${itemsUrl}(${id})`);
        } catch (e) {
          failures.push(`delete new ${id}: ${(e as Error).message}`);
        }
      }
      try {
        await restore(rowsToRestore);
      } catch (e) {
        failures.push(`restore old rows: ${(e as Error).message}`);
      }
      if (failures.length) throw new Error(failures.join('; '));
    };

    try {
      for (const body of bodies) await createAndRemember(body);
      for (const row of oldRows) {
        const id = sharePointItemId(row);
        if (id == null) throw new Error(`${list}: existing row has no item ID`);
        await this.del(`${itemsUrl}(${id})`);
        deletedOldRows.push(row);
      }
    } catch (e) {
      const rollbackError = await runRollback(() => compensate(deletedOldRows));
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : '';
      throw new Error(`${(e as Error).message}${suffix}`);
    }

    return async (): Promise<void> => compensate(oldRows);
  }

  /**
   * Delete every item matching a pre-built OData $filter clause.
   * `exactDate` narrows the (intentionally loose, ±1d) date-window
   * clause to rows on one exact calendar date — without it, deletes
   * scoped by shiftDateRange also hit the same shift code on adjacent
   * days (e.g. unlocking 10 June Day would wipe 9 June Day for the
   * same job). The compare runs through dateOnly so all three legacy
   * timestamp formats (midnight-UTC, noon-UTC, local-start) resolve
   * to their intended calendar date first.
   */
  protected async deleteByFilter(
    list: string,
    filterClause: string,
    exactDate?: { field: string; date: string },
  ): Promise<void> {
    const rows = await this.getAllItems<Record<string, unknown>>(
      list,
      '$filter=' + encodeURIComponent(filterClause),
    );
    const targets = exactDate
      ? rows.filter((r) => dateOnly(r[exactDate.field]) === exactDate.date)
      : rows;
    for (const r of targets) {
      const id = (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
      await this.del(`${this.listUrl(list)}/items(${id})`);
    }
  }

  async whoAmI(): Promise<UserContext> {
    const res = await this.getJson<{
      d: { Title: string; Email: string; LoginName: string };
    }>(`${this.siteUrl}/_api/web/currentUser`);
    return {
      name: res.d.Title || res.d.Email || res.d.LoginName,
      role: 'operator',
      email: res.d.Email || '',
    };
  }

  // ---- diagnostics ---------------------------------------------------

  /**
   * Print the internal field names of every PMD list to console. Run this
   * once in the browser console (`dal.diagnoseFields()`) to verify the
   * FIELD_MAP guesses match your tenant; copy any mismatches into a
   * `fieldMap` override at construction time.
   */
  async diagnoseFields(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const title of Object.values(LISTS)) {
      try {
        const res = await this.getJson<{
          d: { results: { Title: string; InternalName: string; Hidden: boolean }[] };
        }>(
          `${this.listUrl(title)}/fields?$filter=Hidden eq false&$select=Title,InternalName,Hidden`,
        );
        out[title] = res.d.results.map((f) => `${f.InternalName} (${f.Title})`);
      } catch (e) {
        out[title] = [`<error: ${(e as Error).message}>`];
      }
    }
    // eslint-disable-next-line no-console
    console.table(out);
    return out;
  }
}
