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

// Phase 1 — SharePoint List backend (§7.1).
//
// Wiring required at deploy time:
//   - new SharePointDataLayer({ siteUrl: 'https://.../sites/ReseroOperationsAU' })
//   - SP REST calls use browser cookies (works automatically when the SPA is
//     hosted on the SP tenant, e.g. SPFx web part in SiteAssets).
//   - For the Excel→Planning sync (syncPlanningFromExcel) you must supply a
//     Microsoft Graph token provider; in SPFx use MSGraphClient.getToken().
//
// IMPORTANT field-name assumption: this code assumes each list column's
// SharePoint internal name matches the camelCase domain field with its
// initial letter capitalised (`MachineCode`, `ShiftId`, `JobNumber`, ...).
// If you created the columns with spaces or different names, SharePoint
// will mangle them (e.g. "Job Number" -> "Job_x0020_Number"). Edit the
// FIELD_MAP below to match what GET .../items?$top=1 returns.

const LISTS = {
  machines: 'PMD_Machines',
  operators: 'PMD_Operators',
  supervisors: 'PMD_Supervisors',
  products: 'PMD_Products',
  planning: 'PMD_Planning',
  production: 'PMD_Production',
  rejectCategories: 'PMD_RejectCategories',
  bdCodes: 'PMD_BdCodes',
} as const;

// Domain camelCase -> SharePoint internal column name.
const FIELD_MAP = {
  // Machines
  machineCode: 'MachineCode',
  displayName: 'DisplayName',
  sequence: 'Sequence',
  active: 'Active',
  // Operators / Supervisors
  operatorName: 'OperatorName',
  employeeId: 'EmployeeID',
  linkedUser: 'LinkedUser',
  // Products
  partNumber: 'PartNumber',
  description: 'Description',
  standardCycleSec: 'StandardCycleSec',
  cavities: 'Cavities',
  // Planning
  jobNumber: 'JobNumber',
  originalMachine: 'OriginalMachine',
  partDescription: 'PartDescription',
  plannedStart: 'PlannedStart',
  plannedEnd: 'PlannedEnd',
  jobRequired: 'JobRequired',
  qtyPerHr: 'QtyPerHr',
  duration: 'Duration',
  released: 'Released',
  isDieChange: 'IsDieChange',
  manuallyAdded: 'ManuallyAdded',
  source: 'Source',
  // Production
  shiftId: 'ShiftId',
  slotIndex: 'SlotIndex',
  statusCode: 'StatusCode',
  countStart: 'CountStart',
  countEnd: 'CountEnd',
  rejectCount: 'RejectCount',
  rejects: 'Rejects',
  otherType: 'OtherType',
  otherCount: 'OtherCount',
  purgeKg: 'PurgeKg',
  operator: 'Operator',
  supervisor: 'Supervisor',
  bdIssue: 'BdIssue',
  mangoTicket: 'MangoTicket',
  handoverNote: 'HandoverNote',
  locked: 'Locked',
  lockedBy: 'LockedBy',
  lockedAt: 'LockedAt',
  // Reference
  code: 'Code',
  label: 'Label',
  kind: 'Kind',
  subCategory: 'SubCategory',
  owner: 'Owner',
} as const;

export interface SharePointOptions {
  siteUrl: string;
  /** Resolves a Microsoft Graph access token. Required only for syncPlanningFromExcel. */
  graphToken?: () => Promise<string>;
  /** Path to the planning workbook inside the site, e.g.
   *  "Shared Documents/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm" */
  planningFilePath?: string;
}

interface SpItemEnvelope<T> {
  d: { results: T[] };
}

export class SharePointDataLayer implements PmdDataLayer {
  private digest: { value: string; expires: number } | null = null;
  private readonly siteUrl: string;
  private readonly graphToken?: () => Promise<string>;
  private readonly planningFilePath?: string;

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.graphToken = o.graphToken;
    this.planningFilePath = o.planningFilePath;
  }

  // ---- low-level helpers ----------------------------------------------

  private listUrl(title: string): string {
    return `${this.siteUrl}/_api/web/lists/getbytitle('${title}')`;
  }

  private async getDigest(): Promise<string> {
    if (this.digest && this.digest.expires > Date.now() + 5_000) {
      return this.digest.value;
    }
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
      // Refresh 5 minutes before expiry (SP gives 1800s by default).
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

  private async getAllItems<T = Record<string, unknown>>(list: string, params = ''): Promise<T[]> {
    const out: T[] = [];
    let url = `${this.listUrl(list)}/items?$top=5000${params ? '&' + params : ''}`;
    while (url) {
      const env = await this.getJson<SpItemEnvelope<T> & { d: { __next?: string } }>(url);
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

  private async del(url: string, ifMatch = '*'): Promise<void> {
    const digest = await this.getDigest();
    const res = await fetch(url, {
      method: 'POST', // SP uses X-HTTP-Method override for DELETE too
      credentials: 'include',
      headers: {
        'X-RequestDigest': digest,
        'IF-MATCH': ifMatch,
        'X-HTTP-Method': 'DELETE',
      },
    });
    if (!res.ok) throw new Error(`DELETE ${url} → ${res.status}`);
  }

  /** Looks up the SP.Data list-item type ('SP.Data.<sanitised>ListItem'). */
  private static itemType(list: string): string {
    // SharePoint replaces underscores with _x005f_ in entity type names.
    const safe = list.replace(/_/g, '_x005f_');
    return `SP.Data.${safe}ListItem`;
  }

  // ---- mappers (camelCase <-> SharePoint columns) ---------------------

  private read<T extends object>(item: Record<string, unknown>, fields: ReadonlyArray<keyof typeof FIELD_MAP>): T {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f as string] = item[FIELD_MAP[f]] ?? null;
    out.id = (item as { ID?: number; Id?: number }).ID ?? (item as { Id?: number }).Id ?? 0;
    return out as T;
  }

  private write(
    fields: ReadonlyArray<keyof typeof FIELD_MAP>,
    obj: Record<string, unknown>,
    list: string,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      __metadata: { type: SharePointDataLayer.itemType(list) },
    };
    for (const f of fields) {
      const v = obj[f as string];
      if (v !== undefined) payload[FIELD_MAP[f]] = v;
    }
    return payload;
  }

  // ---- reference lists ------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    const rows = await this.getAllItems(LISTS.machines);
    return rows.map((r) =>
      this.read<Machine>(r, ['machineCode', 'displayName', 'sequence', 'active']),
    );
  }
  async listOperators(): Promise<Operator[]> {
    const rows = await this.getAllItems(LISTS.operators);
    return rows.map((r) =>
      this.read<Operator>(r, ['operatorName', 'employeeId', 'active', 'linkedUser']),
    );
  }
  async listSupervisors(): Promise<Supervisor[]> {
    const rows = await this.getAllItems(LISTS.supervisors);
    return rows.map((r) =>
      this.read<Supervisor>(r, ['operatorName', 'employeeId', 'active', 'linkedUser']),
    );
  }
  async listProducts(): Promise<Product[]> {
    const rows = await this.getAllItems(LISTS.products);
    return rows.map((r) =>
      this.read<Product>(r, [
        'partNumber',
        'description',
        'standardCycleSec',
        'cavities',
        'active',
      ]),
    );
  }
  async listRejectCategories(): Promise<RejectCategory[]> {
    const rows = await this.getAllItems(LISTS.rejectCategories);
    return rows.map((r) =>
      this.read<RejectCategory>(r, ['code', 'label', 'sequence', 'kind']),
    );
  }
  async listBdCodes(): Promise<BdCode[]> {
    const rows = await this.getAllItems(LISTS.bdCodes);
    return rows.map((r) =>
      this.read<BdCode>(r, ['code', 'label', 'subCategory', 'sequence', 'owner']),
    );
  }

  // ---- planning -------------------------------------------------------

  private readonly PLANNING_FIELDS: ReadonlyArray<keyof typeof FIELD_MAP> = [
    'jobNumber',
    'machineCode',
    'originalMachine',
    'partNumber',
    'partDescription',
    'plannedStart',
    'plannedEnd',
    'jobRequired',
    'qtyPerHr',
    'duration',
    'released',
    'isDieChange',
    'manuallyAdded',
    'source',
  ];

  async listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]> {
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${FIELD_MAP.machineCode} eq '${filter.machineCode}'`);
    if (filter.released !== undefined) parts.push(`${FIELD_MAP.released} eq ${filter.released ? 1 : 0}`);
    const q = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(LISTS.planning, q);
    return rows.map((r) => this.read<PlanningOrder>(r, this.PLANNING_FIELDS));
  }

  async upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder> {
    const payload = this.write(this.PLANNING_FIELDS, order as unknown as Record<string, unknown>, LISTS.planning);
    // Title doubles as JobNumber per §7.1.
    payload.Title = order.jobNumber;
    if (order.id > 0) {
      await this.post(`${this.listUrl(LISTS.planning)}/items(${order.id})`, payload, '*');
      return order;
    }
    const res = await this.post(`${this.listUrl(LISTS.planning)}/items`, payload);
    const created = ((await res.json()) as { d: { ID: number } }).d;
    return { ...order, id: created.ID };
  }

  async deletePlanningOrder(id: number): Promise<void> {
    await this.del(`${this.listUrl(LISTS.planning)}/items(${id})`);
  }

  // ---- production ----------------------------------------------------

  private readonly PRODUCTION_FIELDS: ReadonlyArray<keyof typeof FIELD_MAP> = [
    'machineCode',
    'shiftId',
    'jobNumber',
    'slotIndex',
    'statusCode',
    'countStart',
    'countEnd',
    'rejectCount',
    'rejects',
    'otherType',
    'otherCount',
    'purgeKg',
    'operator',
    'supervisor',
    'bdIssue',
    'mangoTicket',
    'handoverNote',
    'locked',
    'lockedBy',
    'lockedAt',
  ];

  async listProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${FIELD_MAP.machineCode} eq '${filter.machineCode}'`);
    if (filter.shiftId) parts.push(`${FIELD_MAP.shiftId} eq '${filter.shiftId}'`);
    if (filter.jobNumber) parts.push(`${FIELD_MAP.jobNumber} eq '${filter.jobNumber}'`);
    if (filter.shiftIdFrom) parts.push(`${FIELD_MAP.shiftId} ge '${filter.shiftIdFrom}'`);
    if (filter.shiftIdTo) parts.push(`${FIELD_MAP.shiftId} le '${filter.shiftIdTo}'`);
    const q = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(LISTS.production, q);
    return rows.map((r) => this.read<ProductionRecord>(r, this.PRODUCTION_FIELDS));
  }

  /**
   * Upsert by composite key (MachineCode, ShiftId, JobNumber, SlotIndex) so
   * a slot stays unique even when different devices retry (§5.6 LWW).
   */
  async upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord> {
    let id = record.id;
    if (id <= 0) {
      const match = await this.listProduction({
        machineCode: record.machineCode,
        shiftId: record.shiftId,
        jobNumber: record.jobNumber,
      });
      const existing = match.find((r) => r.slotIndex === record.slotIndex);
      if (existing) id = existing.id;
    }
    const payload = this.write(
      this.PRODUCTION_FIELDS,
      record as unknown as Record<string, unknown>,
      LISTS.production,
    );
    payload.Title = record.jobNumber || '(slot)';
    if (id > 0) {
      await this.post(`${this.listUrl(LISTS.production)}/items(${id})`, payload, '*');
      return { ...record, id };
    }
    const res = await this.post(`${this.listUrl(LISTS.production)}/items`, payload);
    const created = ((await res.json()) as { d: { ID: number } }).d;
    return { ...record, id: created.ID };
  }

  async deleteProductionRecord(id: number): Promise<void> {
    await this.del(`${this.listUrl(LISTS.production)}/items(${id})`);
  }

  /**
   * Lock every (MachineCode, ShiftId) record (§5.5). Creates a placeholder
   * SlotIndex=0 item if the shift had no records yet.
   */
  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
  ): Promise<void> {
    const rows = await this.listProduction({ machineCode, shiftId });
    const now = new Date().toISOString();
    if (rows.length === 0) {
      await this.upsertProductionRecord({
        id: 0,
        machineCode,
        shiftId,
        jobNumber: '',
        slotIndex: 0,
        statusCode: '',
        countStart: null,
        countEnd: null,
        rejectCount: 0,
        rejects: '{}',
        otherType: '',
        otherCount: 0,
        purgeKg: null,
        operator,
        supervisor,
        bdIssue: '',
        mangoTicket: '',
        handoverNote: '',
        locked: true,
        lockedBy: supervisor,
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    // Serial MERGE on each row. Real production would use the $batch endpoint
    // for atomicity; keeping this simple for v1.
    for (const r of rows) {
      await this.upsertProductionRecord({
        ...r,
        locked: true,
        lockedBy: supervisor,
        lockedAt: now,
        supervisor,
        operator: operator || r.operator,
        updatedAt: now,
      });
    }
  }

  async unlockShift(machineCode: string, shiftId: string): Promise<void> {
    const rows = await this.listProduction({ machineCode, shiftId });
    for (const r of rows) {
      await this.upsertProductionRecord({
        ...r,
        locked: false,
        lockedBy: '',
        lockedAt: '',
      });
    }
  }

  async whoAmI(): Promise<UserContext> {
    const res = await this.getJson<{
      d: { Title: string; Email: string; LoginName: string };
    }>(`${this.siteUrl}/_api/web/currentUser`);
    // Role is resolved by membership lookup elsewhere; default to operator.
    return { name: res.d.Title || res.d.Email || res.d.LoginName, role: 'operator' };
  }

  // ---- Excel → Planning sync (§7 of conversation, real workflow) ------

  /**
   * Read the planning workbook and rebuild PMD_Planning:
   *   1. Microsoft Graph workbook API → row values
   *   2. Filter rows that have a Start Date
   *   3. Delete every existing PMD_Planning item
   *   4. POST one item per kept row
   *
   * Columns from the Excel sheet (per user spec): A,B,C,D,E,F,G,H,O,Q,R.
   * Mapping (best effort — adjust to match your sheet):
   *   A=Job Date, B=Machine, C=Job#, D=Part#, E=Part Desc,
   *   F=Job Required, G=Qty/Hr, H=Duration,
   *   O=Original Machine, Q=Planned Start, R=Planned End
   *
   * Requires `graphToken` and `planningFilePath` in the constructor options.
   */
  async syncPlanningFromExcel(): Promise<{ inserted: number; skipped: number }> {
    if (!this.graphToken)
      throw new Error('syncPlanningFromExcel: pass graphToken in SharePointOptions');
    if (!this.planningFilePath)
      throw new Error('syncPlanningFromExcel: pass planningFilePath in SharePointOptions');

    const token = await this.graphToken();
    const headers = { Authorization: `Bearer ${token}` };

    // Resolve site id from the SP REST URL — the path after the hostname is
    // what Graph wants as `/sites/{host}:{site-path}:`.
    const u = new URL(this.siteUrl);
    const siteId = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname}`,
      { headers },
    )
      .then((r) => r.json() as Promise<{ id: string }>)
      .then((j) => j.id);

    // Default drive (Documents). Path inside the drive = planningFilePath
    // with any leading "Shared Documents/" stripped.
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

    // Column letter -> index (A=0, B=1, ..., O=14, Q=16, R=17).
    const col = (letter: string): number => letter.charCodeAt(0) - 'A'.charCodeAt(0);
    const COLS = {
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

    const dataRows = values.slice(1); // header is row 0
    let inserted = 0;
    let skipped = 0;
    const newRows: PlanningOrder[] = [];
    for (const r of dataRows) {
      const start = r[COLS.plannedStart];
      if (start == null || start === '') {
        skipped++;
        continue;
      }
      const ps = excelDate(start) ?? new Date(String(start));
      const pe = excelDate(r[COLS.plannedEnd]) ?? new Date(String(r[COLS.plannedEnd]));
      if (!isFinite(ps.getTime())) {
        skipped++;
        continue;
      }
      newRows.push({
        id: 0,
        jobNumber: String(r[COLS.jobNumber] ?? '').trim(),
        machineCode: String(r[COLS.machine] ?? '').trim(),
        originalMachine: String(r[COLS.originalMachine] ?? '').trim(),
        partNumber: String(r[COLS.partNumber] ?? '').trim(),
        partDescription: String(r[COLS.partDesc] ?? '').trim(),
        plannedStart: ps.toISOString(),
        plannedEnd: pe.toISOString(),
        jobRequired: Number(r[COLS.jobRequired]) || 0,
        qtyPerHr: Number(r[COLS.qtyPerHr]) || 0,
        duration: Number(r[COLS.duration]) || 0,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      });
    }

    // Wipe existing rows.
    const existing = await this.getAllItems<{ ID?: number; Id?: number }>(LISTS.planning, '$select=ID');
    for (const it of existing) {
      const id = it.ID ?? it.Id;
      if (id) await this.del(`${this.listUrl(LISTS.planning)}/items(${id})`);
    }

    // Insert fresh rows.
    for (const row of newRows) {
      await this.upsertPlanningOrder(row);
      inserted++;
    }
    return { inserted, skipped };
  }
}

/** Excel serial date → JS Date. Returns null if v isn't a number-like serial. */
function excelDate(v: unknown): Date | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 200000) return null;
  // Excel epoch = 1899-12-30 UTC (leap-bug compatible).
  const ms = (n - 25569) * 86400 * 1000;
  return new Date(ms);
}

/** Duck-typed check used by the UI to know if the active DAL can sync. */
export function canSyncPlanning(dal: unknown): dal is { syncPlanningFromExcel: () => Promise<{ inserted: number; skipped: number }> } {
  return typeof (dal as { syncPlanningFromExcel?: unknown })?.syncPlanningFromExcel === 'function';
}
