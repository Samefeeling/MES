// Operator sheet — what the sheet is showing: its state, the data layer it
// reads and writes through, and the view each tab and device remembers.
import { isIpadDevice } from '../../core/device';
import { isSupervisor } from '../supervisor-auth';
import type {
  ShiftCode,
  ProductionRecord,
  PlanningOrder,
  Machine,
  Operator,
  RejectCategory,
  BdCode,
} from '../../types';
import type { OrderFacts } from '../../core/order-history';
import type { PmdDataLayer } from '../../dal';

/**
 * Device-class write rule (replaces the old per-device OwnerDevice claim
 * arbitration which caused fights between iPads on the floor):
 *   iPad → writable (it's the on-floor data-entry device)
 *   anything else → read-only, unless supervisor mode is signed in
 * Memoised iPad detection + live supervisor session → re-evaluated on
 * every call so a supervisor sign-in flips the UI immediately.
 */
export function canWriteThisDevice(): boolean {
  return isIpadDevice() || isSupervisor();
}

// PMD Operator Production Sheet — Excel-style rebuild of modPMDOperator.bas.
// One machine + one shift + one job at a time. 16 half-hour slots horizontally;
// rows are: Machine Status / 10 defect rows (D01-D10).

interface OpState {
  mc: string;
  viewDate: Date;
  shiftCode: ShiftCode;
  selJob: string;
  prod: ProductionRecord[];
  planning: PlanningOrder[];
  machines: Machine[];
  /** Full roster objects (carry .shift) so the dropdowns can narrow to
   *  the selected shift's people — see rosterNames(). */
  operators: Operator[];
  supervisors: Operator[];
  /** Refresh is the operator's explicit escape hatch from the normal
   *  five-day planning window: once pressed, show every Planning order for
   *  the rest of this Operator-page session. */
  showAllPlanningOrders: boolean;
  rejCats: RejectCategory[];
  /** BDCODE -> PMD_BreakdownMaster row. Cause is authoritative for all
   * Breakdown detail shown on the Operator sheet. */
  bdCodes: Map<string, BdCode>;
  selOperator: string;
  selSupervisor: string;
  /** The press and shift ("machine|shiftId") the names above were picked
   *  or loaded for. Names staged for a sheet not yet confirmed carry from
   *  one order to the next on the same press in the same shift — the same
   *  crew — and never into another shift or onto another press. */
  namesFor: string;
  /** 1 = single-shift detail (editable); 2 = today's 3 shifts;
   *  3 = past 7 days; 4 = past 30 days. Levels 2-4 are read-only summaries. */
  viewLevel: number;
  /** Sum of Good across all shifts of selJob — drives the cross-shift Job Left. */
  jobTotalGood: number;
  /** "machine|shiftId" keys of EARLIER shifts of selJob that produced
   *  pieces but were never signed off. Job Left arithmetic is signed-only
   *  (see refreshJobTotal), so while this is non-empty the number
   *  OVERSTATES what's still needed — the ⚠ next to Job Left names the
   *  shift(s) that need signing. */
  unsignedEarlier: string[];
  /** What the selected order's own signed history says about it (Part #,
   *  Order Qty, cycle time) — the fallback after Planning.csv, which drops an
   *  order Epicor has completed (an overrun one included) while the press is
   *  still running it. Null until read, or for another order. */
  jobFacts: { job: string; facts: OrderFacts } | null;
  /** Good already signed on OTHER shifts, per co-runner of `job` — what the
   *  block-the-cavity reminder needs to know each co-runner's Job Left. Read
   *  for one selection on one (machine, shift) `key`; anything else on screen
   *  means it has not been read yet and no reminder is shown from it. */
  coRunGood: { job: string; key: string; at: number; totals: Map<string, number> } | null;
  /** Orders this press ran in the previous shift that Planning.csv no longer
   *  holds — an order overrun past its quantity is complete in Epicor while
   *  the press is still on it. Offered in the Job# list as carried over,
   *  never picked for the worker. `key` is the press and shift they are for. */
  carried: { key: string; jobs: string[] } | null;
  /** Slots currently highlighted for status entry (tap or hold-and-drag). */
  selSet: Set<number>;
  /** Part # → die / paint hex colour + physical die number, read from
   *  PMD_ProductDieColor on boot. Drives the swatch on the Product
   *  Description meta cell + the Die# pill so the operator can see the
   *  colour and which die to fit before starting the job. */
  dieColors: Map<string, { hex: string; name: string; dieNumber: string; die: string; coRun: boolean }>;
  /** Die # → cavities, read from PMD_DieMaster on boot. Keyed by
   *  dieKey() because the two lists drift in case and padding. This is
   *  what makes the Cavities figure a lookup instead of a question: the
   *  order fixes the part, the part fixes the die, the die fixes this. */
  dieCavities: Map<string, number | null>;
}

export let S: OpState | null = null;

export let dalRef: PmdDataLayer;

/** The sheet's state and its data layer are held here and set by
 *  `renderOperator`; every other part of the sheet only reads them. */
export function setSheetState(state: OpState): void {
  S = state;
}

export function setSheetDal(dal: PmdDataLayer): void {
  dalRef = dal;
}

// Per-tab persistence of which shift the operator was last looking at.
// Without this, switching to KPIs and back resets viewDate / shiftCode to
// today's live shift — and an iPad operator who'd been reviewing 02/06
// loses their place every time they tap a top-nav link by accident.
const UI_KEY = 'pmd_op_view_v1';

// Per-DEVICE memory of the press this iPad last worked on. sessionStorage
// dies with the tab, so an iPad whose Safari tab was killed (or that
// reopens the sheet from a bookmark carrying a stale #/op/… hash) used to
// land on machines[0] — every floor iPad snapped back to 1600T after an
// asset redeploy and workers typed into the wrong press. localStorage
// survives tab death and redeploys (the auto-updater never touches it);
// main.ts consults it on boot. Only the MACHINE is remembered at device
// scope — date / shift / job deliberately reset to the live defaults so
// yesterday's context can't leak into a fresh day.
const DEVICE_MC_KEY = 'pmd_op_mc_v1';

interface PersistedView {
  mc: string;
  viewDateIso: string;
  shiftCode: ShiftCode;
  selJob: string;
  selOperator: string;
  selSupervisor: string;
}

export function loadSavedOperatorView(): PersistedView | null {
  try {
    const raw = sessionStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as PersistedView) : null;
  } catch {
    return null;
  }
}

/** The press this DEVICE last had open ('' when never saved / blocked). */
export function loadDeviceMachine(): string {
  try {
    return localStorage.getItem(DEVICE_MC_KEY) ?? '';
  } catch {
    return '';
  }
}

export function loadView(): PersistedView | null {
  return loadSavedOperatorView();
}

export function saveView(): void {
  if (!S) return;
  try {
    sessionStorage.setItem(
      UI_KEY,
      JSON.stringify({
        mc: S.mc,
        viewDateIso: S.viewDate.toISOString(),
        shiftCode: S.shiftCode,
        selJob: S.selJob,
        selOperator: S.selOperator,
        selSupervisor: S.selSupervisor,
      }),
    );
  } catch {
    /* storage blocked — best effort */
  }
  try {
    localStorage.setItem(DEVICE_MC_KEY, S.mc);
  } catch {
    /* storage blocked — best effort */
  }
}
