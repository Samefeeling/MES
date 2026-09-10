/**
 * The planner's working state: which orders sit on which line, who is on them,
 * where their bar starts, and what each shift booked.
 *
 * Placement is modelled as named "containers" of job ids — one per line plus a
 * pool of un-assigned orders — which makes drag-and-drop uniform. The derived
 * schedule (start, Expect Date, colour) is computed in
 * `engine/assembly/board.ts`; this store only owns the inputs.
 */

import { create } from 'zustand';
import { manualJob, type ManualOrder } from '@/domain/manualOrder';
import type { JobId } from '@/domain/ids';
import type { Job, WorkCenter } from '@/domain/types';
import {
  MAX_WORKERS_PER_ORDER,
  readLineKey,
  type CrewAssignment,
  type LineKey,
} from '@/domain/assembly';

/** Container id for the un-scheduled job pool. */
export const POOL_ID = '__pool__';

/**
 * How long an order's plan outlives its last appearance in an export.
 *
 * `Planning1.csv` is re-exported twice a day, and an order missing from one of
 * them is more often a bad export than a finished job: a filter changed
 * upstream, the file was written while the BAQ was still running, a row lost
 * its part number and was skipped. Acting on the first absence made that
 * unrecoverable — the crew, the dragged start, the shift's own bookings and
 * the order's place in its line all went in one pass, and when the row came
 * back it came back bare, at the bottom of the pool.
 *
 * So an absence is recorded rather than acted on, and only a fortnight of them
 * forgets anything. Nothing is drawn in the meantime: the board builds its
 * rows from the export, so an order that is not in one has no row either way.
 * What is being kept is the planning, against the order coming back.
 */
export const PLAN_RETENTION_DAYS = 14;

/** Local `YYYY-MM-DD`, the key both the board and this store count days in. */
const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

/**
 * The same date `days` earlier. Built from the parts rather than by subtracting
 * milliseconds: a calendar day is not always 86,400,000 ms, and this is asked
 * across the two Sundays a year when it is not.
 */
const daysBefore = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);

export type Containers = Record<string, JobId[]>;

export type PauseReason =
  | 'material-shortage'
  | 'waiting-previous-stage'
  | 'equipment'
  | 'quality'
  | 'labour-reallocated';

/** One daily ASSY_Production booking, shaped for downstream KPI.ts use. */
export interface ProductionEntry {
  laborHours?: number;
  date: string;
  /** Quantity confirmed complete during the shift. */
  complete: number;
  reject: number;
  rework: number;
  /** Total output reported by the shift, including pieces awaiting disposition. */
  shiftOutput: number;
  paused: boolean;
  pauseReason: PauseReason | null;
  /** Explicit supervisor confirmation that no more work remains on this job. */
  jobCompleted: boolean;
  /** Immutable crew snapshot for this shift. */
  operatorIds?: string[];
  operatorNames?: string[];
  /** Exact completion instant; set only when `jobCompleted` is true. */
  completedAt?: string | null;
  notes: string;
}

export interface ActualStartRecord {
  /** Exact instant the Start production button was confirmed. */
  startedAt: string;
  /** Required whenever the normal release gate was overridden. */
  overrideReason: string | null;
  operatorIds: string[];
  operatorNames: string[];
}

export interface ProgressBaseline {
  /** Source quantities at the first local booking, used to avoid double counting. */
  remainingQty: number;
  completedQty: number;
}

interface PlanState {
  containers: Containers;
  initialized: boolean;
  lineLayoutVersion: number;
  manualOrders: Record<string, ManualOrder>;
  addManualOrder: (order: ManualOrder) => void;

  /** Supervisor-owned current production line for each operator. */
  workerLines: Record<string, LineKey>;
  /**
   * Who is on each order, and between which days.
   *
   * The only record of it. There used to be a second, `orderWorkers`, holding
   * the same people without their windows, and every mutation had to write
   * both — so the two disagreed the moment anyone was given a window, and
   * every reader had to know which of them to believe. Plans stored in the
   * older shape are migrated on the way in; see `setAssemblyPlan`.
   */
  orderCrewAssignments: Record<string, CrewAssignment[]>;
  /** Job id → ISO day the planner dragged the bar to. */
  orderStarts: Record<string, string>;
  orderActualStarts: Record<string, ActualStartRecord>;
  /**
   * Job id → supervisor approval to work this order at the weekend. Absent
   * means no: the schedule steps over Saturday and Sunday by default, and the
   * board asks before writing weekend work.
   */
  orderOvertime: Record<string, boolean>;
  /**
   * Job id → workers the supervisor has explicitly allowed to be on this order
   * while they are on another at the same time. Nobody does two jobs at once,
   * so the board asks before allocating into an overlap; this is the answer.
   * Stored against the order being allocated — the pair is approved either way
   * round.
   */
  orderDoubleBooked: Record<string, string[]>;
  /** Job id → end-of-shift completed-quantity entries. */
  progress: Record<string, { date: string; qty: number }[]>;
  progressBaselines: Record<string, ProgressBaseline>;
  production: Record<string, ProductionEntry[]>;
  /**
   * Job id → the local day it was last in an export. The plan's memory of what
   * the source has shown it, and the only thing that separates an order that
   * has finished from one a bad export left out. See `PLAN_RETENTION_DAYS`.
   */
  lastSeen: Record<string, string>;

  /**
   * Merge a refreshed dataset into the current layout: keep every placement the
   * planner made, hold what an absent order had planned for `PLAN_RETENTION_DAYS`
   * in case it comes back, and file genuinely new jobs onto their workbook line
   * (or the pool). Idempotent — safe to call on every load.
   */
  reconcile: (workCenters: WorkCenter[], jobs: Job[], now?: Date) => void;
  /** Replace the whole layout (e.g. loaded from persistence). */
  setContainers: (containers: Containers) => void;
  /** Put a worker on an order (no-op when full or already on it). */
  assignWorker: (jobId: JobId, workerId: string) => void;
  assignWorkerWindow: (
    jobId: JobId,
    workerId: string,
    fromDay: string | null,
    toDayExclusive: string | null,
  ) => void;
  updateWorkerWindow: (
    jobId: JobId,
    workerId: string,
    fromDay: string | null,
    toDayExclusive: string | null,
  ) => void;
  /** Take a worker off an order. */
  unassignWorker: (jobId: JobId, workerId: string) => void;
  /** Record that the supervisor accepts this person being on two orders. */
  approveDoubleBooking: (jobId: JobId, workerId: string) => void;
  /**
   * Crew several orders at once, for a freshly imported export. Only fills
   * orders that have nobody on them — an allocation already made is the
   * supervisor's and is never overwritten.
   */
  assignCrews: (allocations: Record<string, string[]>) => void;
  /** Move an operator's current roster position without rewriting recorded work. */
  moveWorkerToLine: (workerId: string, line: LineKey) => void;
  /** Pin an order's bar to a start day (null clears the pin). */
  setOrderStart: (jobId: JobId, isoDay: string | null) => void;
  startOrder: (jobId: JobId, record: ActualStartRecord) => void;
  /** Approve, or withdraw, weekend working on one order. */
  setOvertime: (jobId: JobId, approved: boolean) => void;
  recordProduction: (jobId: JobId, entry: ProductionEntry) => void;
  /** Save the shift and its progress atomically; completion also releases crew. */
  saveProductionEntry: (
    jobId: JobId,
    entry: ProductionEntry,
    source: ProgressBaseline,
  ) => void;
  /** Replace the assembly plan wholesale (e.g. loaded from persistence). */
  setAssemblyPlan: (plan: {
    /** Only read, never written: the older shape, migrated on the way in. */
    lineLayoutVersion?: number;
    manualOrders?: Record<string, ManualOrder>;
    orderWorkers?: Record<string, string[]>;
    workerLines?: Record<string, LineKey>;
    orderCrewAssignments?: Record<string, CrewAssignment[]>;
    orderStarts?: Record<string, string>;
    orderActualStarts?: Record<string, ActualStartRecord>;
    orderOvertime?: Record<string, boolean>;
    orderDoubleBooked?: Record<string, string[]>;
    progress?: Record<string, { date: string; qty: number }[]>;
    progressBaselines?: Record<string, ProgressBaseline>;
    production?: Record<string, ProductionEntry[]>;
    lastSeen?: Record<string, string>;
  }) => void;
  /** Move a job into `toContainer` at `toIndex` (end if omitted). */
  moveJob: (jobId: JobId, toContainer: string, toIndex?: number) => void;
  /** Which container currently holds the job, or null. */
  containerOf: (jobId: JobId) => string | null;
}

function emptyContainers(workCenters: WorkCenter[]): Containers {
  const c: Containers = { [POOL_ID]: [] };
  for (const w of workCenters) c[w.id] = [];
  return c;
}

/**
 * Where a job belongs before the planner touches it: its assembly line, or the
 * moulding line the workbook has it on.
 */
function homeContainer(job: Job, known: Set<string>): string {
  if (job.manual) return known.has('FACTORY_GENERAL') ? 'FACTORY_GENERAL' : POOL_ID;
  // The line is already decided — by ERP for TBP/PMD/Table/General, by the
  // routing table or the BOM for the rest (see engine/assembly/lineRouter).
  // Re-deriving it here from the part description is exactly the guess those
  // rules exist to replace, so this only migrates a retired line name.
  const target = job.department === 'assembly'
    ? (readLineKey(String(job.line ?? '')) ?? job.line)
    : job.preferredMachine;
  return target && known.has(String(target)) ? String(target) : POOL_ID;
}

/** Remove a job id from every container (returns a new map). */
function withoutJob(containers: Containers, jobId: JobId): Containers {
  const next: Containers = {};
  for (const [key, ids] of Object.entries(containers)) {
    next[key] = ids.includes(jobId) ? ids.filter((id) => id !== jobId) : ids;
  }
  return next;
}

/**
 * Every order this plan holds something for: allocated, dragged, started,
 * booked against, or simply sitting on a line. What retention is about.
 */
const plannedJobIds = (state: PlanState): Set<string> => {
  const ids = new Set<string>();
  const records: Record<string, unknown>[] = [
    state.orderCrewAssignments,
    state.orderStarts,
    state.orderActualStarts,
    state.orderOvertime,
    state.orderDoubleBooked,
    state.progress,
    state.progressBaselines,
    state.production,
  ];
  for (const record of records) {
    for (const id of Object.keys(record)) ids.add(id);
  }
  for (const jobIds of Object.values(state.containers)) {
    for (const id of jobIds) ids.add(String(id));
  }
  return ids;
};

const MIN_DAY = '0000-00-00';

const fullAssignments = (workers: string[]): CrewAssignment[] =>
  workers.slice(0, MAX_WORKERS_PER_ORDER).map((workerId) => ({
    workerId,
    fromDay: null,
    toDayExclusive: null,
  }));

const startsAt = (assignment: CrewAssignment): string =>
  assignment.fromDay ?? MIN_DAY;

const activeAt = (assignment: CrewAssignment, day: string): boolean =>
  startsAt(assignment) <= day &&
  (assignment.toDayExclusive === null || day < assignment.toDayExclusive);

const windowsOverlap = (
  a: CrewAssignment,
  b: CrewAssignment,
): boolean =>
  (a.toDayExclusive === null || startsAt(b) < a.toDayExclusive) &&
  (b.toDayExclusive === null || startsAt(a) < b.toDayExclusive);

/** Maximum people active together, evaluated at every window start. */
const withinCrewLimit = (assignments: CrewAssignment[]): boolean => {
  const starts = new Set(assignments.map(startsAt));
  return [...starts].every(
    (day) =>
      assignments.filter((assignment) => activeAt(assignment, day)).length <=
      MAX_WORKERS_PER_ORDER,
  );
};

export const usePlanStore = create<PlanState>((set, get) => ({
  containers: { [POOL_ID]: [] },
  workerLines: {},
  orderCrewAssignments: {},
  orderStarts: {},
  orderActualStarts: {},
  orderOvertime: {},
  orderDoubleBooked: {},
  progress: {},
  progressBaselines: {},
  production: {},
  lastSeen: {},
  initialized: false,
  lineLayoutVersion: 0,
  manualOrders: {},
  addManualOrder(order) {
    if (!order.id.startsWith('FG-') || !order.description.trim() || !order.supportDepartment.trim() || !Number.isFinite(order.plannedHours) || order.plannedHours <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(order.day)) return;
    set(state => state.manualOrders[order.id] ? state : ({ manualOrders: { ...state.manualOrders, [order.id]: order }, containers: { ...state.containers, FACTORY_GENERAL: [...(state.containers.FACTORY_GENERAL ?? []), manualJob(order).id] }, orderStarts: { ...state.orderStarts, [order.id]: order.day + 'T07:00:00' } }));
  },


  reconcile(workCenters, jobs, now = new Date()) {
    set((state) => {
      jobs = [...jobs, ...Object.values(state.manualOrders).map(manualJob)];
      const known = new Set(workCenters.map((w) => String(w.id)));
      const jobsById = new Map(jobs.map(job => [String(job.id), job]));
      const liveJobs = new Set(jobsById.keys());
      const next: Containers = emptyContainers(workCenters);
      const placed = new Set<string>();

      // What the source has shown us, and when. Everything in this export was
      // seen today; everything else keeps the day it was last in one, until
      // that day drops out of the retention window.
      const today = dayKey(now);
      const forgetBefore = dayKey(daysBefore(now, PLAN_RETENTION_DAYS));
      const lastSeen: Record<string, string> = {};
      for (const [id, day] of Object.entries(state.lastSeen)) {
        if (day >= forgetBefore) lastSeen[id] = day;
      }
      // A plan saved before absences were recorded carries none of these days,
      // and it is only ever empty before the first reconcile — every export
      // since stamps each of its orders. Those orders are not evidence of
      // anything either way, so they are taken as seen now and given the
      // ordinary retention from here. Done once, on the way in: applying it on
      // every pass would re-stamp an order the moment it went absent, and
      // nothing would ever be let go of.
      if (Object.keys(state.lastSeen).length === 0) {
        for (const id of plannedJobIds(state)) lastSeen[id] = today;
      }
      for (const id of liveJobs) lastSeen[id] = today;
      const retained = (id: string): boolean => id in lastSeen;

      // 1. Carry over existing placements — including an order missing from
      //    this export, which keeps its line and its place in it so that a
      //    partial export cannot shuffle the board.
      for (const [key, ids] of Object.entries(state.containers)) {
        // A plan saved against a line that no longer exists is carried over to
        // whichever line took that work, not tipped into the pool: the orders
        // on it were placed by a person, and the line going away is not a
        // reason to un-place them.
        const successor = key === POOL_ID ? null : readLineKey(key);
        const target = key === POOL_ID || known.has(key)
          ? key
          : successor && known.has(successor) ? successor : POOL_ID;
        for (const id of ids) {
          const sid = String(id);
          if (!retained(sid) || placed.has(sid)) continue;
          next[target].push(id);
          placed.add(sid);
        }
      }

      // 2. File any genuinely new jobs onto their home work centre, else pool.
      for (const job of jobs) {
        if (placed.has(String(job.id))) continue;
        next[homeContainer(job, known)].push(job.id);
        placed.add(String(job.id));
      }

      const keep = <T,>(src: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [k, v] of Object.entries(src)) {
          if (retained(k)) out[k] = v;
        }
        return out;
      };

      // Crew is the supervisor's to set, but a brand-new order starts with
      // whatever allocation the source system already has on it.
      const orderCrewAssignments = keep(state.orderCrewAssignments);
      for (const job of jobs) {
        const key = String(job.id);
        if (!orderCrewAssignments[key] && job.assignedWorkers.length > 0) {
          orderCrewAssignments[key] = fullAssignments(
            job.assignedWorkers.map(String),
          );
        }
      }

      return {
        containers: next,
        orderCrewAssignments,
        orderStarts: keep(state.orderStarts),
        orderActualStarts: keep(state.orderActualStarts),
        orderOvertime: keep(state.orderOvertime),
        orderDoubleBooked: keep(state.orderDoubleBooked),
        progress: keep(state.progress),
        progressBaselines: keep(state.progressBaselines),
        production: keep(state.production),
        lastSeen,
        initialized: true,
        lineLayoutVersion: 1,
      };
    });
  },

  setContainers(containers) {
    set({ containers, initialized: true });
  },

  assignWorker(jobId, workerId) {
    get().assignWorkerWindow(jobId, workerId, null, null);
  },

  assignWorkerWindow(jobId, workerId, fromDay, toDayExclusive) {
    set((state) => {
      const key = String(jobId);
      if ((state.production[key] ?? []).some(entry => entry.jobCompleted)) return state;
      if (fromDay && toDayExclusive && fromDay >= toDayExclusive) return state;
      const current = state.orderCrewAssignments[key] ?? [];
      const proposed: CrewAssignment = { workerId, fromDay, toDayExclusive };
      if (
        current.some(
          (assignment) =>
            assignment.workerId === workerId &&
            windowsOverlap(assignment, proposed),
        )
      ) return state;
      const next = [...current, proposed];
      if (!withinCrewLimit(next)) return state;
      return {
        orderCrewAssignments: { ...state.orderCrewAssignments, [key]: next },
      };
    });
  },

  updateWorkerWindow(jobId, workerId, fromDay, toDayExclusive) {
    set((state) => {
      const key = String(jobId);
      if ((state.production[key] ?? []).some(entry => entry.jobCompleted)) return state;
      if (fromDay && toDayExclusive && fromDay >= toDayExclusive) return state;
      const current = state.orderCrewAssignments[key] ?? [];
      const proposed: CrewAssignment = { workerId, fromDay, toDayExclusive };
      const next = [
        ...current.filter((assignment) => assignment.workerId !== workerId),
        proposed,
      ];
      if (!withinCrewLimit(next)) return state;
      return {
        orderCrewAssignments: { ...state.orderCrewAssignments, [key]: next },
      };
    });
  },

  unassignWorker(jobId, workerId) {
    set((state) => {
      const key = String(jobId);
      if ((state.production[key] ?? []).some(entry => entry.jobCompleted)) return state;
      const assignments = state.orderCrewAssignments[key] ?? [];
      // Any approval to double-book them here goes with them: put the same
      // person back later and the overlap is a fresh decision, not an old one.
      const approved = (state.orderDoubleBooked[key] ?? []).filter(
        (w) => w !== workerId,
      );
      const orderDoubleBooked = { ...state.orderDoubleBooked };
      if (approved.length > 0) orderDoubleBooked[key] = approved;
      else delete orderDoubleBooked[key];

      return {
        orderCrewAssignments: {
          ...state.orderCrewAssignments,
          [key]: assignments.filter(
            (assignment) => assignment.workerId !== workerId,
          ),
        },
        orderDoubleBooked,
      };
    });
  },

  approveDoubleBooking(jobId, workerId) {
    set((state) => {
      const key = String(jobId);
      const current = state.orderDoubleBooked[key] ?? [];
      if (current.includes(workerId)) return state;
      return {
        orderDoubleBooked: {
          ...state.orderDoubleBooked,
          [key]: [...current, workerId],
        },
      };
    });
  },

  assignCrews(allocations) {
    set((state) => {
      const orderCrewAssignments = { ...state.orderCrewAssignments };
      let changed = false;
      for (const [jobId, crew] of Object.entries(allocations)) {
        if (state.orderActualStarts[jobId]) continue;
        if ((orderCrewAssignments[jobId] ?? []).length > 0 || crew.length === 0) {
          continue;
        }
        orderCrewAssignments[jobId] = fullAssignments(crew);
        changed = true;
      }
      return changed ? { orderCrewAssignments } : state;
    });
  },

  moveWorkerToLine(workerId, line) {
    set((state) => {
      const assignmentsFor = (jobId: string): CrewAssignment[] =>
        state.orderCrewAssignments[jobId] ?? [];
      const hasWorker = (jobId: string): boolean =>
        assignmentsFor(jobId).some(
          (assignment) => assignment.workerId === workerId,
        );

      // Roster moves change future allocation; recorded shift crews remain immutable.
      const containerByJob = new Map<string, string>();
      for (const [container, jobIds] of Object.entries(state.containers)) {
        for (const jobId of jobIds) containerByJob.set(String(jobId), container);
      }

      // Release off-line current allocations, retaining the recorded shift history.
      const affected = Object.keys(state.orderCrewAssignments).filter(
        (jobId) => hasWorker(jobId) && containerByJob.get(jobId) !== line,
      );
      const orderCrewAssignments = { ...state.orderCrewAssignments };
      const orderDoubleBooked = { ...state.orderDoubleBooked };

      for (const jobId of affected) {
        const next = assignmentsFor(jobId).filter(
          (assignment) => assignment.workerId !== workerId,
        );
        if (next.length > 0) orderCrewAssignments[jobId] = next;
        else orderCrewAssignments[jobId] = [];
      }
      // An approval may be stored against either side of the old overlap.
      // Once a line move removes any assignment, expire every approval for
      // this worker so a future clash always needs a fresh decision.
      if (affected.length > 0) {
        for (const [jobId, workers] of Object.entries(orderDoubleBooked)) {
          const next = workers.filter((id) => id !== workerId);
          if (next.length > 0) orderDoubleBooked[jobId] = next;
          else delete orderDoubleBooked[jobId];
        }
      }

      return {
        workerLines: { ...state.workerLines, [workerId]: line },
        orderCrewAssignments,
        orderDoubleBooked,
      };
    });
  },

  setOrderStart(jobId, isoDay) {
    set((state) => {
      const orderStarts = { ...state.orderStarts };
      if (isoDay === null) delete orderStarts[String(jobId)];
      else orderStarts[String(jobId)] = isoDay;
      return { orderStarts };
    });
  },

  startOrder(jobId, record) {
    set((state) => {
      const key = String(jobId);
      if (
        state.orderActualStarts[key] ||
        record.operatorIds.length === 0 ||
        Number.isNaN(Date.parse(record.startedAt))
      ) return state;
      return {
        orderActualStarts: { ...state.orderActualStarts, [key]: record },
      };
    });
  },

  setOvertime(jobId, approved) {
    set((state) => {
      const orderOvertime = { ...state.orderOvertime };
      if (approved) orderOvertime[String(jobId)] = true;
      else delete orderOvertime[String(jobId)];
      return { orderOvertime };
    });
  },


  recordProduction(jobId, entry) {
    set((state) => {
      const key = String(jobId);
      const entries = (state.production[key] ?? []).filter(
        (existing) => existing.date !== entry.date,
      );
      return {
        production: {
          ...state.production,
          [key]: [...entries, entry].sort((a, b) => a.date.localeCompare(b.date)),
        },
      };
    });
  },

  saveProductionEntry(jobId, entry, source) {
    set((state) => {
      const key = String(jobId);
      const actualStart = state.orderActualStarts[key];
      const quantities = [
        entry.complete,
        entry.reject,
        entry.rework,
        entry.shiftOutput,
      ];
      if (
        !actualStart ||
        !quantities.every((value) => Number.isFinite(value) && value >= 0) ||
        (entry.jobCompleted && !entry.completedAt)
      ) return state;
      const savedEntry: ProductionEntry = {
        ...entry,
        operatorIds: entry.operatorIds ?? actualStart.operatorIds,
        operatorNames: entry.operatorNames ?? actualStart.operatorNames,
      };
      const productionEntries = (state.production[key] ?? []).filter(
        (existing) => existing.date !== savedEntry.date,
      );
      const progressEntries = (state.progress[key] ?? []).filter(
        (existing) => existing.date !== savedEntry.date,
      );
      const orderCrewAssignments = { ...state.orderCrewAssignments };
      const orderDoubleBooked = { ...state.orderDoubleBooked };
      if (savedEntry.jobCompleted) {
        delete orderCrewAssignments[key];
        delete orderDoubleBooked[key];
      }
      return {
        production: {
          ...state.production,
          [key]: [...productionEntries, savedEntry].sort((a, b) =>
            a.date.localeCompare(b.date),
          ),
        },
        progress: {
          ...state.progress,
          [key]: [...progressEntries, { date: savedEntry.date, qty: savedEntry.complete }].sort(
            (a, b) => a.date.localeCompare(b.date),
          ),
        },
        progressBaselines: state.progressBaselines[key]
          ? state.progressBaselines
          : { ...state.progressBaselines, [key]: source },
        orderCrewAssignments,
        orderDoubleBooked,
      };
    });
  },

  setAssemblyPlan(plan) {
    set((state) => {
      // A plan stored before crew had windows carries `orderWorkers` and no
      // assignments. Read once, here, and never written back.
      const orderCrewAssignments =
        plan.orderCrewAssignments ??
        (plan.orderWorkers
          ? Object.fromEntries(
              Object.entries(plan.orderWorkers).map(([jobId, workers]) => [
                jobId,
                fullAssignments(workers),
              ]),
            )
          : state.orderCrewAssignments);
      return {
        lineLayoutVersion: plan.lineLayoutVersion ?? 0,
        manualOrders: plan.manualOrders ?? state.manualOrders,
        workerLines: plan.workerLines ?? state.workerLines,
        orderCrewAssignments,
        orderStarts: plan.orderStarts ?? state.orderStarts,
        orderActualStarts: plan.orderActualStarts ?? state.orderActualStarts,
        orderOvertime: plan.orderOvertime ?? state.orderOvertime,
        orderDoubleBooked: plan.orderDoubleBooked ?? state.orderDoubleBooked,
        progress: plan.progress ?? state.progress,
        progressBaselines:
          plan.progressBaselines ?? state.progressBaselines,
        production: plan.production ?? state.production,
        lastSeen: plan.lastSeen ?? state.lastSeen,
      };
    });
  },

  moveJob(jobId, toContainer, toIndex) {
    set((state) => {
      if (state.manualOrders[String(jobId)] && toContainer !== 'FACTORY_GENERAL') return state;
      const cleared = withoutJob(state.containers, jobId);
      const target = [...(cleared[toContainer] ?? [])];
      const at = toIndex === undefined ? target.length : Math.max(0, Math.min(toIndex, target.length));
      target.splice(at, 0, jobId);
      return { containers: { ...cleared, [toContainer]: target } };
    });
  },



  containerOf(jobId) {
    for (const [key, ids] of Object.entries(get().containers)) {
      if (ids.includes(jobId)) return key;
    }
    return null;
  },
}));
