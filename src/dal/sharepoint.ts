import type {
  BdCode,
  Machine,
  Operator,
  PlanningFilter,
  PlanningOrder,
  Product,
  ProductDieColor,
  ProductionFilter,
  ProductionRecord,
  RejectCategory,
  StatusCode,
  Supervisor,
  UserContext,
} from '../types';
import type { PmdDataLayer } from './types';
import { bdCategoryOf, bdLabelFor, BD_TAXONOMY } from '../core/breakdown';
import { slotClock } from '../core/shifts';

// =====================================================================
// SharePointDataLayer — Resero Operations AU site.
//
// Talks to the 11 lists shown in the screenshot, with three save-time
// outputs (PMD_Production header + PMD_BreakDown status-hour analytic +
// PMD_Rejects per-event log) instead of the per-slot row model the
// MemoryDataLayer uses.
//
// Live editing (operator filling out the sheet) is cached in memory by
// this adapter; the cache is flushed to the three lists on `lockShift`
// (= Sign off & Save). Past shifts are hydrated back from the header
// table on demand so the trace view works.
// =====================================================================

const LISTS = {
  machine: 'PMD_Machine',
  operator: 'PMD_Operator',
  supervisor: 'PMD_Supervisor',
  products: 'PMD_Products',
  planning: 'PMD_Planning',
  production: 'PMD_Production',
  /** Transient "in-progress" mirror of PMD_Production. pushLiveSnapshot
   *  writes here every poll tick; Sign Off & Save copies the row into
   *  PMD_Production and deletes it from here. Same column schema as
   *  PMD_Production by design — see the production field map. */
  liveStatus: 'PMD_LiveStatus',
  rejects: 'PMD_Rejects',
  breakdown: 'PMD_BreakDownlog',
  rejectCategories: 'PMD_RejectCategories',
  breakdownMaster: 'PMD_BreakdownMaster',
  productDieColor: 'PMD_ProductDieColor',
  rdoRoster: 'RDO Roster 2026-2030',
} as const;

// SharePoint's internal column names are baked in at creation time. These
// are my best guess based on the column titles in the screenshot —
// spaces become `_x0020_`, slashes become `_x002f_`. If your actual
// internal names differ, override per-list via `SharePointOptions.fieldMap`
// at construction time (printed by `diagnoseFields()` for confirmation).
// Field map calibrated against the diagnoseFields() output on
// reseroglobal.sharepoint.com/sites/ReseroOperationsAU (2026-05-26).
// Pattern note: Many lists were imported from Excel/external sources,
// which left the primary column in `Title` (machine code, part number,
// reject code, etc.) and gave the other columns auto-generated names
// like `field_1`. Don't try to "fix" by hand — match what's there.
const DEFAULT_FIELDS = {
  machine: {
    code: 'Title', // machine code (e.g. "1600T") lives in Title
    active: 'IsActive_x003a_Yes_x002f_No', // display is literally "IsActive: Yes/No"
    displayOrder: 'DisplayOrder',
  },
  operator: {
    // Title = operator name; `Supervisor` (internal) displays as
    // "Supervisor_1", and `Supervisor0` (internal) is the Lookup column.
    shift: 'Shift',
    name: 'Title',
    position: 'Position',
    supervisor1: 'Supervisor',
    supervisor: 'Supervisor0',
  },
  supervisor: {
    // Title = role title (e.g. "Day shift Supervisor"); Name = person name.
    title: 'Title',
    name: 'Name',
  },
  products: {
    // Title = PartNum; other columns are auto-named field_1..field_6.
    partNum: 'Title',
    desc: 'field_1',
    family: 'field_2',
    group: 'field_3',
    partClass: 'field_4',
    typeCode: 'field_5',
    cost: 'field_6',
  },
  planning: {
    // Source of truth is now Epicor REST — scripts/sync-epicor-to-sp.ps1
    // (running on the always-on on-prem PC, every 15 min) pulls the BAQ
    // and upserts here. Epicor has no machine assignment for PMD orders,
    // so Title is filled with JobNum (acts as natural key) and the app
    // never reads it back — machineCode below is sourced as empty and
    // the operator dropdown lists all PMD-released orders.
    machine: '', // skip read/write — no machine in Epicor source
    startDateTime: 'StartDateTime',
    qtyHour: 'QTYperHour',
    dueDate: 'Due_Date',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    remaining: 'Calculated_RemainingQty',
    duration: 'Duration',
    dieNumber: '', // no source
    dc: '', // no source
  },
  production: {
    machine: 'Title',
    // The `MachineCode` column on this tenant has been repurposed to hold
    // the 16-char status timeline string — same value as PMD_BreakDownlog.
    // StatusTimeline — so the SP list is self-readable without joining.
    // `machineCodeAlt` is therefore a misnomer kept for backwards-compat
    // of the field map; see upsertProductionHeader for what actually gets
    // written here.
    machineCodeAlt: 'MachineCode',
    date: 'SlotStart_x003a_', // display "Date", actually the DateTime "SlotStart:"
    shift: 'ShiftId',
    // The dedicated StatusTimeline column was never re-added to
    // PMD_Production — the timeline lives in MachineCode (see above) and
    // PMD_BreakDownlog.StatusTimeline. Leave blank so the writer skips it.
    timeline: '',
    jobNumber: 'JobNumber',
    // Cached so the SP list is readable without joining to PMD_Planning —
    // requested by the supervisor reviewing signed-off shifts. Part # is
    // also denormalised so KPIs can resolve PMD_ProductDieColor by
    // record.partNumber directly.
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    countStart: 'CountStart',
    countEnd: 'CountEnd',
    reject: 'Reject',
    operator: 'Operator',
    supervisor: 'Supervisor',
    runTime: 'RunTime',
    downTime: 'Downtime',
    handover: 'Handover',
    totalGood: 'TotalGood',
  },
  rejects: {
    // Title = Machine; Date is a DateTime (not date-only).
    machine: 'Title',
    shift: 'Shift',
    date: 'Date',
    timeline: 'Timeline',
    jobNum: 'JobHead_JobNum',
    rejectCode: 'RejectCode',
    rejectCategory: 'RejectCategory',
    rejectNumber: 'RejectNumber',
  },
  breakdown: {
    // Confirmed against diagnoseFields on PMD_BreakDownlog (renamed from
    // PMD_BreakDown). Adds a new BDCode column for the dominant breakdown
    // code on the shift (picked from the slots that had B status).
    date: 'Date',
    machine: 'Title',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    shift: 'Shift',
    statusTimeline: 'StatusTimeline',
    bdCode: 'BDCode',
    r: 'R_Runtime',
    b: 'B_BreakDown',
    c: 'C_ColorChange',
    d: 'D_DieChange',
    i: 'I_InsertChange',
    m: 'M_Maintainance',
    o: 'O_NoWork',
    p: 'P_Purge',
    s: 'S_StartUpShutdown',
  },
  rejectCategories: {
    // Title = Code (P11, P12, ...); Description = the human label.
    code: 'Title',
    description: 'Description',
  },
  breakdownMaster: {
    // Title = Cause (the longest descriptive field); Code/Category/
    // LikelyOwner are explicit columns.
    code: 'Code',
    category: 'Category',
    cause: 'Title',
    likelyOwner: 'LikelyOwner',
  },
  productDieColor: {
    // Per-Part # die / paint colour. PartNum is the natural key, matching
    // Planning.csv's JobHead_PartNum (= PlanningOrder.partNumber).
    // ColorHex stores "#RRGGBB"; ActualColor is the friendly label
    // (e.g. "Grey Green") used for the swatch tooltip and the KPIs Color
    // column label.
    partNum: 'PartNum',
    hex: 'ColorHex',
    name: 'ActualColor',
  },
} as const;

export type SharePointFieldMap = typeof DEFAULT_FIELDS;
export type PartialFieldMap = {
  [K in keyof SharePointFieldMap]?: Partial<SharePointFieldMap[K]>;
};

export interface SharePointOptions {
  siteUrl: string;
  /** Resolves a Microsoft Graph access token. Required only for syncPlanningFromExcel. */
  graphToken?: () => Promise<string>;
  /** Path inside the site to the planning workbook. */
  planningFilePath?: string;
  /**
   * Server-relative path to a CSV holding planning data (preferred over
   * reading PMD_Planning list when set). Example:
   *   "/sites/PMD/Shared Documents/PMD/Planning.csv"
   * Produced by scripts/sync-epicor-to-sp.ps1 + OneDrive sync.
   */
  planningCsvPath?: string;
  /** Override any list/field internal name without editing this file. */
  fieldMap?: PartialFieldMap;
}

export class SharePointDataLayer implements PmdDataLayer {
  private digest: { value: string; expires: number } | null = null;
  private readonly siteUrl: string;
  private readonly graphToken?: () => Promise<string>;
  private readonly planningFilePath?: string;
  private readonly planningCsvPath?: string;
  private readonly F: SharePointFieldMap;

  /**
   * Cache of unsaved slot records for shifts the operator is currently
   * editing. Key = `${machineCode}|${shiftId}|${jobNumber}`. Flushed to
   * the three production lists on lockShift. Mirrored to localStorage on
   * every change so that an accidental nav (back/forward, top-nav tap)
   * or a page refresh does not wipe a half-filled shift — the operator's
   * data is preserved until sign-off explicitly clears it.
   */
  private editCache = new Map<string, ProductionRecord[]>();
  private static readonly EDIT_CACHE_KEY = 'pmd_edit_cache_v1';
  /** Hydrated headers: same key, value = the synthesised slot 0 record. */
  private hydratedKeys = new Set<string>();
  /**
   * Cache of `ListItemEntityTypeFullName` per list title. Encoding a list
   * title to that string by hand (`SP.Data.${encoded}ListItem`) is unreliable
   * — when a list has been renamed since creation, the entity type still
   * reflects the original title and SP rejects POSTs with "type … could not
   * be resolved by the model". One round-trip to read it cures that.
   */
  private entityTypeCache = new Map<string, string>();
  /**
   * Module-lived cache of PMD_ProductDieColor — the list is small (a
   * few thousand rows) and effectively read-only at runtime, but every
   * view (Operator / KPI / Trace) was re-fetching it on first render,
   * which is a 2-3 s round trip against the live tenant. Cache once,
   * reuse forever; the user can hard-refresh to repopulate.
   */
  private dieColorCache: ProductDieColor[] | null = null;

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.graphToken = o.graphToken;
    this.planningFilePath = o.planningFilePath;
    this.planningCsvPath = o.planningCsvPath;
    // Merge user overrides into the defaults.
    this.F = mergeFieldMap(DEFAULT_FIELDS, o.fieldMap);
    this.rehydrateEditCache();
  }

  private rehydrateEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointDataLayer.EDIT_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<[string, ProductionRecord[]]>;
      for (const [k, v] of parsed) this.editCache.set(k, v);
    } catch (e) {
      console.warn('[pmd] could not rehydrate edit cache:', e);
    }
  }

  /**
   * Mark the cache dirty and write it to localStorage in the next
   * microtask. Callers can fire this on every keystroke / per-slot
   * upsert without paying for 10× full-cache stringifies during a
   * drag-fill — the coalesced write happens once per event-loop turn.
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const payload = JSON.stringify(Array.from(this.editCache.entries()));
        localStorage.setItem(SharePointDataLayer.EDIT_CACHE_KEY, payload);
      } catch (e) {
        // Quota exceeded or private mode — caller will still get an
        // in-memory copy, we just won't survive a refresh.
        console.warn('[pmd] could not persist edit cache:', e);
      }
    }, 0);
  }

  // ---- low-level helpers ----------------------------------------------

  private listUrl(title: string): string {
    return `${this.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(title)}')`;
  }

  private async getDigest(): Promise<string> {
    if (this.digest && this.digest.expires > Date.now() + 5_000) return this.digest.value;
    const res = await fetch(`${this.siteUrl}/_api/contextinfo`, {
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

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose' },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return (await res.json()) as T;
  }

  private async getAllItems<T = Record<string, unknown>>(list: string, qs = ''): Promise<T[]> {
    const out: T[] = [];
    let url = `${this.listUrl(list)}/items?$top=5000${qs ? '&' + qs : ''}`;
    while (url) {
      const env = await this.getJson<{ d: { results: T[]; __next?: string } }>(url);
      out.push(...env.d.results);
      url = env.d.__next ?? '';
    }
    return out;
  }

  private async post(url: string, body: unknown, ifMatch?: string): Promise<Response> {
    const digest = await this.getDigest();
    const res = await fetch(url, {
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

  private async del(url: string): Promise<void> {
    const digest = await this.getDigest();
    const res = await fetch(url, {
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
  private async itemType(list: string): Promise<string> {
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

  // ---- reference lists ------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    const F = this.F.machine;
    const rows = await this.getAllItems(LISTS.machine);
    return rows.map((r, i) => ({
      id: getId(r),
      machineCode: str(r[F.code]),
      displayName: str(r[F.code]),
      sequence: num(r[F.displayOrder]) || i + 1,
      active: bool(r[F.active]) ?? true,
    }));
  }

  async listOperators(): Promise<Operator[]> {
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    return rows.map((r) => ({
      id: getId(r),
      operatorName: str(r[F.name]),
      active: true,
    }));
  }

  async listSupervisors(): Promise<Supervisor[]> {
    // Supervisors are now derived from the distinct Supervisor_1 column
    // on PMD_Operator (a free-text field on each operator's row), not
    // from the separate PMD_Supervisor list. Drops the Lookup column
    // and the second REST round-trip on every boot — listOperators
    // already brings these rows back, so in practice this is free.
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    const seen = new Set<string>();
    const out: Supervisor[] = [];
    for (const r of rows) {
      const name = str(r[F.supervisor1]).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ id: out.length + 1, operatorName: name, active: true });
    }
    return out;
  }

  async listProducts(): Promise<Product[]> {
    const F = this.F.products;
    const rows = await this.getAllItems(LISTS.products);
    return rows.map((r) => ({
      id: getId(r),
      partNumber: str(r[F.partNum]),
      description: str(r[F.desc]),
      standardCycleSec: 0,
      cavities: 1,
      active: true,
    }));
  }

  async listRejectCategories(): Promise<RejectCategory[]> {
    const F = this.F.rejectCategories;
    const rows = await this.getAllItems(LISTS.rejectCategories);
    return rows.map((r, i) => {
      const code = str(r[F.code]);
      return { code, label: str(r[F.description]), sequence: i + 1 };
    });
  }

  async listBdCodes(): Promise<BdCode[]> {
    const F = this.F.breakdownMaster;
    try {
      const rows = await this.getAllItems(LISTS.breakdownMaster);
      if (rows.length === 0) return bdFallback();
      return rows.map((r, i) => ({
        code: str(r[F.code]),
        label: str(r[F.cause]),
        subCategory: str(r[F.category]),
        sequence: i + 1,
        owner: str(r[F.likelyOwner]),
      }));
    } catch {
      // If the list is empty / unreadable, fall back to the hard-coded
      // taxonomy so the cascade UI keeps working.
      return bdFallback();
    }
  }

  async listProductDieColors(): Promise<ProductDieColor[]> {
    // Cached after the first successful read — the list is small and
    // read-only at runtime; refetching it on every nav was a 2-3 s
    // round-trip per view. Operators hard-reload the page to pick up
    // colour list edits, which is the established workflow anyway.
    if (this.dieColorCache) return this.dieColorCache;
    const F = this.F.productDieColor;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.productDieColor);
      if (rows.length === 0) {
        this.dieColorCache = [];
        return this.dieColorCache;
      }
      // Direct field reads — works when SP kept the typed column names.
      const direct = rows
        .map((r) => ({
          partNumber: str(r[F.partNum]).trim(),
          hex: normaliseHex(str(r[F.hex])),
          name: str(r[F.name]).trim(),
        }))
        .filter((c) => c.partNumber && c.hex);
      if (direct.length > 0) {
        console.info(
          '[pmd] PMD_ProductDieColor cached:',
          direct.length,
          'of',
          rows.length,
          'rows',
        );
        this.dieColorCache = direct;
        return this.dieColorCache;
      }
      // SP modern UI sometimes auto-renames new columns to `field_N`.
      // Probe the first row: the hex column is whichever one carries a
      // #RRGGBB value; Title is the part number; the remaining text
      // field is the colour name.
      const r0 = rows[0];
      const isHex = (v: unknown) => /^#?[0-9a-fA-F]{6}$/.test(str(v).trim());
      const hexKey = Object.keys(r0).find((k) => isHex(r0[k]));
      const partKey = str(r0.Title).trim() ? 'Title' : Object.keys(r0).find((k) => k !== hexKey && /^[A-Za-z0-9_-]+$/.test(str(r0[k])));
      const nameKey = Object.keys(r0).find(
        (k) =>
          k !== hexKey &&
          k !== partKey &&
          /^field_\d|Title|Name|Color/.test(k) &&
          str(r0[k]).trim().length > 0,
      );
      console.warn(
        '[pmd] PMD_ProductDieColor direct read found 0 mappings; auto-detected',
        { partKey, hexKey, nameKey },
        'first row:',
        r0,
      );
      if (!partKey || !hexKey) {
        this.dieColorCache = [];
        return this.dieColorCache;
      }
      const auto = rows
        .map((r) => ({
          partNumber: str(r[partKey]).trim(),
          hex: normaliseHex(str(r[hexKey])),
          name: nameKey ? str(r[nameKey]).trim() : '',
        }))
        .filter((c) => c.partNumber && c.hex);
      this.dieColorCache = auto;
      return this.dieColorCache;
    } catch (e) {
      // Tenant without PMD_ProductDieColor → no swatch is fine; the
      // existing keyword-derived colour on KPIs takes over.
      // Do NOT cache the failure — the next call retries.
      console.warn('[pmd] PMD_ProductDieColor unavailable, swatches disabled:', e);
      return [];
    }
  }

  // ---- planning -------------------------------------------------------

  async listPlanning(_filter: PlanningFilter): Promise<PlanningOrder[]> {
    // Two sources, picked by config:
    //  1. CSV file in a doc library (PREFERRED) — written by PowerShell on
    //     the shop-floor PC and uploaded via OneDrive sync. No SP write
    //     credentials needed anywhere; the script just touches the local
    //     synced folder. App reads via SP file REST.
    //  2. PMD_Planning list (legacy) — kept for tenants that haven't moved
    //     to the CSV pipeline yet.
    if (this.planningCsvPath) {
      return this.loadPlanningCsv(this.planningCsvPath);
    }
    const F = this.F.planning;
    const rows = await this.getAllItems(LISTS.planning, '');
    return rows.map((r) => {
      const start = isoDate(r[F.startDateTime]);
      const due = isoDate(r[F.dueDate]);
      const dur = num(r[F.duration]) || 0;
      const end = dur > 0 ? new Date(new Date(start).getTime() + dur * 3600_000).toISOString() : due;
      return {
        id: getId(r),
        jobNumber: str(r[F.jobNum]),
        machineCode: '',
        originalMachine: '',
        partNumber: str(r[F.partNum]),
        partDescription: str(r[F.partDesc]),
        plannedStart: start,
        plannedEnd: end,
        jobRequired: num(r[F.remaining]) || 0,
        qtyPerHr: num(r[F.qtyHour]) || 0,
        duration: dur,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      };
    });
  }

  private async loadPlanningCsv(rawPath: string): Promise<PlanningOrder[]> {
    // Accept a full https://…/sites/…/file.csv URL or a server-relative
    // path with or without percent-encoded spaces — normalise once,
    // encode per segment so '/' separators survive, double single quotes
    // for OData. Cache-bust per request so OneDrive uploads show up.
    const serverRelative = toServerRelativePath(rawPath);
    const encodedPath = serverRelative
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
      .replace(/'/g, "''");
    const url = `${this.siteUrl}/_api/web/getFileByServerRelativeUrl('${encodedPath}')/$value?_t=${Date.now()}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!res.ok) {
      throw new Error(
        `Planning CSV fetch failed (${res.status}) for ${serverRelative}`,
      );
    }
    return parsePlanningCsv(await res.text());
  }

  async upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder> {
    const F = this.F.planning;
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.planning) },
      [F.startDateTime]: order.plannedStart,
      [F.qtyHour]: order.qtyPerHr,
      [F.dueDate]: order.plannedEnd,
      [F.jobNum]: order.jobNumber,
      [F.partNum]: order.partNumber,
      [F.partDesc]: order.partDescription,
      [F.remaining]: order.jobRequired,
      [F.duration]: order.duration,
    };
    // Optional/legacy columns — only include when the field map has a real
    // SP internal name. Title is now populated by the Epicor sync job
    // directly (set to JobNum) so the app never needs to write it here.
    if (F.machine) body[F.machine] = order.machineCode;
    if (F.dc) body[F.dc] = order.isDieChange ? 'D' : '';
    if (order.id > 0) {
      await this.post(`${this.listUrl(LISTS.planning)}/items(${order.id})`, body, '*');
      return order;
    }
    const res = await this.post(`${this.listUrl(LISTS.planning)}/items`, body);
    const created = ((await res.json()) as { d: { ID: number } }).d;
    return { ...order, id: created.ID };
  }

  async deletePlanningOrder(id: number): Promise<void> {
    await this.del(`${this.listUrl(LISTS.planning)}/items(${id})`);
  }

  // ---- production (header / events) ----------------------------------
  //
  // PmdDataLayer is per-slot, but PMD_Production is per-(machine,shift,job).
  // We keep an in-memory cache of slot edits while a shift is being filled
  // and flush to the three lists on lockShift.

  private cacheKey(mc: string, sid: string, job: string): string {
    return `${mc}|${sid}|${job}`;
  }

  async listProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    // 1) Pull cached slot records that match the filter (current shift).
    const cached: ProductionRecord[] = [];
    for (const list of this.editCache.values()) {
      for (const r of list) if (productionMatches(r, filter)) cached.push(r);
    }
    // 2) Hydrate header rows from PMD_Production (signed-off) AND
    //    PMD_LiveStatus (in-progress mirror). Signed wins for any
    //    overlapping tuple — lockShift copies the row across and
    //    deletes the live source, so an overlap only ever appears in
    //    the brief window between those two writes.
    const seen = new Set(cached.map((r) => this.cacheKey(r.machineCode, r.shiftId, r.jobNumber)));
    const [prodHeaders, liveHeaders, rejectsByKey, timelinesByKey] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchHeaders(LISTS.liveStatus, filter).catch((e) => {
        // The live list may not exist yet on a fresh tenant — fall
        // back to "no live rows" so the rest of the page still loads.
        console.warn('[pmd] PMD_LiveStatus read failed (treating as empty):', e);
        return [] as HeaderRow[];
      }),
      this.fetchRejectsByKey(filter),
      this.fetchBreakdownTimelines(filter),
    ]);

    const matchesFilter = (h: HeaderRow): boolean => {
      // Defensive re-filter. shiftDateRange is intentionally loose
      // (±1 d) to catch legacy noon-UTC / local-start timestamps; with
      // the F.shift clause it also catches the same shift code on
      // adjacent calendar dates — yesterday's Day shift would leak
      // into a "today's Day shift" query.
      const hShiftId = `${h.date}-${h.shift}`;
      if (filter.shiftId && hShiftId !== filter.shiftId) return false;
      if (filter.shiftIdFrom && hShiftId < filter.shiftIdFrom) return false;
      if (filter.shiftIdTo && hShiftId > filter.shiftIdTo) return false;
      if (filter.machineCode && h.machineCode !== filter.machineCode) return false;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) return false;
      return true;
    };

    const ingest = (h: HeaderRow, isSignedOff: boolean): void => {
      if (!matchesFilter(h)) return;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      if (seen.has(key)) return;
      seen.add(key);
      // Splice the breakdown-side timeline onto the header so
      // expandHeaderToSlots can decode it. Without this, every
      // signed-off shift comes back with an empty timeline → no
      // Machine Status row, and every reject collapses into the
      // canonical slot 0 (07:00–07:30 for Day shift).
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: timelinesByKey.get(key) ?? '' };
      cached.push(
        ...this.expandHeaderToSlots(hWithTimeline, rejectsByKey.get(key) ?? [], isSignedOff),
      );
      this.hydratedKeys.add(key);
    };

    // Signed-off first so it wins any (rare) overlap with a not-yet-
    // deleted live row.
    for (const h of prodHeaders) ingest(h, true);
    // Dedup LiveStatus to one row per machine — the highest SP ID
    // wins as the proxy for "most recently written" (each iPad's poll
    // tick re-upserts the row, but stale snapshots from an earlier
    // shift / job that never got cleaned up linger in PMD_LiveStatus
    // and would otherwise overlay the current activity). Result: at
    // most 9 cards in the Live Status view, one per press.
    const latestLiveByMachine = new Map<string, HeaderRow>();
    for (const h of liveHeaders) {
      const prev = latestLiveByMachine.get(h.machineCode);
      if (!prev || h.id > prev.id) latestLiveByMachine.set(h.machineCode, h);
    }
    for (const h of latestLiveByMachine.values()) ingest(h, false);
    return cached;
  }

  /**
   * Read header rows from PMD_Production OR PMD_LiveStatus. Both
   * share the production field map by design — PMD_LiveStatus is a
   * column-for-column mirror of PMD_Production, holding the same
   * tuple until Sign Off & Save copies it across and deletes it
   * here.
   */
  private async fetchHeaders(list: string, filter: ProductionFilter): Promise<HeaderRow[]> {
    const F = this.F.production;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    if (filter.jobNumber) parts.push(`${F.jobNumber} eq '${filter.jobNumber}'`);
    // F.date points at SlotStart_x003a_ (DateTime). Filter with datetime'...'
    // and combine with ShiftId for an exact-shift match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${shift}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(list, qs);
    return rows.map((r) => ({
      id: getId(r),
      machineCode: str(r[F.machine]),
      date: dateOnly(r[F.date]),
      shift: str(r[F.shift]),
      jobNumber: str(r[F.jobNumber]),
      partNumber: F.partNum ? str(r[F.partNum]).trim() : '',
      // The 16-char status timeline lives in the MachineCode column on
      // this tenant; prefer it over the (empty / fallback) F.timeline
      // entry so listProduction can rebuild per-slot status without a
      // round-trip to PMD_BreakDownlog.
      timeline:
        (F.machineCodeAlt && str(r[F.machineCodeAlt])) ||
        (F.timeline && str(r[F.timeline])) ||
        '',
      countStart: nullOrNum(r[F.countStart]),
      countEnd: nullOrNum(r[F.countEnd]),
      reject: num(r[F.reject]),
      operator: str(r[F.operator]),
      supervisor: str(r[F.supervisor]),
      runTime: F.runTime ? num(r[F.runTime]) : 0,
      downTime: num(r[F.downTime]),
      // Handover is the JSON {people,plant,machine,material} blob, stored
      // when the shift was signed off. Used by the operator side-panel
      // textareas and the KPI Handover column.
      handover: F.handover ? str(r[F.handover]) : '',
    }));
  }

  /**
   * Pull StatusTimeline strings keyed by (machine|shiftId|jobNumber) from
   * PMD_BreakDownlog so listProduction can splice them onto the header
   * rows that come back from PMD_Production. PMD_Production no longer
   * carries the timeline directly (Status column was deleted from the
   * tenant) — without this fetch, every signed-off shift would come back
   * with no Machine Status row and rejects collapsed to slot 0.
   */
  private async fetchBreakdownTimelines(
    filter: ProductionFilter,
  ): Promise<Map<string, string>> {
    const F = this.F.breakdown;
    if (!F.statusTimeline) return new Map();
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${filter.jobNumber}'`);
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${shift}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.breakdown, qs);
    } catch {
      return new Map();
    }
    const out = new Map<string, string>();
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const key = this.cacheKey(mc, sid, job);
      const tl = str(r[F.statusTimeline]);
      if (tl) out.set(key, tl);
    }
    return out;
  }

  private async fetchRejectsByKey(
    filter: ProductionFilter,
  ): Promise<Map<string, RejectRow[]>> {
    const F = this.F.rejects;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${filter.jobNumber}'`);
    // PMD_Rejects.Date is DateTime — use a ±1d window around the shift's
    // date so both new (noon-UTC marker) and legacy (local-start) rows match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${shift}'`);
    }
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.rejects, qs);
    } catch {
      return new Map();
    }
    const out = new Map<string, RejectRow[]>();
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const key = this.cacheKey(mc, sid, job);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push({
        id: getId(r),
        timeline: str(r[F.timeline]),
        code: str(r[F.rejectCode]),
        category: str(r[F.rejectCategory]),
        qty: num(r[F.rejectNumber]),
      });
    }
    return out;
  }

  private expandHeaderToSlots(
    h: HeaderRow,
    rejects: RejectRow[],
    /** True for rows from PMD_Production (signed off); false for rows
     *  from PMD_LiveStatus (in progress). The caller knows which list
     *  the header came from — no need to infer from supervisor. */
    isSignedOff: boolean,
  ): ProductionRecord[] {
    const shiftId = `${h.date}-${h.shift}`;
    const slots: ProductionRecord[] = [];
    const timeline = (h.timeline || '').padEnd(16, '·').slice(0, 16);
    const stamp = new Date().toISOString();
    for (let i = 0; i < 16; i++) {
      const ch = timeline[i];
      if (ch === '·' || ch === ' ') continue;
      slots.push({
        id: 0,
        machineCode: h.machineCode,
        shiftId,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        slotIndex: i,
        statusCode: ch as ProductionRecord['statusCode'],
        countStart: i === 0 ? h.countStart : null,
        countEnd: i === 0 ? h.countEnd : null,
        rejectCount: 0,
        rejects: '{}',
        purgeKg: null,
        operator: i === 0 ? h.operator : '',
        supervisor: i === 0 ? h.supervisor : '',
        bdIssue: '',
        mangoTicket: '',
        handoverNote: i === 0 ? h.handover : '',
        locked: isSignedOff,
        lockedBy: h.supervisor,
        lockedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    if (slots.length === 0 || slots[0].slotIndex !== 0) {
      // Always provide a canonical slot 0 so the UI can read totals.
      slots.unshift({
        id: 0,
        machineCode: h.machineCode,
        shiftId,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        slotIndex: 0,
        statusCode: '',
        countStart: h.countStart,
        countEnd: h.countEnd,
        rejectCount: h.reject,
        rejects: '{}',
        purgeKg: null,
        operator: h.operator,
        supervisor: h.supervisor,
        bdIssue: '',
        mangoTicket: '',
        handoverNote: h.handover,
        locked: isSignedOff,
        lockedBy: h.supervisor,
        lockedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      });
    } else {
      // slots[0] already exists from the timeline loop — patch its
      // handover note in place so the canonical slot carries it.
      slots[0].handoverNote = h.handover;
    }
    // Merge rejects into the canonical slot 0's `rejects` JSON, and per-slot
    // events into slot records when the Timeline cell matches.
    for (const ev of rejects) {
      const slotIdx = timelineToSlot(ev.timeline);
      const target = slots.find((s) => s.slotIndex === slotIdx) ?? slots[0];
      let obj: Record<string, number> = {};
      try {
        obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
      } catch {
        /* keep {} */
      }
      obj[ev.code] = (obj[ev.code] || 0) + ev.qty;
      target.rejects = JSON.stringify(obj);
      target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    }
    return slots;
  }

  async upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord> {
    // Cache live edit; do not write to SharePoint until sign-off.
    const key = this.cacheKey(record.machineCode, record.shiftId, record.jobNumber);
    const list = this.editCache.get(key) ?? [];
    const idx = list.findIndex((r) => r.slotIndex === record.slotIndex);
    const stored = { ...record, id: idx >= 0 ? list[idx].id || -1 : -(list.length + 1) };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    this.editCache.set(key, list);
    this.persistEditCache();
    return stored;
  }

  async deleteProductionRecord(id: number): Promise<void> {
    // Remove from cache. Persisted rows are deleted only via shift unlock.
    let mutated = false;
    for (const [key, list] of this.editCache) {
      const filtered = list.filter((r) => r.id !== id);
      if (filtered.length !== list.length) {
        this.editCache.set(key, filtered);
        mutated = true;
      }
    }
    if (mutated) this.persistEditCache();
  }

  /**
   * Sign off & Save (§5): flush every cached (machine, shiftId, job) tuple
   * to PMD_Production header + PMD_BreakDown analytic + PMD_Rejects events.
   */
  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
  ): Promise<void> {
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const ownKey = (job: string): string => this.cacheKey(machineCode, shiftId, job);
    const myTuples: ProductionRecord[][] = [];
    for (const [key, list] of this.editCache) {
      if (!key.startsWith(`${machineCode}|${shiftId}|`)) continue;
      myTuples.push(list);
    }
    if (myTuples.length === 0) {
      // Nothing edited — still write a placeholder header so the shift is
      // recorded as having been signed off.
      myTuples.push([]);
    }
    // Single planning lookup (per machine) so we can populate JobHead_PartNum
    // and JobHead_PartDescription on PMD_BreakDownlog and PMD_Production
    // rows from the matching order — supervisors review the SP list and
    // didn't want to join to PMD_Planning to read what part was running.
    const orders = await this.listPlanning({ machineCode });
    const partNumOf = (job: string): string =>
      orders.find((o) => o.jobNumber === job)?.partNumber ?? '';
    const partDescOf = (job: string): string =>
      orders.find((o) => o.jobNumber === job)?.partDescription ?? '';
    for (const slots of myTuples) {
      const job =
        slots[0]?.jobNumber ?? '';
      const agg = aggregateSlots(slots);
      const tag = `${machineCode}|${shiftId}|${job}`;
      try {
        await this.upsertProductionHeader({
          machineCode,
          date,
          shift,
          jobNumber: job,
          partNumber: partNumOf(job),
          partDescription: partDescOf(job),
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject: agg.reject,
          operator: operator || agg.operator,
          supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
        });
      } catch (e) {
        throw new Error(`PMD_Production write failed (${tag}): ${(e as Error).message}`);
      }
      try {
        await this.replaceBreakdownEvents(
          {
            machineCode,
            date,
            shift,
            jobNumber: job,
            partNumber: partNumOf(job),
            timeline: agg.timeline,
          },
          slots,
        );
      } catch (e) {
        throw new Error(`PMD_BreakDownlog write failed (${tag}): ${(e as Error).message}`);
      }
      try {
        await this.replaceRejectEvents(
          { machineCode, date, shift, jobNumber: job },
          agg.rejectEvents,
        );
      } catch (e) {
        throw new Error(`PMD_Rejects write failed (${tag}): ${(e as Error).message}`);
      }
      // Sweep the in-progress mirror so other iPads' Live Status drops
      // this row in favour of the new signed-off Production record on
      // their next poll. Best-effort — pushLiveSnapshot won't re-create
      // the row because lockShift also clears editCache below.
      await this.deleteLiveRow(machineCode, shiftId, job);
      this.editCache.delete(ownKey(job));
    }
    this.persistEditCache();
  }

  /**
   * Push every unsigned editCache entry to **PMD_LiveStatus** as an
   * in-progress snapshot. Other iPads' Live Status reads PMD_LiveStatus
   * (alongside PMD_Production for signed-off rows) so the floor view
   * shows what's happening on every press without waiting for Sign
   * Off & Save.
   *
   * PMD_LiveStatus mirrors PMD_Production's column schema; lockShift
   * copies the row across and deletes it from here, so the two lists
   * never hold the same tuple simultaneously beyond a brief window.
   *
   * Called from the operator poll tick (every 60 s) and right after
   * multiFillApply so the new status pattern shows up immediately.
   * Fire-and-forget; a failure just means the live view is up-to-60-s
   * stale until the next tick succeeds.
   */
  async pushLiveSnapshot(): Promise<void> {
    if (this.editCache.size === 0) return;
    // One planning fetch so every live row can carry JobHead_PartNum —
    // KPIs and the colour swatch resolve PMD_ProductDieColor on the
    // record's partNumber, not by joining back to planning.
    const planning = await this.listPlanning({}).catch(() => [] as PlanningOrder[]);
    const partNumByJob = new Map<string, string>();
    for (const o of planning) partNumByJob.set(o.jobNumber, o.partNumber);
    const tasks: Promise<void>[] = [];
    for (const [key, slots] of this.editCache) {
      if (slots.length === 0) continue;
      // Skip cache entries that hold nothing but a freshly-picked
      // operator / supervisor name with no actual production data —
      // see hasMeaningfulProgress(). Avoids littering the broker with
      // empty rows every time someone picked the wrong job and
      // switched.
      if (!hasMeaningfulProgress(slots)) continue;
      const canon = slots.find((s) => s.slotIndex === 0) ?? slots[0];
      if (!canon) continue;
      const [machineCode, shiftId, jobNumber] = key.split('|');
      if (!machineCode || !shiftId || !jobNumber) continue;
      const date = shiftId.slice(0, 10);
      const shift = shiftId.slice(11);
      const agg = aggregateSlots(slots);
      tasks.push(
        this.upsertHeaderInto(LISTS.liveStatus, {
          machineCode,
          date,
          shift,
          jobNumber,
          partNumber: partNumByJob.get(jobNumber) ?? '',
          partDescription: '',
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject: agg.reject,
          operator: canon.operator,
          supervisor: canon.supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
        }).catch((e) => {
          // Snapshot push is best-effort; never propagate.
          console.warn('[pmd] live snapshot push failed for', key, e);
        }),
      );
    }
    await Promise.all(tasks);
  }

  async unlockShift(
    machineCode: string,
    shiftId: string,
    jobNumber?: string,
  ): Promise<void> {
    // Find PMD_Production rows for this (Machine, SlotStart:, Shift) and
    // delete their corresponding analytic + reject rows so the operator
    // can refile. When jobNumber is provided, scope all three deletes to
    // that job — a shift can hold several orders and unlocking one
    // mustn't wipe the others' signed-off records.
    const F = this.F.production;
    const shift = shiftId.slice(11);
    const jobClause = (fJob: string): string =>
      jobNumber ? ` and ${fJob} eq '${jobNumber}'` : '';
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${shift}'${jobClause(F.jobNumber)}`,
      );
    const rows = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.production, qs);
    for (const r of rows) await this.del(`${this.listUrl(LISTS.production)}/items(${r.ID ?? r.Id})`);
    const Fb = this.F.breakdown;
    await this.deleteByFilter(
      LISTS.breakdown,
      `${Fb.machine} eq '${machineCode}' and (${shiftDateRange(shiftId, Fb.date)}) and ${Fb.shift} eq '${shift}'${jobClause(Fb.jobNum)}`,
    );
    const Fr = this.F.rejects;
    await this.deleteByFilter(
      LISTS.rejects,
      `${Fr.machine} eq '${machineCode}' and (${shiftDateRange(shiftId, Fr.date)}) and ${Fr.shift} eq '${shift}'${jobClause(Fr.jobNum)}`,
    );
    // Also clear any leftover PMD_LiveStatus mirror for this tuple so
    // the next listProduction doesn't re-hydrate a stale snapshot
    // alongside the (now-deleted) signed-off rows.
    try {
      await this.deleteByFilter(
        LISTS.liveStatus,
        `${F.machine} eq '${machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${shift}'${jobClause(F.jobNumber)}`,
      );
    } catch (e) {
      console.warn('[pmd] unlock: live mirror cleanup failed', e);
    }
    // Drop hydrated cache so a re-read pulls fresh. Scope to the job
    // when one was supplied, otherwise drop the whole shift's keys.
    const prefix = jobNumber
      ? `${machineCode}|${shiftId}|${jobNumber}`
      : `${machineCode}|${shiftId}|`;
    this.hydratedKeys.forEach((k) => {
      if (k.startsWith(prefix)) this.hydratedKeys.delete(k);
    });
  }

  private async upsertProductionHeader(h: HeaderInput): Promise<void> {
    await this.upsertHeaderInto(LISTS.production, h);
  }

  private async upsertHeaderInto(
    list: string,
    h: HeaderInput,
  ): Promise<void> {
    const F = this.F.production;
    // F.date is a DateTime column. Stamp noon UTC of the shift's calendar
    // date so the SP list displays the right date in every regional setting
    // (see shiftDateMarker for why local-clock start was a bad anchor).
    // F.machine is mapped to Title, so writing [F.machine] populates Title
    // with the machine code (e.g. "Batt1") — no separate Machine column.
    const shiftId = `${h.date}-${h.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(list) },
      [F.machine]: h.machineCode,
      [F.shift]: h.shift,
      [F.jobNumber]: h.jobNumber,
      [F.countStart]: h.countStart ?? null,
      [F.countEnd]: h.countEnd ?? null,
      [F.reject]: h.reject,
      [F.operator]: h.operator,
      [F.supervisor]: h.supervisor,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    // Optional columns: only write if the field map has a non-empty name,
    // otherwise SP rejects the whole POST with "property X does not exist".
    // The `MachineCode` column is repurposed to carry the 16-char status
    // timeline string — see DEFAULT_FIELDS.production for context.
    if (F.machineCodeAlt) body[F.machineCodeAlt] = h.timeline;
    if (F.timeline) body[F.timeline] = h.timeline;
    if (F.partNum) body[F.partNum] = h.partNumber;
    if (F.partDesc) body[F.partDesc] = h.partDescription;
    if (F.downTime) body[F.downTime] = h.downTime;
    if (F.runTime) body[F.runTime] = h.runTime;
    if (F.handover) body[F.handover] = formatHandover(h.handover);
    if (F.totalGood) {
      const cs = h.countStart;
      const ce = h.countEnd;
      const good = cs != null && ce != null ? Math.max(0, ce - cs - h.reject) : 0;
      body[F.totalGood] = good;
    }
    // PMD_LiveStatus was rebuilt by the user to mirror PMD_Production's
    // schema, but they may not have added every column yet (e.g.
    // JobHead_PartNum). Strip any fields previously rejected by SP for
    // this list so the rest of the row still lands.
    this.stripRejectedFields(list, body);
    // Find existing by composite key; MERGE if found, else POST. Use a ±1d
    // window so legacy rows (written with local-start UTC) are MERGE'd in
    // place rather than ending up as duplicates next to the new noon-UTC row.
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${h.machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${h.shift}' and ${F.jobNumber} eq '${h.jobNumber}'`,
      );
    const existing = await this.getAllItems<Record<string, unknown>>(list, qs);
    const target =
      existing.length > 0
        ? `${this.listUrl(list)}/items(${(existing[0] as { ID?: number; Id?: number }).ID ?? (existing[0] as { ID?: number; Id?: number }).Id})`
        : `${this.listUrl(list)}/items`;
    const ifMatch = existing.length > 0 ? '*' : undefined;
    await this.postWithFieldRetry(list, target, body, ifMatch);
  }

  /** Per-list cache of column internal names that SP has already
   *  rejected with "property X does not exist". upsertHeaderInto strips
   *  these before posting so a missing column on the broker list
   *  doesn't doom every snapshot. */
  private rejectedFields = new Map<string, Set<string>>();

  private stripRejectedFields(list: string, body: Record<string, unknown>): void {
    const banned = this.rejectedFields.get(list);
    if (!banned) return;
    for (const k of banned) delete body[k];
  }

  /** POST that retries once after a "property X does not exist" error,
   *  remembering the offending column so future writes to this list
   *  skip it. The first failed write surfaces a console.warn so the
   *  operator knows which SP column needs adding. */
  private async postWithFieldRetry(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch?: string,
  ): Promise<void> {
    try {
      await this.post(url, body, ifMatch);
    } catch (e) {
      const msg = (e as Error).message || '';
      const m = /property\s+'?([A-Za-z0-9_]+)'?\s+does not exist/i.exec(msg);
      if (!m) throw e;
      const field = m[1];
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
      const retry = { ...body };
      delete retry[field];
      await this.post(url, retry, ifMatch);
    }
  }

  /**
   * Delete every PMD_LiveStatus row matching this (machine, shift,
   * job) tuple. Called at the end of lockShift so the just-signed-off
   * tuple no longer haunts every iPad's Live Status view as an
   * "in-progress" snapshot. Best-effort: a failure leaves a stale row
   * which the next pushLiveSnapshot from anywhere would just refresh,
   * so we surface but don't throw.
   */
  private async deleteLiveRow(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    const F = this.F.production;
    const shift = shiftId.slice(11);
    try {
      await this.deleteByFilter(
        LISTS.liveStatus,
        `${F.machine} eq '${machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${shift}' and ${F.jobNumber} eq '${jobNumber}'`,
      );
    } catch (e) {
      console.warn('[pmd] live row cleanup failed for', { machineCode, shiftId, jobNumber }, e);
    }
  }

  /**
   * Per-shift PMD_BreakDownlog write — one row per (machine, shift, job).
   * StatusTimeline is the 16-char string ("RRRBBBCCCRRRRRRR") so the whole
   * shift's status pattern is recoverable from a single row. R/B/C/D/I/M/
   * O/P/S columns are the per-status hour totals (slot count × 0.5h).
   * BDCode = the most frequent breakdown code among the B slots (the
   * dominant cause). Row count stays tiny — one per signed-off shift+job.
   */
  private async replaceBreakdownEvents(
    key: {
      machineCode: string;
      date: string;
      shift: string;
      jobNumber: string;
      partNumber: string;
      timeline: string;
    },
    slots: ProductionRecord[],
  ): Promise<void> {
    const F = this.F.breakdown;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    await this.deleteByFilter(
      LISTS.breakdown,
      `${F.machine} eq '${key.machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${key.shift}' and ${F.jobNum} eq '${key.jobNumber}'`,
    );
    const type = await this.itemType(LISTS.breakdown);
    // Count per-status slots across the whole shift; each slot = 0.5h.
    const counts: Record<StatusCode, number> = {
      R: 0, B: 0, C: 0, D: 0, I: 0, M: 0, O: 0, P: 0, S: 0,
    };
    const bdTally: Record<string, number> = {};
    for (const r of slots) {
      const c = r.statusCode as StatusCode | '';
      if (c && c in counts) counts[c as StatusCode] += 1;
      if (c === 'B' && r.bdIssue) bdTally[r.bdIssue] = (bdTally[r.bdIssue] ?? 0) + 1;
    }
    const dominantBd = Object.keys(bdTally).sort(
      (a, b2) => bdTally[b2] - bdTally[a],
    )[0] ?? '';
    const body: Record<string, unknown> = {
      __metadata: { type },
      [F.machine]: key.machineCode,
      [F.shift]: key.shift,
      [F.jobNum]: key.jobNumber,
      [F.partNum]: key.partNumber,
      [F.statusTimeline]: key.timeline,
      [F.bdCode]: dominantBd,
      [F.r]: counts.R * 0.5,
      [F.b]: counts.B * 0.5,
      [F.c]: counts.C * 0.5,
      [F.d]: counts.D * 0.5,
      [F.i]: counts.I * 0.5,
      [F.m]: counts.M * 0.5,
      [F.o]: counts.O * 0.5,
      [F.p]: counts.P * 0.5,
      [F.s]: counts.S * 0.5,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    await this.post(`${this.listUrl(LISTS.breakdown)}/items`, body);
  }

  private async replaceRejectEvents(
    key: { machineCode: string; date: string; shift: string; jobNumber: string },
    events: RejectEvent[],
  ): Promise<void> {
    const F = this.F.rejects;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    await this.deleteByFilter(
      LISTS.rejects,
      `${F.machine} eq '${key.machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${key.shift}' and ${F.jobNum} eq '${key.jobNumber}'`,
    );
    for (const ev of events) {
      const body: Record<string, unknown> = {
        __metadata: { type: await this.itemType(LISTS.rejects) },
        // F.machine is mapped to Title; setting it populates Title with the
        // machine code. No separate Machine column exists.
        [F.machine]: key.machineCode,
        [F.shift]: key.shift,
        [F.timeline]: ev.timeline,
        [F.jobNum]: key.jobNumber,
        [F.rejectCode]: ev.code,
        [F.rejectCategory]: ev.category,
        [F.rejectNumber]: ev.qty,
      };
      if (slotStartIso) body[F.date] = slotStartIso;
      await this.post(`${this.listUrl(LISTS.rejects)}/items`, body);
    }
  }

  /** Delete every item matching a pre-built OData $filter clause. */
  private async deleteByFilter(list: string, filterClause: string): Promise<void> {
    const rows = await this.getAllItems<{ ID?: number; Id?: number }>(
      list,
      '$filter=' + encodeURIComponent(filterClause),
    );
    for (const r of rows) await this.del(`${this.listUrl(list)}/items(${r.ID ?? r.Id})`);
  }


  async whoAmI(): Promise<UserContext> {
    const res = await this.getJson<{
      d: { Title: string; Email: string; LoginName: string };
    }>(`${this.siteUrl}/_api/web/currentUser`);
    return { name: res.d.Title || res.d.Email || res.d.LoginName, role: 'operator' };
  }

  // ---- Excel → Planning sync -----------------------------------------

  async syncPlanningFromExcel(): Promise<{ inserted: number; skipped: number }> {
    if (!this.graphToken)
      throw new Error('syncPlanningFromExcel: pass graphToken in SharePointOptions');
    if (!this.planningFilePath)
      throw new Error('syncPlanningFromExcel: pass planningFilePath in SharePointOptions');
    const token = await this.graphToken();
    const headers = { Authorization: `Bearer ${token}` };
    const u = new URL(this.siteUrl);
    const siteId = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname}`,
      { headers },
    )
      .then((r) => r.json() as Promise<{ id: string }>)
      .then((j) => j.id);
    const drivePath = this.planningFilePath.replace(/^Shared Documents\//, '');
    const sheet = encodeURIComponent('Planning');
    const wbBase = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeURI(drivePath)}:/workbook`;

    // Heavy .xlsm with formulas/external links times out on every direct
    // /range call because Graph re-opens + recalculates each time. Open a
    // read-only workbook session first (persistChanges=false), pass the
    // session-id on subsequent calls — Graph reuses the already-loaded
    // workbook and skips recalc, dropping the latency from "504 timeout"
    // territory to a few seconds.
    let sessionId = '';
    try {
      const sRes = await fetch(`${wbBase}/createSession`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ persistChanges: false }),
      });
      if (sRes.ok) {
        sessionId = ((await sRes.json()) as { id: string }).id ?? '';
      }
    } catch {
      /* session is an optimisation, fall back to direct calls */
    }
    const wbHeaders: Record<string, string> = sessionId
      ? { ...headers, 'workbook-session-id': sessionId }
      : headers;

    // Read rows in chunks so even a slow file completes — and stop as soon
    // as we hit a blank row (the planning sheet is contiguous from row 2).
    const CHUNK = 500;
    const MAX_CHUNKS = 10; // 5000-row ceiling
    const values: unknown[][] = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const fromRow = i * CHUNK + 1;
      const toRow = fromRow + CHUNK - 1;
      const rangeUrl = `${wbBase}/worksheets('${sheet}')/range(address='A${fromRow}:R${toRow}')?$select=values`;
      const rangeRes = await fetch(rangeUrl, { headers: wbHeaders });
      if (!rangeRes.ok) {
        if (sessionId) {
          // Best-effort close so the workbook lock releases sooner.
          void fetch(`${wbBase}/closeSession`, { method: 'POST', headers: wbHeaders });
        }
        throw new Error(
          `Graph workbook fetch failed: ${rangeRes.status} ${await rangeRes.text()}`,
        );
      }
      const chunk = ((await rangeRes.json()) as { values: unknown[][] }).values ?? [];
      // Trim trailing blank rows in this chunk; stop if we hit them.
      let lastNonBlank = chunk.length - 1;
      while (lastNonBlank >= 0 && chunk[lastNonBlank].every((c) => c == null || c === '')) {
        lastNonBlank--;
      }
      values.push(...chunk.slice(0, lastNonBlank + 1));
      if (lastNonBlank < chunk.length - 1) break; // hit blank tail → done
    }
    if (sessionId) {
      void fetch(`${wbBase}/closeSession`, { method: 'POST', headers: wbHeaders });
    }
    if (!values || values.length < 2) return { inserted: 0, skipped: 0 };

    const col = (letter: string): number => letter.charCodeAt(0) - 'A'.charCodeAt(0);
    // Column letters per the actual workbook (calibrated 2026-06-01):
    //   A=Machine  B=StartDateTime  C=QtyPerHour  D=Due_Date
    //   E=JobHead_JobNum  F=JobHead_PartNum  G=JobHead_PartDescription
    //   H=Calculated_RemainingQty  O=DIENumber  Q=Duration  R=DIEChange
    const C = {
      machine: col('A'),
      plannedStart: col('B'),
      qtyPerHr: col('C'),
      plannedEnd: col('D'),
      jobNumber: col('E'),
      partNumber: col('F'),
      partDesc: col('G'),
      jobRequired: col('H'),
      dieNumber: col('O'),
      duration: col('Q'),
      dieChange: col('R'),
    };

    let inserted = 0;
    let skipped = 0;
    const fresh: PlanningOrder[] = [];
    for (const r of values.slice(1)) {
      const start = r[C.plannedStart];
      if (start == null || start === '') {
        skipped++;
        continue;
      }
      // Use excelDate strictly — its native `new Date(string)` fallback would
      // re-introduce the UTC-bug for ISO strings ending in Z.
      const ps = excelDate(start);
      if (!ps || !isFinite(ps.getTime())) {
        skipped++;
        continue;
      }
      const dur = Number(r[C.duration]) || 0;
      let pe = excelDate(r[C.plannedEnd]);
      if (!pe || !isFinite(pe.getTime())) {
        // Due_Date blank or unparseable → derive from start + Duration hours
        // so the order is still pickable in the operator sheet's UI.
        pe = new Date(ps.getTime() + dur * 3600_000);
      }
      const machineCode = String(r[C.machine] ?? '').trim();
      fresh.push({
        id: 0,
        jobNumber: String(r[C.jobNumber] ?? '').trim(),
        machineCode,
        originalMachine: machineCode,
        partNumber: String(r[C.partNumber] ?? '').trim(),
        partDescription: String(r[C.partDesc] ?? '').trim(),
        plannedStart: ps.toISOString(),
        plannedEnd: pe.toISOString(),
        jobRequired: Number(r[C.jobRequired]) || 0,
        qtyPerHr: Number(r[C.qtyPerHr]) || 0,
        duration: dur,
        released: true,
        // R = DIEChange column; 'D' / 'Y' / 'TRUE' all count as die-change.
        isDieChange: /^(D|Y|TRUE)$/i.test(String(r[C.dieChange] ?? '').trim()),
        manuallyAdded: false,
        source: 'ERP',
      });
    }

    // Wipe existing rows, then insert fresh ones.
    const existing = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.planning, '$select=ID');
    for (const it of existing) {
      const id = it.ID ?? it.Id;
      if (id) await this.del(`${this.listUrl(LISTS.planning)}/items(${id})`);
    }
    for (const row of fresh) {
      await this.upsertPlanningOrder(row);
      inserted++;
    }
    return { inserted, skipped };
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

// ---- helpers ---------------------------------------------------------

function mergeFieldMap(base: SharePointFieldMap, override?: PartialFieldMap): SharePointFieldMap {
  if (!override) return base;
  const out = { ...base } as SharePointFieldMap;
  for (const k of Object.keys(override) as Array<keyof SharePointFieldMap>) {
    const merged = { ...(base[k] as Record<string, string>), ...(override[k] as Record<string, string>) };
    (out[k] as Record<string, string>) = merged;
  }
  return out;
}

function getId(r: Record<string, unknown>): number {
  const v = (r as { ID?: number; Id?: number }).ID ?? (r as { Id?: number }).Id;
  return typeof v === 'number' ? v : 0;
}

function str(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Coerce a SP "HexColor" cell into a CSS-ready string. Accepts
 *  "#1e3a8a", "1e3a8a", "1E3A8A"; rejects anything that doesn't look
 *  like a 6-digit (or 3-digit) hex so a typo can't pollute inline
 *  styles. Returns '' when invalid. */
function normaliseHex(raw: string): string {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return '';
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullOrNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|y|1)$/i.test(v);
  return undefined;
}

export function dateOnly(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  // SP DateTime is stored UTC. A Sydney Day shift starts 07:00 AEST =
  // 21:00 UTC previous calendar day, so slicing the first 10 chars of
  // the ISO string would shift the shiftId back one day and break every
  // downstream match (KPI shiftIds set, operator sid() comparison,
  // rejects-by-key lookup). Convert UTC back to local, then format the
  // local calendar date — Afternoon and Night sit safely within a single
  // UTC day so this also makes the three shifts symmetric.
  const d = new Date(v);
  if (isNaN(d.getTime())) return v.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDate(v: unknown): string {
  if (typeof v === 'string' && v) return new Date(v).toISOString();
  return '';
}

function parseShiftIdLoose(sid: string): { date: string; shift: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([A-Za-z]+))?/.exec(sid);
  if (!m) return { date: '', shift: '' };
  return { date: m[1], shift: m[2] ?? '' };
}

/**
 * The instant we stamp PMD_Production / PMD_BreakDownlog / PMD_Rejects rows
 * with for a given shift. Midnight UTC of the shift's calendar date.
 *
 * The SP tenant we ship to has its regional setting at Auckland (UTC+12 /
 * +13 NZDT) even though the plant is in Sydney (UTC+10 / +11 AEDT). The
 * earlier choice of noon UTC kept the date stable for negative-offset
 * tenants but slipped a day forward when SP rendered the value in
 * Auckland — the operator reported PMD_Production showing 6/06 in the
 * tooltip while they were working the Sydney 5/06 night shift.
 *
 * Midnight UTC of the shift date works the other way: in any positive
 * regional setting (which is every place this plant could realistically
 * be administered from, +0 through +14) the displayed date is the
 * shift's date, because we add hours to midnight rather than crossing
 * into the next day. Date-Only SP columns also store this correctly —
 * they pick up the date portion of the UTC value as-is.
 *
 * Filters in this file use a ±1-day window so older rows written with
 * the legacy noon-UTC or local-start timestamps still match — no
 * migration required.
 */
function shiftDateMarker(shiftId: string): string {
  return `${shiftId.slice(0, 10)}T00:00:00.000Z`;
}

/** UTC instant for the start (inclusive) and end (inclusive) of a
 *  date-only window padded by 1 day on either side, so both the new
 *  midnight-UTC marker and any legacy local-start timestamps land inside.
 *  `to` defaults to `from` for single-shift queries. */
function shiftDateRange(fromShiftId: string, fDate: string, toShiftId = fromShiftId): string {
  const from = new Date(`${fromShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const to = new Date(`${toShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const lo = new Date(from - 86_400_000).toISOString();
  const hi = new Date(to + 2 * 86_400_000).toISOString();
  return `${fDate} ge datetime'${lo}' and ${fDate} le datetime'${hi}'`;
}

/** Convenience for filters with optional `from` / `to` shiftIds —
 *  returns an empty string when neither bound is set so the caller can
 *  just include it in an `and`-chain. */
function shiftDateRangeFromTo(
  from: string | undefined,
  to: string | undefined,
  fDate: string,
): string {
  if (!from && !to) return '';
  if (from && to) return shiftDateRange(from, fDate, to);
  if (from) {
    const lo = new Date(
      new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime() - 86_400_000,
    ).toISOString();
    return `${fDate} ge datetime'${lo}'`;
  }
  // to-only
  const hi = new Date(
    new Date(`${to!.slice(0, 10)}T00:00:00.000Z`).getTime() + 2 * 86_400_000,
  ).toISOString();
  return `${fDate} le datetime'${hi}'`;
}

function productionMatches(r: ProductionRecord, f: ProductionFilter): boolean {
  if (f.machineCode && r.machineCode !== f.machineCode) return false;
  if (f.shiftId && r.shiftId !== f.shiftId) return false;
  if (f.jobNumber && r.jobNumber !== f.jobNumber) return false;
  if (f.shiftIdFrom && r.shiftId < f.shiftIdFrom) return false;
  if (f.shiftIdTo && r.shiftId > f.shiftIdTo) return false;
  return true;
}

function timelineToSlot(t: string): number {
  if (/^\d+$/.test(t)) return Math.max(0, Math.min(15, Number(t)));
  // Expect "HH:MM-HH:MM" or "HH:MM".
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // Shift starts at 07/15/23 — derive by closest match to 30-min grid from 7am.
  const minutes = h * 60 + min;
  const startCandidates = [7 * 60, 15 * 60, 23 * 60];
  let best = 0;
  for (const start of startCandidates) {
    const span = (minutes - start + 60 * 24) % (60 * 24);
    if (span >= 0 && span < 8 * 60) {
      best = Math.floor(span / 30);
      break;
    }
  }
  return Math.max(0, Math.min(15, best));
}

interface HeaderRow {
  id: number;
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string;
}

interface HeaderInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string; // JSON {people,plant,machine,material} from the canonical slot
}

interface StatusHours {
  R: number;
  B: number;
  C: number;
  D: number;
  I: number;
  M: number;
  O: number;
  P: number;
  S: number;
}

interface RejectRow {
  id: number;
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

interface RejectEvent {
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

/**
 * True if the operator has filled in something worth surfacing on
 * other iPads — a status code on any slot, a counter reading, a
 * reject quantity, a purge weight, or a handover note. Picking a
 * Job# / Operator / Supervisor on its own does *not* count: the
 * editCache row gets created from the very first upsert (typically
 * the Operator select), and pushing that to SP would spam Live
 * Status with empty cards every time someone changed their mind
 * about which order to start.
 */
function hasMeaningfulProgress(slots: ProductionRecord[]): boolean {
  for (const r of slots) {
    if (r.statusCode) return true;
    if (r.countStart != null) return true;
    if (r.countEnd != null) return true;
    if (r.purgeKg != null) return true;
    if (r.rejectCount > 0) return true;
    if (r.rejects && r.rejects !== '{}') return true;
    const note = (r.handoverNote ?? '').trim();
    if (note && note !== '{}') return true;
  }
  return false;
}

function aggregateSlots(slots: ProductionRecord[]): {
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  runTime: number;
  downTime: number;
  hours: StatusHours;
  rejectEvents: RejectEvent[];
  bdCode: string;
  handover: string;
} {
  const timelineArr = Array.from({ length: 16 }, () => '·');
  const hours: StatusHours = { R: 0, B: 0, C: 0, D: 0, I: 0, M: 0, O: 0, P: 0, S: 0 };
  let canonical: ProductionRecord | undefined;
  let reject = 0;
  const rejectEvents: RejectEvent[] = [];
  // Tally BD codes across all B slots so we can pick the most frequent one
  // for PMD_BreakDownlog.BDCode (analytic-level dominant code).
  const bdTally = new Map<string, number>();
  for (const r of slots) {
    if (r.slotIndex === 0) canonical = r;
    if (r.statusCode && r.slotIndex >= 0 && r.slotIndex < 16) {
      timelineArr[r.slotIndex] = r.statusCode;
      const code = r.statusCode as keyof StatusHours;
      if (code in hours) hours[code] += 0.5;
    }
    if (r.statusCode === 'B' && r.bdIssue) {
      bdTally.set(r.bdIssue, (bdTally.get(r.bdIssue) ?? 0) + 1);
    }
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      obj = {};
    }
    const shiftId = r.shiftId;
    const slotLabel = slotClock(shiftId, r.slotIndex) || String(r.slotIndex);
    for (const [code, qty] of Object.entries(obj)) {
      if (!qty) continue;
      reject += qty;
      rejectEvents.push({
        timeline: slotLabel,
        code,
        // RejectCategory = the machine STATUS in that slot (R/D/C/...). Lets
        // Power BI split "defects while running" vs "during a die change" etc.
        category: r.statusCode || 'R',
        qty,
      });
    }
  }
  // Most frequent BD code wins; ties broken by insertion order.
  let bdCode = '';
  let bdMax = 0;
  for (const [code, n] of bdTally) {
    if (n > bdMax) {
      bdMax = n;
      bdCode = code;
    }
  }
  return {
    timeline: timelineArr.join(''),
    countStart: canonical?.countStart ?? null,
    countEnd: canonical?.countEnd ?? null,
    reject,
    operator: canonical?.operator ?? '',
    runTime: hours.R,
    downTime: hours.B + hours.M,
    hours,
    rejectEvents,
    bdCode,
    handover: canonical?.handoverNote ?? '',
  };
}


/** Turn the handover JSON {people,plant,machine,material} into readable text. */
function formatHandover(json: string): string {
  if (!json) return '';
  try {
    const h = JSON.parse(json) as Record<string, string>;
    return (['people', 'plant', 'machine', 'material'] as const)
      .filter((k) => (h[k] ?? '').trim())
      .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${h[k].trim()}`)
      .join('\n');
  } catch {
    return json; // already plain text
  }
}

function excelDate(v: unknown): Date | null {
  if (v == null || v === '') return null;

  // Excel serial — happens when Graph is asked with valuesOnly=true or for
  // workbook ranges where the cell type is numeric DateTime. Decompose the
  // serial as UTC to extract the wall-clock components Excel intended, then
  // rebuild via the local Date constructor so a Sydney user gets 12:00
  // local for a cell that reads "12:00", not 12:00 UTC (= 22:00 Sydney).
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 200000) {
    const utcMs = (v - 25569) * 86400 * 1000;
    const u = new Date(utcMs);
    return new Date(
      u.getUTCFullYear(),
      u.getUTCMonth(),
      u.getUTCDate(),
      u.getUTCHours(),
      u.getUTCMinutes(),
      u.getUTCSeconds(),
    );
  }

  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // Graph routinely returns ISO 8601 strings like "2026-05-25T12:00:00.000Z"
  // for DateTime cells. Excel has no timezone — the "12:00" the user typed
  // is wall-clock, not UTC. Parsing via `new Date()` would treat the Z as
  // UTC and shift everything by the local offset (Sydney AEST: 10 hours,
  // which is the "10:00 PM" symptom reported). Extract the components and
  // anchor them to local time instead. The time portion is optional so
  // bare "2026-05-25" from a CSV with date-only columns is accepted too.
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/i.exec(
      s,
    );
  if (iso) {
    return new Date(
      +iso[1], +iso[2] - 1, +iso[3],
      iso[4] ? +iso[4] : 0,
      iso[5] ? +iso[5] : 0,
      iso[6] ? +iso[6] : 0,
    );
  }

  // AU date with optional time, e.g. "25/05/2026", "25/05/2026 14:00",
  // or "25/05/2026 2:00:00 PM". JS's native parser is unreliable here
  // because en-US engines flip to MM/DD interpretation.
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(s);
  if (au) {
    let hour = au[4] ? parseInt(au[4], 10) : 0;
    if (au[7]) {
      const isPm = au[7].toLowerCase() === 'pm';
      if (isPm && hour < 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
    }
    return new Date(
      +au[3], +au[2] - 1, +au[1],
      hour, au[5] ? +au[5] : 0, au[6] ? +au[6] : 0,
    );
  }

  return null;
}

function bdFallback(): BdCode[] {
  return BD_TAXONOMY.map((c, i) => ({
    code: c.code,
    label: c.cause,
    subCategory: bdCategoryOf(c.code)?.label ?? '',
    sequence: i + 1,
    owner: c.owner,
  }));
}

// Used by trace view bd label fallback (re-exported so consumers don't
// have to dig into ../core/breakdown directly when working with codes
// surfaced from SharePoint).
export { bdLabelFor };

/** Duck-typed check used by the UI to know if the active DAL can sync. */
export function canSyncPlanning(
  dal: unknown,
): dal is { syncPlanningFromExcel: () => Promise<{ inserted: number; skipped: number }> } {
  return typeof (dal as { syncPlanningFromExcel?: unknown })?.syncPlanningFromExcel === 'function';
}

// ---------------------------------------------------------------------------
// CSV parsing for the Epicor → CSV → SharePoint file → app pipeline.
// Tiny single-purpose parser: handles quoted fields with embedded commas
// and double-double-quote escapes; ignores BOM and CRLF/LF line endings.
// ---------------------------------------------------------------------------

export function parsePlanningCsv(text: string): PlanningOrder[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.trim());
  const idx = (name: string): number => header.indexOf(name);
  const iJob = idx('JobHead_JobNum');
  const iPart = idx('JobHead_PartNum');
  const iDesc = idx('JobHead_PartDescription');
  const iRem = idx('Calculated_RemainingQty');
  const iStart = idx('JobHead_StartDate');
  const iDue = idx('JobHead_ReqDueDate');
  const iDur = idx('Calculated_RemaingLaborHrs');
  const iQty = idx('JobOper_ProdStandard');
  const out: PlanningOrder[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    const job = row[iJob] ?? '';
    if (!job) continue;
    const startIso = csvDateToIso(row[iStart] ?? '');
    const dueIso = csvDateToIso(row[iDue] ?? '');
    const dur = parseFloat(row[iDur] ?? '0') || 0;
    const end = startIso && dur > 0
      ? new Date(new Date(startIso).getTime() + dur * 3600_000).toISOString()
      : dueIso;
    out.push({
      id: 0,
      jobNumber: job,
      machineCode: '',
      originalMachine: '',
      // Trim Part # so a stray trailing space in the Excel cell can't
      // break the PMD_ProductDieColor Map lookup (operator swatch +
      // KPIs colour column both key on this).
      partNumber: (row[iPart] ?? '').trim(),
      partDescription: row[iDesc] ?? '',
      plannedStart: startIso,
      plannedEnd: end,
      jobRequired: parseFloat(row[iRem] ?? '0') || 0,
      qtyPerHr: parseFloat(row[iQty] ?? '0') || 0,
      duration: dur,
      released: true,
      isDieChange: false,
      manuallyAdded: false,
      source: 'ERP',
    });
  }
  return out;
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip — \n handles the row break
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function csvDateToIso(s: string): string {
  // PowerShell emits ISO; manually-edited CSVs sometimes carry en-AU
  // dd/mm/yyyy [HH:mm[:ss] [am/pm]] or bare dates. excelDate already
  // handles all three, including the wall-clock-as-local rule needed
  // to keep Sydney-typed times from shifting by the UTC offset.
  return excelDate(s)?.toISOString() ?? '';
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
