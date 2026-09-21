/**
 * Persistence contract for saved plans. Single planner, so "current" is the
 * working plan; `list()` supports named snapshots if you want them later.
 */

import type { Containers } from '@/store/planStore';
import type {
  ActualStartRecord,
  ProductionEntry,
  ProgressBaseline,
} from '@/store/planStore';
import type { CrewAssignment, LineKey } from '@/domain/assembly';

export interface PersistedPlan {
  id: string;
  name: string;
  /** ISO timestamp. */
  savedAt: string;
  containers: Containers;
  /** Assembly plan: crew per order, pinned starts, booked output. */
  assembly?: {
    /** Shared exclusions from automatic crew suggestions. */
    ignoredOrderIds?: string[];
    lineLayoutVersion?: number;
    manualOrders?: Record<string, import('@/domain/manualOrder').ManualOrder>;
    /**
     * The shape crew was stored in before it had day windows. Read on the way
     * in and migrated; never written. See `planStore.setAssemblyPlan`.
     */
    orderWorkers?: Record<string, string[]>;
    /** Supervisor-owned roster placement, independent of legacy Skills data. */
    workerLines?: Record<string, LineKey>;
    /**
     * Worker id → the local days they were marked off on the board.
     *
     * A shift record rather than planning: it is what happened, not what
     * somebody decided, so it is written as soon as it is marked and is not
     * dropped when a draft plan is. See `planParts`.
     */
    workerOnLeave?: Record<string, string[]>;
    /**
     * Lines the supervisor opened on the floor. Part of the plan rather than
     * of one browser: a bench opened for a rush is a fact about the week, and
     * every screen reading the board has to see the same one.
     */
    virtualLines?: import('@/domain/assembly').VirtualLine[];
    /** What this floor calls each line, where the built-in name is not it. */
    lineNames?: Record<string, string>;
    /**
     * The sequence the lines are drawn in, arranged by dragging one onto
     * another. Absent on a plan nobody has arranged, which reads as the order
     * the plant lists them in — see `domain/assembly.arrangeLines`.
     */
    lineOrder?: LineKey[];
    /** Date-bounded crew plan; supersedes static `orderWorkers`. */
    orderCrewAssignments?: Record<string, CrewAssignment[]>;
    orderStarts?: Record<string, string>;
    /** Exact, immutable production start confirmation. */
    orderActualStarts?: Record<string, ActualStartRecord>;
    /** Orders the supervisor approved for weekend working. */
    orderOvertime?: Record<string, boolean>;
    /** Per order, the people approved to be on it while on another too. */
    orderDoubleBooked?: Record<string, string[]>;
    progress?: Record<string, { date: string; qty: number }[]>;
    progressBaselines?: Record<string, ProgressBaseline>;
    /** Daily rows persisted by the backend in the ASSY_Production list. */
    production?: Record<string, ProductionEntry[]>;
    /**
     * Job id → the local day the order was last in a source export. Without
     * it, retention restarts on every page load and an order missing from the
     * first export after one loses its plan anyway. See `PLAN_RETENTION_DAYS`.
     */
    lastSeen?: Record<string, string>;
  };
}

export interface PlanSummary {
  id: string;
  name: string;
  savedAt: string;
}

/** The id used for the planner's live working plan. */
export const CURRENT_PLAN_ID = 'current';

/**
 * The id a day's closing plan is filed under.
 *
 * One row per day the board was used, holding that day's last saved state.
 * The working plan is a single row that every save overwrites, so until these
 * existed the board had no history at all: a crew allocation lost to a
 * mis-drag, an order somebody moved off a line, a shift entry saved against
 * the wrong job — there was nothing to compare with and nothing to go back to.
 *
 * Each day's row is also, exactly, the state the next day starts from: the
 * plan is not reset overnight, so the last save of Thursday *is* Friday's
 * opening position, and this is the record of what that was.
 */
export const dailyPlanId = (day: string): string => `day-${day}`;

/** True for the ids `dailyPlanId` makes, so a listing can tell them apart. */
export const isDailyPlanId = (id: string): boolean =>
  /^day-\d{4}-\d{2}-\d{2}$/.test(id);

export interface PlanRepository {
  save(plan: PersistedPlan): Promise<void>;
  load(id?: string): Promise<PersistedPlan | null>;
  list(): Promise<PlanSummary[]>;
  /**
   * File a read-only copy of a plan under its own id, leaving the working plan
   * alone. Used for the daily archive above.
   *
   * Written once per id: a day that has already been filed is never rewritten,
   * so a second board coming along later — or a tab that was open across
   * midnight and is behind — cannot overwrite the history with a staler copy.
   */
  saveSnapshot(plan: PersistedPlan): Promise<void>;
}
