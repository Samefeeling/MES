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

export interface Product {
  id: number;
  partNumber: string;
  description: string;
  standardCycleSec: number;
  cavities: number;
  active: boolean;
}

// `named` = the 5 fixed reject rows on the operator sheet (P11/P12/P1/P5/P9);
// `other` = the codes selectable from the "Other (Drop Down)" row.
export type RejectKind = 'named' | 'other';

export interface RejectCategory {
  code: string;
  label: string;
  sequence: number;
  kind: RejectKind;
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
  slotIndex: number; // 0..15
  statusCode: StatusCode | '';
  countStart: number | null;
  countEnd: number | null;
  rejectCount: number;
  rejects: string; // JSON, e.g. {"P11":3,"P14":1}
  otherType: string; // "Other (Drop Down)" value for this slot (.bas row 12)
  otherCount: number; // "Other #" qty for this slot (.bas row 13)
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
