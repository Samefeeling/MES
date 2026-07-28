import type {
  BdCode,
  DieChangeLog,
  DieMaintenanceRequest,
  DieMaster,
  Machine,
  Operator,
  ParetoFilter,
  ParetoSlice,
  PlanningFilter,
  PlanningOrder,
  ProductDieColor,
  ProductionCounterRecord,
  ProductionFilter,
  ProductionRecord,
  RejectCategory,
  StatusCode,
  Supervisor,
  UserContext,
} from '../types';
import type { PmdDataLayer } from './types';
import { bdLabelFor } from '../core/breakdown';
import { dieChangeEventKey } from '../core/die';
import {
  seedBdCodes,
  seedDieChangeLogs,
  seedDieMaintenance,
  seedDieMaster,
  seedMachines,
  seedOperators,
  seedPlanning,
  seedProductDieColors,
  seedProduction,
  seedRejectCategories,
  seedSupervisors,
} from './seed';

/**
 * In-memory backend (Phase 0 / Mock). Implements the full PmdDataLayer
 * contract with last-write-wins semantics (§5.6). Data lives only for the
 * page session — used for the demo and as the contract reference for the
 * SharePoint / SQL / Azure adapters.
 */
export class MemoryDataLayer implements PmdDataLayer {
  private machines: Machine[];
  private operators: Operator[];
  private supervisors: Supervisor[];
  private rejectCategories: RejectCategory[];
  private bdCodes: BdCode[];
  private planning: PlanningOrder[];
  private production: ProductionRecord[];
  private dieColors: ProductDieColor[];
  private dieMaster: DieMaster[];
  private dieMaintenance: DieMaintenanceRequest[];
  private dieChangeLogs: DieChangeLog[] = [];
  private nextDclId = 1;
  private nextMaintId: number;
  private nextProdId: number;
  /** Tuples currently unlocked from a signed-off state (parity with the
   *  SharePoint DAL so the operator UI's force-load works in dev too). */
  private unlockedTuples = new Set<string>();
  /** Photos "attached" per signed tuple — object URLs standing in for the
   *  SharePoint attachment URLs, so the 📷 flow is testable in dev. */
  private photos = new Map<string, Array<{ name: string; url: string }>>();

  constructor(now: Date = new Date()) {
    this.machines = seedMachines();
    this.operators = seedOperators();
    this.supervisors = seedSupervisors();
    this.rejectCategories = seedRejectCategories();
    this.bdCodes = seedBdCodes();
    this.planning = seedPlanning(now);
    this.production = seedProduction(now, this.planning);
    this.dieColors = seedProductDieColors();
    this.dieMaster = seedDieMaster(now);
    this.dieMaintenance = seedDieMaintenance(now);
    this.dieChangeLogs = seedDieChangeLogs(now);
    this.nextDclId = Math.max(0, ...this.dieChangeLogs.map((r) => r.id)) + 1;
    this.nextMaintId = Math.max(0, ...this.dieMaintenance.map((r) => r.id)) + 1;
    this.nextProdId = Math.max(0, ...this.production.map((r) => r.id)) + 1;
  }

  // Deep-copy on the way out so callers can't mutate internal state.
  private static clone<T>(v: T): T {
    return structuredClone(v);
  }

  async listMachines(): Promise<Machine[]> {
    return MemoryDataLayer.clone(this.machines.filter((m) => m.active));
  }
  async listOperators(): Promise<Operator[]> {
    return MemoryDataLayer.clone(this.operators.filter((o) => o.active));
  }
  async listSupervisors(): Promise<Supervisor[]> {
    return MemoryDataLayer.clone(this.supervisors.filter((s) => s.active));
  }
  async listRejectCategories(): Promise<RejectCategory[]> {
    return MemoryDataLayer.clone(
      [...this.rejectCategories].sort((a, b) => a.sequence - b.sequence),
    );
  }
  async listBdCodes(): Promise<BdCode[]> {
    return MemoryDataLayer.clone([...this.bdCodes].sort((a, b) => a.sequence - b.sequence));
  }
  async listProductDieColors(): Promise<ProductDieColor[]> {
    return MemoryDataLayer.clone(this.dieColors);
  }
  async listDieMaster(): Promise<DieMaster[]> {
    return MemoryDataLayer.clone(this.dieMaster);
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
      >
    >,
  ): Promise<void> {
    const key = dieNumber.trim().toUpperCase();
    const row = this.dieMaster.find((m) => m.dieNumber.trim().toUpperCase() === key);
    if (!row) throw new Error(`No PMD_DieMaster row for die ${dieNumber}`);
    if (patch.toolStatus !== undefined) row.toolStatus = patch.toolStatus;
    if (patch.dateStamp !== undefined) row.dateStamp = patch.dateStamp;
    if (patch.lastServiceDate !== undefined) row.lastServiceDate = patch.lastServiceDate;
    if (patch.availableDate !== undefined) row.availableDate = patch.availableDate;
    if (patch.maintenanceLevel !== undefined) row.maintenanceLevel = patch.maintenanceLevel;
    if (patch.notes !== undefined) row.notes = patch.notes;
  }

  async sendNotice(notice: {
    to: string[];
    subject: string;
    body: string;
    text?: string;
  }): Promise<void> {
    // No mail server in the demo backend — just record the intent so the
    // fire-and-forget path is observable in dev / tests.
    console.info('[pmd] (memory) notice →', notice.to.join(', '), '·', notice.subject);
  }

  // ---- die maintenance (PMD_DieMaintenance parity) ---------------------

  async listDieMaintenance(): Promise<DieMaintenanceRequest[]> {
    return MemoryDataLayer.clone(
      [...this.dieMaintenance].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  async createDieMaintenance(
    req: Omit<DieMaintenanceRequest, 'id' | 'createdAt' | 'closedAt'>,
  ): Promise<DieMaintenanceRequest> {
    const created: DieMaintenanceRequest = MemoryDataLayer.clone({
      ...req,
      id: this.nextMaintId++,
      createdAt: new Date().toISOString(),
      closedAt: '',
    });
    this.dieMaintenance.push(created);
    return MemoryDataLayer.clone(created);
  }

  workOrderSource(): 'mango-csv' | 'list' | null {
    return 'list';
  }

  async listDieChangeLog(): Promise<DieChangeLog[]> {
    return MemoryDataLayer.clone(
      [...this.dieChangeLogs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  async createDieChangeLog(log: Omit<DieChangeLog, 'id' | 'createdAt'>): Promise<DieChangeLog> {
    const eventKey = dieChangeEventKey(
      log.machineCode,
      log.date,
      log.shift,
      log.jobNumber,
      log.eventStartSlot,
    );
    const clean = {
      ...log,
      eventKey,
      eventStartSlot: Math.max(0, Math.floor(log.eventStartSlot)),
      eventEndSlot: Math.max(log.eventStartSlot, Math.floor(log.eventEndSlot)),
    };
    const existing = this.dieChangeLogs.find((r) => r.eventKey === eventKey);
    if (existing) {
      Object.assign(existing, MemoryDataLayer.clone({ ...clean, id: existing.id, createdAt: existing.createdAt }));
      return MemoryDataLayer.clone(existing);
    }
    const created: DieChangeLog = MemoryDataLayer.clone({
      ...clean,
      id: this.nextDclId++,
      createdAt: new Date().toISOString(),
    });
    this.dieChangeLogs.push(created);
    return MemoryDataLayer.clone(created);
  }

  async updateDieMaintenance(
    id: number,
    patch: Partial<Pick<DieMaintenanceRequest, 'status' | 'mangoTicket' | 'closedAt'>>,
  ): Promise<void> {
    const row = this.dieMaintenance.find((r) => r.id === id);
    if (!row) throw new Error(`Die maintenance request ${id} not found`);
    if (patch.status) row.status = patch.status;
    if (patch.mangoTicket !== undefined) row.mangoTicket = patch.mangoTicket;
    if (patch.closedAt !== undefined) row.closedAt = patch.closedAt;
  }

  async createManualOrder(o: {
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
  }): Promise<PlanningOrder> {
    const norm = o.jobNumber.trim().toUpperCase();
    if (this.planning.some((p) => p.jobNumber.trim().toUpperCase() === norm))
      throw new Error(`Job ${o.jobNumber} is already in the order list`);
    const created: PlanningOrder = {
      id: 900_000 + this.planning.length,
      jobNumber: o.jobNumber.trim(),
      machineCode: '',
      originalMachine: '',
      partNumber: o.partNumber,
      partDescription: o.partDescription,
      plannedStart: '',
      plannedEnd: '',
      orderQty: o.orderQty,
      jobRequired: o.orderQty,
      qtyPerHr: 0,
      duration: 0,
      released: true,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
    };
    this.planning.push(created);
    return MemoryDataLayer.clone(created);
  }

  async listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]> {
    let rows = this.planning;
    if (filter.machineCode) rows = rows.filter((p) => p.machineCode === filter.machineCode);
    if (filter.released !== undefined)
      rows = rows.filter((p) => p.released === filter.released);
    return MemoryDataLayer.clone(
      [...rows].sort(
        (a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime(),
      ),
    );
  }

  async listProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    let rows = this.production;
    if (filter.machineCode) rows = rows.filter((r) => r.machineCode === filter.machineCode);
    if (filter.jobNumber) rows = rows.filter((r) => r.jobNumber === filter.jobNumber);
    if (filter.shiftId) rows = rows.filter((r) => r.shiftId === filter.shiftId);
    if (filter.shiftIdFrom) rows = rows.filter((r) => r.shiftId >= filter.shiftIdFrom!);
    if (filter.shiftIdTo) rows = rows.filter((r) => r.shiftId <= filter.shiftIdTo!);
    return MemoryDataLayer.clone(rows);
  }

  async listProductionCounters(filter: ProductionFilter): Promise<ProductionCounterRecord[]> {
    const rows = await this.listProduction(filter);
    const byTuple = new Map<string, ProductionRecord>();
    for (const r of rows) {
      if (r.slotIndex !== 0) continue;
      byTuple.set(`${r.machineCode}|${r.shiftId}|${r.jobNumber}`, r);
    }
    return [...byTuple.values()].map((r) => ({
      machineCode: r.machineCode,
      shiftId: r.shiftId,
      jobNumber: r.jobNumber,
      partNumber: r.partNumber,
      countStart: r.countStart,
      countEnd: r.countEnd,
      cavities: r.cavities,
    }));
  }

  /** Reject Pareto derived from the in-memory records' per-code reject
   *  maps — the mock stand-in for PMD_Rejects. Label resolves from the
   *  seeded RejectCategories (code → description). */
  async listRejectPareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const labelByCode = new Map(this.rejectCategories.map((c) => [c.code, c.label]));
    const qty = new Map<string, number>();
    const statusQty = new Map<
      string,
      Partial<Record<StatusCode | 'Unknown', number>>
    >();
    for (const r of this.inWindow(filter)) {
      let obj: Record<string, number> = {};
      try {
        obj = r.rejects ? (JSON.parse(r.rejects) as Record<string, number>) : {};
      } catch {
        obj = {};
      }
      for (const [code, v] of Object.entries(obj)) {
        const n = Number(v) || 0;
        if (n <= 0) continue;
        qty.set(code, (qty.get(code) ?? 0) + n);
        const status: StatusCode | 'Unknown' = r.statusCode || 'Unknown';
        const statuses = statusQty.get(code) ?? {};
        statuses[status] = (statuses[status] ?? 0) + n;
        statusQty.set(code, statuses);
      }
    }
    return paretoSlices(
      qty,
      (code) => labelByCode.get(code) ?? code,
      (code) => statusQty.get(code),
    );
  }

  /** Downtime Pareto derived from B-status slots' bdIssue — the mock
   *  stand-in for PMD_BreakDownlog (BDCode + breakdown hours). Each B
   *  slot is 0.5 h. */
  async listDowntimePareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const hrs = new Map<string, number>();
    for (const r of this.inWindow(filter)) {
      if (r.statusCode !== 'B' || !r.bdIssue) continue;
      hrs.set(r.bdIssue, (hrs.get(r.bdIssue) ?? 0) + 0.5);
    }
    return paretoSlices(hrs, (code) => bdLabelFor(code) || code);
  }

  /** Records inside a Pareto date window (+ optional machine). */
  private inWindow(filter: ParetoFilter): ProductionRecord[] {
    return this.production.filter((r) => {
      if (filter.machineCode && r.machineCode !== filter.machineCode) return false;
      const day = r.shiftId.slice(0, 10);
      return day >= filter.from && day <= filter.to;
    });
  }

  // Last-write-wins (§5.6): match on composite key, no version check.
  async upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord> {
    const now = new Date().toISOString();
    const idx =
      record.id > 0
        ? this.production.findIndex((r) => r.id === record.id)
        : this.production.findIndex(
            (r) =>
              r.machineCode === record.machineCode &&
              r.shiftId === record.shiftId &&
              r.jobNumber === record.jobNumber &&
              r.slotIndex === record.slotIndex,
          );
    if (idx >= 0) {
      const merged = MemoryDataLayer.clone({
        ...record,
        id: this.production[idx].id,
        createdAt: this.production[idx].createdAt,
        updatedAt: now,
      });
      this.production[idx] = merged;
      return MemoryDataLayer.clone(merged);
    }
    const created = MemoryDataLayer.clone({
      ...record,
      id: this.nextProdId++,
      createdAt: now,
      updatedAt: now,
    });
    this.production.push(created);
    return MemoryDataLayer.clone(created);
  }

  async deleteProductionRecord(id: number): Promise<void> {
    this.production = this.production.filter((r) => r.id !== id);
  }

  /** Contract parity with the SharePoint backend: forget a tuple's
   *  UNSIGNED rows (a browse the worker never confirmed). Signed-off
   *  rows are the permanent record and are never discarded. */
  async discardUnconfirmedTuple(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    this.production = this.production.filter(
      (r) =>
        r.locked ||
        r.machineCode !== machineCode ||
        r.shiftId !== shiftId ||
        r.jobNumber !== jobNumber,
    );
  }

  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
    jobNumber?: string,
    /** Accepted for interface parity with the SharePoint DAL; the memory
     *  DAL doesn't persist a JobLeft column. */
    _jobLeft?: number | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    // Per-job sign-off: other orders on the same shift stay editable
    // (matches the SharePoint DAL — see its lockShift for rationale).
    const rows = this.production.filter(
      (r) =>
        r.machineCode === machineCode &&
        r.shiftId === shiftId &&
        (!jobNumber || r.jobNumber === jobNumber),
    );
    if (rows.length === 0) {
      this.production.push({
        id: this.nextProdId++,
        machineCode,
        shiftId,
        jobNumber: jobNumber ?? '',
        partNumber: '',
        slotIndex: 0,
        statusCode: '',
        countStart: null,
        countEnd: null,
        rejectCount: 0,
        rejects: '{}',
        purgeKg: null,
        operator,
        supervisor,
        bdIssue: '',
        mangoTicket: '',
        handoverNote: '',
        qcBy: '',
        locked: true,
        reopened: false,
        lockedBy: supervisor,
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    for (const r of rows) {
      r.locked = true;
      r.reopened = false;
      r.lockedBy = supervisor;
      r.lockedAt = now;
      r.supervisor = supervisor;
      if (operator) r.operator = operator;
      r.updatedAt = now;
      this.unlockedTuples.delete(`${r.machineCode}|${r.shiftId}|${r.jobNumber}`);
    }
  }

  async unlockShift(
    machineCode: string,
    shiftId: string,
    jobNumber?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const r of this.production) {
      if (r.machineCode !== machineCode || r.shiftId !== shiftId) continue;
      if (jobNumber && r.jobNumber !== jobNumber) continue;
      r.locked = false;
      r.reopened = true;
      r.lockedBy = '';
      r.lockedAt = '';
      r.updatedAt = now;
      this.unlockedTuples.add(`${r.machineCode}|${r.shiftId}|${r.jobNumber}`);
    }
  }

  isUnlockedTuple(machineCode: string, shiftId: string, jobNumber: string): boolean {
    return this.unlockedTuples.has(`${machineCode}|${shiftId}|${jobNumber}`);
  }

  async attachProductionPhoto(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    fileName: string,
    data: Blob,
  ): Promise<boolean> {
    // Same contract as SharePoint: attachments hang off the SIGNED header
    // row, so an unsigned tuple reports false and the caller keeps the
    // photo queued until lockShift.
    const signed = this.production.some(
      (r) =>
        r.machineCode === machineCode &&
        r.shiftId === shiftId &&
        r.jobNumber === jobNumber &&
        r.locked,
    );
    if (!signed) return false;
    const key = `${machineCode}|${shiftId}|${jobNumber}`;
    const list = this.photos.get(key) ?? [];
    if (!list.some((p) => p.name === fileName)) {
      list.push({ name: fileName, url: URL.createObjectURL(data) });
    }
    this.photos.set(key, list);
    return true;
  }

  async listProductionPhotos(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<Array<{ name: string; url: string }>> {
    return [...(this.photos.get(`${machineCode}|${shiftId}|${jobNumber}`) ?? [])];
  }

  async whoAmI(): Promise<UserContext> {
    // Mock identity. Real backends resolve this from the host platform (§2.4).
    return { name: 'Christopher King', role: 'supervisor' };
  }
}

/** Value-descending ParetoSlice[] from a code→value tally. */
function paretoSlices(
  tally: Map<string, number>,
  labelFor: (code: string) => string,
  byStatusFor?: (
    code: string,
  ) => Partial<Record<StatusCode | 'Unknown', number>> | undefined,
): ParetoSlice[] {
  return Array.from(tally.entries())
    .map(([code, value]) => {
      const slice: ParetoSlice = { code, label: labelFor(code), value: +value.toFixed(2) };
      const byStatus = byStatusFor?.(code);
      if (byStatus) slice.byStatus = byStatus;
      return slice;
    })
    .sort((a, b) => b.value - a.value);
}
