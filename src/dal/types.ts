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
  listRejectCategories(): Promise<RejectCategory[]>;
  listBdCodes(): Promise<BdCode[]>;
  /** Die / paint colour per Part #. Used by the operator's Product
   *  Description swatch and the KPIs Color column. Optional — a tenant
   *  without PMD_ProductDieColor returns an empty list. */
  listProductDieColors?(): Promise<ProductDieColor[]>;

  // Planning (read-only — the Epicor → Planning.csv pipeline owns writes)
  listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]>;

  /** Reject quantity per defect code over a date range, for the KPI
   *  Reject Pareto. SharePoint reads PMD_Rejects directly (RejectCode +
   *  RejectCategory + RejectNumber); the memory backend derives it from
   *  its records. Each slice's `label` is the RejectCategory. Sorted
   *  value-descending. Optional — KPI hides the chart when absent. */
  listRejectPareto?(filter: ParetoFilter): Promise<ParetoSlice[]>;
  /** Breakdown downtime hours per BDCode over a date range, for the KPI
   *  Downtime Pareto. SharePoint reads PMD_BreakDownlog (BDCode +
   *  B_BreakDown hours); `label` is the breakdown cause. Sorted
   *  value-descending. Optional — KPI hides the chart when absent. */
  listDowntimePareto?(filter: ParetoFilter): Promise<ParetoSlice[]>;

  // Production (hot path)
  listProduction(filter: ProductionFilter): Promise<ProductionRecord[]>;
  /** Signed-off history only — reads PMD_Production exclusively, with no
   *  in-progress PMD_LiveStatus mirror and no local editCache blended in.
   *  The Trace "Job Number Search" uses this so a historical lookup
   *  reflects the canonical source of truth. Optional — callers fall back
   *  to listProduction()+locked filter when a backend doesn't model the
   *  live/signed split (memory DAL). */
  listSignedOffProduction?(filter: ProductionFilter): Promise<ProductionRecord[]>;
  upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord>;
  deleteProductionRecord(id: number): Promise<void>;
  /** Signs off records for a (machine, shift). When jobNumber is
   *  supplied, ONLY that job's records are signed off — other orders
   *  on the same shift (e.g. the next job an operator already started
   *  on the remaining timeline slots) stay live and editable. Omit to
   *  sign off every job on the shift (legacy whole-shift sign-off). */
  lockShift(machineCode: string, shiftId: string, supervisor: string, operator: string, jobNumber?: string, jobLeft?: number | null): Promise<void>;
  /** Unlocks signed-off records for a (machine, shift). When jobNumber
   *  is supplied, only that job's rows are unlocked; otherwise the
   *  whole shift is unlocked. Per-job is the common path (one order
   *  signed off by mistake on a shift that holds several orders). */
  unlockShift(machineCode: string, shiftId: string, jobNumber?: string): Promise<void>;
  /** True when a (machine, shift, job) tuple has been unlocked from a
   *  signed-off state and is currently being edited (before the
   *  re-sign-off commits). The operator UI uses this to force-load the
   *  authoritative Operator / Supervisor (and other canonical totals)
   *  from the rehydrated PMD_Production row rather than keeping a
   *  leftover live selection. Optional — backends that don't model an
   *  unlock-edit window can omit it (treated as false). */
  isUnlockedTuple?(machineCode: string, shiftId: string, jobNumber: string): boolean;
  /** Attach a photo (already-compressed JPEG blob) to the PMD_Production
   *  header row for (machine, shift, job). Returns false when that row
   *  doesn't exist yet — the tuple hasn't been signed off — so callers
   *  keep the photo queued and retry after lockShift creates the row.
   *  Optional — backends without attachment storage omit it. */
  attachProductionPhoto?(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    fileName: string,
    data: Blob,
  ): Promise<boolean>;
  /** Photos already attached to the tuple's PMD_Production row, for the
   *  side panel's thumbnail strip. Empty when the row doesn't exist.
   *  Optional — pairs with attachProductionPhoto. */
  listProductionPhotos?(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<Array<{ name: string; url: string }>>;
  /** Flush every unsigned editCache entry to the backing store as a
   *  "live snapshot" so other clients can see this iPad's in-progress
   *  work without waiting for Sign Off & Save. Fire-and-forget; the
   *  operator poll calls this every 60 s. No-op for stores that
   *  share state in-process (memory DAL). */
  pushLiveSnapshot?(): Promise<void>;

  /** Install the live-mirror gate: pushLiveSnapshot only broadcasts a
   *  tuple the hook approves. The app wires this to the confirmed-tuple
   *  registry (core/confirm.ts) so un-confirmed browse artefacts never
   *  reach PMD_LiveStatus. Optional — in-process backends omit it. */
  setLiveGate?(gate: (machineCode: string, shiftId: string, jobNumber: string) => boolean): void;

  /** Discard a tuple's local unsigned edits (edit cache) and best-effort
   *  delete its already-mirrored PMD_LiveStatus row. The operator UI
   *  calls this when the worker navigates away from a (machine, shift,
   *  job) they never confirmed — that selection was a browse, not a run,
   *  and keeping it around is exactly how junk rows were born. Optional. */
  discardUnconfirmedTuple?(machineCode: string, shiftId: string, jobNumber: string): Promise<void>;

  /** Live-mirror health for the on-screen badge: whether this device is
   *  allowed to push, when its last snapshot fully succeeded, and the
   *  last failure's message. Optional — in-process backends omit it. */
  mirrorHealth?(): { writable: boolean; okAt: number | null; failAt: number | null; error: string };

  /** This client's stable device id. Stamped onto PMD_LiveStatus's
   *  OwnerDevice column for after-the-fact diagnostics ("which iPad
   *  last touched this press?"). Optional — single-device backends
   *  (memory) can omit it. */
  getDeviceId?(): string;

  // Identity
  whoAmI(): Promise<UserContext>;
}

export type BackendKind = 'memory' | 'sharepoint';
