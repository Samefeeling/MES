/**
 * Derives the assembly Gantt: one row per order, grouped by line.
 *
 * ## Where a bar starts
 *
 * As early as it can. Every order asks for today and is pushed out only by
 * something real: a component another order is still making, material that has
 * not landed, a crew still on something else, or a line with no build position
 * free. Nothing waits for the day Epicor pencilled in — that date is worked
 * back from the due date and is a *deadline*, which the board carries as `Must
 * start` rather than as an instruction to stand idle until then.
 *
 * A line is not a single station: it has several build positions, so up to
 * `line.parallelOrders` orders run side by side, and only when every position
 * is busy does an order queue behind whichever frees first. What decides who
 * gets the position, and the people, is how much slack an order has left —
 * `urgency`, the day it must start to still make its due date. A bar the
 * planner dragged keeps its day regardless: a drag is an instruction.
 *
 * ## What waits for what
 *
 * `JobMaterialReq.csv` says which components each order consumes, and
 * `engine/assembly/dependencies` turns those into the orders that build them.
 * An order starts no earlier than the last of them finishes — so a chair on
 * ASSY sits behind its cover on UPL and its shell on a moulding press, and
 * pulling any of those forward pulls the chair forward with it.
 *
 * ## Who waits for whom
 *
 * The other chain is the people. Nobody builds two orders at once, so an order
 * whose crew is still on something else begins when the last of them is
 * free — and begins *exactly* then, not on whatever day Epicor pencilled in.
 * That is how the floor actually runs: a team finishes one order and picks up
 * the next the same shift, so the board shows neither the overlap of two bars
 * sharing a person nor the idle days between them.
 *
 * Nothing here waits for the next morning. A person's shift is 7.5 hours of
 * continuous capacity and orders queue into it back to back: somebody who
 * comes off one at eleven picks up the next at eleven, and if that fills the
 * day the one after takes tomorrow. The same is true of a component — finished
 * at eleven in the morning, and the order waiting on it starts that day. Only
 * a shift with nothing left in it costs the next order a day, which is what
 * keeps a chain of steps tight rather than spending a day at each link.
 *
 * ## Where a bar ends
 *
 * Its length is the remaining work divided by the crew on it, so allocating
 * another person visibly shortens it. Those are *working* days: the factory is
 * shut at the weekend, so a bar steps over Saturday and Sunday unless the
 * supervisor has approved overtime on that order. The end of the bar is the
 * Expect Date, which the colour compares against the Due Date — finishing on
 * the due date itself is on time, and past it is red. Due never moves here.
 *
 * Pure — same shape as `computeBoardView` for moulding.
 */

import type {
  Job,
  JobMaterialLink,
  MaterialStatus,
  PlanningDataset,
} from '@/domain/types';
import {
  DEFAULT_HORIZON_DAYS,
  LINES,
  stepLinesOf,
  virtualLineDef,
  workKind,
  type CrewAssignment,
  type LineDef,
  type VirtualLine,
  type Worker,
  type WorkKind,
} from '@/domain/assembly';
import type { DataIndexes } from '@/engine/indexes';
import { explodeMaterials } from '@/engine/materialExplosion';
import { materialAvailability } from '@/engine/materialAvailability';
import { releaseCheck, type ReleaseCheck } from './release';
import { buildDependencies, type Dependency } from './dependencies';
import {
  crewHoursPerDay,
  dailyTargetQty,
  durationDays,
  hoursPerUnit,
  latestStart,
  remainingHours,
} from './duration';
import {
  addDays,
  addWorkingDays,
  nextWorkingDay,
  prevWorkingDay,
  scheduleStatus,
  startOfDay,
  subWorkingDays,
  wholeDaysBetween,
  type ScheduleStatus,
} from './dates';
import { allocateStock, partKey } from './stockAllocation';
import { endOfCrewDay, idleRuns, planVariableCrew, type CrewDayPlan, type TakenOnDay, type VariableCrewPlan } from './crewSchedule';
import { onLeaveOnDay, type LeaveDays } from './attendance';
import { lineLoad, type LineLoad } from './workload';
import { expandRouting } from './routing';
import { jobNumOf } from '@/domain/routing';
import { JobId } from '@/domain/ids';
import { nextWorkingMoment, workFractionAt } from './shift';
import { fromDayKey, toDayKey } from '@/lib/time';
import type {
  ActualStartRecord,
  ProductionEntry,
  ProgressBaseline,
} from '@/store/planStore';

/** One shift's booked output on an order. */
export interface BookedDay {
  /** Local `YYYY-MM-DD` of the shift it was booked against. */
  day: string;
  qty: number;
  /** `qty` valued at the order's standard hours per unit. */
  hours: number;
}

/**
 * A stretch of open days in the middle of an order that it is not worked,
 * and what had its crew instead.
 *
 * A person whose Wednesday is fully spoken for gives this order the Tuesday
 * and the Thursday. That is what really happens on the floor and the plan is
 * right to say so — a Wednesday only part-used is not one of these, because
 * the next order takes the rest of it — but a bar with
 * a hole in it reads as two orders, and the planner's instinct is to drag it
 * back together, which pins it and books the person on both at once. So the
 * pause is drawn as part of the bar, with the order that caused it named.
 */
export interface CrewPause {
  /** The open days lost, in order. */
  days: string[];
  /** Orders that had this order's crew on those days. */
  heldBy: string[];
}

/** One day this order has somebody another order has as well. */
export interface CrewClash {
  day: string;
  workerId: string;
  /** The other order holding them that day. */
  withJob: string;
}

export interface OrderRow {
  job: Job;
  /** Quantities exactly as supplied by the current source refresh. */
  sourceRemainingQty?: number;
  sourceCompletedQty?: number;
  line: LineDef;
  /**
   * The trade this order calls for, read off its description. UPL is not one
   * bench — cutting, softies and upholstering are different people.
   */
  kind: WorkKind;
  /** Crew allocated to this order (already capped at the maximum). */
  workers: Worker[];
  /** Date-bounded crew membership; null bounds mean the whole order. */
  crewAssignments?: CrewAssignment[];
  /**
   * Exact future shift capacity: which people this order has on which day, and
   * how much of each shift it takes. This is what the board plans with, and
   * every row carries it — empty on a row nobody is on, and on a moulding row,
   * whose crew is managed off this board entirely.
   */
  crewDays: CrewDayPlan[];
  /** Open days inside the run with nobody on it, and what took them. */
  pauses?: CrewPause[];
  /**
   * Days this order shares a person with another one. Both orders carry it —
   * see `markDoubleBookings`.
   */
  doubleBooked?: CrewClash[];
  /** End of the last covered shift when a bounded crew leaves work unfinished. */
  planThrough?: Date | null;
  /** Remaining standard hours with no crew currently assigned to cover them. */
  uncoveredHours?: number;
  /**
   * People on this order's crew that the plan never uses, because every day it
   * runs they are already on something else. They keep their chip — taking a
   * name off is the supervisor's call, not the board's — but the order really
   * is running without them, so the board says so instead of quietly planning
   * a smaller crew than the row shows.
   */
  crewWithoutRoom?: Worker[];
  /**
   * Crew who are not in today — off sick, on leave, or marked off on the
   * board. They keep their chip and their allocation: a half-built order
   * belongs to whoever was building it, and a day off is not a hand-over.
   * What it is, is the reason this order has fewer hands today than the row
   * appears to show, so the row says so.
   */
  crewOnLeaveToday?: Worker[];
  /** Confirmed production start, separate from the planned bar date. */
  actualStart?: ActualStartRecord | null;
  completedAt?: string | null;
  /** Bar start; null when the order cannot be scheduled (no crew). */
  start: Date | null;
  /**
   * The day the order takes on its line, whether or not anyone is on it. Same
   * as `start` once it has a crew; without one it is where the bar *would*
   * begin, which is what lets the board answer "if I put Mary on this, would
   * she be on two orders at once?" before she is on it.
   */
  plannedStart: Date;
  /** Bar end = Expect Date; null when unschedulable. */
  expectDate: Date | null;
  /** Bar length in days worked; null when unschedulable. */
  days: number | null;
  /** Which of the line's parallel build positions the order took (0-based). */
  slot: number;
  /** Approved by the supervisor to run through the weekend. */
  overtime: boolean;
  /** Units the crew should finish per day at this allocation. */
  dailyTarget: number;
  status: ScheduleStatus;
  material: MaterialStatus;
  /** Material rows to pick for this job, straight from JobMaterialReq.csv. */
  pickList?: JobMaterialLink[];
  release: ReleaseCheck;
  /** Orders this one waits on, with the component each supplies. */
  predecessors: Dependency[];
  /** The one actually holding the bar back, when any is; else null. */
  waitingOn: Dependency | null;
  /**
   * What the shift actually booked against this order, day by day, in standard
   * hours. This is the past half of the board: the columns behind today show
   * output that was recorded, not work that was planned.
   */
  booked: BookedDay[];
  /**
   * Last day work can begin and still be finished by the Due Date, at this
   * crew — the due date less the work, over open days. Epicor's own Start Date
   * is derived the same way, so the two disagreeing means the crew size or the
   * hours differ from what it assumed. `null` with nobody on the order.
   */
  mustStartBy: Date | null;
  /** Explicitly closed during today's shift; retained until tomorrow for confirmation. */
  completedToday: boolean;
}

export interface LineGroup {
  line: LineDef;
  rows: OrderRow[];
  /** Work still queued on the line, and how long its crew needs to clear it. */
  load: LineLoad;
  /**
   * How many orders the lane holds once its benches are counted.
   *
   * A lane made of benches normally holds none of its own — every order is on
   * one of the three — so its header would otherwise read "0 orders, 0 h" over
   * three rows of work. `load` is rolled up the same way, which is what makes
   * UPL-SSS read 33.1 h over 6.8 + 4.5 + 21.8.
   */
  benchOrders?: number;
}

export interface AssemblyGanttView {
  /**
   * First day column — the previous working day, so the board opens with
   * yesterday's shift still on screen.
   */
  horizonStart: Date;
  /**
   * Midnight today. Nothing is scheduled before it however far back the first
   * column reaches: the columns to its left are history.
   */
  today: Date;
  /** Number of day columns. */
  horizonDays: number;
  groups: LineGroup[];
  /** Assembly orders not on any line yet. */
  pool: Job[];
  workers: Worker[];
  /**
   * Who is on leave and when, as the board was built with it. Carried on the
   * view so every reader of the board — the roll in the column heading, the
   * crew suggestion, the pickers — answers "is this person in?" from the same
   * place the schedule did.
   */
  workerOnLeave: LeaveDays;
  rowsByJob: Map<string, OrderRow>;
  jobsById: Map<string, Job>;
  /** Material links that could not be used, e.g. a circular one. */
  dependencyWarnings: string[];
  totals: {
    orders: number;
    green: number;
    red: number;
    /** Placed on a line but with nobody on them, so they have no dates yet. */
    needsCrew: number;
    /** Standard hours still to run across every scheduled order. */
    remainingHours: number;
  };
}

export interface AssemblyInputs {
  dataset: PlanningDataset;
  indexes: DataIndexes;
  /** Line id → ordered job ids. */
  containers: Record<string, unknown[]>;
  /** Job id → who is on it, and between which days. */
  orderCrewAssignments?: Record<string, CrewAssignment[]>;
  /**
   * Job id → the people the supervisor has said may work it while they are on
   * another order too. They are exempt from the hand-over rule below: the
   * supervisor has already been asked and answered.
   */
  orderDoubleBooked?: Record<string, string[]>;
  /** Job id → ISO day the planner dragged the bar to. */
  orderStarts: Record<string, string>;
  orderActualStarts?: Record<string, ActualStartRecord>;
  /** Job id → supervisor approval to work this order at the weekend. */
  orderOvertime?: Record<string, boolean>;
  /** Job id → end-of-shift completed-quantity entries. */
  progress: Record<string, { date: string; qty: number }[]>;
  progressBaselines?: Record<string, ProgressBaseline>;
  /** Daily production confirmations, including explicit job completion. */
  production?: Record<string, ProductionEntry[]>;
  /**
   * Lines the supervisor opened on the floor, beyond the eight the plant is
   * built as. They schedule exactly like a built-in line and sit after them.
   */
  virtualLines?: readonly VirtualLine[];
  /**
   * What this floor calls each line, keyed by line key. Only the lines that
   * were renamed are in here; everything else keeps its built-in name.
   */
  lineNames?: Record<string, string>;
  workers: Worker[];
  /**
   * Worker id → the local days they are on leave, marked on the board. Read
   * together with the roster's own `onShift` and `plannedLeave` — see
   * `engine/assembly/attendance`.
   */
  workerOnLeave?: LeaveDays;
  today: Date;
}

/**
 * Put an order on one of a line's build positions.
 *
 * `slots` holds, per position, the moment it next frees up. An order that asks
 * for a day when any position is already clear keeps that exact day. When they
 * are all busy the answer depends on who is asking:
 *
 *   - left to itself, the order falls in behind the position that clears first,
 *     which is what keeps a line to three orders at a time;
 *   - dragged there by the planner, it stays put. A drag is an instruction, not
 *     a request — the last thing it should do is quietly snap back — and the
 *     day then reads over capacity on the load histogram, which is the honest
 *     way to say the line has been asked to run four orders at once.
 */
function claimSlot(
  slots: Date[],
  want: Date,
  pinned: boolean,
): { start: Date; slot: number } {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].getTime() <= want.getTime()) return { start: want, slot: i };
  }
  let first = 0;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].getTime() < slots[first].getTime()) first = i;
  }
  return { start: pinned ? want : slots[first], slot: first };
}

/** Moulding rows keep moulding's own dates; this board does not schedule them. */
const MOULDING_MATERIAL: MaterialStatus = {
  level: 'unknown',
  earliestStart: null,
  shortages: [],
};

/** When moulding plans to run an order: its own start, else its due date. */
const mouldingStart = (j: Job): Date | null => j.startDate ?? j.dueDate;

/**
 * One moulding order as a board row.
 *
 * Read-only: the dates are moulding's, not ours. The row exists so the press
 * work is visible above the assembly lines, and so an assembly order that
 * needs one of these shells can be held behind the run that makes it.
 */
function mouldingRow(job: Job, line: LineDef, today: Date): OrderRow {
  const days = Math.max(0.25, job.laborHrs / 24);
  const start = startOfDay(mouldingStart(job) ?? today);
  return {
    job,
    sourceRemainingQty: job.remainingQty,
    sourceCompletedQty: job.completedQty,
    line,
    kind: 'general',
    workers: [],
    crewAssignments: [],
    crewDays: [],
    planThrough: addDays(start, days),
    uncoveredHours: 0,
    actualStart: null,
    completedAt: null,
    start,
    plannedStart: start,
    expectDate: addDays(start, days),
    days,
    slot: 0,
    overtime: false,
    dailyTarget: 0,
    status: {
      color: 'grey' as const,
      dueSlackDays: null,
      reason: 'Moulding plan — shown for context, not scheduled here',
    },
    material: MOULDING_MATERIAL,
    pickList: [],
    release: {
      level: 'ready' as const,
      releasable: true,
      needsOverride: false,
      unconfirmed: false,
      reason: 'Moulding plan',
    },
    predecessors: [],
    waitingOn: null,
    booked: [],
    mustStartBy: null,
    completedToday: false,
  };
}

/**
 * Which moulding orders the PMD row shows.
 *
 * Only the press work assembly is actually waiting on — the shells and frames
 * a chair on ASSY, a cover on UPL or a top on TABLE cannot be built without.
 * Those are the ones a supervisor needs to see and chase.
 *
 * The row used to be padded out with the next few press jobs by date, which
 * filled the top of the board with work nothing on it depended on. With
 * nothing needed the row is empty, and the caller drops the lane entirely.
 */
function mouldingContextRows(
  rows: Map<string, OrderRow>,
  neededIds: Set<string>,
): OrderRow[] {
  return [...neededIds]
    .map((id) => rows.get(id))
    .filter((r): r is OrderRow => Boolean(r))
    .sort((a, b) => a.start!.getTime() - b.start!.getTime());
}

/**
 * Who has been given the same person, on the same day, as somebody else.
 *
 * Read off the finished board rather than worked out while it is being built,
 * because the answer belongs to *both* orders and the one that happens to be
 * resolved second is not the one at fault. Only a pinned or a started order
 * can produce one: those are decisions somebody made and consult no diary, so
 * they take the days they were given. Which is exactly what makes dragging a
 * bar over its own pause appear to work — the hole closes because the order
 * stopped asking, not because anyone came free.
 *
 * A hand-over is not a clash: somebody coming off one order at eleven and
 * starting the next at eleven shares the day without being in two places, and
 * the fractions say so.
 */
function markDoubleBookings(
  rows: Map<string, OrderRow>,
  approvals: Record<string, string[]>,
): void {
  interface Booking { jobId: string; from: number; to: number }
  const diary = new Map<string, Booking[]>();
  /*
   * A hand-over meets exactly, and both sides of it are worked out by
   * division — hours over a crew's shift — so the two fractions agree to
   * fifteen places and not to seventeen. Compared on the bare edge, every
   * clean hand-over on the board reads as a double booking. A tolerance of
   * about a tenth of a second of a shift is far below anything the day plan
   * means and far above anything the arithmetic can lose.
   */
  const TOUCHING = 1e-6;
  for (const row of rows.values()) {
    const jobId = String(row.job.id);
    for (const day of row.crewDays) {
      for (const workerId of day.workerIds) {
        const key = `${String(workerId)}|${day.day}`;
        const held = diary.get(key) ?? [];
        held.push({ jobId, from: day.from, to: day.from + day.used });
        diary.set(key, held);
      }
    }
  }

  for (const row of rows.values()) {
    const jobId = String(row.job.id);
    const approved = approvals[jobId] ?? [];
    row.doubleBooked = row.crewDays.flatMap((day) =>
      day.workerIds
        .map(String)
        .filter((workerId) => !approved.includes(workerId))
        .flatMap((workerId) => {
          const mineTo = day.from + day.used;
          return (diary.get(`${workerId}|${day.day}`) ?? [])
            .filter(
              (other) =>
                other.jobId !== jobId &&
                other.from < mineTo - TOUCHING &&
                day.from < other.to - TOUCHING,
            )
            .map((other) => ({ day: day.day, workerId, withJob: other.jobId }));
        }),
    );
  }
}

export function computeAssemblyGantt(input: AssemblyInputs): AssemblyGanttView {
  const { dataset, indexes, containers, orderStarts, today } = input;
  // The eight the plant is built as, then whatever the supervisor opened.
  /*
   * The lines, under whatever this floor calls them.
   *
   * The rename is applied once, here, so nothing downstream has to know there
   * is such a thing: the header, the hover, the roster strip and the row
   * written to `ASSY_Production` all read `line.name` as they always did.
   */
  const lineNames = input.lineNames ?? {};
  const named = (line: LineDef): LineDef => {
    const own = lineNames[String(line.key)]?.trim();
    return own ? { ...line, name: own } : line;
  };
  const boardLines: LineDef[] = [
    ...LINES,
    ...(input.virtualLines ?? []).map(virtualLineDef),
  ].map(named);
  const orderOvertime = input.orderOvertime ?? {};
  const progress = input.progress ?? {};
  const progressBaselines = input.progressBaselines ?? {};
  const production = input.production ?? {};
  const orderActualStarts = input.orderActualStarts ?? {};
  const orderCrewAssignments = input.orderCrewAssignments ?? {};
  const orderDoubleBooked = input.orderDoubleBooked ?? {};
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const completionDate = (job: Job): string | null =>
    (production[String(job.id)] ?? [])
      .filter((entry) => entry.jobCompleted)
      .map((entry) => entry.date)
      .sort()
      .at(-1) ?? null;
  const completionInstant = (job: Job): string | null =>
    (production[String(job.id)] ?? [])
      .filter((entry) => entry.jobCompleted)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1)?.completedAt ?? null;

  /**
   * Fold the shift's completed-quantity entries into the order, so the bar
   * shortens as work is booked and lengthens when a day misses its target.
   */
  const withProgress = (job: Job): Job => {
    const booked = (progress[String(job.id)] ?? []).reduce(
      (s, e) => s + e.qty,
      0,
    );
    if (booked <= 0) return job;
    const baseline = progressBaselines[String(job.id)];
    const total = job.completedQty + job.remainingQty;
    // Once Epicor reflects a local booking, its RemainingQty wins. Until then,
    // the original source snapshot minus local bookings wins. Taking the lower
    // value prevents the same output being deducted a second time on refresh.
    const effectiveRemaining = baseline
      ? Math.min(job.remainingQty, Math.max(0, baseline.remainingQty - booked))
      : Math.max(0, job.remainingQty - booked);
    const done = Math.max(job.completedQty, total - effectiveRemaining);
    return {
      ...job,
      completedQty: done,
      remainingQty: effectiveRemaining,
    };
  };

  /**
   * The shift log for one order, valued in standard hours. `withProgress` has
   * already folded these into the quantities, so the total quantity — and with
   * it the hours per unit — is the same before and after.
   */
  const bookedDays = (job: Job): BookedDay[] => {
    const perUnit = hoursPerUnit(job);
    return (progress[String(job.id)] ?? []).map((entry) => ({
      day: entry.date,
      qty: entry.qty,
      hours: entry.qty * perUnit,
    }));
  };

  /**
   * What has been confirmed at one operation of one order.
   *
   * An order on a benched line is not at its bench because somebody put it
   * there; it is there because the operation before it is finished. That is a
   * question about what has been booked, which is why the route is walked here
   * — with the shift records in hand — rather than when the export lands.
   */
  const operationProgress = {
    done: (rowId: string): number =>
      (progress[rowId] ?? []).reduce((sum, entry) => sum + entry.qty, 0),
    closed: (rowId: string): boolean =>
      (production[rowId] ?? []).some((entry) => entry.jobCompleted),
  };

  const sourceAssembly = dataset.jobs.filter((j) => j.department === 'assembly');
  const assemblyJobs = expandRouting(
    sourceAssembly,
    dataset.jobLinks ?? [],
    operationProgress,
  )
    // A completed order remains grey for the confirmation day, then leaves
    // both the lanes and the unassigned pool on the next calendar day.
    .filter((j) => !completionDate(j) || completionDate(j)! >= todayKey)
    .map(withProgress);
  const sourceJobsById = new Map(
    dataset.jobs.map((job) => [String(job.id), job]),
  );
  /**
   * The row that stands for an order when something else waits for it.
   *
   * An order is finished when its *last* operation is, so a successor waits on
   * whichever row is furthest along — and that row's expected finish already
   * carries the rest of the route behind it (`tailHours` below). Orders with
   * no route are their own row, so this map is empty for most of the board.
   */
  const rowIdByOrder = new Map<string, { id: string; seq: number }>();
  for (const job of assemblyJobs) {
    const op = job.operation;
    if (!op) continue;
    const key = String(op.jobNum);
    const held = rowIdByOrder.get(key);
    if (!held || op.seq > held.seq) {
      rowIdByOrder.set(key, { id: String(job.id), seq: op.seq });
    }
  }
  /** An order number as the board files it: the row that answers for it. */
  const rowIdOf = (jobNum: string): string =>
    rowIdByOrder.get(jobNum)?.id ?? jobNum;
  /** The same, applied to a dependency edge on its way onto a row. */
  const asRow = (dep: Dependency): Dependency => {
    const id = rowIdOf(String(dep.onJobId));
    return id === String(dep.onJobId) ? dep : { ...dep, onJobId: JobId(id) };
  };
  const jobsById = new Map(assemblyJobs.map((j) => [String(j.id), j]));
  const workersById = new Map(input.workers.map((w) => [String(w.id), w]));
  /**
   * Who is not in, on any given day. Built once for the whole board: the day
   * planner asks it per person per day across every order there is.
   */
  const onLeave = onLeaveOnDay(
    input.workers,
    input.workerOnLeave ?? {},
    today,
  );
  // Two different "starts". Work is planned from today — there is no working
  // yesterday — but the board opens one working day earlier, so the shift that
  // has just finished is still on screen to be compared against the plan.
  const planStart = startOfDay(today);
  const horizonStart = prevWorkingDay(planStart);

  // The moulding plan, as rows. Built for every press job rather than the few
  // that fit on screen, because any of them may be the one an assembly order
  // is waiting for.
  const pmdLine = named(LINES.find((l) => !l.schedulable)!);
  const mouldingRows = new Map<string, OrderRow>(
    dataset.jobs
      .filter((j) => j.department === 'moulding')
      .map((j) => [String(j.id), mouldingRow(j, pmdLine, today)]),
  );

  /*
   * Stock and dependencies are asked about *orders*, not about benches.
   *
   * An order's components are needed once, whichever bench it has reached, and
   * another order waiting for it is waiting for all of it. So the graph is
   * built over one entry per order number — the row furthest along its route,
   * put back under the order's own number and its own quantities — and the
   * answers are read back through `rowIdOf`.
   */
  const orderJobs: Job[] = [];
  for (const job of assemblyJobs) {
    const op = job.operation;
    if (!op) {
      orderJobs.push(job);
      continue;
    }
    if (rowIdOf(String(op.jobNum)) !== String(job.id)) continue;
    const source = sourceJobsById.get(String(op.jobNum));
    orderJobs.push({
      ...job,
      id: op.jobNum,
      laborHrs: source?.laborHrs ?? job.laborHrs,
      // Only the last operation receives, so only there do the row's
      // quantities and the order's mean the same thing.
      remainingQty: op.last ? job.remainingQty : source?.remainingQty ?? job.remainingQty,
      completedQty: op.last ? job.completedQty : source?.completedQty ?? job.completedQty,
    });
  }
  const everyJob = [
    ...orderJobs,
    ...[...mouldingRows.values()].map((r) => r.job),
  ];
  /*
   * The warehouse answers first.
   *
   * An order that already has its components does not wait for the order
   * building more of them, and the free stock is given out here — earliest
   * need date first — so that two orders cannot both be told the same forty
   * covers are theirs. What each link is left holding is the part of its
   * component the shelf could not supply.
   */
  const stock = allocateStock(
    everyJob,
    dataset.jobLinks ?? [],
    indexes.inventoryByPart,
  );
  // What waits for what, over both departments — a chair waits for its shell.
  const { byJob: dependsOn, warnings: dependencyWarnings } = buildDependencies(
    everyJob,
    dataset.jobLinks ?? [],
    stock,
  );
  const pickListByJob = new Map<string, JobMaterialLink[]>();
  for (const material of dataset.jobLinks ?? []) {
    const id = String(material.jobNum);
    const list = pickListByJob.get(id);
    if (list) list.push(material);
    else pickListByJob.set(id, [material]);
  }

  const rowsByJob = new Map<string, OrderRow>();
  const placed = new Set<string>();
  const groups: LineGroup[] = [];

  /**
   * The moment an order asks to begin: what the planner dragged it to, else the
   * day Epicor scheduled it. Anything already in the past starts as soon as
   * the board opens — there is no working yesterday.
   *
   * A pin is a moment, not a day. It used to be flattened to midnight here, so
   * every dragged bar restarted at the open of its shift — which meant a bar
   * drawn at a quarter to three could be moved and never put back, and a hand
   * that only meant to nudge it an hour moved it most of a day. A pin saved
   * before that is a midnight, and `nextWorkingMoment` reads one as 07:00 that
   * morning, which is exactly what it used to mean.
   */
  const wantedStart = (id: string): Date => {
    const actual = orderActualStarts[id];
    if (actual) return startOfDay(new Date(actual.startedAt));
    const pinned = orderStarts[id];
    if (!pinned) return planStart;
    const wanted = nextWorkingMoment(/^\d{4}-\d{2}-\d{2}$/.test(pinned) ? fromDayKey(pinned) : new Date(pinned));
    return wanted > planStart ? wanted : planStart;
  };

  /**
   * How much of a hurry an order is in — the day it has to start to still make
   * its due date, at the crew currently on it. That is the same arithmetic
   * Epicor used to fill in its own Start Date.
   *
   * With everything asking to start today, this is what decides who gets the
   * build position and the people: the order that runs out of slack first.
   * Orders with no due date go last, because nothing says they are urgent.
   */
  /**
   * The crew a deadline is counted back at.
   *
   * People the roster does not know are not a rate, so they do not count. And
   * one person when nobody is on it at all: an order still has a day by which
   * somebody has to pick it up, and one is both the smallest crew that could
   * and the reading that leaves the least room — a bigger crew only ever moves
   * the answer later. `urgency` and `mustStartBy` are the same question asked
   * at two moments, and used to answer it with two different counts.
   */
  const countBackCrew = (id: string): number =>
    Math.max(
      1,
      new Set(
        (orderCrewAssignments[id] ?? [])
          .map((a) => String(a.workerId))
          .filter((workerId) => workersById.has(workerId)),
      ).size,
    );
  const urgency = (id: string): number => {
    const job = jobsById.get(id);
    if (!job?.dueDate) return Number.MAX_SAFE_INTEGER;
    return (
      latestStart(job, countBackCrew(id), job.dueDate) ?? job.dueDate
    ).getTime();
  };

  // Two passes over the schedulable lines: build rows, then resolve the
  // predecessor chain (a successor may sit on a different line).
  //
  // Each line keeps two orderings, and conflating them was making rows jump
  // about under the planner's hand. `ids` is the planner's own order — where
  // the rows sit on screen — and never changes because a bar moved. `claiming`
  // is by wanted start, and only decides which order gets first refusal on a
  // build position, so dragging a bar earlier still moves it ahead in the
  // queue rather than being ignored.
  /*
   * A routed order stands where its route says, not where anyone put it.
   *
   * You cannot staple a cover nobody has sewn, so the bench an operation is
   * worked at is not a planning decision and there is nothing to drag. It also
   * has to be immediate: the shift closes the sewing and the order is at the
   * stapling bench, without waiting for the next export to file it there.
   */
  const placedByHand = new Set(
    Object.values(containers).flatMap((ids) => ids.map(String)),
  );
  const routedTo = new Map<string, string[]>();
  for (const job of assemblyJobs) {
    // Somewhere a person put it wins: a rush bench opened this morning is a
    // decision, and the route is only the default.
    if (!job.operation || placedByHand.has(String(job.id))) continue;
    const key = String(job.line);
    routedTo.set(key, [...(routedTo.get(key) ?? []), String(job.id)]);
  }

  const pending: { line: LineDef; ids: string[]; claiming: string[] }[] = [];
  for (const line of boardLines) {
    if (!line.schedulable) continue;
    const ids = [
      ...(containers[String(line.id)] ?? []).map(String),
      ...(routedTo.get(String(line.id)) ?? []),
    ].filter(
      (id, i, all) =>
        all.indexOf(id) === i && jobsById.has(id) && !placed.has(id),
    );
    ids.forEach((id) => placed.add(id));
    const claiming = [...ids].sort((a, b) => urgency(a) - urgency(b));
    pending.push({ line, ids, claiming });
  }

  /**
   * Which line each order sits on — and, by its absence, which orders sit on
   * none. Built once: looking it up by scanning every line's list turned the
   * resolve pass into a walk of the whole board per order.
   */
  const lineOf = new Map<string, LineDef>();
  for (const { line, ids } of pending) {
    for (const id of ids) lineOf.set(id, line);
  }

  /**
   * `worker|day` → the moment that person comes off the work already booked
   * on that day. Filled from each row's day plan as it is resolved.
   *
   * A diary, not a watermark. A single "free from" moment per person read as
   * busy for every day up to it, so somebody booked on an order three weeks
   * out was unavailable for all three intervening weeks: they sat idle, and an
   * order that could have used them today either ran short-handed or, when
   * their supposed release fell past its end, ran without them entirely —
   * still wearing their name on the board, which is what "Tom is free but
   * chipped on three orders" looks like from the floor.
   */
  const bookedUntil = new Map<string, Date>();

  /**
   * `worker|day` → the order that took it. The same diary as `bookedUntil`,
   * asked the other question: not "is this day gone" but "where did it go".
   *
   * A hole in the middle of a bar is not a fault to be drawn around; it is one
   * order having been given a day that another one wanted. Naming it turns a
   * bar in pieces into a decision the supervisor can actually take.
   */
  const bookedBy = new Map<string, string>();

  /**
   * The first moment `workerId` is actually free, at or after `from`.
   *
   * Their own day is what matters, not how far their last booking reaches: a
   * person who finishes an order at eleven on Wednesday is free from eleven on
   * Wednesday, and a person whose next booking is a fortnight away is free
   * now. Where a day is used up, the search moves to the next open one.
   */
  const freeFrom = (workerId: string, from: Date): Date => {
    let cursor = from;
    for (let guard = 0; guard < 400; guard++) {
      const day = toDayKey(cursor);
      const busy = bookedUntil.get(`${workerId}|${day}`);
      if (!busy || busy <= cursor) return cursor;
      cursor = busy;
      // Coming off at the close of a shift means the next open day: there is
      // no sliver of this one left to pick up.
      if (toDayKey(cursor) !== day) cursor = nextWorkingDay(cursor);
    }
    return cursor;
  };

  /**
   * How much of that person's day this order has already lost to something
   * else, as a fraction of the shift.
   *
   * The diary stores the moment they come off what is booked, so the fraction
   * is just how far into the day that moment is — a person who finishes at
   * eleven has given away 0.53 of the day, and the next order takes the rest.
   *
   * This used to answer yes or no, and a booked day was refused whole: the
   * sliver left of an afternoon could not be handed on, so an order whose
   * crew lost two hours of a Monday skipped the Monday entirely and finished a
   * day later, with a hole in the middle of its bar over five and a half hours
   * nobody was using. A person's shift is 7.5 hours of continuous capacity and
   * orders queue into it back to back; only a shift with nothing left in it
   * costs the next order the day.
   *
   * It answers per day, not "free from": a person booked next Monday is free
   * this Thursday *and* next Tuesday. Treating that one Monday as the end of
   * their availability cost the order every day after it, so five days of work
   * covered two and the Expect Date went blank while the crew were plainly not
   * full.
   *
   * `approved` names anyone the supervisor has already agreed may be on two
   * orders at once; their diary is not consulted.
   */
  const takenOnDay = (approved: readonly string[]): TakenOnDay =>
    (workerId, day) => {
      if (approved.includes(workerId)) return 0;
      const held = bookedUntil.get(`${workerId}|${day}`);
      if (!held) return 0;
      // Work done by then, not time elapsed: somebody coming off at half past
      // twelve has 285 of the shift's 450 minutes behind them, and the hour
      // they spent at the urn and over lunch bought this order nothing.
      return workFractionAt(held);
    };

  /**
   * The moment the *first* of a crew can pick this order up.
   *
   * Not the last: a team whose second member is tied up for another week does
   * not stand around waiting for them. Whoever is free starts, and the rest
   * join as they come off what they are on — `readyDay` below turns that into
   * the date-bounded assignments the day planner already understands, so the
   * order gets one person's capacity until the others arrive.
   *
   * `null` only when there is nobody on the order at all.
   */
  const readyAt = (crewIds: string[], approved: string[]): Date | null => {
    let earliest: Date | null = null;
    for (const workerId of crewIds) {
      if (approved.includes(workerId)) continue;
      const free = freeFrom(String(workerId), planStart);
      if (!earliest || free < earliest) earliest = free;
    }
    return earliest;
  };

  // Line id → when each of its build positions next frees up.
  const slotsByLine = new Map<string, Date[]>();
  const slotsFor = (line: LineDef): Date[] => {
    const key = String(line.id);
    let slots = slotsByLine.get(key);
    if (!slots) {
      slots = Array.from({ length: Math.max(1, line.parallelOrders) }, () =>
        startOfDay(planStart),
      );
      slotsByLine.set(key, slots);
    }
    return slots;
  };

  /** Resolve a row, recursing into its predecessor first. Cycle-safe. */
  const resolve = (id: string, seen: Set<string>): OrderRow | null => {
    const existing = rowsByJob.get(id);
    if (existing) return existing;
    const job = jobsById.get(id);
    if (!job) return null;
    /*
     * An order on no line is not planned here, and gets no row.
     *
     * It used to be scheduled onto UPL — whichever line happened to be second
     * in the list — whenever something waiting on it reached this far. That
     * gave it a build position, took UPL's people for it, and handed its
     * successor a finish date to start from, none of which the board drew
     * anywhere. What the successor is actually waiting for is somebody to put
     * this order on a line, and the predecessor loop below now says so.
     */
    const line = lineOf.get(id);
    if (!line) return null;
    if (seen.has(id)) return null; // dependency cycle — treat as unconstrained
    seen.add(id);

    const actualStart = orderActualStarts[id] ?? null;
    const latestCrew = (production[id] ?? [])
      .filter((entry) => (entry.operatorIds ?? []).length > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1)?.operatorIds;
    const completedToday = completionDate(job) === todayKey;
    // Who the shift said was on it. Save Entry releases the crew when an
    // order is closed, so for a completed row this is the only record left of
    // who actually built it — and for a started one it is what the operator
    // confirmed, which outranks anything allocated afterwards.
    const recordedCrew = latestCrew ?? actualStart?.operatorIds ?? [];
    const configuredAssignments = orderCrewAssignments[id];
    const crewAssignments: CrewAssignment[] = configuredAssignments
      ? configuredAssignments
      : completedToday
        ? []
        : recordedCrew.map((workerId) => ({
            workerId,
            fromDay: null,
            toDayExclusive: null,
          }));
    // A completed row keeps the last shift's names for confirmation even
    // though Save Entry has already released every future assignment.
    const displayWorkerIds = crewAssignments.length > 0
      ? [...new Set(crewAssignments.map((assignment) => assignment.workerId))]
      : completedToday
        ? recordedCrew
        : [];
    const workers = displayWorkerIds
      .map((w) => workersById.get(String(w)))
      .filter((w): w is Worker => Boolean(w));
    // Weekend work is a cost decision, so it is approved per order rather than
    // assumed. Without it the bar steps over Saturday and Sunday.
    const overtime = Boolean(orderOvertime[id]);

    // Where the order asks to be, before the line's capacity has its say.
    let want = wantedStart(id);

    // A team rolls straight from one order on to the next: this one begins the
    // moment the first of its people is free, and the rest join as they come
    // off what they are on. No overlap, and no idle days either — the crew's
    // availability replaces the wanted day rather than merely capping it.
    // A confirmed start and a bar the planner dragged both stand as they are:
    // those are records of a decision, and the clash markers say the rest.
    const pinned = Boolean(orderStarts[id] || actualStart);
    const approved = orderDoubleBooked[id] ?? [];
    const sequenced = !pinned && !completedToday;
    const freed = sequenced
      ? readyAt(
          crewAssignments.map((a) => String(a.workerId)),
          approved,
        )
      : null;
    if (freed) want = freed > planStart ? freed : planStart;

    /*
     * Nothing can start before its components exist — but "exist" has two
     * answers, and the board only ever read the second.
     *
     * The first is the shelf. What free stock already covers was allocated
     * before this loop (see `stockAllocation`), so a component the warehouse
     * can supply in full imposes no wait at all, however many orders are open
     * for it; part of one buys part of the run, and the bar is pulled back
     * from the component's date by the work that part supports.
     *
     * The second is the order building it, and there the edges are grouped by
     * the component they supply. Several open batches of one part are
     * alternatives, not a queue: the consumer needs one of them, so it waits
     * for the first to be ready. Taking each edge on its own — which is what
     * this did — quietly made every order wait for the *latest* batch of every
     * part, which is the opposite of what the floor does. Different components
     * are all needed, so across parts it is still the latest that governs.
     */
    const predecessors = dependsOn.get(jobNumOf(id)) ?? [];
    let waitingOn: Dependency | null = null;
    let predecessorBlocked = false;
    if (!actualStart) {
      const alternatives = new Map<string, Dependency[]>();
      for (const dep of predecessors) {
        // An explicitly named predecessor stands alone: it is a decision about
        // this order rather than one of several sources of a part.
        const key = dep.part ? partKey(dep.part) : `job\u0000${String(dep.onJobId)}`;
        const group = alternatives.get(key);
        if (group) group.push(dep);
        else alternatives.set(key, [dep]);
      }

      for (const group of alternatives.values()) {
        const covered = Math.min(1, Math.max(0, group[0].coveredFraction));
        // The whole requirement is in the racks: this component is not a wait.
        if (covered >= 1) continue;

        let ready: { when: Date; dep: Dependency } | null = null;
        let blocked: Dependency | null = null;
        let supplied = false;
        for (const dep of group) {
          const predId = rowIdOf(String(dep.onJobId));
          const pred = resolve(predId, seen) ?? mouldingRows.get(predId) ?? null;
          if (pred?.expectDate) {
            if (!ready || pred.expectDate < ready.when) {
              ready = { when: pred.expectDate, dep };
            }
          } else if (pred && remainingHours(pred.job) > 0) {
            // A component with uncovered work has no honest finish date. Do
            // not let its successor slip through merely because that date is
            // null — but another batch of the same part still can.
            blocked ??= dep;
          } else if (!pred && jobsById.has(predId) && !lineOf.has(predId)) {
            // A live order that is on no line yet. Nothing has been planned
            // for it, so there is no date to wait for — and coming free
            // because the date is missing is the one answer that is wrong.
            blocked ??= dep;
          } else {
            // Finished, or gone from the plan: this source owes nothing, so
            // the component is there and no other batch of it matters.
            supplied = true;
          }
        }
        if (supplied) continue;

        if (ready) {
          /*
           * Stock buys a head start. What is on the shelf covers `covered` of
           * the run, so the order may begin that much work before the rest
           * lands and runs out exactly as it arrives. With nothing in stock
           * this is the component's own date, which is what the board has
           * always used.
           */
          const run = durationDays(job, workers.length) ?? 0;
          const floor =
            covered > 0 && run > 0
              ? subWorkingDays(ready.when, covered * run)
              : ready.when;
          if (floor > want) {
            want = floor;
            waitingOn = ready.dep;
          }
        } else if (blocked) {
          predecessorBlocked = true;
          waitingOn ??= blocked;
        }
      }
    }

    const material = materialAvailability(
      explodeMaterials(job, indexes.bomByJob, indexes.bomByPart),
      indexes.inventoryByPart,
      indexes.poByPart,
    );
    // Material that only lands on a future PO cannot be worked before then.
    if (!actualStart && material.earliestStart && material.earliestStart > want) {
      want = startOfDay(material.earliestStart);
    }
    if (!overtime && !actualStart) want = nextWorkingDay(want);

    // Take one of the line's build positions. The order keeps the day it asked
    // for whenever one is free; otherwise it queues behind the first to clear,
    // unless the planner dragged it there by hand.
    const slots = slotsFor(line);
    const claim = claimSlot(slots, want, pinned);
    // To the moment, not to the day — `nextWorkingDay` keeps the hour and only
    // moves a weekend on. A component finished at eleven in the
    // morning is finished at eleven in the morning, and the order waiting on it
    // starts then — `planVariableCrew` gives that first day only the rest of
    // its shift, so the two bars meet exactly instead of one of them spending a
    // day at the link. The same is true of a crew: what is left of the day they
    // came free is what the next order gets, so nobody works two shifts in one.
    const start = actualStart
      ? claim.start
      : overtime
        ? claim.start
        : nextWorkingDay(claim.start);
    // Only the remaining work is planned, so a job that started yesterday
    // consumes today's capacity from today onward; its confirmed historical
    // start is still retained as the left edge of the bar.
    const capacityStart = start < planStart ? planStart : start;
    // Each person gives this order whatever their own diary has left of each
    // day, and only a full one costs it the day. The bounds the planner set by
    // hand are untouched — those are a decision, not an inference — and a bar
    // the planner pinned consults no diary at all: it was put there on purpose.
    // A day somebody is not in is a day they give this order nothing, which is
    // exactly what a full diary means to the planner — so absence is folded in
    // here rather than modelled a second way.
    //
    // It applies to a pinned bar too, where the diary deliberately does not: a
    // start somebody dragged is a decision about *when* the order runs, not a
    // claim that the people on it are at work. And it outranks a double-booking
    // approval — the supervisor agreeing that Mary may split her day between
    // two orders says nothing about a Mary who is at home with flu.
    const booked = sequenced ? takenOnDay(approved) : undefined;
    const taken: TakenOnDay = (workerId, day) =>
      onLeave(workerId, day) ? 1 : (booked?.(workerId, day) ?? 0);

    const crewPlan: VariableCrewPlan = predecessorBlocked
      ? {
          start: null,
          expectDate: null,
          coveredUntil: null,
          days: null,
          crewDays: [],
          uncoveredHours: remainingHours(job),
        }
      : planVariableCrew(
          capacityStart,
          remainingHours(job),
          crewAssignments,
          overtime,
          taken,
        );
    const expectDate = completedToday ? planStart : crewPlan.expectDate;
    const days = completedToday ? 0 : crewPlan.days;
    /*
     * The order finishes when its *route* does, not when this bench does.
     *
     * A row sewing the last of an order still has it stapled in front of it,
     * and an order whose sewing lands on Friday is not an order ready on
     * Friday. So the benches still to come are added to the expected finish,
     * estimated at the crew this bench is running — which is the best guess
     * available before anyone has been allocated to a bench the work has not
     * reached. The bar itself is unchanged: it draws the operation, because
     * the operation is what the people on this row are doing.
     */
    const tailHours = job.operation?.tailHours ?? 0;
    const tailCrew = Math.max(
      1,
      crewPlan.crewDays.at(-1)?.workerIds.length ?? workers.length,
    );
    const orderExpect =
      expectDate && tailHours > 0 && !completedToday
        ? addWorkingDays(expectDate, tailHours / crewHoursPerDay(tailCrew))
        : expectDate;
    const status = completedToday
      ? {
          color: 'grey' as const,
          dueSlackDays: null,
          reason: 'Job completed today',
        }
      : scheduleStatus(orderExpect, job.dueDate);

    const row: OrderRow = {
      job,
      sourceRemainingQty: sourceJobsById.get(id)?.remainingQty ?? job.remainingQty,
      sourceCompletedQty: sourceJobsById.get(id)?.completedQty ?? job.completedQty,
      line,
      kind: workKind(line.key),
      workers,
      // The bounds the planner set, and only those. Which days each person
      // actually gave the order is `crewDays`, and who could give it none at
      // all is `crewWithoutRoom` — both worked out against their diaries.
      crewAssignments,
      crewWithoutRoom: completedToday
        ? []
        : workers.filter(
            (worker) =>
              !crewPlan.crewDays.some((day) =>
                day.workerIds.includes(String(worker.id)),
              ),
          ),
      crewDays: completedToday ? [] : crewPlan.crewDays,
      crewOnLeaveToday: completedToday
        ? []
        : workers.filter((worker) => onLeave(String(worker.id), todayKey)),
      // Filled once every row has a plan — see `markDoubleBookings` below.
      doubleBooked: [],
      pauses: completedToday
        ? []
        : idleRuns(crewPlan.crewDays, overtime).map((days) => ({
            days,
            heldBy: [
              ...new Set(
                days.flatMap((day) =>
                  crewAssignments
                    .map((a) => bookedBy.get(`${String(a.workerId)}|${day}`))
                    .filter((jobId): jobId is string => Boolean(jobId)),
                ),
              ),
            ],
          })),
      planThrough: completedToday ? planStart : crewPlan.coveredUntil,
      uncoveredHours: completedToday ? 0 : crewPlan.uncoveredHours,
      actualStart,
      completedAt: completionInstant(job),
      start: completedToday
        ? planStart
        : actualStart
          ? start
          : crewPlan.start,
      plannedStart: start,
      expectDate: orderExpect,
      days,
      slot: claim.slot,
      overtime,
      dailyTarget: dailyTargetQty(
        job,
        crewPlan.crewDays[0]?.workerIds.length ?? 0,
      ),
      status,
      material,
      /*
       * Keyed by the order number, not the row key. JobMaterialReq.csv
       * knows ASM8002; a routed row is ASM8002#20, so looking the list up
       * by the row key found nothing and every bench row came back with an
       * empty pick list. The material to pick belongs to the order, and
       * each of its operations is working towards the same one.
       */
      pickList: pickListByJob.get(jobNumOf(id)) ?? [],
      release: releaseCheck(material, job.materialPrep),
      /*
       * Named by the row that answers for the order, not by the order number.
       *
       * A dependency is a fact about orders — this one needs that one's part —
       * and everything drawing it needs a row: the arrows, the marked-run
       * move, the focus walk. The row furthest along the predecessor's route
       * is the one that finishes it, and its expected date already carries the
       * rest of that route. What the supervisor reads is still the order
       * number: `jobNumOf` puts it back.
       */
      predecessors: predecessors.map(asRow),
      waitingOn: waitingOn ? asRow(waitingOn) : null,
      booked: bookedDays(job),
      mustStartBy: job.dueDate
        ? latestStart(job, countBackCrew(id), job.dueDate)
        : null,
      completedToday,
    };

    rowsByJob.set(id, row);
    // The position stays taken until this order finishes on it. A closed order
    // gives it straight back.
    //
    // A bar the planner dragged takes no position at all: it was put there
    // over the line's capacity, on purpose, and the day reads as over capacity
    // on the load histogram rather than pushing the orders already there out
    // of the planner's way. An order confirmed as running is different — that
    // one is genuinely on a position, so it holds one.
    const heldUntil = expectDate ?? crewPlan.coveredUntil;
    const overCommitted = Boolean(orderStarts[id]) && !actualStart;
    if (
      heldUntil &&
      !completedToday &&
      !overCommitted &&
      heldUntil > slots[claim.slot]
    ) {
      slots[claim.slot] = heldUntil;
    }
    // And these people are spoken for until their last shift on it. Taken from
    // the day plan rather than from the bar, so somebody who is only on the
    // first half of an order is free again from the middle of it.
    if (!completedToday) {
      for (const day of crewPlan.crewDays) {
        const until = endOfCrewDay(day);
        for (const workerId of day.workerIds) {
          const key = `${String(workerId)}|${day.day}`;
          const held = bookedUntil.get(key);
          if (!held || until > held) bookedUntil.set(key, until);
          if (!bookedBy.has(key)) bookedBy.set(key, id);
        }
      }
    }
    return row;
  };

  /**
   * Hours routed to a bench the order has not reached yet.
   *
   * Counted once per order per bench, not once per row: Gluing's foaming and
   * sewing are both in front of the same stapling, and adding each of their
   * tails would put that stapling on the bench twice. An order is one order
   * however many benches are working it at the moment.
   */
  const incomingHours = new Map<string, number>();
  const countIncoming = (): void => {
    incomingHours.clear();
    const counted = new Set<string>();
    for (const row of rowsByJob.values()) {
      const op = row.job.operation;
      if (!op) continue;
      for (const step of op.tail) {
        const key = String(step.line);
        const mark = `${String(op.jobNum)}\u0000${key}`;
        if (counted.has(mark)) continue;
        counted.add(mark);
        incomingHours.set(key, (incomingHours.get(key) ?? 0) + step.hours);
      }
    }
  };

  const withLoad = (line: LineDef, rows: OrderRow[]): LineGroup => ({
    line,
    rows,
    load: lineLoad(rows, incomingHours.get(String(line.key)) ?? 0),
  });

  /**
   * A lane's header, carrying its benches' work as well as its own.
   *
   * The benches are separate lines and keep their own rows, their own people
   * and their own bars; what the lane adds is the one figure a supervisor
   * reads first — how much work is standing on UPL-SSS altogether.
   */
  const rollUpBenches = (groups: LineGroup[]): LineGroup[] => {
    const byLine = new Map(groups.map((group) => [group.line.key, group]));
    return groups.map((group) => {
      const benches = stepLinesOf(group.line.key)
        .map((line) => byLine.get(line.key))
        .filter((held): held is LineGroup => Boolean(held));
      if (benches.length === 0) return group;
      const rows = [...group.rows, ...benches.flatMap((held) => held.rows)];
      const incoming = benches.reduce(
        (sum, held) => sum + held.load.incomingHours,
        incomingHours.get(String(group.line.key)) ?? 0,
      );
      return {
        ...group,
        load: lineLoad(rows, incoming),
        benchOrders: rows.length,
      };
    });
  };

  // Schedule in claim order, draw in the planner's order. `resolve` memoises
  // into `rowsByJob`, so the second loop only reads back what the first built.
  //
  // One queue across every line, not one per line: people work more than one
  // line, so whoever asks first should get them. Sorting per line instead
  // would hand UPL its pick of the roster before ASSY had asked. The sort is
  // stable, so within a line the claim order is exactly as it was.
  //
  // An order already running comes first, then one the planner has dragged,
  // then the rest by the day they ask for. A drag has to claim its people
  // before anything else does, or the order it was dragged away from simply
  // takes them back and the two bars end up sharing a crew again.
  //
  // The queue is not the whole story, and cannot be: `resolve` recurses into
  // an order's predecessors, so a component is scheduled the moment something
  // waiting on it comes up, whatever its own place in the queue. That is the
  // right way round — a successor's dates are meaningless without it — but it
  // does mean a low-urgency component can take a build position and its
  // people ahead of a more urgent order on the same line.
  const claimRank = (id: string): number =>
    orderActualStarts[id] ? 0 : orderStarts[id] ? 1 : 2;
  const claimOrder = pending
    .flatMap((p) => p.claiming)
    .sort((a, b) => claimRank(a) - claimRank(b) || urgency(a) - urgency(b));
  for (const id of claimOrder) resolve(id, new Set());
  markDoubleBookings(rowsByJob, orderDoubleBooked);
  countIncoming();
  for (const { line, ids } of pending) {
    const rows = ids
      .map((id) => rowsByJob.get(id))
      .filter((r): r is OrderRow => Boolean(r));
    groups.push(withLoad(line, rows));
  }

  // PMD context row on top, led by the press work assembly is waiting for.
  const neededMoulding = new Set(
    [...rowsByJob.values()]
      .flatMap((r) => r.predecessors)
      .map((d) => String(d.onJobId))
      .filter((id) => mouldingRows.has(id)),
  );
  // Nothing on the assembly side waiting for a press means nothing to show:
  // the lane is context, and context nobody is waiting on is just noise.
  const pmdRows = mouldingContextRows(mouldingRows, neededMoulding);
  if (pmdRows.length > 0) groups.unshift(withLoad(pmdLine, pmdRows));
  groups.sort((a, b) => a.line.sortIndex - b.line.sortIndex);
  const rolled = rollUpBenches(groups);
  groups.length = 0;
  groups.push(...rolled);

  const pool = assemblyJobs.filter((j) => !placed.has(String(j.id)));

  const scheduled = [...rowsByJob.values()];
  // Days reached back for history are extra: the board still shows the usual
  // run of planning days ahead of today.
  const leadDays = wholeDaysBetween(planStart, horizonStart);
  const horizonDays = Math.max(
    DEFAULT_HORIZON_DAYS + leadDays,
    ...scheduled.map((r) =>
      (r.expectDate ?? r.planThrough)
        ? Math.ceil(
            ((r.expectDate ?? r.planThrough)!.getTime() -
              horizonStart.getTime()) /
              86_400_000,
          ) + 1
        : 0,
    ),
  );

  return {
    horizonStart,
    today: planStart,
    horizonDays,
    groups,
    pool,
    workers: input.workers,
    workerOnLeave: input.workerOnLeave ?? {},
    rowsByJob,
    jobsById,
    dependencyWarnings,
    totals: {
      orders: scheduled.length,
      green: scheduled.filter((r) => r.status.color === 'green').length,
      red: scheduled.filter((r) => r.status.color === 'red').length,
      needsCrew: scheduled.filter(
        (r) => (r.uncoveredHours ?? (r.days === null ? 1 : 0)) > 0,
      ).length,
      remainingHours: totalRemainingHours(scheduled),
    },
  };
}

/** Total remaining standard hours across a set of rows. */
export const totalRemainingHours = (rows: OrderRow[]): number =>
  rows.reduce((s, r) => s + remainingHours(r.job), 0);
