/**
 * Derived assembly Gantt — the counterpart to `selectors.useBoardView` for the
 * moulding board. Both read the same plan store; only the derivation differs.
 */

import { useMemo } from 'react';
import {
  computeAssemblyGantt,
  type AssemblyGanttView,
  type OrderRow,
} from '@/engine/assembly/board';
import { useDataStore } from './dataStore';
import { usePlanStore } from './planStore';

export function useAssemblyGantt(): AssemblyGanttView | null {
  const dataset = useDataStore((s) => s.dataset);
  const indexes = useDataStore((s) => s.indexes);
  const containers = usePlanStore((s) => s.containers);
  const orderCrewAssignments = usePlanStore((s) => s.orderCrewAssignments);
  const orderDoubleBooked = usePlanStore((s) => s.orderDoubleBooked);
  const orderStarts = usePlanStore((s) => s.orderStarts);
  const orderActualStarts = usePlanStore((s) => s.orderActualStarts);
  const orderOvertime = usePlanStore((s) => s.orderOvertime);
  const progress = usePlanStore((s) => s.progress);
  const progressBaselines = usePlanStore((s) => s.progressBaselines);
  const production = usePlanStore((s) => s.production);

  return useMemo(
    () =>
      dataset && indexes
        ? computeAssemblyGantt({
            dataset,
            indexes,
            containers,
            orderCrewAssignments,
            orderDoubleBooked,
            orderStarts,
            orderActualStarts,
            orderOvertime,
            progress,
            progressBaselines,
            production,
            workers: dataset.workers,
            today: new Date(),
          })
        : null,
    [
      dataset,
      indexes,
      containers,
      orderCrewAssignments,
      orderDoubleBooked,
      orderStarts,
      orderActualStarts,
      orderOvertime,
      progress,
      progressBaselines,
      production,
    ],
  );
}

/**
 * Re-derive the board with extra crew on top of the current plan.
 *
 * For work that has to try something and see what the schedule does with it —
 * `suggestCrew` staffs one order per line, asks for the board back, and
 * staffs the next against the dates that came out. Crewing an order moves it
 * and everything waiting on its parts, so guessing is how a suggestion ends
 * up double-booking people.
 *
 * Read straight from the stores rather than through React state: this is
 * called in a loop inside one event, so it must see each round's own answer.
 */
export function recomputeAssemblyGantt(
  extraCrew: Record<string, string[]>,
): AssemblyGanttView | null {
  const { dataset, indexes } = useDataStore.getState();
  if (!dataset || !indexes) return null;
  const plan = usePlanStore.getState();
  return computeAssemblyGantt({
    dataset,
    indexes,
    containers: plan.containers,
    orderCrewAssignments: {
      ...plan.orderCrewAssignments,
      ...Object.fromEntries(
        Object.entries(extraCrew).map(([jobId, workers]) => [
          jobId,
          workers.map((workerId) => ({
            workerId,
            fromDay: null,
            toDayExclusive: null,
          })),
        ]),
      ),
    },
    orderDoubleBooked: plan.orderDoubleBooked,
    orderStarts: plan.orderStarts,
    orderActualStarts: plan.orderActualStarts,
    orderOvertime: plan.orderOvertime,
    progress: plan.progress,
    progressBaselines: plan.progressBaselines,
    production: plan.production,
    workers: dataset.workers,
    today: new Date(),
  });
}

/** The row for one order, if it is on a line. */
export function findOrderRow(
  board: AssemblyGanttView | null,
  jobId: string | null,
): OrderRow | null {
  if (!board || !jobId) return null;
  return board.rowsByJob.get(jobId) ?? null;
}
