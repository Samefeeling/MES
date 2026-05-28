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
    // Title = machine code (e.g. "1600T"). The column with internal
    // name `Machine` actually displays as "DieNumber" — don't confuse
    // them. JobHead/Calculated/D_C use the names below verbatim.
    machine: 'Title',
    startDateTime: 'StartDateTime',
    qtyHour: 'Qty_x002f_Hour',
    dueDate: 'DueDate',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    remaining: 'Calculated_RemainingQty',
    duration: 'Duration',
    dieNumber: 'Machine', // weird but real — internal Machine = DieNumber
    dc: 'D_x002f_C',
  },
  production: {
    // Schema from ?$top=1 response. RunTime confirmed present by user
    // (it was just absent from the sample row's data); re-enabled.
    machine: 'Title',
    date: 'SlotStart_x003a_', // display "Date", actually the DateTime "SlotStart:"
    shift: 'ShiftId',
    timeline: 'Status', // display "Timeline"
    jobNumber: 'JobNumber',
    countStart: 'CountStart',
    countEnd: 'CountEnd',
    reject: 'Reject',
    operator: 'Operator',
    supervisor: 'Supervisor',
    runTime: 'RunTime',
    downTime: 'Downtime',
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
  /** Override any list/field internal name without editing this file. */
  fieldMap?: PartialFieldMap;
}

export class SharePointDataLayer implements PmdDataLayer {
  private digest: { value: string; expires: number } | null = null;
  private readonly siteUrl: string;
  private readonly graphToken?: () => Promise<string>;
  private readonly planningFilePath?: string;
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

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.graphToken = o.graphToken;
    this.planningFilePath = o.planningFilePath;
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
    if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
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

  private static itemType(list: string): string {
    // SharePoint mangles underscores to _x005f_ in the SP.Data entity type.
    const safe = list.replace(/[^A-Za-z0-9]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);
    return `SP.Data.${safe}ListItem`;
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
      // The 10 D-codes are all fixed rows on the operator sheet (no "other").
      return { code, label: str(r[F.description]), sequence: i + 1, kind: 'named' as const };
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

  async listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]> {
    const F = this.F.planning;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${filter.machineCode}'`);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(LISTS.planning, qs);
    return rows.map((r) => {
      const start = isoDate(r[F.startDateTime]);
      const due = isoDate(r[F.dueDate]);
      const dur = num(r[F.duration]) || 0;
      // Approximate end if not stored: start + duration hours.
      const end = dur > 0 ? new Date(new Date(start).getTime() + dur * 3600_000).toISOString() : due;
      return {
        id: getId(r),
        jobNumber: str(r[F.jobNum]),
        machineCode: str(r[F.machine]),
        originalMachine: str(r[F.machine]),
        partNumber: str(r[F.partNum]),
        partDescription: str(r[F.partDesc]),
        plannedStart: start,
        plannedEnd: end,
        jobRequired: num(r[F.remaining]) || 0,
        qtyPerHr: num(r[F.qtyHour]) || 0,
        duration: dur,
        released: true,
        isDieChange: str(r[F.dc]).toUpperCase() === 'D',
        manuallyAdded: false,
        source: 'ERP',
      };
    });
  }

  async upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder> {
    const F = this.F.planning;
    const body: Record<string, unknown> = {
      __metadata: { type: SharePointDataLayer.itemType(LISTS.planning) },
      // F.machine → Title (machine code lives in Title, e.g. "1600T")
      [F.machine]: order.machineCode,
      [F.startDateTime]: order.plannedStart,
      [F.qtyHour]: order.qtyPerHr,
      [F.dueDate]: order.plannedEnd,
      [F.jobNum]: order.jobNumber,
      [F.partNum]: order.partNumber,
      [F.partDesc]: order.partDescription,
      [F.remaining]: order.jobRequired,
      [F.duration]: order.duration,
      [F.dc]: order.isDieChange ? 'D' : '',
    };
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
        otherType: '',
        otherCount: 0,
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
        otherType: '',
        otherCount: 0,
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
    for (const slots of myTuples) {
      const job =
        slots[0]?.jobNumber ?? '';
      const agg = aggregateSlots(slots);
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
      });
      await this.upsertBreakdownAnalytic({
        machineCode,
        date,
        shift,
        jobNumber: job,
        partNumber: slots[0]?.handoverNote ? '' : '',
        timeline: agg.timeline,
        hours: agg.hours,
        bdCode: agg.bdCode,
      });
      await this.replaceRejectEvents(
        { machineCode, date, shift, jobNumber: job },
        agg.rejectEvents,
      );
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
      __metadata: { type: SharePointDataLayer.itemType(LISTS.production) },
      [F.machine]: h.machineCode,
      [F.shift]: h.shift,
      [F.jobNumber]: h.jobNumber,
      [F.timeline]: h.timeline,
      [F.countStart]: h.countStart ?? null,
      [F.countEnd]: h.countEnd ?? null,
      [F.reject]: h.reject,
      [F.operator]: h.operator,
      [F.supervisor]: h.supervisor,
      [F.downTime]: h.downTime,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    if (F.runTime) body[F.runTime] = h.runTime;
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

  private async upsertBreakdownAnalytic(h: BreakdownInput): Promise<void> {
    const F = this.F.breakdown;
    // F.machine → Title (no separate Machine column on PMD_BreakDown).
    // F.date → DateTime; write the shift's start instant.
    const sb = shiftBounds(`${h.date}-${h.shift}`);
    const slotStartIso = sb?.start.toISOString();
    const body: Record<string, unknown> = {
      __metadata: { type: SharePointDataLayer.itemType(LISTS.breakdown) },
      [F.machine]: h.machineCode,
      [F.shift]: h.shift,
      [F.jobNum]: h.jobNumber,
      [F.partNum]: h.partNumber,
      [F.statusTimeline]: h.timeline,
      [F.bdCode]: h.bdCode,
      [F.r]: h.hours.R,
      [F.b]: h.hours.B,
      [F.c]: h.hours.C,
      [F.d]: h.hours.D,
      [F.i]: h.hours.I,
      [F.m]: h.hours.M,
      [F.o]: h.hours.O,
      [F.p]: h.hours.P,
      [F.s]: h.hours.S,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    const dateClause = slotStartIso
      ? `${F.date} eq datetime'${slotStartIso}'`
      : `${F.date} eq null`;
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${h.machineCode}' and ${dateClause} and ${F.shift} eq '${h.shift}' and ${F.jobNum} eq '${h.jobNumber}'`,
      );
    const existing = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.breakdown, qs);
    if (existing.length > 0) {
      const id = existing[0].ID ?? existing[0].Id;
      await this.post(`${this.listUrl(LISTS.breakdown)}/items(${id})`, body, '*');
    } else {
      await this.post(`${this.listUrl(LISTS.breakdown)}/items`, body);
    }
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
        __metadata: { type: SharePointDataLayer.itemType(LISTS.rejects) },
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
    const rangeUrl =
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeURI(
        drivePath,
      )}:/workbook/worksheets('${sheet}')/usedRange(valuesOnly=true)?$select=values`;
    const rangeRes = await fetch(rangeUrl, { headers });
    if (!rangeRes.ok)
      throw new Error(`Graph workbook fetch failed: ${rangeRes.status} ${await rangeRes.text()}`);
    const { values } = (await rangeRes.json()) as { values: unknown[][] };
    if (!values || values.length < 2) return { inserted: 0, skipped: 0 };

    const col = (letter: string): number => letter.charCodeAt(0) - 'A'.charCodeAt(0);
    // Columns per spec: A,B,C,D,E,F,G,H,O,Q,R (mapped to PMD_Planning).
    const C = {
      jobDate: col('A'),
      machine: col('B'),
      jobNumber: col('C'),
      partNumber: col('D'),
      partDesc: col('E'),
      jobRequired: col('F'),
      qtyPerHr: col('G'),
      duration: col('H'),
      originalMachine: col('O'),
      plannedStart: col('Q'),
      plannedEnd: col('R'),
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
      const ps = excelDate(start) ?? new Date(String(start));
      if (!isFinite(ps.getTime())) {
        skipped++;
        continue;
      }
      const pe = excelDate(r[C.plannedEnd]) ?? new Date(String(r[C.plannedEnd]));
      fresh.push({
        id: 0,
        jobNumber: String(r[C.jobNumber] ?? '').trim(),
        machineCode: String(r[C.machine] ?? '').trim(),
        originalMachine: String(r[C.originalMachine] ?? '').trim(),
        partNumber: String(r[C.partNumber] ?? '').trim(),
        partDescription: String(r[C.partDesc] ?? '').trim(),
        plannedStart: ps.toISOString(),
        plannedEnd: pe.toISOString(),
        jobRequired: Number(r[C.jobRequired]) || 0,
        qtyPerHr: Number(r[C.qtyPerHr]) || 0,
        duration: Number(r[C.duration]) || 0,
        released: true,
        isDieChange: false,
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
}

interface BreakdownInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  timeline: string;
  hours: StatusHours;
  /** Dominant breakdown code on this shift (PMD_BreakDownlog.BDCode). Empty if no B slots. */
  bdCode: string;
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
        category: categoryFor(code),
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
  };
}

function categoryFor(_code: string): string {
  // The 10 D-codes are flat (no sub-grouping); RejectCode carries the detail.
  return 'Defect';
}

function excelDate(v: unknown): Date | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 200000) return null;
  const ms = (n - 25569) * 86400 * 1000;
  return new Date(ms);
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
