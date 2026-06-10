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
  locked: boolean;
  lockedBy: string;
  lockedAt: string;
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
