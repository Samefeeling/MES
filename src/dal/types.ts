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
  /** The die ASSET register (PMD_DieMaster) — one row per physical tool:
   *  cavities, cycle time, weight, changeover minutes, expected life and
   *  the toolroom's ToolStatus verdict. Read-only from the app (the
   *  toolroom edits the list in SharePoint). Optional — a tenant without
   *  the list returns an empty array and the Status column shows "—". */
  listDieMaster?(): Promise<DieMaster[]>;
  /** Change a tool's condition verdict (and its audit dates) or its
   *  customised PM plan (MaintenanceLevel) on the die asset register. The
   *  UI stamps dateStamp on every change, lastServiceDate when the new
   *  status is 'serviced', and availableDate (the maintenance-confirmed
   *  return date) when the new status is 'in-service'; maintenanceLevel
   *  is supervisor-edited from the drilldown's Service Plan section.
   *  Optional — only backends that can write PMD_DieMaster implement it;
   *  without it the Status badge and PM plan are display-only. */
  updateDieMaster?(
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
  ): Promise<void>;

  /** Queue a notice email. Used by the Die board to alert the toolroom lead
   *  when a tool's ToolStatus changes. Optional — only backends with an
   *  outbound path implement it.
   *
   *  Resolving means ACCEPTED FOR DELIVERY, not delivered: the SharePoint
   *  backend writes a PMD_Notices row that a Power Automate flow turns into
   *  mail (SP.Utilities.Utility.SendEmail, the old direct route, was retired
   *  by Microsoft). The UI calls it fire-and-forget so a failure here never
   *  blocks or rolls back the write the notice is about. */
  sendNotice?(notice: {
    to: string[];
    subject: string;
    /** HTML body. */
    body: string;
    /** Same content as `body` without markup, for plain-text delivery and
     *  so a queue row stays readable in SharePoint. */
    text?: string;
    /** Which feature raised it (e.g. 'die-status') — lets one flow serve
     *  several notice types. */
    source?: string;
  }): Promise<void>;

  // Die maintenance (Trace → 🛠 Die Management). Backed by the
  // PMD_DieMaintenance list on SharePoint (auto-provisioned on first
  // write — see the SharePoint DAL); MangoTicket on each request is the
  // future Mango-integration link. Optional as a group: a backend either
  // implements all three or none.
  /** All maintenance requests, newest first. Empty when the list doesn't
   *  exist yet (nothing has been requested). */
  listDieMaintenance?(): Promise<DieMaintenanceRequest[]>;
  /** The machine/plant half of the same Mango report: work orders whose
   *  Plant/Equipment names a press or other equipment rather than a die,
   *  with the raw asset on `asset` so the Die board's Machine column can
   *  match them to a press by code. Only the CSV mirror serves these;
   *  returns [] on backends/tenants without it. Newest first. */
  listMachineMaintenance?(): Promise<DieMaintenanceRequest[]>;
  /** Persist a new request (id/createdAt assigned by the backend). */
  createDieMaintenance?(
    req: Omit<DieMaintenanceRequest, 'id' | 'createdAt' | 'closedAt'>,
  ): Promise<DieMaintenanceRequest>;
  /** Advance a request's lifecycle (open → in-progress → done) and/or
   *  attach the Mango ticket id once it exists there. */
  updateDieMaintenance?(
    id: number,
    patch: Partial<Pick<DieMaintenanceRequest, 'status' | 'mangoTicket' | 'closedAt'>>,
  ): Promise<void>;
  /** Which source the most recent listDieMaintenance() actually served:
   *  'mango-csv' (report mirror) or 'list' (PMD_DieMaintenance
   *  fallback); null before the first read. Diagnostics only — the Die
   *  tab's chip uses it to say why history might be missing. */
  workOrderSource?(): 'mango-csv' | 'list' | null;

  // Die change log (PMD_DieChangeLog) — the operator's die-change
  // condition report, popped up on the first D/I status of a tuple.
  /** All die-change reports, newest first. */
  listDieChangeLog?(): Promise<DieChangeLog[]>;
  /** Persist a new report (id/createdAt assigned by the backend). */
  createDieChangeLog?(log: Omit<DieChangeLog, 'id' | 'createdAt'>): Promise<DieChangeLog>;

  // Planning (read-only — the Epicor → Planning.csv pipeline owns writes)
  listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]>;

  /** Persist an order the Epicor extract is missing (rush job, extract
   *  lag) so the operator can pick it. Supervisor-only in the UI. Stored
   *  outside the planning pipeline (PMD_ManualOrders on SharePoint) and
   *  merged into listPlanning with source 'Manual' — an ERP row for the
   *  same job number wins once Epicor catches up. Optional. */
  createManualOrder?(o: {
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
  }): Promise<PlanningOrder>;

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
  /** Canonical slot-0 counters only. The Tool service planner uses this
   *  lightweight path for its rolling annual ledger so it does not have
   *  to download a year of status/reject event detail. */
  listProductionCounters?(filter: ProductionFilter): Promise<ProductionCounterRecord[]>;
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
