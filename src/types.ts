// Domain model — mirrors §3 (Data Schema) and §2 (Domain Model) of the spec.
// Field names use camelCase in the app; backend adapters map to/from the
// physical column names (PascalCase in SharePoint/SQL).

export type StatusCode = 'R' | 'B' | 'C' | 'D' | 'I' | 'M' | 'O' | 'P' | 'S';
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
  /** PMD_ProductDieColor.CoRun (Yes/No). Two parts are treated as
   *  co-runners — run simultaneously on one press, so the operator sheet
   *  mirrors their machine status — only when they share a die AND BOTH
   *  carry CoRun = Yes. Same die without the flag means they run
   *  one-after-another and stay independent. Defaults to false. */
  coRun: boolean;
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
   *  display. Distinct from jobRequired, which counts down as pieces ship. */
  orderQty: number;
  /** Remaining quantity (Epicor Calculated_RemainingQty) — drives "Job left". */
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
   *  (PMD_Production.Reopened = Yes). The row is editable again — but only
   *  its already-signed slots and counts, not new time periods — and every
   *  device sees the same reopened state because the flag is on the server,
   *  not device-local. Cleared back to false on the next sign-off. */
  reopened?: boolean;
  createdAt: string;
  updatedAt: string;
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
 *  the quantity/hours it accounts for. Reject Pareto → RejectCode +
 *  RejectCategory; Downtime Pareto → BDCode + breakdown cause. */
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
}
