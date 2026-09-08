/**
 * A first crew for the orders that have none.
 *
 * A fresh export carries no allocation — `Planning1.csv` says what to build,
 * never who builds it — and an order with nobody on it has no duration, so it
 * has no bar, no Expect Date and no share of the load. Eighty such orders is
 * not a schedule, and staffing them one at a time is not a morning's work.
 *
 * So: hand every unstaffed order a crew drawn from the operators currently
 * placed on its line, preferring matching skills and trades. Remaining labour
 * determines team size, with three people preferred for table assembly.
 * The supervisor can adjust the result. It only ever *adds*: an
 * order somebody has already crewed is left exactly as it is.
 *
 * Pure. No React, no store.
 */

import {
  MAX_WORKERS_PER_ORDER,
  PRODUCTIVE_HOURS_PER_PERSON,
  canWorkKind,
  type CrewAssignment,
  type LineKey,
  type Worker,
} from '@/domain/assembly';
import { durationDays, remainingHours, remainingQty } from './duration';
import { addDays, addWorkingDays } from './dates';
import { planVariableCrew, type CrewDayPlan } from './crewSchedule';
import type { AssemblyGanttView, OrderRow } from './board';
import { toDayKey } from '@/lib/time';

export interface CrewSuggestion {
  /** Job id → worker ids, for the orders that had nobody on them. */
  allocations: Record<string, string[]>;
  /** How many orders were given a crew. */
  staffed: number;
  /** Orders left alone because their current line roster has nobody available. */
  unstaffed: number;
}

/**
 * How many people to put on one order.
 *
 * These are preferences, not minimum staffing gates. A smaller available
 * line roster still produces a crew; manual allocations remain untouched.
 */
export function preferredCrewSize(row: OrderRow): number {
  const hours = remainingHours(row.job);
  if (hours <= 0) return 0;
  if (row.line.key === 'TABLE' || hours > 50) return 3;
  return hours > PRODUCTIVE_HOURS_PER_PERSON ? 2 : 1;
}

/** Skills rank within the supervisor's current line allocation. */
function skillRank(worker: Worker, row: OrderRow): number {
  if (!worker.skills.includes(row.line.key)) return 2;
  return canWorkKind(worker, row.kind) ? 0 : 1;
}

/**
 * When an order would run with `crew` people on it.
 *
 * From `plannedStart`, which the line hands out whether or not anyone is
 * allocated — so this answers for an order nobody is on yet, which is exactly
 * when a supervisor is deciding who to put on it.
 */
function span(row: OrderRow, crew: number): { from: Date; to: Date } | null {
  const days = durationDays(row.job, crew);
  if (days === null) return null;
  const from = row.plannedStart;
  return {
    from,
    to: row.overtime ? addDays(from, days) : addWorkingDays(from, days),
  };
}

/** Two hours of one shift apart, in day-fractions — anything less is nothing. */
const SHIFT_EPSILON = 0.02;

/**
 * Do these two day plans want the same hours of the same shift?
 *
 * Sharing a *day* is not a clash any more: an order picking up where another
 * left off starts part-way through the shift and takes only what is left of
 * it, so a hand-over puts both on the day and neither is over-booked. What
 * counts is the two stretches actually overlapping.
 */
const sharesShift = (a: CrewDayPlan, b: CrewDayPlan): boolean =>
  a.day === b.day &&
  a.from < b.from + b.used - SHIFT_EPSILON &&
  b.from < a.from + a.used - SHIFT_EPSILON;

/**
 * Anyone this row shares hours of a shift with somewhere else on the board.
 *
 * Measured on what the schedule actually planned — `crewDays` — rather than by
 * re-planning the order. `clashesFor` below answers a different question ("if
 * I put this person on, would they clash?") and has to imagine them working
 * the whole order to answer it, which is not what the board did: somebody
 * still busy elsewhere joins on the day they come free.
 */
export function clashesOnBoard(
  rows: Iterable<OrderRow>,
  row: OrderRow,
  workerId: string,
): OrderRow[] {
  const mine = row.crewDays.filter((day) =>
    day.workerIds.includes(workerId),
  );
  if (mine.length === 0) return [];
  const id = String(row.job.id);
  const out: OrderRow[] = [];
  for (const other of rows) {
    if (String(other.job.id) === id) continue;
    if (!other.line.schedulable || other.completedToday) continue;
    const clashes = other.crewDays.some(
      (theirs) =>
        theirs.workerIds.includes(workerId) &&
        mine.some((day) => sharesShift(day, theirs)),
    );
    if (clashes) out.push(other);
  }
  return out;
}

/** Anyone at all on this row working two orders in the same hours. */
export function overlapsOnBoard(
  rows: Iterable<OrderRow>,
  row: OrderRow,
): boolean {
  const all = [...rows];
  const onIt = new Set(
    row.crewDays.flatMap((day) => day.workerIds),
  );
  return [...onIt].some(
    (workerId) => clashesOnBoard(all, row, workerId).length > 0,
  );
}

/**
 * The orders `workerId` is already on that would run at the same time as
 * `target` — the work they cannot be in two places for.
 *
 * Nobody does two jobs at once, so this is the check behind allocating: the
 * supervisor either picks someone else or says explicitly that this one is
 * fine (splitting their day between two orders, or covering a hand-over).
 * Bars that merely touch — one ending as the next begins — do not clash.
 *
 * Only the target order can be unstaffed; any order the person is already on
 * has at least one person, and therefore has real dates.
 */
/**
 * The order replanned as if `workerId` were on it for the whole of it.
 *
 * Both questions below start here — "would adding them clash?" and "where is
 * their first useful gap?" — because both are asked before the schedule has
 * had a chance to place them, and so both have to imagine it.
 */
function planWith(target: OrderRow, workerId: string) {
  const current =
    target.crewAssignments ??
    target.workers.map((worker) => ({
      workerId: String(worker.id),
      fromDay: null,
      toDayExclusive: null,
    }));
  const proposed: CrewAssignment[] = current.some(
    (assignment) => assignment.workerId === workerId,
  )
    ? current
    : [...current, { workerId, fromDay: null, toDayExclusive: null }];
  return planVariableCrew(
    target.plannedStart,
    remainingHours(target.job),
    proposed,
    target.overtime,
  );
}

export function clashesFor(
  rows: OrderRow[],
  target: OrderRow,
  workerId: string,
): OrderRow[] {
  if (!target.line.schedulable || target.completedToday) return [];
  const mine = planWith(target, workerId);
  const mineDays = mine.crewDays.filter((day) =>
    day.workerIds.includes(workerId),
  );
  if (mineDays.length === 0) return [];
  const id = String(target.job.id);
  return rows.filter(
    (r) =>
      String(r.job.id) !== id &&
      r.line.schedulable &&
      !r.completedToday &&
      r.workers.some((w) => String(w.id) === workerId) &&
      r.crewDays.some(
        (day) =>
          day.workerIds.includes(workerId) &&
          mineDays.some((mineDay) => sharesShift(mineDay, day)),
      ),
  );
}

export interface FreeCrewWindow {
  /** First local day the worker can help this order. */
  fromDay: string;
  /** First unavailable day; null means they can stay through completion. */
  toDayExclusive: string | null;
  /** Orders beginning on the boundary, shown as the reason for the hand-off. */
  nextJobIds: string[];
}

/**
 * Earliest useful gap a worker can lend to an order without touching a later
 * commitment. This is what turns Bill's empty 2/9–3/9 into a safe hand-off
 * instead of rejecting him because he has another order later in the week.
 */
export function freeCrewWindow(
  rows: OrderRow[],
  target: OrderRow,
  workerId: string,
): FreeCrewWindow | null {
  const plan = planWith(target, workerId);
  const candidateDays = plan.crewDays.filter((day) =>
    day.workerIds.includes(workerId),
  );
  if (candidateDays.length === 0) return null;

  const otherRows = rows.filter(
    (row) =>
      String(row.job.id) !== String(target.job.id) && !row.completedToday,
  );
  const busy = new Map<string, { plan: CrewDayPlan; jobId: string }[]>();
  for (const row of otherRows) {
    for (const day of row.crewDays) {
      if (!day.workerIds.includes(workerId)) continue;
      const held = busy.get(day.day) ?? [];
      held.push({ plan: day, jobId: String(row.job.id) });
      busy.set(day.day, held);
    }
  }
  /** Only the hours of a shift this order would actually want back. */
  const taken = (mine: CrewDayPlan) =>
    (busy.get(mine.day) ?? []).filter((other) =>
      sharesShift(mine, other.plan),
    );

  const firstConflict = candidateDays.findIndex(
    (day) => taken(day).length > 0,
  );
  if (firstConflict < 0) {
    return {
      fromDay: candidateDays[0].day,
      toDayExclusive: null,
      nextJobIds: [],
    };
  }
  // A gap after an immediate conflict needs an explicit user choice; the
  // default offered here is deliberately only the safe leading gap.
  if (firstConflict === 0) return null;
  const boundary = candidateDays[firstConflict];
  return {
    fromDay: candidateDays[0].day,
    toDayExclusive: boundary.day,
    nextJobIds: taken(boundary).map((other) => other.jobId),
  };
}

interface Span {
  from: Date;
  to: Date;
}

const clashesWith = (booked: Span[] | undefined, want: Span): boolean =>
  (booked ?? []).some((s) => s.from < want.to && want.from < s.to);

/** Orders on a schedulable line with nobody on them and work left to do. */
const waitingRows = (board: AssemblyGanttView): OrderRow[] =>
  board.groups
    .filter((g) => g.line.schedulable)
    .flatMap((g) => g.rows)
    .filter(
      (r) =>
        r.workers.length === 0 && !r.completedToday && remainingQty(r.job) > 0 && remainingHours(r.job) > 0,
    );

/** How many orders are waiting for a crew — the number on the button. */
export const countUnstaffed = (board: AssemblyGanttView): number =>
  waitingRows(board).length;

/**
 * How many waves to run. Each one re-derives the board, so this bounds the
 * work; whatever is left over is simply offered again next time.
 */
const MAX_WAVES = 40;

/**
 * Staff the earliest waiting order on each line, and say who went where.
 *
 * One per line, not several, because the moment an order is crewed the whole
 * schedule moves — it takes a build position, and anything waiting on its
 * parts follows it out. Guessing where the next two would land is how a
 * suggestion ends up double-booking people; asking the scheduler is not.
 */
function staffOneWave(
  board: AssemblyGanttView,
  into: Record<string, string[]>,
  workerLines: ReadonlyMap<string, LineKey>,
): number {
  // Who is committed when, from the board as it stands.
  const booked = new Map<string, Span[]>();
  for (const row of board.groups.flatMap((g) => g.rows)) {
    if (!row.start || !row.expectDate || row.completedToday) continue;
    for (const w of row.workers) {
      const held = booked.get(String(w.id));
      const span = { from: row.start, to: row.expectDate };
      if (held) held.push(span);
      else booked.set(String(w.id), [span]);
    }
  }

  let staffed = 0;
  for (const group of board.groups) {
    if (!group.line.schedulable) continue;

    // Current line allocation takes priority over legacy Skills. Do not move
    // someone to another line implicitly; rank skills within this roster.
    const onLine: Worker[] = board.workers.filter(
      (w) =>
        w.onShift && !w.plannedLeave?.includes(toDayKey(board.today)) &&
        workerLines.get(String(w.id)) === group.line.key,
    );
    if (onLine.length === 0) continue;
    const rosterIndex = new Map(
      board.workers.map((worker, index) => [String(worker.id), index]),
    );
    const prefer = (a: Worker, b: Worker) =>
      (rosterIndex.get(String(a.id)) ?? 0) -
      (rosterIndex.get(String(b.id)) ?? 0);

    const waiting = group.rows
      .filter(
        (r) =>
          r.workers.length === 0 &&
          !r.completedToday &&
          remainingQty(r.job) > 0 &&
          remainingHours(r.job) > 0 &&
          !into[String(r.job.id)],
      )
      .sort((a, b) => a.plannedStart.getTime() - b.plannedStart.getTime());

    // The earliest order the line can actually crew. One that nobody is free
    // for is skipped rather than stalling the line behind it — the schedule
    // will have moved it out by the next round, and if it never becomes
    // staffable it is left for the supervisor, which is the honest answer.
    for (const next of waiting) {
      const pool = onLine;
      if (pool.length === 0) continue;
      const size = Math.min(preferredCrewSize(next), pool.length, MAX_WORKERS_PER_ORDER);

      // Build the team one at a time. Each person added shortens the bar, so
      // the window the next has to be free across only ever narrows.
      const crew: string[] = [];
      for (let i = 0; i < size; i++) {
        const want = span(next, crew.length + 1);
        if (!want) break;
        const rest = pool.filter((w) => !crew.includes(String(w.id)));
        if (rest.length === 0) break;
        // Skills come first. Among equal matches, prefer someone free, then
        // the lighter queue, with roster order as a deterministic tie-break.
        // A busy match queues behind existing work when the board settles.
        const pick = [...rest].sort((a, b) =>
          skillRank(a, next) - skillRank(b, next) ||
          Number(clashesWith(booked.get(String(a.id)), want)) -
            Number(clashesWith(booked.get(String(b.id)), want)) ||
          (booked.get(String(a.id))?.length ?? 0) -
            (booked.get(String(b.id))?.length ?? 0) || prefer(a, b),
        )[0];
        crew.push(String(pick.id));
      }
      if (crew.length === 0) continue;

      into[String(next.job.id)] = crew;
      staffed++;

      // Book them for this wave too: the lines are staffed one after another,
      // and somebody free on UPL is not still free once ASSY has taken them.
      const taken = span(next, crew.length);
      if (taken) {
        for (const id of crew) {
          const held = booked.get(id);
          if (held) held.push(taken);
          else booked.set(id, [taken]);
        }
      }
      break; // one per line per round; the scheduler settles before the next
    }
  }
  return staffed;
}

/**
 * Crew the waiting orders, letting the schedule settle between each round.
 *
 * `recompute` re-derives the board with the allocations so far. Without it
 * only the first round runs — enough for a preview, not for the real thing:
 * every span after the first is one the scheduler worked out, not one this
 * guessed, which is what keeps the suggestion clash-free.
 */
export function suggestCrew(
  board: AssemblyGanttView,
  recompute?: (allocations: Record<string, string[]>) => AssemblyGanttView,
  workerLines: ReadonlyMap<string, LineKey> = new Map(
    board.workers.flatMap((worker) =>
      worker.skills[0] ? [[String(worker.id), worker.skills[0]]] : [],
    ),
  ),
): CrewSuggestion {
  const allocations: Record<string, string[]> = {};
  let view = board;

  for (let wave = 0; wave < MAX_WAVES; wave++) {
    if (staffOneWave(view, allocations, workerLines) === 0) break;
    if (!recompute) break;
    view = recompute(allocations);
  }

  // A predecessor staffed in a later wave can move an already-suggested
  // successor. Validate against the settled board, removing the most recent
  // suggestion in any pair until no person occupies two orders on one day.
  if (recompute) {
    view = recompute(allocations);
    for (let guard = 0; guard < MAX_WAVES * 3; guard++) {
      const jobIds = Object.keys(allocations).reverse();
      const bad = jobIds.find((jobId) => {
        const row = view.rowsByJob.get(jobId);
        return row
          ? overlapsOnBoard(view.rowsByJob.values(), row)
          : false;
      });
      if (!bad) break;
      delete allocations[bad];
      view = recompute(allocations);
    }
  }

  const staffed = Object.keys(allocations).length;
  return {
    allocations,
    staffed,
    unstaffed: countUnstaffed(board) - staffed,
  };
}
