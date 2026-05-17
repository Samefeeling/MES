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

/**
 * Phase 2 — SQL Server backend (§7.2). SKELETON.
 *
 * Talks to an Express/.NET REST layer in front of SQL Server (the browser
 * never holds a DB connection). JWT auth against AD (passport-saml).
 * Concurrency: optimistic via `UpdatedAt` rowversion; mismatches ignored
 * (last-write-wins, §5.6) but logged server-side for review.
 *
 * Indexes (§7.2): PMD_Production (MachineCode, ShiftId) clustered,
 * non-clustered (JobNumber), (Locked); PMD_Planning (MachineCode, PlannedStart).
 */
export class SqlDataLayer implements PmdDataLayer {
  constructor(private readonly apiBase: string) {}

  private notImpl(method: string): never {
    throw new Error(
      `SqlDataLayer.${method}: not implemented — REST against ${this.apiBase} (§7.2)`,
    );
  }

  async listMachines(): Promise<Machine[]> {
    return this.notImpl('listMachines');
  }
  async listOperators(): Promise<Operator[]> {
    return this.notImpl('listOperators');
  }
  async listSupervisors(): Promise<Supervisor[]> {
    return this.notImpl('listSupervisors');
  }
  async listProducts(): Promise<Product[]> {
    return this.notImpl('listProducts');
  }
  async listRejectCategories(): Promise<RejectCategory[]> {
    return this.notImpl('listRejectCategories');
  }
  async listBdCodes(): Promise<BdCode[]> {
    return this.notImpl('listBdCodes');
  }
  async listPlanning(_filter: PlanningFilter): Promise<PlanningOrder[]> {
    return this.notImpl('listPlanning');
  }
  async upsertPlanningOrder(_order: PlanningOrder): Promise<PlanningOrder> {
    return this.notImpl('upsertPlanningOrder');
  }
  async deletePlanningOrder(_id: number): Promise<void> {
    return this.notImpl('deletePlanningOrder');
  }
  async listProduction(_filter: ProductionFilter): Promise<ProductionRecord[]> {
    return this.notImpl('listProduction');
  }
  async upsertProductionRecord(_record: ProductionRecord): Promise<ProductionRecord> {
    return this.notImpl('upsertProductionRecord');
  }
  async deleteProductionRecord(_id: number): Promise<void> {
    return this.notImpl('deleteProductionRecord');
  }
  async lockShift(
    _machineCode: string,
    _shiftId: string,
    _supervisor: string,
    _operator: string,
  ): Promise<void> {
    return this.notImpl('lockShift');
  }
  async unlockShift(_machineCode: string, _shiftId: string): Promise<void> {
    return this.notImpl('unlockShift');
  }
  async whoAmI(): Promise<UserContext> {
    return this.notImpl('whoAmI');
  }
}
