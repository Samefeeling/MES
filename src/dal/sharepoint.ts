import type {
  BdCode,
  Machine,
  Operator,
  ParetoFilter,
  ParetoSlice,
  PlanningFilter,
  PlanningOrder,
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
import { shiftBounds, slotClock } from '../core/shifts';

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
    // Total order quantity from Epicor — feeds "Order Qty".
    prodQty: 'JobHead_ProdQty',
    // Remaining quantity from Epicor — feeds "Job left".
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
    /** Total job quantity at sign-off time, denormalised so the
     *  operator UI can render Order Qty after Epicor drops a
     *  completed order from PMD_Planning. Optional column on the
     *  tenant; strip-rejected-fields tolerates absence. */
    jobRequired: 'JobRequired',
    countStart: 'CountStart',
    countEnd: 'CountEnd',
    reject: 'Reject',
    operator: 'Operator',
    supervisor: 'Supervisor',
    runTime: 'RunTime',
    downTime: 'Downtime',
    handover: 'Handover',
    totalGood: 'TotalGood',
    // Per-slot QC sign-off, stored as JSON {"<slotIndex>":"<name>"}.
    // Column added to PMD_Production / PMD_LiveStatus to record
    // alternating operator / supervisor quality checks across the
    // shift's 16 half-hour slots.
    qcChecks: 'QualityChecks',
    // Per-slot per-code reject map, JSON {"<slotIndex>":{"<code>":qty}}.
    // PMD_Rejects (event list) is only populated on sign-off, so live
    // shifts on PMD_LiveStatus had no path for reject breakdowns to
    // reach other iPads — Machine Status / QC / Count Start / Count
    // End round-tripped via dedicated columns; rejects didn't. This
    // column closes that gap. The read path prefers PMD_Rejects events
    // when present, falling back to this JSON for live (unsigned) rows.
    rejectsBySlot: 'RejectsBySlot',
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
    // Product category (e.g. "Battens") — groups the KPI TOTAL row
    // into per-category subtotals.
    category: 'Category',
  },
} as const;

export type SharePointFieldMap = typeof DEFAULT_FIELDS;
export type PartialFieldMap = {
  [K in keyof SharePointFieldMap]?: Partial<SharePointFieldMap[K]>;
};

export interface SharePointOptions {
  siteUrl: string;
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
  /**
   * Tuples (`machine|shiftId|jobNumber`) that the supervisor has just
   * unlocked from a signed-off state. While a tuple is in this set,
   * the listProduction self-heal will NOT purge its editCache entry
   * even though PMD_Production still carries the (locked) header —
   * those slots are the active editable copy. Cleared when lockShift
   * commits the edits back. Persisted alongside editCache so a page
   * reload mid-edit doesn't strand the operator with a "locked" UI
   * over their freshly-unlocked cache.
   */
  private unlockedTuples = new Set<string>();
  private static readonly UNLOCKED_TUPLES_KEY = 'pmd_unlocked_tuples_v1';
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
    this.planningCsvPath = o.planningCsvPath;
    // Merge user overrides into the defaults.
    this.F = mergeFieldMap(DEFAULT_FIELDS, o.fieldMap);
    this.rehydrateEditCache();
    this.rehydrateUnlockedTuples();
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

  private rehydrateUnlockedTuples(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointDataLayer.UNLOCKED_TUPLES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as string[];
      for (const k of parsed) this.unlockedTuples.add(k);
    } catch (e) {
      console.warn('[pmd] could not rehydrate unlocked tuples:', e);
    }
  }

  private persistUnlockedTuples(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        SharePointDataLayer.UNLOCKED_TUPLES_KEY,
        JSON.stringify(Array.from(this.unlockedTuples)),
      );
    } catch (e) {
      console.warn('[pmd] could not persist unlocked tuples:', e);
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
      shift: str(r[F.shift]).trim(),
    }));
  }

  async listSupervisors(): Promise<Supervisor[]> {
    // Supervisors are now derived from the distinct Supervisor_1 column
    // on PMD_Operator (a free-text field on each operator's row), not
    // from the separate PMD_Supervisor list. Drops the Lookup column
    // and the second REST round-trip on every boot — listOperators
    // already brings these rows back, so in practice this is free.
    // A supervisor named on operator rows of more than one shift is
    // emitted once per (name, shift) so the operator sheet's roster
    // filter can surface them on each shift they cover.
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    const seen = new Set<string>();
    const out: Supervisor[] = [];
    for (const r of rows) {
      const name = str(r[F.supervisor1]).trim();
      if (!name) continue;
      const shift = str(r[F.shift]).trim();
      const key = `${name}|${shift}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: out.length + 1, operatorName: name, active: true, shift });
    }
    return out;
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
      // Direct field reads against the PartNum / ColorHex / ActualColor /
      // Category columns. Keep rows that carry a category even when the
      // hex is missing / invalid: they can't drive a swatch but still
      // bucket their part into the right KPI category subtotal.
      const direct = rows
        .map((r) => ({
          partNumber: str(r[F.partNum]).trim(),
          hex: normaliseHex(str(r[F.hex])),
          name: str(r[F.name]).trim(),
          category: str(r[F.category]).trim(),
        }))
        .filter((c) => c.partNumber && (c.hex || c.category));
      console.info('[pmd] PMD_ProductDieColor cached:', direct.length, 'of', rows.length, 'rows');
      this.dieColorCache = direct;
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
        // Order Qty = total ProdQty; fall back to the remaining qty so the
        // field is never blank on a tenant that hasn't surfaced ProdQty yet.
        orderQty: num(r[F.prodQty]) || num(r[F.remaining]) || 0,
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

  // ---- management Pareto aggregations --------------------------------

  /**
   * Reject Pareto straight from PMD_Rejects — no production-record JSON
   * round-trip. Groups RejectNumber by RejectCode; each slice's label is
   * the RejectCategory carried on the rows (the dominant one when a code
   * spans categories). Server-side lower-bounds the DateTime so the fetch
   * stays small, then filters the exact [from, to] day window client-side.
   */
  async listRejectPareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.rejects;
    const parts: string[] = [this.dateLowerBound(F.date, filter.from)];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    const qs = '$filter=' + encodeURIComponent(parts.join(' and '));
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.rejects, qs);
    } catch (e) {
      console.warn('[pmd] listRejectPareto: PMD_Rejects read failed', e);
      return [];
    }
    const qty = new Map<string, number>();
    const catTally = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.rejectCode]).trim();
      if (!code) continue;
      const n = num(r[F.rejectNumber]);
      if (n <= 0) continue;
      qty.set(code, (qty.get(code) ?? 0) + n);
      const cat = str(r[F.rejectCategory]).trim();
      if (cat) {
        const m = catTally.get(code) ?? new Map<string, number>();
        m.set(cat, (m.get(cat) ?? 0) + n);
        catTally.set(code, m);
      }
    }
    return paretoFrom(qty, (code) => dominantKey(catTally.get(code)) || code);
  }

  /**
   * Downtime Pareto from PMD_BreakDownlog — sums the B_BreakDown hours per
   * BDCode (the clearest single attribution the log carries). Label is the
   * breakdown cause from the taxonomy. Rows with a blank BDCode or zero
   * breakdown hours contribute nothing.
   */
  async listDowntimePareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.breakdown;
    const parts: string[] = [this.dateLowerBound(F.date, filter.from)];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    const qs = '$filter=' + encodeURIComponent(parts.join(' and '));
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.breakdown, qs);
    } catch (e) {
      console.warn('[pmd] listDowntimePareto: PMD_BreakDownlog read failed', e);
      return [];
    }
    const hrs = new Map<string, number>();
    for (const r of rows) {
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.bdCode]).trim();
      if (!code) continue;
      const h = num(r[F.b]);
      if (h <= 0) continue;
      hrs.set(code, (hrs.get(code) ?? 0) + h);
    }
    return paretoFrom(hrs, (code) => bdLabelFor(code) || code);
  }

  /** Lower-bound clause on a DateTime column, one calendar day before
   *  `fromDate` to cushion the noon-UTC marker / legacy local-start rows.
   *  The exact day window is then enforced client-side via dateOnly. */
  private dateLowerBound(field: string, fromDate: string): string {
    const d = new Date(`${fromDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return `${field} ge datetime'${d.toISOString()}'`;
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
    // Hydrate header rows from PMD_Production (signed-off) AND
    // PMD_LiveStatus (in-progress mirror) first — precedence is
    //   signed-off  >  local editCache  >  live mirror.
    // Signed-off is the immutable record of truth: once a (machine,
    // shift, job) has a PMD_Production header, any editCache rows for
    // the same tuple are stale by definition (taps that slipped in
    // around sign-off, or another iPad's pre-sign-off localStorage)
    // and must not shadow it — that's how a signed-off order with 53
    // goods rendered as an empty, editable timeline. Purge them.
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

    // Self-heal: drop editCache entries whose tuple is already signed
    // off. lockShift deletes the cache on the device that signed off,
    // but other iPads (or a tap that raced the sign-off) can still
    // hold stale rows in localStorage.
    const signedKeys = new Set(
      prodHeaders
        .filter(matchesFilter)
        .map((h) => this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber)),
    );
    let purged = false;
    for (const k of Array.from(this.editCache.keys())) {
      if (!signedKeys.has(k)) continue;
      // Active "unlock & edit": the supervisor unlocked this tuple
      // and the editCache holds the rehydrated rows that the operator
      // is currently editing. PMD_Production still carries the
      // (locked) row because the new unlock design does NOT delete
      // it on the SP side — that's the whole point of the redesign.
      // Self-heal would otherwise wipe the operator's edits the next
      // time anything reads the production list.
      if (this.unlockedTuples.has(k)) continue;
      this.editCache.delete(k);
      purged = true;
    }

    // Drop "junk" PMD_LiveStatus rows: shift ended > 8 h ago AND no
    // MachineStatus letter on any slot. These accumulate when an
    // operator taps a machine, picks a wrong job (or just lands on
    // the wrong shift / date), maybe types a Count Start, and walks
    // away — pushLiveSnapshot had already mirrored the partial cache
    // and there was no path to clean it up. Without this filter, the
    // backfill loop below absorbs them into editCache and shadows
    // the legitimate PMD_Production row when an operator scrolls
    // back to review a past shift. Also fire-and-forget delete the
    // junk from PMD_LiveStatus so the SP list itself stays tidy.
    const liveNow = new Date();
    const liveFresh: HeaderRow[] = [];
    for (const h of liveHeaders) {
      if (isStaleLiveHeader(h, liveNow)) {
        void this.deleteLiveRow(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      } else {
        liveFresh.push(h);
      }
    }
    // GC editCache: drop any status-empty tuple whose shift ended > 8 h
    // ago. UNCONDITIONAL — this must run even when there are no stale
    // server rows left to react to (e.g. the supervisor already deleted
    // the junk from PMD_LiveStatus by hand). Gating it on "saw a stale
    // server row" was the bug that let pushLiveSnapshot keep re-mirroring
    // the local copy straight back onto the list. Status-empty only here
    // so we never drop real local work; OLD rows that carry status are
    // left in the cache but pushLiveSnapshot refuses to re-broadcast them.
    for (const k of Array.from(this.editCache.keys())) {
      const slots = this.editCache.get(k) ?? [];
      if (slots.some((s) => s.statusCode)) continue;
      const sid = k.split('|')[1];
      if (sid && shiftEndedLongAgo(sid, liveNow)) {
        this.editCache.delete(k);
        purged = true;
      }
    }
    if (purged) this.persistEditCache();

    // Backfill editCache from PMD_LiveStatus per slot. PMD_LiveStatus
    // is pushed every 60 s from whichever iPad is editing, and is the
    // only durable source for in-progress slots — if localStorage is
    // stale (page reload between snapshot pushes, fresh device, cleared
    // cache, asset redeploy that forced a refresh) the local cache can
    // be missing slots the broker actually has. Without this merge a
    // subsequent Sign Off & Save aggregates only the local cache and
    // burns a partial timeline into PMD_Production — exactly the
    // SFM507068 14:23 incident.
    //
    // editCache wins per slot: its slots are strictly fresher than the
    // 60 s mirror, and a slot the operator just blanked must not be
    // re-filled from the older snapshot. We only ADD slots LiveStatus
    // has that editCache lacks. Tuples that are already signed off are
    // skipped — PMD_Production is canonical past sign-off.
    let backfilled = false;
    for (const h of liveFresh) {
      if (!matchesFilter(h)) continue;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      if (signedKeys.has(key)) continue;
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: timelinesByKey.get(key) ?? '' };
      const liveSlots = this.expandHeaderToSlots(
        hWithTimeline,
        rejectsByKey.get(key) ?? [],
        false,
      );
      const existing = this.editCache.get(key) ?? [];
      const haveSlot = new Set(existing.map((s) => s.slotIndex));
      let added = false;
      for (const ls of liveSlots) {
        if (haveSlot.has(ls.slotIndex)) continue;
        existing.push(ls);
        added = true;
      }
      if (added) {
        this.editCache.set(key, existing);
        backfilled = true;
      }
    }
    if (backfilled) this.persistEditCache();

    // Local edits for tuples that are NOT signed off.
    const cached: ProductionRecord[] = [];
    for (const list of this.editCache.values()) {
      for (const r of list) if (productionMatches(r, filter)) cached.push(r);
    }
    const seen = new Set(cached.map((r) => this.cacheKey(r.machineCode, r.shiftId, r.jobNumber)));

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
    };

    // Signed-off first so it wins any (rare) overlap with a not-yet-
    // deleted live row.
    for (const h of prodHeaders) ingest(h, true);
    // Live rows already merged into editCache above; the ingest pass
    // still runs them to cover tuples that fall outside the editCache
    // filter (e.g. cross-machine Live Status board reads) — the
    // seen-set dedups any already-emitted tuple.
    for (const h of liveFresh) ingest(h, false);
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
      partDescription: F.partDesc ? str(r[F.partDesc]) : '',
      jobRequired: F.jobRequired ? num(r[F.jobRequired]) : 0,
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
      // Handover is the JSON {machine,mold,material,method} blob (the
      // "4M"), stored when the shift was signed off. Used by the
      // operator side-panel textareas and the KPI Handover column.
      handover: F.handover ? str(r[F.handover]) : '',
      qcChecks: F.qcChecks ? str(r[F.qcChecks]) : '',
      rejectsBySlot: F.rejectsBySlot ? str(r[F.rejectsBySlot]) : '',
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
    // QualityChecks JSON {"<slotIndex>":"<name>"} → per-slot qcBy.
    // Bare-string fallback so a column that pre-dates the JSON format
    // (or has been mis-edited in SP directly) still surfaces something
    // useful instead of swallowing the value.
    let qcMap: Record<string, string> = {};
    if (h.qcChecks) {
      try {
        const parsed = JSON.parse(h.qcChecks);
        if (parsed && typeof parsed === 'object') {
          qcMap = parsed as Record<string, string>;
        }
      } catch {
        /* not JSON — ignore */
      }
    }
    for (let i = 0; i < 16; i++) {
      const ch = timeline[i];
      const blank = ch === '·' || ch === ' ' || !ch;
      // Materialise a slot record when either the status is filled OR a
      // QC sign-off exists for this slot — otherwise a QC done before
      // production was logged would be silently dropped on round-trip.
      if (blank && !qcMap[String(i)]) continue;
      slots.push({
        id: 0,
        machineCode: h.machineCode,
        shiftId,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        partDescription: h.partDescription,
        slotIndex: i,
        statusCode: blank ? '' : (ch as ProductionRecord['statusCode']),
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
        qcBy: qcMap[String(i)] ?? '',
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
        partDescription: h.partDescription,
        jobRequired: h.jobRequired,
        slotIndex: 0,
        statusCode: '',
        countStart: h.countStart,
        countEnd: h.countEnd,
        // PMD_Rejects is the source of truth. When events exist they
        // fully populate per-slot rejectCount below, so seed slot 0 at 0
        // to avoid blending a stale PMD_Production.Reject column total
        // with the event total (the 20-vs-28 drift). Only fall back to
        // the column when there are NO events at all (legacy rows signed
        // off before PMD_Rejects existed, or live rows pre-sign-off).
        rejectCount: rejects.length ? 0 : h.reject,
        rejects: '{}',
        purgeKg: null,
        operator: h.operator,
        supervisor: h.supervisor,
        bdIssue: '',
        mangoTicket: '',
        handoverNote: h.handover,
        qcBy: qcMap['0'] ?? '',
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
      // Same for jobRequired — the per-status slot was created
      // first with jobRequired left blank, but the canonical totals
      // live on slot 0 by convention.
      slots[0].jobRequired = h.jobRequired;
      // And the reject total: the per-status loop initialises
      // rejectCount to 0. Only stamp the column total when there are NO
      // PMD_Rejects events — when events exist they are the source of
      // truth and populate per-slot rejectCount below (see slot-0 seed
      // comment above). This is what stops a stale Reject column from
      // shadowing the real event total on read.
      if (rejects.length === 0) slots[0].rejectCount = h.reject;
    }
    // PMD_Rejects events take precedence (signed-off shifts), but for
    // live (unsigned) rows the events list is empty — fall back to the
    // RejectsBySlot JSON column on PMD_LiveStatus so other iPads see
    // the per-slot per-code breakdown without waiting for sign-off.
    if (rejects.length === 0 && h.rejectsBySlot) {
      let rbsMap: Record<string, Record<string, number>> = {};
      try {
        const parsed = JSON.parse(h.rejectsBySlot);
        if (parsed && typeof parsed === 'object') {
          rbsMap = parsed as Record<string, Record<string, number>>;
        }
      } catch {
        /* not JSON — ignore */
      }
      for (const [slotKey, codes] of Object.entries(rbsMap)) {
        const slotIdx = Number(slotKey);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= 16) continue;
        let target = slots.find((s) => s.slotIndex === slotIdx);
        if (!target) {
          // Reject logged on a slot that has no status set yet — give it
          // a placeholder row so the operator grid can render the count.
          target = {
            id: 0,
            machineCode: h.machineCode,
            shiftId,
            jobNumber: h.jobNumber,
            partNumber: h.partNumber,
            partDescription: h.partDescription,
            slotIndex: slotIdx,
            statusCode: '',
            countStart: null,
            countEnd: null,
            rejectCount: 0,
            rejects: '{}',
            purgeKg: null,
            operator: '',
            supervisor: '',
            bdIssue: '',
            mangoTicket: '',
            handoverNote: '',
            qcBy: '',
            locked: isSignedOff,
            lockedBy: h.supervisor,
            lockedAt: stamp,
            createdAt: stamp,
            updatedAt: stamp,
          };
          slots.push(target);
        }
        let obj: Record<string, number> = {};
        try {
          obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
        } catch {
          /* keep {} */
        }
        for (const [code, qty] of Object.entries(codes)) {
          const n = Number(qty);
          if (!n) continue;
          obj[code] = (obj[code] || 0) + n;
        }
        target.rejects = JSON.stringify(obj);
        target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
      }
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
    jobNumber?: string,
  ): Promise<void> {
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const ownKey = (job: string): string => this.cacheKey(machineCode, shiftId, job);
    const myTuples: ProductionRecord[][] = [];
    for (const [key, list] of this.editCache) {
      if (!key.startsWith(`${machineCode}|${shiftId}|`)) continue;
      // Sign-off is per (machine, shift, JOB): when the supervisor is
      // signing off SFM507006, an operator's in-progress SFM507057 on
      // the same press/shift must NOT be swept up and locked with it —
      // they're still filling the remaining timeline slots.
      if (jobNumber && key !== ownKey(jobNumber)) continue;
      myTuples.push(list);
    }
    if (myTuples.length === 0) {
      // Nothing in editCache for this (machine, shift[, job]) — there
      // is literally nothing to write. Crucially, do NOT push a
      // placeholder header here: upsertHeaderInto's MERGE-if-exists
      // path would PATCH a real PMD_Production row with all-blank
      // values, which is exactly the SFM507068 data-loss path we just
      // redesigned away. If the supervisor pressed Sign Off without
      // any local edits (e.g. on a freshly unlocked shift to confirm
      // "yes, the existing numbers are fine"), the existing row stays
      // as-is and the unlock flag clears below.
      this.unlockedTuples.delete(ownKey(jobNumber ?? ''));
      this.persistUnlockedTuples();
      return;
    }
    // Single planning lookup (per machine) for FALLBACK only. The
    // rehydrated editCache slots already carry the canonical
    // partNumber / partDescription that came back from the existing
    // signed-off row — those are the truth. Planning is consulted
    // only when the cache lacks them (fresh in-progress order).
    // Without this, a re-sign-off after unlock would overwrite the
    // header with whatever the CURRENT planning CSV says, and Epicor
    // drops completed orders from planning — blanking the
    // PartNum / Description columns on the existing row.
    const orders = await this.listPlanning({ machineCode });
    const partNumOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partNumber)?.partNumber;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partNumber ?? '';
    };
    const partDescOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partDescription)?.partDescription;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partDescription ?? '';
    };
    // The denormalised PMD_Production "JobRequired" column carries the order
    // total (Order Qty / JobHead_ProdQty), not the remaining qty — it exists
    // so the UI can show Order Qty after Epicor drops a completed order.
    const jobRequiredOf = (job: string, slots: ProductionRecord[]): number => {
      const fromCache = slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.orderQty ?? 0;
    };
    for (const slots of myTuples) {
      const job = slots[0]?.jobNumber ?? jobNumber ?? '';
      const agg = aggregateSlots(slots);
      const tag = `${machineCode}|${shiftId}|${job}`;
      const partNum = partNumOf(job, slots);
      const partDesc = partDescOf(job, slots);
      const required = jobRequiredOf(job, slots);
      // PMD_Rejects is the source of truth. agg.reject is by construction
      // Σ agg.rejectEvents (same loop), and those events are what
      // replaceRejectEvents writes below — so whenever per-slot detail
      // exists, the Reject column, RejectsBySlot and TotalGood all derive
      // from the SAME event set and cannot drift. The drift we hit on
      // SFM507067 (column 20 vs events 28) came from the READ path
      // blending a stale column total into slot 0; that is fixed in
      // expandHeaderToSlots, so a rehydrated re-sign-off now re-aggregates
      // the real events and self-heals the column.
      //
      // The `|| canon.rejectCount` fallback ONLY fires for a legacy row
      // that has a Reject column total but no PMD_Rejects events at all
      // (per-code detail destroyed by an old broken-unlock incident).
      // There is nothing to re-derive from, so preserving the surviving
      // total beats zeroing it — and since there are no events, the
      // column is still the only record, so this introduces no drift.
      const canon = slots.find((s) => s.slotIndex === 0);
      const reject = agg.reject || (canon?.rejectCount ?? 0);
      try {
        await this.upsertProductionHeader({
          machineCode,
          date,
          shift,
          jobNumber: job,
          partNumber: partNum,
          partDescription: partDesc,
          jobRequired: required,
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject,
          operator: operator || agg.operator,
          supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
          qcChecks: agg.qcChecks,
          rejectsBySlot: agg.rejectsBySlot,
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
            partNumber: partNum,
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
      const tupleKey = ownKey(job);
      this.editCache.delete(tupleKey);
      this.unlockedTuples.delete(tupleKey);
    }
    this.persistEditCache();
    this.persistUnlockedTuples();
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
    const now = new Date();
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
      // Never mirror a shift that is well over. PMD_LiveStatus is an
      // IN-PROGRESS board; an old un-signed-off tuple that is still
      // sitting in THIS device's localStorage editCache (e.g. an
      // abandoned 03/06 experiment, or a mis-tap from days ago) must
      // not be re-broadcast every 60 s poll tick. That re-broadcast is
      // exactly why rows deleted by hand from PMD_LiveStatus kept
      // reappearing: deleting the server row never touched the device
      // cache that recreated it. shiftEndedLongAgo also covers the
      // no-status junk, but the key win here is that it catches OLD
      // rows that DO carry status, which the listProduction junk
      // filter deliberately leaves alone.
      if (shiftEndedLongAgo(shiftId, now)) continue;
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
          jobRequired: 0,
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject: agg.reject,
          operator: canon.operator,
          supervisor: canon.supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
          qcChecks: agg.qcChecks,
          rejectsBySlot: agg.rejectsBySlot,
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
    // Redesigned 2026-06-16 (SFM507068 incident): unlock is now
    // PURELY a client-side rehydrate + mark. The signed-off
    // PMD_Production / PMD_BreakDownlog / PMD_Rejects rows STAY on
    // the SharePoint side untouched. lockShift's upsertHeaderInto
    // already merges-if-exists, so the re-sign-off path PATCHes the
    // existing row by ID rather than POSTing a fresh one — original
    // PartNum, PartDescription, Counts, Timeline and Rejects survive
    // any abandonment, network failure, or planning-CSV ageing
    // (Epicor drops completed orders from planning, which the old
    // delete-then-rewrite path then wrote back as empty PartNum).
    //
    // The tuple is added to `unlockedTuples` so the listProduction
    // self-heal does not purge the editCache rows back out (PMD_
    // Production still carries the locked header so signedKeys would
    // otherwise match). lockShift clears the flag on successful
    // commit. The flag is persisted alongside editCache so a page
    // reload mid-edit doesn't strand the operator.
    const existing = await this.listProduction({
      machineCode,
      shiftId,
      ...(jobNumber ? { jobNumber } : {}),
    });
    let touchedAnyTuple = false;
    for (const r of existing) {
      const rehydrated: ProductionRecord = {
        ...r,
        locked: false,
        lockedBy: '',
        lockedAt: '',
      };
      const key = this.cacheKey(r.machineCode, r.shiftId, r.jobNumber);
      const list = this.editCache.get(key) ?? [];
      // Don't clobber any in-flight edits already in cache for the
      // same slot — `existing` may include unsigned slots when
      // listProduction also returns LiveStatus rows.
      if (!list.some((s) => s.slotIndex === r.slotIndex)) list.push(rehydrated);
      this.editCache.set(key, list);
      this.unlockedTuples.add(key);
      touchedAnyTuple = true;
    }
    this.persistEditCache();
    if (touchedAnyTuple) this.persistUnlockedTuples();
  }

  isUnlockedTuple(machineCode: string, shiftId: string, jobNumber: string): boolean {
    return this.unlockedTuples.has(this.cacheKey(machineCode, shiftId, jobNumber));
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
    // Only write JobRequired when non-zero. 0 here usually means the
    // editCache had no rehydrated value (older rows pre-denormalisation)
    // — writing 0 over a real existing value via the MERGE path would
    // blank it. stripRejectedFields tolerates absence of the column.
    if (F.jobRequired && h.jobRequired > 0) body[F.jobRequired] = h.jobRequired;
    if (F.downTime) body[F.downTime] = h.downTime;
    if (F.runTime) body[F.runTime] = h.runTime;
    if (F.handover) body[F.handover] = formatHandover(h.handover);
    if (F.qcChecks) body[F.qcChecks] = h.qcChecks;
    if (F.rejectsBySlot) body[F.rejectsBySlot] = h.rejectsBySlot;
    if (F.totalGood) {
      const cs = h.countStart;
      const ce = h.countEnd;
      const good = cs != null && ce != null ? Math.max(0, ce - cs - h.reject) : 0;
      body[F.totalGood] = good;
    }
    // SharePoint rejects C0/C1 control characters (NUL, etc.) in text
    // columns with a generic 500 "Invalid text value. A text field
    // contains invalid data." that doesn't say WHICH column. Strip them
    // out of every string value in the body so a stray paste from
    // Excel/Epicor or a zero-width oddity in a handover note can't fail
    // the whole sign-off. Whitespace (\t \n \r) is preserved.
    sanitizeBodyStrings(body);
    // PMD_LiveStatus was rebuilt by the user to mirror PMD_Production's
    // schema, but they may not have added every column yet (e.g.
    // JobHead_PartNum). Strip any fields previously rejected by SP for
    // this list so the rest of the row still lands.
    this.stripRejectedFields(list, body);
    // Find existing by composite key; MERGE if found, else POST. The
    // fetch uses the ±1d window for legacy-timestamp tolerance, but the
    // MERGE target must then be narrowed to the EXACT calendar date —
    // the window also matches the same shift code on adjacent days
    // (same job running Day shift on consecutive days is normal), and
    // merging into yesterday's row destroys yesterday's signed-off
    // record while leaving today unreadable.
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${h.machineCode}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${h.shift}' and ${F.jobNumber} eq '${h.jobNumber}'`,
      );
    const windowRows = await this.getAllItems<Record<string, unknown>>(list, qs);
    const existing = windowRows.filter((r) => dateOnly(r[F.date]) === h.date);
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
      const missing = /property\s+'?([A-Za-z0-9_]+)'?\s+does not exist/i.exec(msg);
      if (missing) {
        const field = missing[1];
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
        return;
      }
      if (/Invalid text value/i.test(msg)) {
        const culprit = await this.findInvalidTextField(list, url, body, ifMatch);
        if (culprit) return; // findInvalidTextField already wrote the body minus the offender
      }
      throw e;
    }
  }

  /** Bisect the string-valued fields of a SP body to find the one that
   *  triggers "Invalid text value". Returns the offending field name and
   *  leaves the row written (minus that field) on success — or null if
   *  removing none of them helps (in which case the caller re-throws the
   *  original error). Stops as soon as one removal succeeds. Order:
   *  longest values first, since the most common cause is a JSON payload
   *  (QualityChecks, RejectsBySlot) overflowing a column that was
   *  accidentally provisioned as Single line text (255-char limit). */
  private async findInvalidTextField(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch: string | undefined,
  ): Promise<string | null> {
    const textKeys = Object.keys(body)
      .filter(
        (k) =>
          k !== '__metadata' && typeof body[k] === 'string' && (body[k] as string).length > 0,
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
        return k;
      } catch (e) {
        if (!/Invalid text value/i.test((e as Error).message || '')) throw e;
      }
    }
    return null;
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
        { field: F.date, date: shiftId.slice(0, 10) },
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
      { field: F.date, date: key.date },
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
      { field: F.date, date: key.date },
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
  private async deleteByFilter(
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
    return { name: res.d.Title || res.d.Email || res.d.LoginName, role: 'operator' };
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

/** Build a value-descending ParetoSlice[] from a code→value tally. */
function paretoFrom(
  tally: Map<string, number>,
  labelFor: (code: string) => string,
): ParetoSlice[] {
  return Array.from(tally.entries())
    .map(([code, value]) => ({ code, label: labelFor(code), value: +value.toFixed(2) }))
    .sort((a, b) => b.value - a.value);
}

/** The key with the largest tallied value (e.g. dominant RejectCategory
 *  for a code), or '' when the map is empty. */
function dominantKey(m: Map<string, number> | undefined): string {
  if (!m) return '';
  let best = '';
  let bestN = -1;
  for (const [k, n] of m) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
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
  partDescription: string;
  jobRequired: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string;
  qcChecks: string;
  rejectsBySlot: string;
}

interface HeaderInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  jobRequired: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string; // JSON {machine,mold,material,method} (4M) from the canonical slot
  /** JSON {"<slotIndex>":"<name>"} — the per-slot QC sign-off map. */
  qcChecks: string;
  /** JSON {"<slotIndex>":{"<code>":qty}} — per-slot per-code reject
   *  breakdown. Mirrors what PMD_Rejects holds for signed-off shifts,
   *  but written eagerly to the LiveStatus row so other iPads can read
   *  the breakdown without waiting for sign-off. */
  rejectsBySlot: string;
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
/**
 * Grace window after a shift's end during which its rows may still be
 * legitimately written/mirrored (late sign-off, last-minute edits).
 * Past this, a shift can no longer be "in progress".
 */
export const LIVE_STALE_GRACE_MS = 8 * 3600_000;

/**
 * True when `shiftId`'s shift ended more than `graceMs` ago — i.e. it
 * can't possibly be a live, in-progress shift any more. Unparseable
 * shift ids return false (leave alone). Boundary equality counts as
 * "ended" (`<=`).
 */
export function shiftEndedLongAgo(
  shiftId: string,
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  const b = shiftBounds(shiftId);
  if (!b) return false;
  return b.end.getTime() + graceMs <= now.getTime();
}

/**
 * "Junk" PMD_LiveStatus row: the shift it points to is decisively in
 * the past (ended more than `graceMs` ago) AND nobody ever stamped a
 * MachineStatus on any half-hour slot of it. These are produced when
 * an operator taps a machine, picks a (wrong) job, maybe types a
 * Count Start, then realises the mistake and walks away — the live
 * snapshot push had already mirrored the partial cache onto
 * PMD_LiveStatus and there was no path to clean it up.
 *
 * The user-facing impact was twofold:
 *  1. PMD_LiveStatus grew an ever-longer list of orphans (one per
 *     mis-tap per device).
 *  2. listProduction's editCache backfill (the SFM507068 fix) would
 *     happily absorb those orphans, shadowing the canonical
 *     PMD_Production rows for the same (machine, shift) when an
 *     operator scrolled back to review a past shift.
 *
 * Only flag rows that have ZERO machine status anywhere — countStart /
 * countEnd / reject on their own are NOT proof of run; a finished
 * shift always has at least one timeline letter. Future-dated rows
 * are never flagged: they may be a deliberately scheduled tap-ahead
 * and we don't want to silently delete planned work.
 *
 * NOTE: an OLD row that DOES carry status (e.g. an abandoned 03/06
 * experiment) is NOT junk by this definition — deleting real data is
 * out of scope here. The defence against those re-appearing on the
 * live board lives in pushLiveSnapshot, which refuses to mirror any
 * shift that `shiftEndedLongAgo`.
 *
 * `now` is injected so the helper is testable; pass `new Date()` in
 * the live path.
 */
export function isStaleLiveHeader(
  h: { date: string; shift: string; timeline?: string },
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  if (!shiftEndedLongAgo(`${h.date}-${h.shift}`, now, graceMs)) return false;
  const timeline = h.timeline || '';
  for (const ch of timeline) {
    if (ch && ch !== '·' && ch !== ' ') return false;
  }
  return true;
}

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
  qcChecks: string;
  rejectsBySlot: string;
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
  // Quality-check sign-offs roll up into one JSON map keyed by slot
  // index — the PMD_Production.QualityChecks column stores this verbatim
  // so the round-trip is lossless.
  const qcMap: Record<string, string> = {};
  for (const r of slots) {
    if (r.qcBy && r.slotIndex >= 0 && r.slotIndex < 16) qcMap[String(r.slotIndex)] = r.qcBy;
  }
  // Per-slot per-code reject map — same data PMD_Rejects holds, but
  // serialised onto the LiveStatus header so other iPads see it during
  // a live shift (PMD_Rejects is only written on sign-off).
  const rejectsBySlotMap: Record<string, Record<string, number>> = {};
  for (const r of slots) {
    if (r.slotIndex < 0 || r.slotIndex >= 16) continue;
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      continue;
    }
    const filtered: Record<string, number> = {};
    for (const [code, qty] of Object.entries(obj)) {
      const n = Number(qty);
      if (!n) continue;
      filtered[code] = n;
    }
    if (Object.keys(filtered).length) rejectsBySlotMap[String(r.slotIndex)] = filtered;
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
    qcChecks: Object.keys(qcMap).length ? JSON.stringify(qcMap) : '',
    rejectsBySlot: Object.keys(rejectsBySlotMap).length ? JSON.stringify(rejectsBySlotMap) : '',
  };
}


/** Turn the handover JSON {machine,mold,material,method} into readable text. */
/**
 * Strip characters that SharePoint REST rejects from string values in a
 * POST/MERGE body. The 500 "Invalid text value. A text field contains
 * invalid data." error doesn't name the offending column, so the safer
 * play is to scrub up front. Removes:
 *   - C0 control characters U+0000..U+001F except \t \r \n (NUL, VT, etc.
 *     come back from Excel paste / clipboard glitches; SP refuses them).
 *   - C1 controls U+007F..U+009F.
 *   - Unicode line / paragraph separators U+2028 / U+2029 (slip in from
 *     Word and break the JSON parser SP uses for verbose envelopes).
 *   - The BOM U+FEFF anywhere except position 0 (also a common CSV gift).
 * Mutates the body in place. `__metadata` and non-string values are left
 * alone.
 */
export function sanitizeBodyStrings(body: Record<string, unknown>): void {
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/g;
  for (const [k, v] of Object.entries(body)) {
    if (k === '__metadata' || typeof v !== 'string') continue;
    if (bad.test(v)) body[k] = v.replace(bad, '');
  }
}

function formatHandover(json: string): string {
  if (!json) return '';
  try {
    const h = JSON.parse(json) as Record<string, string>;
    return (['machine', 'mold', 'material', 'method'] as const)
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
  const firstIdx = (...names: string[]): number => {
    for (const n of names) {
      const i = idx(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iJob = idx('JobHead_JobNum');
  const iPart = idx('JobHead_PartNum');
  const iDesc = idx('JobHead_PartDescription');
  const iProd = idx('JobHead_ProdQty');
  const iRem = idx('Calculated_RemainingQty');
  const iStart = idx('JobHead_StartDate');
  const iDue = idx('JobHead_ReqDueDate');
  const iDur = idx('Calculated_RemaingLaborHrs');
  const iQty = idx('JobOper_ProdStandard');
  // Optional column: decimal hours-of-day for the planned start
  // (e.g. 18.68 → 18:40:48). Epicor emits this separately from the
  // date so JobHead_StartDate is just YYYY-MM-DD; we layer the
  // decimal-hours value back onto that date here. The Epicor field
  // is JobHead_StartHour; the remaining variants are kept as
  // defensive fallbacks so a header rename in the export tool
  // doesn't require a code change.
  const iStartTime = firstIdx(
    'JobHead_StartHour',
    'JobHead_StartTime',
    'JobHead_Start_Time',
    'Start_Time',
    'StartTime',
    'Start Time',
  );
  const out: PlanningOrder[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    const job = row[iJob] ?? '';
    if (!job) continue;
    let startIso = csvDateToIso(row[iStart] ?? '');
    // Layer the start-time decimal onto the start-date when the
    // column is present and parses as a finite non-negative number
    // less than 24. Anything else (blank, NaN, > 24) is ignored so
    // a missing value can't silently shift a job to midnight.
    if (startIso && iStartTime >= 0) {
      const raw = (row[iStartTime] ?? '').trim();
      if (raw !== '') {
        const decH = parseFloat(raw);
        if (isFinite(decH) && decH >= 0 && decH < 24) {
          startIso = applyDecimalHoursToIso(startIso, decH);
        }
      }
    }
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
      // Order Qty = total ProdQty; Job Left = remaining. Fall back to the
      // remaining value when the export predates the ProdQty column.
      orderQty:
        (iProd >= 0 ? parseFloat(row[iProd] ?? '0') : 0) ||
        parseFloat(row[iRem] ?? '0') ||
        0,
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

/**
 * Convert decimal hours-of-day to (hh, mm, ss). 18.68 → 18:40:48.
 * Rounds the seconds and carries 60 → 00 + next-minute / next-hour so
 * a value of 23.999999 doesn't materialise as 23:59:60 (which Date
 * happily accepts but quietly rolls into the next day).
 */
export function decimalHoursToHms(h: number): [number, number, number] {
  let hh = Math.floor(h);
  const remMin = (h - hh) * 60;
  let mm = Math.floor(remMin);
  let ss = Math.round((remMin - mm) * 60);
  if (ss === 60) {
    ss = 0;
    mm += 1;
  }
  if (mm === 60) {
    mm = 0;
    hh += 1;
  }
  return [hh, mm, ss];
}

/** Replace the wall-clock time of an ISO timestamp with the decimal
 *  hours-of-day value. Keeps the original calendar date untouched. */
function applyDecimalHoursToIso(iso: string, decimalHours: number): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  const [hh, mm, ss] = decimalHoursToHms(decimalHours);
  d.setHours(hh, mm, ss, 0);
  return d.toISOString();
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
