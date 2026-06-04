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
 * Phase 3 — Azure backend (§7.3). SKELETON.
 *
 * Recommended option A: Azure SQL + Azure Static Web Apps with SWA-managed
 * Functions for the API (same row shape as Phase 2; migration is a bacpac
 * import). Auth via Entra ID / Azure AD B2C through SWA's built-in provider;
 * `whoAmI` reads `/.auth/me`.
 */
export class AzureDataLayer implements PmdDataLayer {
  constructor(private readonly apiBase: string) {}

  private notImpl(method: string): never {
    throw new Error(
      `AzureDataLayer.${method}: not implemented — SWA Functions at ${this.apiBase} (§7.3)`,
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
  async unlockShift(
    _machineCode: string,
    _shiftId: string,
    _jobNumber?: string,
  ): Promise<void> {
    return this.notImpl('unlockShift');
  }
  async whoAmI(): Promise<UserContext> {
    return this.notImpl('whoAmI');
  }
}
