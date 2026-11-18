// SharePoint data layer — the lists and their columns as this tenant names
// them, and the options a deployment may override them with.


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

export const LISTS = {
  machine: 'PMD_Machine',
  operator: 'PMD_Operator',
  supervisor: 'PMD_Supervisor',
  planning: 'PMD_Planning',
  /** Supervisor-added orders missing from the Epicor extract. Title =
   *  JobNumber; auto-provisioned on first add (see createManualOrder). */
  manualOrders: 'PMD_ManualOrders',
  production: 'PMD_Production',
  /** Transient "in-progress" mirror of PMD_Production. pushLiveSnapshot
   *  writes here every poll tick; Sign Off & Save copies the row into
   *  PMD_Production and deletes it from here. Same column schema as
   *  PMD_Production by design — see the production field map. */
  liveStatus: 'PMD_LiveStatus',
  rejects: 'PMD_Rejects',
  breakdown: 'PMD_BreakDownlog',
  rejectCategories: 'PMD_RejectCategories',
  breakdownMaster: 'PMD_BreakdownMaster',
  productDieColor: 'PMD_ProductDieColor',
  /** Legacy die maintenance requests, read only when the Mango report
   *  mirror (MangoWorkOrders.csv) is missing. Work orders are raised in
   *  Mango now, so the app never writes here. */
  dieMaintenance: 'PMD_DieMaintenance',
  /** Die asset register (one row per physical tool) — created by hand on
   *  the site (2026-07). Read-only from the app; the toolroom maintains
   *  ToolStatus / cavities / changeover facts directly in SharePoint. */
  dieMaster: 'PMD_DieMaster',
  /** Die-change condition reports (created by hand 2026-07 — internal
   *  names verified against the list schema export). The operator sheet
   *  writes here when a Die/Insert Change is first marked. */
  dieChangeLog: 'PMD_DieChangeLog',
  rdoRoster: 'RDO Roster 2026-2030',
  /** The plan of record of each press in each shift (SavedShiftPlan),
   *  written an hour before the shift (or at its first sign-off), kept up with
   *  Planning.csv for what is left of the shift while it runs, deleted after
   *  two months; plus one `PlanningChecked` row. Auto-provisioned
   *  on the first keep (see ensureShiftPlanList). */
  shiftPlan: 'PMD_ShiftPlan',
  /** The days the factory is shut — public holidays and RDOs — kept by the
   *  Assembly board (assembly/src/data/sharepoint/factoryCalendar.list.ts):
   *  Date, and Name ("RDO" or the holiday's name). Read-only here. */
  factoryCalendar: 'FactoryCalendar',
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
export const DEFAULT_FIELDS = {
  machine: {
    code: 'Title', // machine code (e.g. "1600T") lives in Title
    active: 'IsActive_x003a_Yes_x002f_No', // display is literally "IsActive: Yes/No"
    displayOrder: 'DisplayOrder',
    // Maint → Machine. Resolved against the list's own field map at read
    // time (display name or internal name), and added if missing.
    status: 'Status',
    lastService: 'LastService',
    mtbf: 'MTBF',
    mttr: 'MTTR',
    breakdowns: 'Breakdowns',
    available: 'Available',
    availableDate: 'AvailableDate',
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
  planning: {
    // Source of truth is now Epicor REST — scripts/sync-epicor-to-sp.ps1
    // (running on the always-on on-prem PC, every 15 min) pulls the BAQ
    // and upserts here. Epicor has no machine assignment for PMD orders,
    // so Title is filled with JobNum (acts as natural key) and the app
    // never reads it back — machineCode below is sourced as empty and
    // the operator dropdown lists all PMD-released orders.
    machine: '', // skip read/write — no machine in Epicor source
    startDateTime: 'StartDateTime',
    qtyHour: 'QTYperHour',
    dueDate: 'Due_Date',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    // Total order quantity from Epicor — feeds "Order Qty".
    prodQty: 'JobHead_ProdQty',
    // Remaining quantity from Epicor — feeds "Job left".
    remaining: 'Calculated_RemainingQty',
    duration: 'Duration',
    dieNumber: '', // no source
    dc: '', // no source
  },
  production: {
    machine: 'Title',
    // The `MachineCode` column on this tenant has been repurposed to hold
    // the 16-char status timeline string — same value as PMD_BreakDownlog.
    // StatusTimeline — so the SP list is self-readable without joining.
    // `machineCodeAlt` is therefore a misnomer kept for backwards-compat
    // of the field map; see upsertProductionHeader for what actually gets
    // written here.
    machineCodeAlt: 'MachineCode',
    date: 'SlotStart_x003a_', // display "Date", actually the DateTime "SlotStart:"
    shift: 'ShiftId',
    // The dedicated StatusTimeline column was never re-added to
    // PMD_Production — the timeline lives in MachineCode (see above) and
    // PMD_BreakDownlog.StatusTimeline. Leave blank so the writer skips it.
    timeline: '',
    jobNumber: 'JobNumber',
    // Cached so the SP list is readable without joining to PMD_Planning —
    // requested by the supervisor reviewing signed-off shifts. Part # is
    // also denormalised so KPIs can resolve PMD_ProductDieColor by
    // record.partNumber directly.
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    /** Total job quantity at sign-off time, denormalised so the
     *  operator UI can render Order Qty after Epicor drops a
     *  completed order from PMD_Planning. Optional column on the
     *  tenant; strip-rejected-fields tolerates absence. */
    jobRequired: 'JobRequired',
    /** Cycle time (hours/piece) denormalised at sign-off so a past shift
     *  can recompute Shift Target after Epicor drops the order. Optional
     *  column; stripRejectedFields tolerates absence. */
    cycleTime: 'CycleTime',
    /** Shift Target snapshot written at sign-off for the SP list / Power
     *  BI. The app recomputes the authoritative value from CycleTime, so
     *  this is a denormalised convenience, not a read dependency. */
    shiftTarget: 'ShiftTarget',
    /** The shift's Schedule % frozen at sign-off. Schedule Adherence is
     *  otherwise recomputed live against Planning.csv, and Epicor drops a
     *  completed order from planning — so Monday's number could not be
     *  reproduced on Friday. Optional column; stripRejectedFields tolerates
     *  absence. */
    vsPlan: 'VSPLAN',
    /** The machine-shift's Schedule Adherence (%) and the pieces its plan
     *  asked for, saved at sign-off — see scheduleSnapshotForShift. A
     *  percentage alone cannot be summed over a week, so the plan rides
     *  beside it. ScheduleAttain may be a plain number (87.5) or a number
     *  column shown as a percentage (0.875); scheduleAttainAsFraction tells
     *  which. Optional columns; stripRejectedFields tolerates absence. */
    scheduleAttain: 'ScheduleAttain',
    schedulePlan: 'SchedulePlan',
    countStart: 'CountStart',
    countEnd: 'CountEnd',
    /** Identical cavities on the die (pieces per press cycle). Actual
     *  pieces = (CountEnd − CountStart) × Cavities. Canonical on slot 0.
     *  Optional column; stripRejectedFields tolerates absence (defaults
     *  to 1). */
    cavities: 'Cavities',
    reject: 'Reject',
    operator: 'Operator',
    supervisor: 'Supervisor',
    runTime: 'RunTime',
    downTime: 'Downtime',
    handover: 'Handover',
    totalGood: 'TotalGood',
    // Per-slot QC sign-off, stored as JSON {"<slotIndex>":"<name>"}.
    // Column added to PMD_Production / PMD_LiveStatus to record
    // alternating operator / supervisor quality checks across the
    // shift's 16 half-hour slots.
    qcChecks: 'QualityChecks',
    // Per-slot per-code reject map, JSON {"<slotIndex>":{"<code>":qty}}.
    // PMD_Rejects (event list) is only populated on sign-off, so live
    // shifts on PMD_LiveStatus had no path for reject breakdowns to
    // reach other iPads — Machine Status / QC / Count Start / Count
    // End round-tripped via dedicated columns; rejects didn't. This
    // column closes that gap. The read path prefers PMD_Rejects events
    // when present, falling back to this JSON for live (unsigned) rows.
    rejectsBySlot: 'RejectsBySlot',
    /** PMD_LiveStatus only: the device id that last touched this
     *  (machine, shift, job) live row. Diagnostics-only — the write
     *  rule is device-CLASS (iPad vs not) via SharePointOptions.canWrite,
     *  not per-device-id arbitration (the old claim model caused fights
     *  between iPads in practice). Absent on PMD_Production; strip-
     *  rejected-fields tolerates the column not existing on a tenant. */
    ownerDevice: 'OwnerDevice',
    /** Wall-clock timestamp (date+time) of when the (machine, shift, job)
     *  was signed off, written on lockShift. The signed-off banner reads
     *  this so it shows when sign-off ACTUALLY happened, not the viewing
     *  device's current clock. DateTime column; stripRejectedFields
     *  tolerates absence (older tenants fall back to the render-time
     *  stamp). */
    signOff: 'Signoff',
    /** Job Left at sign-off time — the same value the operator sees on
     *  the Operator side panel (JobRequired − sum-of-Good across every
     *  shift of this job, including the one being signed off). Persisted
     *  so a supervisor reviewing a past shift in SharePoint / Power BI
     *  can read what the floor saw without re-deriving from production
     *  rows. Number column; stripRejectedFields tolerates absence. */
    jobLeft: 'JobLeft',
    /** PMD_Production only — Yes/No flag a supervisor sets when re-opening a
     *  signed-off order for correction. Yes = reopened (editable again, all
     *  devices agree); No / absent = locked. Cleared to No on re-sign-off.
     *  Optional column; stripRejectedFields tolerates absence (then a
     *  reopened order falls back to the old device-local behaviour). */
    reopened: 'Reopened',
    /** Planned start of the order (JobHead_StartDate with its time from the
     *  planning CSV, local ISO '2026-07-01T18:40:00'), denormalised onto
     *  PMD_Production at sign-off — same pattern as PartNum/JobRequired.
     *  Epicor drops completed orders from planning, so without this the
     *  historical operator views retain the original start for jobs that
     *  finished. Text column (avoids the site-timezone shifting we
     *  hit on Signoff); stripRejectedFields tolerates absence. */
    plannedStart: 'PlannedStart',
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
    bdCause: 'BDCause',
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
    // Current tenant columns are BDCODE + Cause. listBdCodes also probes
    // the legacy Code + Title names so older deployments keep working.
    code: 'BDCODE',
    category: 'Category',
    cause: 'Cause',
    likelyOwner: 'LikelyOwner',
  },
  productDieColor: {
    // Per-Part # die / paint colour. PartNum is the natural key, matching
    // Planning.csv's JobHead_PartNum (= PlanningOrder.partNumber).
    // ColorHex stores "#RRGGBB"; ActualColor is the friendly label
    // (e.g. "Grey Green") used for the swatch tooltip and the KPIs Color
    // column label.
    partNum: 'PartNum',
    hex: 'ColorHex',
    name: 'ActualColor',
    // Product category (e.g. "Battens") — groups the KPI TOTAL row
    // into per-category subtotals.
    category: 'Category',
    /** Physical die number — shown next to Product Description on the
     *  operator sheet so the floor knows which die to fit. Optional
     *  column; stripRejectedFields tolerates absence. */
    dieNumber: 'DieNumber',
    /** Die description (the `Die` column — the tool's human name).
     *  Optional column; read resolves common naming variants. */
    die: 'Die',
    /** Yes/No flag marking a part as a co-runner: parts that share a die
     *  AND both carry CoRun = Yes are run simultaneously on one press, so
     *  the operator sheet mirrors the machine status across them. Same
     *  die without the flag (or only one side flagged) means they run
     *  one-after-another and stay independent. Optional column. */
    coRun: 'CoRun',
  },
  dieMaster: {
    // Column names as created on the site (single-word display names, so
    // internal names match). DieNumber may live in Title instead when the
    // list was made by renaming the default column — listDieMaster probes
    // both. All cells are hand-edited; reads coerce defensively.
    dieNumber: 'DieNumber',
    description: 'DieDescription',
    cavities: 'Cavities',
    cycleTime: 'CycleTime',
    dieWeightKg: 'DieWeightKG',
    leanReady: 'LeanReady',
    toolInjectorPlate: 'ToolInjectorPlate',
    changeOverIn: 'ChangeOverIn',
    changeOverOut: 'ChangeOverOut',
    // Observed median die-change hours, written by the KPI import. Number
    // column, auto-provisioned on first write like MaintenanceLevel/Notes.
    changeOverMedian: 'ChangeOverMedian',
    lifeCycle: 'LifeCycle',
    dateStamp: 'DateStamp',
    lastServiceDate: 'LastServiceDate',
    availableDate: 'Available',
    toolStatus: 'ToolStatus',
    // Multi-line text: the die's customised multi-level PM plan
    // (`L2 | 10,000 shots | task; task` per line). Empty = default plan.
    maintenanceLevel: 'MaintenanceLevel',
    // Multi-line text: the running SOC change log, one note per line
    // (`Date/Shift/Machine/Operator: body`). Empty = no notes yet.
    notes: 'Notes',
  },
  dieChangeLog: {
    // Internal names straight from the list schema export (2026-07).
    // Date is DateOnly; DieNumberOut/In are Number columns; ChangeOver is
    // MultiChoice (Die / Insert / Space In / SpaceOut); the 13 component
    // columns are Choice with the three "1./2./3." condition strings.
    date: 'Date',
    shift: 'Shift',
    dieSetter: 'DieSetter',
    machine: 'Machine',
    changeOver: 'ChangeOver',
    jobNumber: 'JobNumber',
    dieNumberOut: 'DieNumberOut',
    dieDescriptionOut: 'DieDescriptionOut',
    dieNumberIn: 'DieNumberIn',
    dieDescriptionIn: 'DieDescriptionIn',
    problemDescription: 'ProblemDescription',
    /** Added by ensureDieChangeLogSchema. EventKey is indexed + unique so
     *  two iPads cannot create two rows for the same continuous D/I block. */
    eventKey: 'EventKey',
    eventStartSlot: 'EventStartSlot',
    eventEndSlot: 'EventEndSlot',
    /** The existing 13 Choice columns remain the OUT inspection. The IN
     *  inspection is JSON because duplicating 13 more Choice fields makes
     *  the list brittle and hard to provision consistently. */
    componentsInJson: 'ComponentsInJson',
    problemDescriptionIn: 'ProblemDescriptionIn',
    /** The 1 / 2 / 3 the setter signs the whole inspection off on — the
     *  worst component rating on the event. Written as a bare digit; the
     *  column may be Number or Choice depending on how the site made it,
     *  so the type is read off the list and the value shaped to match. */
    signOffStatus: 'SignOffStatus',
  },
  dieMaintenance: {
    // Title = DieNumber (natural key into PMD_ProductDieColor.DieNumber).
    // All other columns are plain Text/Note so auto-provisioning stays
    // simple and nothing fights SharePoint's choice-column validation.
    // ClosedAt is TEXT ISO on purpose — DateTime columns get shifted by
    // the site timezone (same lesson as PMD_Production.PlannedStart).
    dieNumber: 'Title',
    status: 'Status',
    maintType: 'MaintType',
    priority: 'Priority',
    description: 'Description',
    contact: 'Contact',
    requestedBy: 'RequestedBy',
    machine: 'Machine',
    jobNumber: 'JobNumber',
    mangoTicket: 'MangoTicket',
    closedAt: 'ClosedAt',
    dueDate: 'DueDate',
  },
} as const;

export type SharePointFieldMap = typeof DEFAULT_FIELDS;

export type PartialFieldMap = {
  [K in keyof SharePointFieldMap]?: Partial<SharePointFieldMap[K]>;
};

export interface SharePointOptions {
  siteUrl: string;
  /**
   * Server-relative path to a CSV holding planning data (preferred over
   * reading PMD_Planning list when set). Example:
   *   "/sites/PMD/Shared Documents/PMD/Planning.csv"
   * Produced by scripts/sync-epicor-to-sp.ps1 + OneDrive sync.
   */
  planningCsvPath?: string;
  /**
   * Server-relative path to the Mango plant-equipment work-order report
   * (CSV). When set, the Die Management tab's work-order list mirrors
   * this file INSTEAD of the PMD_DieMaintenance list — Mango is the
   * system of record; the file is refreshed by scripts/sync-mango-csv.mjs
   * (Playwright download on the on-prem PC) + OneDrive sync, same
   * pipeline as Planning.csv. Example:
   *   "/sites/PMD/Shared Documents/PMD/MangoWorkOrders.csv"
   */
  mangoCsvPath?: string;
  /**
   * Server-relative path to MachinePM.csv — Mango's plant-equipment
   * register with its PM events, in the same folder as the other two.
   * Feeds Maint → Machine (next service) and Maint → Team (PM due).
   */
  machinePmCsvPath?: string;
  /** Override any list/field internal name without editing this file. */
  fieldMap?: PartialFieldMap;
  /**
   * Whether THIS browser is allowed to mutate the SharePoint lists.
   * The DAL itself is UA-agnostic — the UI injects this hook (typically
   * `isIpadDevice() || isSupervisor()`) so cache-merge and live-snapshot
   * paths can tell whether to treat the local editCache as authoritative
   * (writable: per-slot merge wins) or stale (read-only: server snapshot
   * wins wholesale). Defaults to `() => true` for backwards-compatibility
   * and for tests / scripts that need to write unconditionally.
   */
  canWrite?: () => boolean;
}

export function mergeFieldMap(base: SharePointFieldMap, override?: PartialFieldMap): SharePointFieldMap {
  if (!override) return base;
  const out = { ...base } as SharePointFieldMap;
  for (const k of Object.keys(override) as Array<keyof SharePointFieldMap>) {
    const merged = { ...(base[k] as Record<string, string>), ...(override[k] as Record<string, string>) };
    (out[k] as Record<string, string>) = merged;
  }
  return out;
}

export type MachineMasterField = 'status' | 'lastService' | 'mtbf' | 'mttr' | 'breakdowns' | 'available' | 'availableDate';

export const MACHINE_MASTER_FIELDS: readonly MachineMasterField[] = [
  'status', 'lastService', 'mtbf', 'mttr', 'breakdowns', 'available', 'availableDate',
];
