/**
 * Domain model for the PMD production schedule.
 *
 * The shapes here mirror the master Epicor/SharePoint workbook
 * (`PMD_Schedule_master_epicor.xlsm`) but are decoupled from any sheet
 * layout — the `data/` adapter layer is responsible for mapping raw cells
 * onto these types. Everything below is plain data; behaviour lives in
 * `engine/`.
 */

import type {
  ColorId,
  InsertId,
  JobId,
  MachineId,
  PartId,
  ToolId,
  WorkCenterId,
  WorkerId,
} from './ids';
import type { MaterialPrepStatus, OrderType, Worker } from './assembly';

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

/** The two production departments this board plans. */
export type Department = 'moulding' | 'assembly';

/**
 * A place work happens: a moulding line (1300T, Batt1) or an assembly area
 * (B – Sofa). Both render as lanes/columns, so the board treats them alike.
 */
export interface WorkCenter {
  id: WorkCenterId;
  kind: 'machine' | 'area';
  department: Department;
  /** Human label, e.g. "1300T" or "B – Sofa". */
  name: string;
  /** Shorter label for tight UI; falls back to `name`. */
  short?: string;
  /** Press tonnage parsed from the name (1300T → 1300). Moulding only. */
  tonnage?: number;
  /** Typical crew size the supervisor allocates. Assembly areas only. */
  suggested?: { min: number; max: number };
  /** Display order on the board; lower is higher. */
  sortIndex: number;
}

/** Shift pattern controlling how many wall-clock hours a day a line runs. */
export interface ShiftPattern {
  /** Key used in the workbook, e.g. "3shift". */
  id: string;
  /** Running hours per calendar day (3shift → 24, 1shift → 8). */
  hoursPerDay: number;
}

/**
 * Routing / capability row: which machine can run a part, with which die,
 * colour and insert. Sourced from the `resource` sheet
 * (BNO → machine / die / Column1=colour / Column3=insert).
 */
export interface RoutingEntry {
  partNum: PartId;
  machine: MachineId;
  tool: ToolId | null; // die / mould
  color: ColorId | null;
  insert: InsertId | null;
  description: string;
}

// ---------------------------------------------------------------------------
// Demand / inventory / supply (material planning inputs)
// ---------------------------------------------------------------------------

/** On-hand balance for a part (finished good or raw material), from `ohb`. */
export interface InventoryItem {
  partNum: PartId;
  description: string;
  /** Epicor Part_TypeCode: "M" manufactured, "P" purchased, … */
  typeCode: string | null;
  onHand: number;
  cmplWip: number;
  supply: number;
  demand: number;
  /** Raw optional Calculated_Demand from the on-hand export; null means unknown. */
  calculatedDemand?: number | null;
  /** Calculated free-on-hand = onHand + supply − demand (may be negative). */
  freeOnHand: number;
}

/** One BOM / material requirement line for a job, from `part req`. */
export interface BomLine {
  finishedPart: PartId;
  jobNum: JobId | null;
  componentPart: PartId;
  requiredQty: number;
  uom: string;
  dueDate: Date | null;
  outstandingQty: number;
}

/** An open purchase order receipt for a raw material, from `po`. */
export interface PoLine {
  partNum: PartId;
  poNum: string | null;
  /** Quantity still to be received. */
  outstandingQty: number;
  dueDate: Date | null;
  promiseDate: Date | null;
  buyer: string | null;
}

/** Period demand for a part, from `total req`. */
export interface DemandLine {
  partNum: PartId;
  reqDate: Date | null;
  reqQty: number;
}

/**
 * One material line of a production order, from `JobMaterialReq.csv`.
 *
 * Order `jobNum` builds `parentPart` and consumes `childPart` to do it. That is
 * what ties the four lines together: wherever another open order is still
 * making `childPart`, this one cannot start until that order is finished.
 *
 *   JobMtl_JobNum   JobHead_PartNum   JobMtl_PartNum
 *   ASM80010        PDSC-FA747        PDSC00747U      ← waits on the UPL order
 *   ASM8002         PDSC00747U        PDSC00747       ← which waits on cut&sew
 */
export interface JobMaterialLink {
  /** `JobMtl_JobNum` — the order that consumes the material. */
  jobNum: JobId;
  /** `JobHead_PartNum` — the part that order builds. */
  parentPart: PartId;
  /** `JobMtl_PartNum` — the component it consumes. */
  childPart: PartId;
  /** Quantity of the component the order needs, when the export carries it. */
  requiredQty: number | null;
}

// ---------------------------------------------------------------------------
// Production orders (jobs)
// ---------------------------------------------------------------------------

/**
 * A releasable production order — the thing a planner drags onto a line.
 * Combines `open jobs` (qty, standard) with the current `planning`
 * assignment (machine, die).
 */
export interface Job {
  id: JobId;
  /** Which department runs it — decides which board it appears on. */
  department: Department;
  partNum: PartId;
  description: string;
  /** Calculated_RemainingQty — units still to be produced. */
  remainingQty: number;
  /** Units per hour the part runs at on its line (planning `qty/hr`). */
  qtyPerHr: number | null;
  /**
   * Standard hours for the **whole** order, completed part included. The bar
   * length is the remaining share of it (`engine/assembly/duration`), so that
   * booking output during the shift shortens the bar.
   *
   * The Epicor export carries the *remaining* hours
   * (`Calculated_RemainingLaborHrs`); the CSV adapter grosses that back up.
   */
  laborHrs: number;
  dueDate: Date | null;
  /**
   * Scheduled start from the source system, when it carries one. From
   * `JobHead_StartDate` + `JobHead_StartHour`, so it carries a time of day.
   */
  startDate: Date | null;
  /** Material "required by" date (planning `Req. By`). */
  reqBy: Date | null;
  /** Null means the source did not provide a trustworthy release value. */
  released: boolean | null;
  /** Scheduling priority; 1 is most urgent. */
  priority: number;
  /**
   * Physical readiness of the material kit, set by the material handler. This
   * is separate from the *computed* availability in `MaterialStatus`: the
   * engine says whether stock exists, this says whether it has been picked.
   */
  materialPrep: MaterialPrepStatus;

  // --- moulding-specific -------------------------------------------------
  /** Die named on the current schedule, used as the changeover key. */
  tool: ToolId | null;
  /** Machine the workbook currently has it on (the planner can override). */
  preferredMachine: MachineId | null;

  // --- assembly-specific -------------------------------------------------
  /** Which of the three kinds of assembly work order this is. */
  orderType: OrderType | null;
  /** The line the order is planned on (UPL / ASSY / TABLE). */
  line: WorkCenterId | null;
  /** Units finished so far, entered at the end of each shift. */
  completedQty: number;
  /**
   * Orders that must finish before this one can start.
   *
   * Mostly derived: `JobMaterialReq.csv` says which components an order
   * consumes, and any component another open order is still making is a
   * predecessor (`engine/assembly/dependencies`). An explicit `Predecessor`
   * column in the order export is merged in on top.
   */
  predecessors: JobId[];
  /** Crew the source system has on the order; the supervisor may change it. */
  assignedWorkers: WorkerId[];
}

// ---------------------------------------------------------------------------
// The complete dataset the engine works over
// ---------------------------------------------------------------------------

export interface PlanningDataset {
  /** Every lane across both departments; filter by `department` per board. */
  workCenters: WorkCenter[];
  jobs: Job[];
  routing: RoutingEntry[];
  inventory: InventoryItem[];
  bom: BomLine[];
  po: PoLine[];
  demand: DemandLine[];
  /** Order-to-order material links, the source of the dependency chain. */
  jobLinks: JobMaterialLink[];
  /** Assembly shift roster. */
  workers: Worker[];
  /** When the source workbook was last refreshed. */
  fetchedAt: Date;
}

// ---------------------------------------------------------------------------
// Computed / derived (engine outputs) — see engine/*
// ---------------------------------------------------------------------------

export type MaterialStatusLevel = 'ok' | 'short' | 'covered' | 'unknown';

/** Shortage detail for a single component of a job. */
export interface ComponentShortage {
  componentPart: PartId;
  description: string;
  requiredQty: number;
  freeOnHand: number;
  shortQty: number;
  /** Earliest PO date that clears the shortfall, if any. */
  coverageDate: Date | null;
  poNum: string | null;
}

/** Roll-up of material readiness for a whole job. */
export interface MaterialStatus {
  level: MaterialStatusLevel;
  /** Earliest date all components are available (null = ready now). */
  earliestStart: Date | null;
  shortages: ComponentShortage[];
}
