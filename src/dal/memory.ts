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
import {
  seedBdCodes,
  seedMachines,
  seedOperators,
  seedPlanning,
  seedProducts,
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
  private products: Product[];
  private rejectCategories: RejectCategory[];
  private bdCodes: BdCode[];
  private planning: PlanningOrder[];
  private production: ProductionRecord[];
  private nextProdId: number;
  private nextPlanId: number;

  constructor(now: Date = new Date()) {
    this.machines = seedMachines();
    this.operators = seedOperators();
    this.supervisors = seedSupervisors();
    this.products = seedProducts();
    this.rejectCategories = seedRejectCategories();
    this.bdCodes = seedBdCodes();
    this.planning = seedPlanning(now);
    this.production = seedProduction(now, this.planning);
    this.nextProdId = Math.max(0, ...this.production.map((r) => r.id)) + 1;
    this.nextPlanId = Math.max(0, ...this.planning.map((p) => p.id)) + 1;
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
  async listProducts(): Promise<Product[]> {
    return MemoryDataLayer.clone(this.products.filter((p) => p.active));
  }
  async listRejectCategories(): Promise<RejectCategory[]> {
    return MemoryDataLayer.clone(
      [...this.rejectCategories].sort((a, b) => a.sequence - b.sequence),
    );
  }
  async listBdCodes(): Promise<BdCode[]> {
    return MemoryDataLayer.clone([...this.bdCodes].sort((a, b) => a.sequence - b.sequence));
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

  async upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder> {
    const idx = this.planning.findIndex((p) => p.id === order.id);
    if (idx >= 0) {
      this.planning[idx] = MemoryDataLayer.clone(order);
      return MemoryDataLayer.clone(this.planning[idx]);
    }
    const created = MemoryDataLayer.clone({ ...order, id: this.nextPlanId++ });
    this.planning.push(created);
    return MemoryDataLayer.clone(created);
  }

  async deletePlanningOrder(id: number): Promise<void> {
    this.planning = this.planning.filter((p) => p.id !== id);
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

  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const rows = this.production.filter(
      (r) => r.machineCode === machineCode && r.shiftId === shiftId,
    );
    if (rows.length === 0) {
      this.production.push({
        id: this.nextProdId++,
        machineCode,
        shiftId,
        jobNumber: '',
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
        locked: true,
        lockedBy: supervisor,
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    for (const r of rows) {
      r.locked = true;
      r.lockedBy = supervisor;
      r.lockedAt = now;
      r.supervisor = supervisor;
      if (operator) r.operator = operator;
      r.updatedAt = now;
    }
  }

  async unlockShift(machineCode: string, shiftId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const r of this.production) {
      if (r.machineCode === machineCode && r.shiftId === shiftId) {
        r.locked = false;
        r.lockedBy = '';
        r.lockedAt = '';
        r.updatedAt = now;
      }
    }
  }

  async whoAmI(): Promise<UserContext> {
    // Mock identity. Real backends resolve this from the host platform (§2.4).
    return { name: 'Christopher King', role: 'supervisor' };
  }
}
