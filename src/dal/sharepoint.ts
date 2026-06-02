import type {
  BdCode,
  Machine,
  Operator,
  PlanningFilter,
  PlanningOrder,
  Product,
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
  products: 'PMD_Products',
  planning: 'PMD_Planning',
  production: 'PMD_Production',
  rejects: 'PMD_Rejects',
  breakdown: 'PMD_BreakDownlog',
  rejectCategories: 'PMD_RejectCategories',
  breakdownMaster: 'PMD_BreakdownMaster',
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
    // Mirror of the machine code (this tenant has a separate MachineCode
    // column alongside Title). Empty = skip-write.
    machineCodeAlt: 'MachineCode',
    date: 'SlotStart_x003a_', // display "Date", actually the DateTime "SlotStart:"
    shift: 'ShiftId',
    // Status column was deleted from this tenant — the 16-char timeline
    // string is still persisted via PMD_BreakDownlog.StatusTimeline, so the
    // operator view + trace can still rebuild per-slot status on reload.
    // Set this to a real column name (e.g. 'StatusTimeline') if you ever
    // add it back to PMD_Production.
    timeline: '',
    jobNumber: 'JobNumber',
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
   * In-memory cache of slot records for shifts the operator is currently
   * editing. Key = `${machineCode}|${shiftId}|${jobNumber}`. Flushed to
   * the three production lists on lockShift; survives reloads only within
   * the same browser tab.
   */
  private editCache = new Map<string, ProductionRecord[]>();
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

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.graphToken = o.graphToken;
    this.planningFilePath = o.planningFilePath;
    this.planningCsvPath = o.planningCsvPath;
    // Merge user overrides into the defaults.
    this.F = mergeFieldMap(DEFAULT_FIELDS, o.fieldMap);
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
    const F = this.F.supervisor;
    const rows = await this.getAllItems(LISTS.supervisor);
    return rows.map((r) => ({
      id: getId(r),
      operatorName: str(r[F.name]) || str(r[F.title]),
      active: true,
    }));
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

  private async loadPlanningCsv(serverRelativePath: string): Promise<PlanningOrder[]> {
    // Bust SP's edge cache so we always get the freshest sync output.
    const cacheBust = `?_t=${Date.now()}`;
    const url =
      `${this.siteUrl}/_api/web/getFileByServerRelativeUrl('` +
      encodeURIComponent(serverRelativePath) +
      `')/$value` +
      cacheBust;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!res.ok) {
      throw new Error(
        `Planning CSV fetch failed (${res.status}) for ${serverRelativePath}`,
      );
    }
    const text = await res.text();
    return parsePlanningCsv(text);
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
    // 2) Hydrate header rows from PMD_Production for the same filter,
    //    skipping any (mc,sid,job) we already have in cache.
    const seen = new Set(cached.map((r) => this.cacheKey(r.machineCode, r.shiftId, r.jobNumber)));
    const headers = await this.fetchProductionHeaders(filter);
    const rejectsByKey = await this.fetchRejectsByKey(filter);
    for (const h of headers) {
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      if (seen.has(key)) continue;
      cached.push(...this.expandHeaderToSlots(h, rejectsByKey.get(key) ?? []));
      this.hydratedKeys.add(key);
    }
    return cached;
  }

  private async fetchProductionHeaders(filter: ProductionFilter): Promise<HeaderRow[]> {
    const F = this.F.production;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    if (filter.jobNumber) parts.push(`${F.jobNumber} eq '${filter.jobNumber}'`);
    // F.date points at SlotStart_x003a_ (DateTime). Filter with datetime'...'
    // and combine with ShiftId for an exact-shift match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      const b = shiftBounds(filter.shiftId);
      if (b) parts.push(`${F.date} eq datetime'${b.start.toISOString()}'`);
      if (shift) parts.push(`${F.shift} eq '${shift}'`);
    }
    if (filter.shiftIdFrom) {
      const b = shiftBounds(filter.shiftIdFrom);
      if (b) parts.push(`${F.date} ge datetime'${b.start.toISOString()}'`);
    }
    if (filter.shiftIdTo) {
      const b = shiftBounds(filter.shiftIdTo);
      if (b) parts.push(`${F.date} le datetime'${b.end.toISOString()}'`);
    }
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(LISTS.production, qs);
    return rows.map((r) => ({
      id: getId(r),
      machineCode: str(r[F.machine]),
      date: dateOnly(r[F.date]),
      shift: str(r[F.shift]),
      jobNumber: str(r[F.jobNumber]),
      timeline: str(r[F.timeline]),
      countStart: nullOrNum(r[F.countStart]),
      countEnd: nullOrNum(r[F.countEnd]),
      reject: num(r[F.reject]),
      operator: str(r[F.operator]),
      supervisor: str(r[F.supervisor]),
      runTime: F.runTime ? num(r[F.runTime]) : 0,
      downTime: num(r[F.downTime]),
    }));
  }

  private async fetchRejectsByKey(
    filter: ProductionFilter,
  ): Promise<Map<string, RejectRow[]>> {
    const F = this.F.rejects;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${filter.jobNumber}'`);
    // PMD_Rejects.Date is DateTime — filter by the shift's start instant,
    // computed from shiftBounds(shiftId) to match what we wrote on save.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      const b = shiftBounds(filter.shiftId);
      if (b) parts.push(`${F.date} eq datetime'${b.start.toISOString()}'`);
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

  private expandHeaderToSlots(h: HeaderRow, rejects: RejectRow[]): ProductionRecord[] {
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
        handoverNote: '',
        locked: true, // headers are persisted = signed off
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
        handoverNote: '',
        locked: true,
        lockedBy: h.supervisor,
        lockedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      });
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
    return stored;
  }

  async deleteProductionRecord(id: number): Promise<void> {
    // Remove from cache. Persisted rows are deleted only via shift unlock.
    for (const [key, list] of this.editCache) {
      const filtered = list.filter((r) => r.id !== id);
      if (filtered.length !== list.length) this.editCache.set(key, filtered);
    }
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
    // on PMD_BreakDownlog and PMD_Production rows from the matching order.
    const orders = await this.listPlanning({ machineCode });
    const partNumOf = (job: string): string =>
      orders.find((o) => o.jobNumber === job)?.partNumber ?? '';
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
      this.editCache.delete(ownKey(job));
    }
  }

  async unlockShift(machineCode: string, shiftId: string): Promise<void> {
    // Find PMD_Production rows for this (Machine, SlotStart:, Shift) and
    // delete their corresponding analytic + reject rows so the operator can
    // refile.
    const F = this.F.production;
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const b = shiftBounds(shiftId);
    const dateClause = b
      ? `${F.date} eq datetime'${b.start.toISOString()}'`
      : `${F.date} eq null`;
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${machineCode}' and ${dateClause} and ${F.shift} eq '${shift}'`,
      );
    const rows = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.production, qs);
    for (const r of rows) await this.del(`${this.listUrl(LISTS.production)}/items(${r.ID ?? r.Id})`);
    // Best-effort matching deletion in PMD_BreakDown and PMD_Rejects.
    // Their Date columns are DateTime; use the shift's start instant.
    const isoStart = b?.start.toISOString();
    if (isoStart) {
      const Fb = this.F.breakdown;
      await this.deleteByFilter(
        LISTS.breakdown,
        `${Fb.machine} eq '${machineCode}' and ${Fb.date} eq datetime'${isoStart}' and ${Fb.shift} eq '${shift}'`,
      );
      const Fr = this.F.rejects;
      await this.deleteByFilter(
        LISTS.rejects,
        `${Fr.machine} eq '${machineCode}' and ${Fr.date} eq datetime'${isoStart}' and ${Fr.shift} eq '${shift}'`,
      );
    }
    // Drop hydrated cache for this shift so a re-read pulls fresh.
    this.hydratedKeys.forEach((k) => {
      if (k.startsWith(`${machineCode}|${shiftId}|`)) this.hydratedKeys.delete(k);
    });
    void date; // kept for future per-list `date`-only deletes
  }

  private async upsertProductionHeader(h: HeaderInput): Promise<void> {
    const F = this.F.production;
    // The date column is a DateTime (SlotStart:); store the shift's wall-clock
    // start instant. F.machine is mapped to Title, so writing [F.machine]
    // populates Title with the machine code (e.g. "Batt1") — no separate
    // Machine column exists.
    const b = shiftBounds(`${h.date}-${h.shift}`);
    const slotStartIso = b?.start.toISOString();
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.production) },
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
    if (F.machineCodeAlt) body[F.machineCodeAlt] = h.machineCode;
    if (F.timeline) body[F.timeline] = h.timeline;
    if (F.downTime) body[F.downTime] = h.downTime;
    if (F.runTime) body[F.runTime] = h.runTime;
    if (F.handover) body[F.handover] = formatHandover(h.handover);
    if (F.totalGood) {
      const cs = h.countStart;
      const ce = h.countEnd;
      const good = cs != null && ce != null ? Math.max(0, ce - cs - h.reject) : 0;
      body[F.totalGood] = good;
    }
    // Find existing by composite key; MERGE if found, else POST.
    const dateClause = slotStartIso
      ? `${F.date} eq datetime'${slotStartIso}'`
      : `${F.date} eq null`;
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${h.machineCode}' and ${dateClause} and ${F.shift} eq '${h.shift}' and ${F.jobNumber} eq '${h.jobNumber}'`,
      );
    const existing = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.production, qs);
    if (existing.length > 0) {
      const id = existing[0].ID ?? existing[0].Id;
      await this.post(`${this.listUrl(LISTS.production)}/items(${id})`, body, '*');
    } else {
      await this.post(`${this.listUrl(LISTS.production)}/items`, body);
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
    const sb = shiftBounds(shiftId);
    const slotStartIso = sb?.start.toISOString();
    const dateClause = slotStartIso
      ? `${F.date} eq datetime'${slotStartIso}'`
      : `${F.date} eq null`;
    await this.deleteByFilter(
      LISTS.breakdown,
      `${F.machine} eq '${key.machineCode}' and ${dateClause} and ${F.shift} eq '${key.shift}' and ${F.jobNum} eq '${key.jobNumber}'`,
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
    // PMD_Rejects.Date is DateTime — derive the shift's start instant the
    // same way the write does so the wipe matches what we'll insert.
    const sb = shiftBounds(`${key.date}-${key.shift}`);
    const slotStartIso = sb?.start.toISOString();
    const dateClause = slotStartIso
      ? `${F.date} eq datetime'${slotStartIso}'`
      : `${F.date} eq null`;
    await this.deleteByFilter(
      LISTS.rejects,
      `${F.machine} eq '${key.machineCode}' and ${dateClause} and ${F.shift} eq '${key.shift}' and ${F.jobNum} eq '${key.jobNumber}'`,
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

function dateOnly(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, 10);
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
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
}

interface HeaderInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
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
  // anchor them to local time instead.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$/i.exec(s);
  if (iso) {
    return new Date(
      +iso[1], +iso[2] - 1, +iso[3],
      +iso[4], +iso[5], iso[6] ? +iso[6] : 0,
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
      partNumber: row[iPart] ?? '',
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
  const t = s.trim();
  if (!t) return '';
  // PowerShell Export-Csv default for [datetime] is the local culture format.
  // Accept ISO 8601 (with or without Z) and en-AU "dd/MM/yyyy [HH:mm[:ss] [am/pm]]".
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?/i.exec(t);
  if (iso) {
    return new Date(
      +iso[1],
      +iso[2] - 1,
      +iso[3],
      +iso[4],
      +iso[5],
      iso[6] ? +iso[6] : 0,
    ).toISOString();
  }
  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (isoDateOnly) {
    return new Date(+isoDateOnly[1], +isoDateOnly[2] - 1, +isoDateOnly[3]).toISOString();
  }
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(t);
  if (au) {
    let hr = au[4] ? parseInt(au[4], 10) : 0;
    if (au[7]) {
      const pm = au[7].toLowerCase() === 'pm';
      if (pm && hr < 12) hr += 12;
      if (!pm && hr === 12) hr = 0;
    }
    return new Date(
      +au[3],
      +au[2] - 1,
      +au[1],
      hr,
      au[5] ? +au[5] : 0,
      au[6] ? +au[6] : 0,
    ).toISOString();
  }
  return '';
}
