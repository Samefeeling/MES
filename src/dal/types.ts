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
  Supervisor,
  UserContext,
} from '../types';

// §6.1 — the single seam every backend implements. The UI and core logic
// depend only on this interface, never on a concrete backend.
export interface PmdDataLayer {
  // Reference data (cached aggressively — §6.2)
  listMachines(): Promise<Machine[]>;
  listOperators(): Promise<Operator[]>;
  listSupervisors(): Promise<Supervisor[]>;
  listProducts(): Promise<Product[]>;
  listRejectCategories(): Promise<RejectCategory[]>;
  listBdCodes(): Promise<BdCode[]>;
  /** Die / paint colour per Part #. Used by the operator's Product
   *  Description swatch and the KPIs Color column. Optional — a tenant
   *  without PMD_ProductDieColor returns an empty list. */
  listProductDieColors?(): Promise<ProductDieColor[]>;

  // Planning (read-mostly)
  listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]>;
  upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder>;
  deletePlanningOrder(id: number): Promise<void>;

  // Production (hot path)
  listProduction(filter: ProductionFilter): Promise<ProductionRecord[]>;
  upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord>;
  deleteProductionRecord(id: number): Promise<void>;
  lockShift(machineCode: string, shiftId: string, supervisor: string, operator: string): Promise<void>;
  /** Unlocks signed-off records for a (machine, shift). When jobNumber
   *  is supplied, only that job's rows are unlocked; otherwise the
   *  whole shift is unlocked. Per-job is the common path (one order
   *  signed off by mistake on a shift that holds several orders). */
  unlockShift(machineCode: string, shiftId: string, jobNumber?: string): Promise<void>;
  /** Flush every unsigned editCache entry to the backing store as a
   *  "live snapshot" so other clients can see this iPad's in-progress
   *  work without waiting for Sign Off & Save. Fire-and-forget; the
   *  operator poll calls this every 60 s. No-op for stores that
   *  share state in-process (memory DAL). */
  pushLiveSnapshot?(): Promise<void>;

  // Identity
  whoAmI(): Promise<UserContext>;
}

export type BackendKind = 'memory' | 'sharepoint' | 'sql' | 'azure';
