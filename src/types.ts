// Domain model — mirrors §3 (Data Schema) and §2 (Domain Model) of the spec.
// Field names use camelCase in the app; backend adapters map to/from the
// physical column names (PascalCase in SharePoint/SQL).

export type StatusCode = 'R' | 'B' | 'C' | 'D' | 'I' | 'M' | 'O' | 'P' | 'S';
/** PMD_Rejects.RejectCategory captures the machine state at the instant a
 *  reject happened. Unknown preserves blank/legacy values without guessing. */
export type RejectMachineStatus = StatusCode | 'Unknown';
export type ShiftCode = 'Day' | 'Afternoon' | 'Night';
export type Role = 'operator' | 'supervisor' | 'admin';

/** How a status code is accounted for in KPI rollups (§2.2). */
export type StatusKind = 'production' | 'downtime' | 'setup' | 'idle';

export interface Machine {
  id: number;
  machineCode: string;
  displayName: string;
  sequence: number;
  active: boolean;
}

export interface Operator {
  id: number;
  operatorName: string;
  employeeId?: string;
  active: boolean;
  linkedUser?: string;
  /** Roster shift this person works (PMD_Operator.Shift), e.g. "Day".
   *  Empty / undefined when untagged — such entries show on every shift
   *  so a missing tag never hides a needed name. */
  shift?: string;
}

// PMD_Supervisors has the same shape as PMD_Operators (§3.3).
export type Supervisor = Operator;

export interface RejectCategory {
  code: string;
  label: string;
  sequence: number;
}

/** A single row of PMD_ProductDieColor: the die / paint colour tied
 *  to a Part #. Drives the swatch on the operator's Product
 *  Description field and the Color column on KPIs. */
export interface ProductDieColor {
  /** Epicor Part # (e.g. "SF-1234-A"). Matches PlanningOrder.partNumber. */
  partNumber: string;
  /** CSS-ready hex value (e.g. "#1e3a8a"). Empty string when unknown. */
  hex: string;
  /** Friendly name (e.g. "Navy"). Empty string when not recorded. */
  name: string;
  /** Product category (e.g. "Battens") — groups the KPI TOTAL row into
   *  per-category subtotals. Empty string when not recorded. */
  category: string;
  /** Physical die number used to run the part (e.g. "D-247"). Shown on the
   *  operator sheet next to Product Description so the floor knows which
   *  die to fit before starting the job. Empty when not recorded. */
  dieNumber: string;
  /** Die description from PMD_ProductDieColor's `Die` column (the human
   *  name of the tool, e.g. "Viva Backrest 2-cav"). Empty when not
   *  recorded. Shown on the Die Management table next to the number. */
  die: string;
  /** PMD_ProductDieColor.CoRun (Yes/No). Two parts are treated as
   *  co-runners — run simultaneously on one press, so the operator sheet
   *  mirrors their machine status — only when they share a die AND BOTH
   *  carry CoRun = Yes. Same die without the flag means they run
   *  one-after-another and stay independent. Defaults to false. */
  coRun: boolean;
}

/** Condition of a physical die, from PMD_DieMaster.ToolStatus:
 *  Serviced (green — maintenance up to date) · In service (blue — the
 *  tool is in active use) · To be Serviced (orange — service is owed) ·
 *  Problems (red — known defect / do not run without checking). */
export type ToolStatus = 'serviced' | 'in-service' | 'to-be-serviced' | 'problems';

/** Intensity band of the shot-based service rule (core/die.ts
 *  TOOL_MAINTENANCE_RULES). Service is due only from accumulated press
 *  cycles (shots); calendar age does not advance the PM status.
 *  B is the site baseline; C is the condition-escalated band applied
 *  while the latest Die Change Log reports worn/damaged components. */
export type ToolMaintenanceLevel = 'A' | 'B' | 'C';

/** One row of PMD_DieMaster — the die ASSET register (one row per
 *  physical tool), maintained by the toolroom directly in SharePoint.
 *  PMD_ProductDieColor stays the part→die MAPPING; this list carries the
 *  tool's own facts. All numeric fields are null when the cell is empty. */
export interface DieMaster {
  /** Natural key, matches ProductDieColor.dieNumber. */
  dieNumber: string;
  /** DieDescription column. */
  description: string;
  cavities: number | null;
  /** Nominal cycle time (seconds). */
  cycleTime: number | null;
  dieWeightKg: number | null;
  /** Yes/No: tool is lean-changeover ready. Null when the cell is empty. */
  leanReady: boolean | null;
  /** ToolInjectorPlate column (free text / Yes-No as entered). */
  toolInjectorPlate: string;
  /** Changeover HOURS in / out (the toolroom records these in hours,
   *  not minutes — a big mould swap is a 1-4 h job). */
  changeOverIn: number | null;
  changeOverOut: number | null;
  /** Expected total life (shots). */
  lifeCycle: number | null;
  /** DateStamp column — when the row was last reviewed / status changed. */
  dateStamp: string;
  /** LastServiceDate column — when the tool last came back from service.
   *  Stamped automatically when the app sets ToolStatus to Serviced;
   *  also the preferred reset point for the A/B/C service counter.
   *  '' when never recorded. */
  lastServiceDate: string;
  /** Available column — while the die is In service, the date the
   *  maintenance team has confirmed it comes back. Drives the Die tab's
   *  Available column. '' when not set. */
  availableDate: string;
  /** '' when the ToolStatus cell is empty / unrecognised. */
  toolStatus: ToolStatus | '';
  /** MaintenanceLevel column (multi-line text) — this die's customised
   *  multi-level PM plan, one level per line
   *  (`L2 | 10,000 shots | task; task`). '' = not customised: the app
   *  shows the default 3-tier template (core/die.ts defaultPmPlanText)
   *  until a supervisor edits it from the drilldown. */
  maintenanceLevel: string;
  /** Notes column (multi-line text) — the running SOC change log for this
   *  die: one note per line, each formatted
   *  `Date/Shift/Machine/Operator: body` (see core/die.ts formatDieNoteLine).
   *  Appended from the die drilldown's "Add note" action; '' when the die
   *  has no notes yet. */
  notes: string;
}

/** Lifecycle of a die maintenance request (Fabrico-style work order):
 *  raised on the floor → picked up by toolroom → closed. */
export type MaintStatus = 'open' | 'in-progress' | 'done';
export type MaintType = 'repair' | 'cleaning' | 'inspection' | 'other';
export type MaintPriority = 'low' | 'normal' | 'high' | 'urgent';

/** One row of PMD_DieMaintenance: a maintenance / cleaning work request
 *  raised against a physical die (Title = DieNumber). MangoTicket is the
 *  hook for the future Mango integration — once the request is mirrored
 *  into Mango, its ticket id lands here so the two systems cross-link. */
export interface DieMaintenanceRequest {
  id: number;
  /** Physical die this request is about (PMD_ProductDieColor.DieNumber).
   *  Empty on a machine/plant work order (see `asset`). */
  dieNumber: string;
  /** Raw Mango Plant/Equipment string this work order was raised against
   *  ("AU - Die 171 Podium Seat", "AU - 850 Tonne Press", …). Preserved so
   *  the Die board can match a machine work order to a press by its code
   *  without knowing Mango's exact asset-naming convention. Only the CSV
   *  mirror fills it; PMD_DieMaintenance rows leave it undefined. */
  asset?: string;
  status: MaintStatus;
  maintType: MaintType;
  priority: MaintPriority;
  /** What's wrong / what needs doing — free text from the requester. */
  description: string;
  /** Built-in maintenance contact the request is addressed to. */
  contact: string;
  requestedBy: string;
  /** Press the die was on when the problem was noticed (optional). */
  machineCode: string;
  /** Job running when the problem was noticed (optional). */
  jobNumber: string;
  /** Mango ticket id once the request exists there ('' until linked). */
  mangoTicket: string;
  createdAt: string; // ISO
  /** Set when status transitions to done ('' while open/in-progress). */
  closedAt: string;

  // ---- Mango report detail (optional) — only the CSV work-order mirror
  // fills these; rows from the PMD_DieMaintenance list leave them
  // undefined. All free text as exported.
  /** Downtime the fault caused (hours, as recorded in Mango). */
  downtime?: string;
  /** Labour hours booked on the work order. */
  labourHours?: string;
  /** "Describe the issue" — the requester's full fault description. */
  issueDetail?: string;
  /** "Actions taken" — Mango's stage/comment history for the order. */
  actionsTaken?: string;
  /** "Summary of work completed". */
  workSummary?: string;
  /** "Corrective action taken". */
  correctiveAction?: string;
  /** "Preventative action taken". */
  preventativeAction?: string;
  /** "Summary" — the closing free-text note (the export's last column). */
  summary?: string;
  /** "Cost (parts, labour)". */
  cost?: string;
  /** "To be completed by" — Mango's promised completion date. For open
   *  orders this is when the die should be AVAILABLE again (ISO). */
  dueDate?: string;
}

/** Condition of one die component at die-change time, mapping the
 *  PMD_DieChangeLog choice values: "1. Good work order" / "2. Operational
 *  but worn" / "3. Damaged or can't be used". '' = not assessed. */
export type DieComponentCondition = '' | 'good' | 'worn' | 'damaged';

/** One row of PMD_DieChangeLog — exactly one continuous D/I block on a
 *  machine/job timeline. Component keys are the list's column names
 *  (Bolts, Cores, EjectorPins, …, WaterLeaks). */
export interface DieChangeLog {
  id: number;
  /** Stable, server-unique identity for the continuous timeline event. */
  eventKey: string;
  /** Inclusive zero-based slot bounds of the continuous D/I block. */
  eventStartSlot: number;
  eventEndSlot: number;
  /** Calendar date of the change (YYYY-MM-DD). */
  date: string;
  shift: string;
  /** Who performed the change (DieSetter column). */
  dieSetter: string;
  machineCode: string;
  /** ChangeOver multi-choice: Die / Insert / Space In / SpaceOut. */
  changeOver: string[];
  jobNumber: string;
  dieNumberOut: string;
  dieDescriptionOut: string;
  dieNumberIn: string;
  dieDescriptionIn: string;
  /** Die OUT component key → condition ('' when not assessed). */
  components: Record<string, DieComponentCondition>;
  /** Die IN component key → condition. Kept on the same event row. */
  componentsIn: Record<string, DieComponentCondition>;
  problemDescription: string;
  problemDescriptionIn: string;
  createdAt: string; // ISO
}

export interface BdCode {
  code: string;
  label: string;
  subCategory?: string;
  sequence: number;
  owner?: string; // Likely-owner per the breakdown taxonomy MD
}

export interface PlanningOrder {
  id: number;
  jobNumber: string;
  machineCode: string;
  originalMachine?: string;
  partNumber: string;
  partDescription: string;
  plannedStart: string; // ISO 8601
  plannedEnd: string; // ISO 8601
  /** Total order quantity (Epicor JobHead_ProdQty) — drives the "Order Qty"
   *  display AND is the base for Job Left (order total − Σ PMD Good). */
  orderQty: number;
  /** Remaining quantity (Epicor Calculated_RemainingQty). NOT the Job Left
   *  base: Epicor decrements this as production is reported back to it, so
   *  subtracting PMD's Good from it again double-counts (SFM507147 showed
   *  0 with 656 left). Only used as a last-resort orderQty fallback. */
  jobRequired: number;
  qtyPerHr: number;
  duration: number; // hours
  released: boolean;
  isDieChange: boolean;
  manuallyAdded: boolean;
  source: 'ERP' | 'Auto-DC' | 'Manual';
}

export interface ProductionRecord {
  id: number;
  machineCode: string;
  shiftId: string; // YYYY-MM-DD-<Day|Afternoon|Night>
  jobNumber: string;
  /** Epicor Part # for the job — denormalised onto every slot so the
   *  KPIs / colour swatch / supervisor list views can read PMD_Production
   *  without joining back to PMD_Planning (orders roll off over time). */
  partNumber: string;
  /** Epicor Part Description for the job — denormalised on the canonical
   *  (slot 0) row so an unlock-then-resign-off path can preserve the
   *  original description even when Epicor has dropped the order from
   *  the active planning CSV. Empty on per-status slots; lockShift
   *  reads it from whatever slot carries a non-empty value. */
  partDescription?: string;
  /** Total job quantity required at sign-off time. Denormalised on the
   *  canonical (slot 0) row so the operator UI can show Order Qty for
   *  jobs that Epicor has since dropped from PMD_Planning (the
   *  active-planning CSV only carries IN-PROGRESS orders). Falls back
   *  to 0 / "—" when the underlying PMD_Production column hasn't been
   *  added on the tenant yet. */
  jobRequired?: number;
  /** Cycle time (hours per piece, Epicor JobOper_ProdStandard)
   *  denormalised onto the canonical (slot 0) row at sign-off via the
   *  PMD_Production.CycleTime column. Lets a PAST shift recompute Shift
   *  Target after Epicor drops the order from PMD_Planning — without it
   *  the synthetic order had no rate and Shift Target rendered "—".
   *  Falls back to 0 / undefined on tenants without the column. */
  cycleTime?: number;
  /** Job Left frozen at JOB START (order total − Good already made on
   *  every OTHER shift of this job). Stamped on the canonical (slot 0)
   *  row when the tuple is first created and persisted to the
   *  PMD_Production.JobLeft column, so a Trace lookup can read "how many
   *  were still needed when this shift started" per row without
   *  re-deriving it. The operator side panel still shows a LIVE Job Left
   *  (this snapshot does not move as the shift produces). Undefined for
   *  die-change rows and on tenants without the column. */
  jobLeft?: number;
  /** Shift Target frozen at JOB START (shiftTargetFor of the at-start
   *  jobLeft + cycle time). Persisted to PMD_Production.ShiftTarget and
   *  read back so Trace shows the recorded target per row. Undefined when
   *  no rate was available / on tenants without the column. */
  shiftTarget?: number;
  /** Number of identical cavities on the die (pieces produced per press
   *  cycle). The press counter ticks once per cycle, so actual pieces =
   *  (Count End − Count Start) × cavities. Canonical on slot 0, persisted
   *  to PMD_Production.Cavities. Defaults to 1 (single cavity) — only a
   *  few presses (550T / 320T / 150T / 125T) ever run a 2-cavity die, and
   *  the operator ticks a box to set it. Undefined / 0 is treated as 1. */
  cavities?: number;
  /** Planned start of the order (JobHead_StartDate + StartHour, local ISO
   *  '2026-07-01T18:40:00'), denormalised onto PMD_Production.PlannedStart
   *  at sign-off so KPI Schedule Adherence still knows when the job was
   *  SCHEDULED after Epicor drops it from planning. Canonical on slot 0;
   *  undefined on live rows and tenants without the column. */
  plannedStart?: string;
  slotIndex: number; // 0..15
  statusCode: StatusCode | '';
  countStart: number | null;
  countEnd: number | null;
  rejectCount: number;
  rejects: string; // JSON, e.g. {"D01":3,"D05":1}
  purgeKg: number | null; // Purge(kg) per (machine, shift, job) — canonical on slot 0
  operator: string;
  supervisor: string;
  bdIssue: string;
  mangoTicket: string;
  handoverNote: string; // only meaningful on slotIndex=0
  /** Per-slot Quality Check sign-off. Even slots are signed by the
   *  operator, odd slots by the supervisor (alternating cadence —
   *  every 30 min one or the other physically checks the press). Empty
   *  string when the check hasn't happened yet. Persists to the
   *  PMD_Production.QualityChecks column as a slot→name JSON map. */
  qcBy: string;
  locked: boolean;
  lockedBy: string;
  lockedAt: string;
  /** Signed-off then re-opened by a supervisor for correction
   *  (PMD_Production.Reopened = Yes). The row is editable again: its
   *  already-signed slots and counts everywhere; NEW time periods only
   *  while the shift is still running or with a supervisor signed in
   *  (an ended shift must not sprout after-the-fact production). Every
   *  device sees the same reopened state because the flag is on the server,
   *  not device-local. Cleared back to false on the next sign-off. */
  reopened?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight canonical production header used by the mould service
 *  counter. It deliberately excludes timelines/rejects so the Tool page
 *  can load a year of shot history without downloading every slot event. */
export interface ProductionCounterRecord {
  machineCode: string;
  shiftId: string;
  jobNumber: string;
  partNumber: string;
  countStart: number | null;
  countEnd: number | null;
  cavities?: number;
}

export interface UserContext {
  name: string;
  role: Role;
}

export interface PlanningFilter {
  machineCode?: string;
  released?: boolean;
}

export interface ProductionFilter {
  machineCode?: string;
  shiftId?: string; // exact match
  shiftIdFrom?: string; // lexicographic range (IDs are YYYY-MM-DD-...)
  shiftIdTo?: string;
  jobNumber?: string;
}

/** Date-range (+ optional machine) filter for the management Pareto
 *  aggregations. Dates are inclusive calendar days, YYYY-MM-DD. */
export interface ParetoFilter {
  from: string;
  to: string;
  machineCode?: string;
}

/** One bar of a Pareto chart: a code, a human label for the legend, and
 *  the quantity/hours it accounts for. Reject Pareto uses RejectCode + its
 *  PMD_RejectCategories master description (PMD_Rejects.RejectCategory is
 *  MachineStatus); Downtime Pareto uses BDCode + breakdown cause. */
export interface ParetoSlice {
  code: string;
  label: string;
  value: number;
  /** Optional per-shift split of `value` so the KPI Reject Pareto can
   *  stack Day / Afternoon / Night like the Output-by-shift chart.
   *  PMD_Rejects carries a Shift column, so listRejectPareto fills this;
   *  sources without shift attribution (Downtime) leave it undefined and
   *  the chart falls back to a single bar. Sums to `value`. */
  byShift?: Record<ShiftCode, number>;
  /** Reject quantity split by the MachineStatus snapshot stored in
   *  PMD_Rejects.RejectCategory. R means the defect occurred during normal
   *  production and is the key action signal; S and other setup states give
   *  context for expected startup/changeover scrap. Sums to `value`. */
  byStatus?: Partial<Record<RejectMachineStatus, number>>;
}
