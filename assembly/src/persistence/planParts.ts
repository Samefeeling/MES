/**
 * The stored plan splits in two, because two different things are kept in it.
 *
 *  - **Planning** is a decision somebody makes: which line an order sits on,
 *    who is on it, where its bar was dragged to, which benches are open. Two
 *    supervisors can hold two different opinions about it at once, so it is
 *    published deliberately — see the Save button in `RefreshControl`. Until
 *    somebody presses Save, their version of it is a draft in their own
 *    browser and nowhere else.
 *
 *  - **Shift records** are things that happened: production started at 07:42,
 *    the shift booked 120 complete and 3 reject, the order was last seen in
 *    an export on Tuesday. Nobody holds an opinion about those, and losing
 *    one because the person who wrote it walked away without pressing a
 *    button would be losing the shift's own work. They are written as soon as
 *    they are made, whoever's planning is current underneath them.
 *
 * Splitting them here, in one place, is what lets the two be written on two
 * different triggers without either half ever having to guess which it is.
 */

import type { PersistedPlan } from './PlanRepository';

type Assembly = NonNullable<PersistedPlan['assembly']>;

/** Assembly keys that make up a planner's opinion; published by Save. */
export const PLANNING_KEYS = [
  'ignoredOrderIds',
  'lineLayoutVersion',
  'manualOrders',
  'workerLines',
  'virtualLines',
  'lineNames',
  'lineOrder',
  'orderCrewAssignments',
  'orderStarts',
  'orderOvertime',
  'orderDoubleBooked',
] as const satisfies ReadonlyArray<keyof Assembly>;

/** Assembly keys that record what the floor did; written as they happen. */
export const SHIFT_RECORD_KEYS = [
  'workerOnLeave',
  'orderActualStarts',
  'progress',
  'progressBaselines',
  'production',
  'lastSeen',
] as const satisfies ReadonlyArray<keyof Assembly>;

/** Container placement lives at the top level, and is planning. */
export interface PlanningPart {
  containers: PersistedPlan['containers'];
  assembly: Pick<Assembly, (typeof PLANNING_KEYS)[number]> &
    Pick<Assembly, 'orderWorkers'>;
}

export interface ShiftRecordPart {
  assembly: Pick<Assembly, (typeof SHIFT_RECORD_KEYS)[number]>;
}

const pick = <K extends keyof Assembly>(
  assembly: Assembly,
  keys: ReadonlyArray<K>,
): Pick<Assembly, K> => {
  const out = {} as Pick<Assembly, K>;
  for (const key of keys) {
    // Absent stays absent: `planStore.setAssemblyPlan` reads a missing key as
    // "keep what is in the store", which is how a plan written by an older
    // build is migrated rather than blanked.
    if (assembly[key] !== undefined) out[key] = assembly[key];
  }
  return out;
};

/**
 * The planner's opinion, out of a stored plan.
 *
 * `orderWorkers` is carried through when a plan predating day-windowed crew
 * has it and nothing has replaced it yet — `planStore.setAssemblyPlan` reads
 * it on the way in and migrates it, and dropping it here would take that
 * plan's crew with it. It is never built into a part on the way out: the
 * store has no such field, so the first write from this board is already in
 * the current shape.
 */
export function planningOf(plan: PersistedPlan): PlanningPart {
  const assembly = plan.assembly ?? {};
  const part: PlanningPart = {
    containers: plan.containers ?? {},
    assembly: pick(assembly, PLANNING_KEYS),
  };
  if (assembly.orderWorkers && !assembly.orderCrewAssignments) {
    part.assembly.orderWorkers = assembly.orderWorkers;
  }
  return part;
}

/** What the floor recorded, out of a stored plan. */
export function shiftRecordsOf(plan: PersistedPlan): ShiftRecordPart {
  return { assembly: pick(plan.assembly ?? {}, SHIFT_RECORD_KEYS) };
}

/** One plan to store, from the two halves and whoever is writing it. */
export function joinPlan(
  id: string,
  name: string,
  planning: PlanningPart,
  records: ShiftRecordPart,
  savedAt: string = new Date().toISOString(),
): PersistedPlan {
  return {
    id,
    name,
    savedAt,
    containers: planning.containers,
    assembly: { ...planning.assembly, ...records.assembly },
  };
}

/**
 * A stable string for "is this the same planning?".
 *
 * Key order is fixed by `PLANNING_KEYS` rather than by whatever order the
 * store happens to have built its objects in, so an unchanged plan compares
 * equal after a reload. The values below it are compared as `JSON.stringify`
 * writes them, which is how they go to the repository anyway — a difference
 * this misses is a difference that would not have been stored either.
 */
export function planningFingerprint(part: PlanningPart): string {
  const containers = Object.keys(part.containers)
    .sort()
    .map((key) => [key, part.containers[key]]);
  const assembly = PLANNING_KEYS.map((key) => [key, part.assembly[key] ?? null]);
  return JSON.stringify([containers, assembly]);
}
