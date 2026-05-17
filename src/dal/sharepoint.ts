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
 * Phase 1 — SharePoint List backend (§7.1). SKELETON: methods are wired to
 * the intended REST shape but throw until the SharePoint lists are stood up.
 *
 * Lists: PMD_Machines, PMD_Operators, PMD_Supervisors, PMD_Products,
 *        PMD_Planning, PMD_Production, PMD_RejectCategories, PMD_BdCodes
 *
 * Field mapping: domain camelCase  <->  SharePoint internal names.
 * Lookups are stored as denormalized text + ID pairs (§7.1 constraint).
 *
 * Auth: implicit browser cookies; FormDigest cached 25 min.
 * Throttling: ≤ 600 req/min/app. View threshold: 5000 items/list — the
 * Production list MUST be partitioned by year or archived (§7.1).
 */
export class SharePointDataLayer implements PmdDataLayer {
  constructor(private readonly siteUrl: string) {}

  private listUrl(title: string): string {
    return `${this.siteUrl}/_api/web/lists/getbytitle('${title}')/items`;
  }

  // Writes need a FormDigest: POST {site}/_api/contextinfo ->
  // d.GetContextWebInformation.FormDigestValue, cached for 25 min (§7.1).

  private notImpl(method: string): never {
    throw new Error(
      `SharePointDataLayer.${method}: not implemented — see §7.1. ` +
        `GET ${this.listUrl('<List>')}?$select=...&$top=...&$filter=...`,
    );
  }

  // Reference data — GET with $select/$orderby, cached 15 min by the caller.
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
    // POST (insert) or MERGE (update) with X-RequestDigest + IF-MATCH: *.
    return this.notImpl('upsertPlanningOrder');
  }
  async deletePlanningOrder(_id: number): Promise<void> {
    return this.notImpl('deletePlanningOrder');
  }

  async listProduction(_filter: ProductionFilter): Promise<ProductionRecord[]> {
    // $filter on ShiftId range (lexicographic since IDs are YYYY-MM-DD-...).
    return this.notImpl('listProduction');
  }
  async upsertProductionRecord(_record: ProductionRecord): Promise<ProductionRecord> {
    // POST /items  Headers: X-RequestDigest, IF-MATCH: *
    // Body: { __metadata:{type:'SP.Data.PMD_x005f_ProductionListItem'}, ... }
    // Title field must be set (use JobNumber). Last-write-wins (§5.6).
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
    // Batch-MERGE every item for (MachineCode, ShiftId); create a SlotIndex=0
    // placeholder if none exist (§5.5).
    return this.notImpl('lockShift');
  }
  async unlockShift(_machineCode: string, _shiftId: string): Promise<void> {
    return this.notImpl('unlockShift');
  }

  async whoAmI(): Promise<UserContext> {
    // GET /_api/web/currentUser, then resolve role from PMD_Operators /
    // PMD_Supervisors membership (§2.4).
    return this.notImpl('whoAmI');
  }
}
