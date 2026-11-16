// SharePoint data layer — dies and presses as assets: the die register, die
// changes, maintenance requests and PM, and the machine master.
import { type MachineMasterField, LISTS, MACHINE_MASTER_FIELDS } from './schema';
import type {
  DieMaster,
  DieChangeLog,
  DieMaintenanceRequest,
  MachineMaster,
  MachinePmEvent,
} from '../../types';
import { fetchThroughThrottle } from './http';
import {
  odataString,
  dateOnly,
  str,
  getId,
  num,
  bool,
  nullOrNum,
  multiChoice,
  parseDieComponentsJson,
  numOrNull,
  responseItemId,
  isoDate,
  looseNum,
  spDay,
  machineCell,
} from './values';
import { machineKey } from '../../core/maint';
import {
  parseToolStatus,
  TOOL_STATUS_META,
  type DieComponent,
  type ListFieldInfo,
  dieComponentsFromFields,
  DIE_COMPONENTS,
  dieChangeEventKey,
  parseDieCondition,
  parseDieSignOffStatus,
  dieSignOffStatus,
  DIE_CONDITION_META,
} from '../../core/die';
import {
  parseMangoWorkOrdersCsv,
  normaliseMaintStatus,
  normaliseMaintType,
  normaliseMaintPriority,
  parseMangoMachineWorkOrdersCsv,
  parseMachinePmCsv,
} from './mango';
import { SharePointReference } from './reference';

export class SharePointMaintenance extends SharePointReference {
  protected dieMasterCache: DieMaster[] | null = null;

  /** Resolved PMD_DieMaster internal names + item id per die number,
   *  captured by listDieMaster so updateDieMaster can write directly. */
  protected dieMasterMeta: {
    keys: Record<string, string>;
    idByDie: Map<string, number>;
    maintenanceLevelExists: boolean;
    notesExists: boolean;
    changeOverMedianExists: boolean;
  } | null = null;

  /** PMD_Machine's maintenance columns, resolved on the first read: the
   *  internal name and type of each, and the item id of every machine. */
  protected machineMasterMeta: {
    keys: Record<MachineMasterField, string>;
    types: Partial<Record<MachineMasterField, string>>;
    /** Number column formatted as a percentage: stores 0.987 for 98.7 %. */
    availableAsFraction: boolean;
    idByCode: Map<string, number>;
  } | null = null;

  protected dieMasterMaintenanceLevelReady: Promise<void> | null = null;

  protected dieMasterNotesReady: Promise<void> | null = null;

  protected dieMasterChangeOverMedianReady: Promise<void> | null = null;

  // ---- die master (PMD_DieMaster) -------------------------------------

  async listDieMaster(): Promise<DieMaster[]> {
    // Same cache policy as PMD_ProductDieColor: small, hand-maintained,
    // read-only at runtime — a hard reload picks up toolroom edits.
    if (this.dieMasterCache) return this.dieMasterCache;
    const F = this.F.dieMaster;
    try {
      // The list was created by hand in the modern UI, where a column's
      // INTERNAL name routinely diverges from the header you see (a
      // renamed Title column, field_2 from grid-view adds, Name0 after a
      // collision…). Guessing display names against row keys is what made
      // every Status render "—" — so resolve deterministically instead:
      // pull the list's field map (display Title → InternalName) and look
      // each configured name up. Exact InternalName match wins; display-
      // Title match (case/space-insensitive) second; configured name last.
      const fieldsEnv = await this.getJson<{
        d: { results: Array<{ Title: string; InternalName: string }> };
      }>(
        `${this.listUrl(LISTS.dieMaster)}/fields?$filter=Hidden eq false&$select=Title,InternalName`,
      );
      const fields = fieldsEnv.d.results;
      const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const internals = new Set(fields.map((f) => f.InternalName));
      const byTitle = new Map<string, string>();
      for (const f of fields) {
        const key = normName(f.Title);
        if (!byTitle.has(key)) byTitle.set(key, f.InternalName);
      }
      const resolve = (configured: string): string =>
        internals.has(configured) ? configured : byTitle.get(normName(configured)) ?? configured;
      const K = {
        dieNumber: resolve(F.dieNumber),
        description: resolve(F.description),
        cavities: resolve(F.cavities),
        cycleTime: resolve(F.cycleTime),
        dieWeightKg: resolve(F.dieWeightKg),
        leanReady: resolve(F.leanReady),
        toolInjectorPlate: resolve(F.toolInjectorPlate),
        changeOverIn: resolve(F.changeOverIn),
        changeOverOut: resolve(F.changeOverOut),
        changeOverMedian: resolve(F.changeOverMedian),
        lifeCycle: resolve(F.lifeCycle),
        dateStamp: resolve(F.dateStamp),
        lastServiceDate: resolve(F.lastServiceDate),
        availableDate: resolve(F.availableDate),
        toolStatus: resolve(F.toolStatus),
        maintenanceLevel: resolve(F.maintenanceLevel),
        notes: resolve(F.notes),
      };
      console.info('[pmd] PMD_DieMaster field resolution:', K);
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieMaster);
      if (rows.length === 0) {
        this.dieMasterCache = [];
        return this.dieMasterCache;
      }
      // DieNumber additionally falls back to Title when the resolved
      // column is empty on every row (list made by renaming Title but a
      // separate DieNumber column also exists, unfilled).
      const dieKey = rows.some((r) => str(r[K.dieNumber]).trim()) ? K.dieNumber : 'Title';
      // Remember resolved keys + item ids so updateDieMaster can write
      // without re-resolving (idByDie keyed by normalised die number).
      this.dieMasterMeta = {
        keys: K,
        idByDie: new Map(
          rows
            .map((r) => [str(r[dieKey]).trim().toUpperCase(), getId(r)] as const)
            .filter(([die, id]) => die && id > 0),
        ),
        maintenanceLevelExists:
          internals.has(F.maintenanceLevel) || byTitle.has(normName(F.maintenanceLevel)),
        notesExists: internals.has(F.notes) || byTitle.has(normName(F.notes)),
        changeOverMedianExists:
          internals.has(F.changeOverMedian) || byTitle.has(normName(F.changeOverMedian)),
      };
      const out = rows
        .map((r) => ({
          dieNumber: str(r[dieKey]).trim(),
          description: str(r[K.description]).trim(),
          cavities: nullOrNum(r[K.cavities]),
          cycleTime: nullOrNum(r[K.cycleTime]),
          dieWeightKg: nullOrNum(r[K.dieWeightKg]),
          leanReady: bool(r[K.leanReady]) ?? null,
          toolInjectorPlate: str(r[K.toolInjectorPlate]).trim(),
          changeOverIn: nullOrNum(r[K.changeOverIn]),
          changeOverOut: nullOrNum(r[K.changeOverOut]),
          changeOverMedian: nullOrNum(r[K.changeOverMedian]),
          lifeCycle: nullOrNum(r[K.lifeCycle]),
          dateStamp: str(r[K.dateStamp]),
          lastServiceDate: str(r[K.lastServiceDate]),
          availableDate: str(r[K.availableDate]),
          toolStatus: parseToolStatus(str(r[K.toolStatus])),
          maintenanceLevel: str(r[K.maintenanceLevel]),
          notes: str(r[K.notes]),
        }))
        .filter((m) => m.dieNumber);
      const withStatus = out.filter((m) => m.toolStatus).length;
      console.info(
        '[pmd] PMD_DieMaster cached:', out.length, 'of', rows.length, 'rows ·',
        withStatus, 'carry a recognised ToolStatus',
      );
      if (out.length > 0 && withStatus === 0) {
        console.warn(
          '[pmd] PMD_DieMaster: no row has a recognised ToolStatus — check the resolved key',
          K.toolStatus, 'and the cell values. Keys on row[0]:', Object.keys(rows[0]),
        );
      }
      this.dieMasterCache = out;
      return this.dieMasterCache;
    } catch (e) {
      // List unreachable — the Status column just shows "—". Not cached
      // so the next call retries. The classic trap: creating the list in
      // the Lists app saves it under "My lists" (the user's PERSONAL
      // space) unless a site is picked — this site's REST then 404s even
      // though the list looks fine to its owner.
      console.warn(
        `[pmd] PMD_DieMaster unreachable on ${this.siteUrl} — ToolStatus column disabled.`,
        `If the list shows under "My lists" in the Lists app, it lives in the owner's personal`,
        `space: recreate it on this site (Site contents → New → List → From existing list).`,
        e,
      );
      throw e;
    }
  }

  /** MaintenanceLevel was introduced after the hand-built DieMaster
   *  list. Create the multi-line text field on the first Supervisor save
   *  so existing deployments upgrade in place; if Manage Lists is blocked,
   *  surface an actionable error instead of pretending the plan stuck. */
  protected async ensureDieMasterMaintenanceLevelField(): Promise<void> {
    if (this.dieMasterMeta?.maintenanceLevelExists) return;
    if (this.dieMasterMaintenanceLevelReady) return this.dieMasterMaintenanceLevelReady;
    this.dieMasterMaintenanceLevelReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.maintenanceLevel;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 3, // Note (multi-line text): one PM level per line
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a multi-line text '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.maintenanceLevel = internal;
      meta.maintenanceLevelExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterMaintenanceLevelReady = null;
      throw e;
    });
    return this.dieMasterMaintenanceLevelReady;
  }

  /** Notes (the SOC change log) is also newer than the hand-built list.
   *  Create the multi-line text column on the first note save so existing
   *  deployments upgrade in place — same self-provisioning pattern as
   *  MaintenanceLevel above. */
  protected async ensureDieMasterNotesField(): Promise<void> {
    if (this.dieMasterMeta?.notesExists) return;
    if (this.dieMasterNotesReady) return this.dieMasterNotesReady;
    this.dieMasterNotesReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.notes;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 3, // Note (multi-line text): one SOC note per line
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a multi-line text '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.notes = internal;
      meta.notesExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterNotesReady = null;
      throw e;
    });
    return this.dieMasterNotesReady;
  }

  /** Provision PMD_DieMaster.ChangeOverMedian (Number) on first import.
   *  Same shape as the MaintenanceLevel / Notes provisioning: the column
   *  is new, and a tenant shouldn't have to hand-create it before the KPI
   *  page can write the observed medians. */
  protected async ensureDieMasterChangeOverMedianField(): Promise<void> {
    if (this.dieMasterMeta?.changeOverMedianExists) return;
    if (this.dieMasterChangeOverMedianReady) return this.dieMasterChangeOverMedianReady;
    this.dieMasterChangeOverMedianReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.changeOverMedian;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 9, // Number — hours, to 2 dp
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a number '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.changeOverMedian = internal;
      meta.changeOverMedianExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterChangeOverMedianReady = null;
      throw e;
    });
    return this.dieMasterChangeOverMedianReady;
  }

  async updateDieMaster(
    dieNumber: string,
    patch: Partial<
      Pick<
        DieMaster,
        | 'toolStatus'
        | 'dateStamp'
        | 'lastServiceDate'
        | 'availableDate'
        | 'maintenanceLevel'
        | 'notes'
        | 'changeOverMedian'
      >
    >,
  ): Promise<void> {
    // listDieMaster resolves the internal names + item ids; make sure it
    // has run (it caches, so this is a no-op after the first call).
    if (!this.dieMasterMeta) await this.listDieMaster();
    const meta = this.dieMasterMeta;
    const key = dieNumber.trim().toUpperCase();
    const id = meta?.idByDie.get(key);
    if (!meta || !id) throw new Error(`No PMD_DieMaster row for die ${dieNumber}`);
    if (patch.maintenanceLevel !== undefined && !meta.maintenanceLevelExists) {
      await this.ensureDieMasterMaintenanceLevelField();
    }
    if (patch.notes !== undefined && !meta.notesExists) {
      await this.ensureDieMasterNotesField();
    }
    if (patch.changeOverMedian !== undefined && !meta.changeOverMedianExists) {
      await this.ensureDieMasterChangeOverMedianField();
    }
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.dieMaster) },
    };
    // Write the human label ("To be Serviced"), not the union slug —
    // the toolroom reads this list directly in SharePoint, and
    // parseToolStatus round-trips it on the way back in.
    if (patch.toolStatus !== undefined)
      body[meta.keys.toolStatus] = patch.toolStatus ? TOOL_STATUS_META[patch.toolStatus].label : '';
    if (patch.dateStamp !== undefined) body[meta.keys.dateStamp] = patch.dateStamp;
    if (patch.lastServiceDate !== undefined)
      body[meta.keys.lastServiceDate] = patch.lastServiceDate;
    if (patch.availableDate !== undefined) body[meta.keys.availableDate] = patch.availableDate;
    if (patch.maintenanceLevel !== undefined)
      body[meta.keys.maintenanceLevel] = patch.maintenanceLevel;
    if (patch.notes !== undefined) body[meta.keys.notes] = patch.notes;
    if (patch.changeOverMedian !== undefined)
      body[meta.keys.changeOverMedian] = patch.changeOverMedian;
    await this.post(`${this.listUrl(LISTS.dieMaster)}/items(${id})`, body, '*');
    // Keep the read cache coherent so a re-mount shows the new state
    // without a hard reload.
    if (this.dieMasterCache) {
      const row = this.dieMasterCache.find((m) => m.dieNumber.trim().toUpperCase() === key);
      if (row) {
        if (patch.toolStatus !== undefined) row.toolStatus = patch.toolStatus;
        if (patch.dateStamp !== undefined) row.dateStamp = patch.dateStamp;
        if (patch.lastServiceDate !== undefined) row.lastServiceDate = patch.lastServiceDate;
        if (patch.availableDate !== undefined) row.availableDate = patch.availableDate;
        if (patch.maintenanceLevel !== undefined) row.maintenanceLevel = patch.maintenanceLevel;
        if (patch.notes !== undefined) row.notes = patch.notes;
        if (patch.changeOverMedian !== undefined) row.changeOverMedian = patch.changeOverMedian;
      }
    }
  }

  /** SOC-note photos are attachments on the die's own PMD_DieMaster row:
   *  no column, no library — they travel with the die. */
  protected async dieMasterItemId(dieNumber: string): Promise<number> {
    if (!this.dieMasterMeta) await this.listDieMaster();
    const id = this.dieMasterMeta?.idByDie.get(dieNumber.trim().toUpperCase());
    if (!id) throw new Error(`No PMD_DieMaster row for die ${dieNumber}`);
    return id;
  }

  async attachDiePhoto(dieNumber: string, fileName: string, data: Blob): Promise<void> {
    const id = await this.dieMasterItemId(dieNumber);
    this.writesStarted++;
    const digest = await this.getDigest();
    // Raw binary body, like attachProductionPhoto — SP stores it verbatim.
    const url = `${this.listUrl(LISTS.dieMaster)}/items(${id})/AttachmentFiles/add(FileName='${encodeURIComponent(odataString(fileName))}')`;
    const res = await fetchThroughThrottle(url, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose', 'X-RequestDigest': digest },
      body: data,
    });
    if (res.ok) return;
    const text = await res.text();
    // A retry after a dropped response: the photo is already there.
    if (/already exists/i.test(text)) return;
    if (/attachments.*(disabled|not enabled)|EnableAttachments/i.test(text)) {
      throw new Error(
        'PMD_DieMaster has attachments turned off — List settings → Advanced settings → Attachments: Enabled',
      );
    }
    throw new Error(`Photo upload ${res.status}: ${text.slice(0, 200)}`);
  }

  async listDiePhotos(dieNumber: string): Promise<Array<{ name: string; url: string }>> {
    const id = await this.dieMasterItemId(dieNumber);
    const env = await this.getJson<{
      d: { results: Array<{ FileName: string; ServerRelativeUrl: string }> };
    }>(`${this.listUrl(LISTS.dieMaster)}/items(${id})/AttachmentFiles`);
    return env.d.results.map((a) => ({ name: a.FileName, url: a.ServerRelativeUrl }));
  }

  // ---- die change log (PMD_DieChangeLog) -------------------------------

  protected dieChangeSchemaReady: Promise<void> | null = null;

  /**
   * How `SignOffStatus` wants its 1 / 2 / 3 written.
   *
   * The site made the column by hand and it is a plain Number on some
   * tenants and a Choice of "1" / "2" / "3" on others. A Choice column
   * rejects the number 3 and a Number column rejects the string — and the
   * whole Die Change Log save fails with it — so the list's own field type
   * decides, read once alongside the schema probe. `null` until probed.
   */
  protected dieSignOffStatusText: boolean | null = null;

  /** Add the four event-level columns introduced by the one-row-per-D/I
   *  model. EventKey is indexed and unique: this is the server-side guard
   *  that makes two iPads saving the same popup converge on one row. */
  protected async ensureDieChangeLogSchema(): Promise<void> {
    if (this.dieChangeSchemaReady) return this.dieChangeSchemaReady;
    this.dieChangeSchemaReady = (async () => {
      const F = this.F.dieChangeLog;
      const fieldsUrl = `${this.listUrl(LISTS.dieChangeLog)}/fields`;
      const readFields = async (): Promise<Set<string>> => {
        const env = await this.getJson<{
          d: {
            results: Array<{ Title: string; InternalName: string; TypeAsString?: string }>;
          };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName,TypeAsString`);
        // Anything but a numeric column takes the digit as text. Choice is
        // the common hand-made shape; Text / Note behave the same way.
        const status = env.d.results.find(
          (f) => f.InternalName === F.signOffStatus || f.Title === F.signOffStatus,
        );
        if (status) {
          this.dieSignOffStatusText = !['Number', 'Counter', 'Currency'].includes(
            status.TypeAsString ?? '',
          );
        }
        return new Set(env.d.results.flatMap((f) => [f.Title, f.InternalName]));
      };
      let present = await readFields();
      const required: Array<{
        name: string;
        kind: number;
        unique?: boolean;
      }> = [
        { name: F.eventKey, kind: 2, unique: true },
        { name: F.eventStartSlot, kind: 9 },
        { name: F.eventEndSlot, kind: 9 },
        { name: F.componentsInJson, kind: 3 },
        { name: F.problemDescriptionIn, kind: 3 },
        // Made by hand on the site that asked for it; created here as a
        // Number for anyone deploying fresh.
        { name: F.signOffStatus, kind: 9 },
      ];
      for (const field of required) {
        if (present.has(field.name)) continue;
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: field.name,
            FieldTypeKind: field.kind,
            ...(field.unique ? { Indexed: true, EnforceUniqueValues: true } : {}),
          });
        } catch (e) {
          // Another device/deploy may have created it between our read and
          // POST. Re-read once; only fail when it is genuinely still absent.
          present = await readFields();
          if (!present.has(field.name)) {
            throw new Error(
              `PMD_DieChangeLog needs column '${field.name}' (${(e as Error).message}). ` +
                'Add the columns documented in docs/DEPLOYMENT.md or grant Manage Lists once.',
            );
          }
        }
        present.add(field.name);
      }
    })().catch((e) => {
      this.dieChangeSchemaReady = null;
      throw e;
    });
    return this.dieChangeSchemaReady;
  }

  protected dieChangeComponentsLoad: Promise<DieComponent[]> | null = null;

  /**
   * The condition checks the Die Change Log asks: PMD_DieChangeLog's own
   * 1 / 2 / 3 Choice columns (dieComponentsFromFields), so a column the
   * toolroom adds is asked, written and read back without a code change.
   * Read once a session; the 13 built-in checks when the columns cannot be
   * read (and that read is tried again next time).
   */
  async listDieChangeComponents(): Promise<DieComponent[]> {
    if (!this.dieChangeComponentsLoad) {
      const F = this.F.dieChangeLog;
      const exclude = new Set<string>(['Title', ...Object.values(F)]);
      this.dieChangeComponentsLoad = this.getJson<{ d: { results: ListFieldInfo[] } }>(
        `${this.listUrl(LISTS.dieChangeLog)}/fields?$filter=Hidden eq false`,
      )
        .then((env) => {
          const found = dieComponentsFromFields(env.d.results, exclude);
          if (!found.length) throw new Error('no 1 / 2 / 3 Choice columns found');
          return found;
        })
        .catch((e) => {
          console.warn('[pmd] PMD_DieChangeLog condition columns unreadable, using the built-in 13:', e);
          this.dieChangeComponentsLoad = null;
          return DIE_COMPONENTS;
        });
    }
    return this.dieChangeComponentsLoad;
  }

  async listDieChangeLog(): Promise<DieChangeLog[]> {
    const F = this.F.dieChangeLog;
    const checks = await this.listDieChangeComponents();
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieChangeLog);
      return rows
        .map((r) => ({
          id: getId(r),
          eventKey:
            str(r[F.eventKey]).trim() ||
            dieChangeEventKey(
              str(r[F.machine]),
              dateOnly(r[F.date]),
              str(r[F.shift]),
              str(r[F.jobNumber]),
              num(r[F.eventStartSlot]) || 0,
            ),
          eventStartSlot: Math.max(0, num(r[F.eventStartSlot]) || 0),
          eventEndSlot: Math.max(
            num(r[F.eventStartSlot]) || 0,
            num(r[F.eventEndSlot]) || num(r[F.eventStartSlot]) || 0,
          ),
          date: dateOnly(r[F.date]),
          shift: str(r[F.shift]).trim(),
          dieSetter: str(r[F.dieSetter]).trim(),
          machineCode: str(r[F.machine]).trim(),
          changeOver: multiChoice(r[F.changeOver]),
          jobNumber: str(r[F.jobNumber]).trim(),
          dieNumberOut: str(r[F.dieNumberOut]).trim(),
          dieDescriptionOut: str(r[F.dieDescriptionOut]).trim(),
          dieNumberIn: str(r[F.dieNumberIn]).trim(),
          dieDescriptionIn: str(r[F.dieDescriptionIn]).trim(),
          components: Object.fromEntries(
            checks.map((c) => [c.key, parseDieCondition(str(r[c.key]))]),
          ),
          componentsIn: parseDieComponentsJson(str(r[F.componentsInJson])),
          signOffStatus: parseDieSignOffStatus(r[F.signOffStatus]),
          problemDescription: str(r[F.problemDescription]),
          problemDescriptionIn: str(r[F.problemDescriptionIn]),
          createdAt: str(r['Created']),
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch (e) {
      console.warn('[pmd] PMD_DieChangeLog unavailable:', e);
      // A caller about to CREATE must be able to distinguish "no rows" from
      // "the read failed". Returning [] here made transient GET failures
      // manufacture duplicate rows on the following POST.
      throw e;
    }
  }

  async createDieChangeLog(
    log: Omit<DieChangeLog, 'id' | 'createdAt' | 'signOffStatus'>,
  ): Promise<DieChangeLog> {
    await this.ensureDieChangeLogSchema();
    const F = this.F.dieChangeLog;
    const eventKey = dieChangeEventKey(
      log.machineCode,
      log.date,
      log.shift,
      log.jobNumber,
      log.eventStartSlot,
    );
    // The one number that summarises the inspection is derived here as well
    // as offered in the form, so a caller that skipped the preview — or a
    // row written by an older build — can never carry a status that
    // disagrees with the 26 ratings sitting beside it on the same row.
    const clean = {
      ...log,
      eventKey,
      eventStartSlot: Math.max(0, Math.floor(log.eventStartSlot)),
      eventEndSlot: Math.max(log.eventStartSlot, Math.floor(log.eventEndSlot)),
      signOffStatus: dieSignOffStatus(log.components, log.componentsIn),
    };
    const findExisting = async (): Promise<DieChangeLog | undefined> =>
      (await this.listDieChangeLog()).find((r) => r.eventKey === eventKey);
    let existing = await findExisting();
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.dieChangeLog) },
      Title: `${clean.machineCode} ${clean.date} · Die ${clean.dieNumberOut || '?'} → ${clean.dieNumberIn || '?'}`,
      [F.eventKey]: eventKey,
      [F.eventStartSlot]: clean.eventStartSlot,
      [F.eventEndSlot]: clean.eventEndSlot,
      // DateOnly column: midnight UTC keeps the calendar date stable in
      // every positive-offset regional setting (same rule as
      // shiftDateMarker — see that comment).
      [F.date]: clean.date ? `${clean.date}T00:00:00.000Z` : null,
      [F.shift]: clean.shift,
      [F.dieSetter]: clean.dieSetter,
      [F.machine]: clean.machineCode,
      [F.changeOver]: { __metadata: { type: 'Collection(Edm.String)' }, results: clean.changeOver },
      [F.jobNumber]: clean.jobNumber,
      // Number columns — null when the die number isn't numeric/known.
      [F.dieNumberOut]: numOrNull(clean.dieNumberOut),
      [F.dieDescriptionOut]: clean.dieDescriptionOut,
      [F.dieNumberIn]: numOrNull(clean.dieNumberIn),
      [F.dieDescriptionIn]: clean.dieDescriptionIn,
      [F.problemDescription]: clean.problemDescription,
      [F.componentsInJson]: JSON.stringify(clean.componentsIn ?? {}),
      [F.problemDescriptionIn]: clean.problemDescriptionIn,
      // A digit, as a number or as text depending on how the column was
      // made (see dieSignOffStatusText). null when nothing was rated — an
      // empty cell says "not inspected", where a 1 would claim "all good".
      [F.signOffStatus]:
        clean.signOffStatus === 0
          ? null
          : this.dieSignOffStatusText === true
            ? String(clean.signOffStatus)
            : clean.signOffStatus,
    };
    for (const c of await this.listDieChangeComponents()) {
      const cond = clean.components[c.key];
      // On update, always write the component (clearing a downgraded flag);
      // on insert, only send a value when set. body[c.key] otherwise stays
      // absent so SharePoint keeps its default. Written in the column's own
      // spelling of the choice.
      if (cond) body[c.key] = c.choices?.[cond] ?? DIE_CONDITION_META[cond].label;
      else if (existing) body[c.key] = null;
    }
    if (existing) {
      // MERGE the existing row (IF-MATCH '*') — no duplicate created.
      await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items(${existing.id})`, body, '*');
      return { ...clean, id: existing.id, createdAt: existing.createdAt };
    }
    let res: Response;
    try {
      res = await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items`, body);
    } catch (e) {
      // EventKey's unique index turns a concurrent create into 409/duplicate.
      // Re-read and MERGE that winner so both devices report success without
      // ever leaving two rows behind.
      existing = await findExisting();
      if (!existing) throw e;
      await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items(${existing.id})`, body, '*');
      return { ...clean, id: existing.id, createdAt: existing.createdAt };
    }
    const createdId = await responseItemId(res);
    if (createdId == null) {
      // Some SharePoint proxies strip the verbose create body. Resolve the
      // server row by its unique key instead of reporting a false failure
      // after the item has already been committed.
      existing = await findExisting();
      if (existing) return { ...clean, id: existing.id, createdAt: existing.createdAt };
      throw new Error('PMD_DieChangeLog create returned no item ID and the saved row could not be re-read');
    }
    return {
      ...clean,
      id: createdId,
      createdAt: new Date().toISOString(),
    };
  }

  // ---- planning -------------------------------------------------------

  // ---- die maintenance (PMD_DieMaintenance) ---------------------------

  async listDieMaintenance(): Promise<DieMaintenanceRequest[]> {
    // Mango CSV report (preferred when configured): Mango is the system
    // of record for work orders; scripts/sync-mango-csv.mjs downloads its
    // report into the OneDrive-synced folder and this reads the mirror.
    // Falls back to the PMD_DieMaintenance list if the file isn't there
    // (sync not set up yet / first run pending).
    if (this.mangoCsvPath) {
      try {
        const [text, dieColors] = await Promise.all([
          this.fetchSiteFile(this.mangoCsvPath, 'Mango work-order CSV'),
          this.listProductDieColors(),
        ]);
        const known = new Set(
          dieColors.map((d) => d.dieNumber.trim().toUpperCase()).filter(Boolean),
        );
        const orders = parseMangoWorkOrdersCsv(text);
        const matched = orders.filter((o) => known.has(o.dieNumber.toUpperCase())).length;
        const withDue = orders.filter((o) => o.dueDate).length;
        console.info(
          '[pmd] Mango work-order CSV:', orders.length, 'orders ·',
          matched, 'matched to a die number ·', withDue, "with a 'To be completed by' date",
        );
        if (orders.length > 0 && withDue === 0) {
          console.warn(
            "[pmd] Mango CSV: NO order has a 'To be completed by' date — the Maint",
            'traffic-light needs it. Check that column is present + filled in the export.',
            'Sample row dueDate:', JSON.stringify(orders[0]?.dueDate),
          );
        }
        return orders;
      } catch (e) {
        console.warn(
          '[pmd] Mango work-order CSV unavailable — falling back to PMD_DieMaintenance:', e,
        );
      }
    }
    const F = this.F.dieMaintenance;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieMaintenance);
      return rows
        .map((r) => ({
          id: getId(r),
          dieNumber: str(r[F.dieNumber]).trim(),
          status: normaliseMaintStatus(str(r[F.status])),
          maintType: normaliseMaintType(str(r[F.maintType])),
          priority: normaliseMaintPriority(str(r[F.priority])),
          description: str(r[F.description]),
          contact: str(r[F.contact]),
          requestedBy: str(r[F.requestedBy]),
          machineCode: str(r[F.machine]),
          jobNumber: str(r[F.jobNumber]),
          mangoTicket: str(r[F.mangoTicket]),
          createdAt: str(r['Created']),
          closedAt: str(r[F.closedAt]),
          dueDate: isoDate(r[F.dueDate]) || undefined,
        }))
        .filter((r) => r.dieNumber)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch (e) {
      // Tenant without the list yet — an empty request book is the honest
      // answer; the list gets created on the first write.
      console.warn('[pmd] PMD_DieMaintenance unavailable (created on first request):', e);
      return [];
    }
  }

  async listMachineMaintenance(): Promise<DieMaintenanceRequest[]> {
    // The machine/plant half of the same Mango report the Die board reads
    // for dies. Only available from the CSV mirror — the legacy
    // PMD_DieMaintenance list is die-scoped, so there's nothing to fall
    // back to. Returns [] when the CSV isn't configured / can't be read.
    if (!this.mangoCsvPath) return [];
    try {
      const text = await this.fetchSiteFile(this.mangoCsvPath, 'Mango work-order CSV');
      const orders = parseMangoMachineWorkOrdersCsv(text);
      const open = orders.filter((o) => o.status !== 'done').length;
      // Distinct assets — the Die board matches these to a press by code, so
      // surfacing them here makes a naming mismatch diagnosable from F12.
      const sampleAssets = Array.from(
        new Set(orders.map((o) => o.asset ?? '').filter(Boolean)),
      ).slice(0, 12);
      console.info(
        '[pmd] Mango machine work orders:', orders.length, 'plant/equipment orders ·', open, 'open ·',
        'sample assets:', sampleAssets,
      );
      return orders;
    } catch (e) {
      console.warn('[pmd] Mango machine work orders unavailable:', e);
      return [];
    }
  }

  // ---- PMD_Machine maintenance columns (Maint → Machine) -----------------

  /** Field name → internal name + type, read from the list itself. A column
   *  is matched on its internal name, else its display name. */
  protected async readMachineFields(): Promise<{
    keys: Record<MachineMasterField, string>;
    types: Partial<Record<MachineMasterField, string>>;
  }> {
    const env = await this.getJson<{
      d: { results: Array<{ Title: string; InternalName: string; TypeAsString?: string }> };
    }>(`${this.listUrl(LISTS.machine)}/fields?$filter=Hidden eq false&$select=Title,InternalName,TypeAsString`);
    const fields = env.d.results;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = {} as Record<MachineMasterField, string>;
    const types: Partial<Record<MachineMasterField, string>> = {};
    for (const k of MACHINE_MASTER_FIELDS) {
      const wanted = this.F.machine[k];
      const f =
        fields.find((x) => x.InternalName === wanted) ?? fields.find((x) => norm(x.Title) === norm(wanted));
      keys[k] = f?.InternalName ?? wanted;
      if (f) types[k] = f.TypeAsString ?? 'Text';
    }
    return { keys, types };
  }

  async listMachineMaster(): Promise<MachineMaster[]> {
    const { keys, types } = await this.readMachineFields();
    let availableAsFraction = false;
    if (types.available === 'Number') {
      try {
        const f = await this.getJson<{ d: { ShowAsPercentage?: boolean } }>(
          `${this.listUrl(LISTS.machine)}/fields/getbyinternalnameortitle('${odataString(keys.available)}')`,
        );
        availableAsFraction = f.d.ShowAsPercentage === true;
      } catch {
        /* older tenants don't expose it — a plain number column */
      }
    }
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.machine);
    const code = (r: Record<string, unknown>): string => str(r[this.F.machine.code]).trim();
    this.machineMasterMeta = {
      keys,
      types,
      availableAsFraction,
      idByCode: new Map(rows.filter((r) => code(r)).map((r) => [machineKey(code(r)), getId(r)])),
    };
    const cell = (r: Record<string, unknown>, k: MachineMasterField): unknown => (types[k] ? r[keys[k]] : undefined);
    const available = (r: Record<string, unknown>): number | null => {
      const n = looseNum(cell(r, 'available'));
      return n == null ? null : availableAsFraction ? Math.round(n * 1000) / 10 : n;
    };
    const missing = MACHINE_MASTER_FIELDS.filter((k) => !types[k]);
    if (missing.length) {
      console.info('[pmd] PMD_Machine has no', missing.map((k) => this.F.machine[k]).join(', '), '— added on the first save');
    }
    return rows
      .filter((r) => code(r))
      .map((r) => ({
        machineCode: code(r),
        status: parseToolStatus(str(cell(r, 'status'))),
        lastService: spDay(cell(r, 'lastService')),
        mtbf: looseNum(cell(r, 'mtbf')),
        mttr: looseNum(cell(r, 'mttr')),
        breakdowns: looseNum(cell(r, 'breakdowns')),
        available: available(r),
        availableDate: spDay(cell(r, 'availableDate')),
      }));
  }

  async updateMachineMaster(
    machineCode: string,
    patch: Partial<Omit<MachineMaster, 'machineCode'>>,
  ): Promise<void> {
    if (!this.machineMasterMeta) await this.listMachineMaster();
    const meta = this.machineMasterMeta!;
    const id = meta.idByCode.get(machineKey(machineCode));
    if (!id) throw new Error(`No PMD_Machine row for ${machineCode}`);
    const fields = MACHINE_MASTER_FIELDS.filter((k) => patch[k] !== undefined);
    if (fields.length === 0) return;
    await this.ensureMachineFields(fields.filter((k) => !meta.types[k]));
    const body: Record<string, unknown> = { __metadata: { type: await this.itemType(LISTS.machine) } };
    for (const k of fields) body[meta.keys[k]] = machineCell(k, patch[k], meta.types[k] ?? 'Text', meta.availableAsFraction);
    await this.post(`${this.listUrl(LISTS.machine)}/items(${id})`, body, '*');
  }

  /** Add the maintenance columns PMD_Machine lacks: Status as text (the four
   *  ToolStatus labels), LastService and AvailableDate as dates, the figures as numbers. */
  protected async ensureMachineFields(missing: MachineMasterField[]): Promise<void> {
    if (missing.length === 0) return;
    const meta = this.machineMasterMeta!;
    const fieldsUrl = `${this.listUrl(LISTS.machine)}/fields`;
    for (const k of missing) {
      const Title = this.F.machine[k];
      const def =
        k === 'status'
          ? { __metadata: { type: 'SP.Field' }, Title, FieldTypeKind: 2 }
          : k === 'lastService' || k === 'availableDate'
            ? { __metadata: { type: 'SP.FieldDateTime' }, Title, FieldTypeKind: 4, DisplayFormat: 0 }
            : { __metadata: { type: 'SP.Field' }, Title, FieldTypeKind: 9 };
      try {
        await this.post(fieldsUrl, def);
      } catch (e) {
        // Another device may have added it in between; only a column that is
        // still missing after a re-read is a real failure.
        const again = await this.readMachineFields();
        if (!again.types[k]) {
          throw new Error(
            `PMD_Machine needs a '${Title}' column (${(e as Error).message}). ` +
              'Add it in List settings or grant Manage Lists once.',
          );
        }
      }
    }
    const { keys, types } = await this.readMachineFields();
    meta.keys = keys;
    meta.types = types;
    console.info('[pmd] PMD_Machine columns ready:', keys);
  }

  async listMachinePm(): Promise<MachinePmEvent[]> {
    if (!this.machinePmCsvPath) return [];
    try {
      const rows = parseMachinePmCsv(await this.fetchSiteFile(this.machinePmCsvPath, 'MachinePM CSV'));
      console.info(
        '[pmd] MachinePM.csv:', new Set(rows.map((r) => r.asset)).size, 'equipment ·',
        rows.filter((r) => r.detail && !r.superseded).length, 'live PM events',
      );
      return rows;
    } catch (e) {
      console.warn('[pmd] MachinePM.csv unavailable:', e);
      return [];
    }
  }
}
