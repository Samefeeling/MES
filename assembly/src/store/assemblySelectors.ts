/**
 * Derived assembly Gantt — the counterpart to `selectors.useBoardView` for the
 * moulding board. Both read the same plan store; only the derivation differs.
 */

import { manualJob } from '@/domain/manualOrder';
import { useMemo } from 'react';
import {
  computeAssemblyGantt,
  type AssemblyGanttView,
  type OrderRow,
} from '@/engine/assembly/board';
import { releasedOrderNumbers } from '@/features/assembly/boardView';
import { jobNumOf } from '@/domain/routing';
import { useDataStore } from './dataStore';
import { useUiStore } from './uiStore';
import { usePlanStore } from './planStore';

type GanttInputs = Parameters<typeof computeAssemblyGantt>[0];

function useGanttInputs(): GanttInputs | null {
  const dataset = useDataStore((s) => s.dataset);
  const indexes = useDataStore((s) => s.indexes);
  const manualOrders = usePlanStore(s => s.manualOrders);
  const containers = usePlanStore((s) => s.containers);
  const workerOnLeave = usePlanStore((s) => s.workerOnLeave);
  const orderCrewAssignments = usePlanStore((s) => s.orderCrewAssignments);
  const orderDoubleBooked = usePlanStore((s) => s.orderDoubleBooked);
  const orderStarts = usePlanStore((s) => s.orderStarts);
  const orderActualStarts = usePlanStore((s) => s.orderActualStarts);
  const orderOvertime = usePlanStore((s) => s.orderOvertime);
  const progress = usePlanStore((s) => s.progress);
  const progressBaselines = usePlanStore((s) => s.progressBaselines);
  const production = usePlanStore((s) => s.production);
  const virtualLines = usePlanStore((s) => s.virtualLines);
  const lineNames = usePlanStore((s) => s.lineNames);

  return useMemo(
    () =>
      dataset && indexes
        ? {
            dataset: { ...dataset, jobs: [...dataset.jobs, ...Object.values(manualOrders).map(manualJob)] },
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
            virtualLines,
            lineNames,
            workers: dataset.workers,
            workerOnLeave,
            today: new Date(),
          }
        : null,
    [
      dataset,
      manualOrders,
      indexes,
      containers,
      workerOnLeave,
      orderCrewAssignments,
      orderDoubleBooked,
      orderStarts,
      orderActualStarts,
      orderOvertime,
      progress,
      progressBaselines,
      production,
      virtualLines,
      lineNames,
    ],
  );
}

/**
 * The board, twice over.
 *
 * `board` is every order in the export. It is the plan: what is saved and
 * synced back to SharePoint, and what an order is looked up in. A view
 * setting must never change what is written.
 *
 * `shown` is what the Gantt draws. With Released Only on (the default) it is
 * planned again from the released orders alone — see `releasedOrderNumbers` —
 * so the line loads, day loads and crew counts on screen are the capacity the
 * released work needs, not that plus orders nobody can build yet. With All, or
 * when nothing in the export is unreleased, it is `board` itself.
 */
export function useAssemblyBoards(releasedOnly: boolean): {
  board: AssemblyGanttView | null;
  shown: AssemblyGanttView | null;
  /** Assembly orders Released Only is keeping off the board. */
  unreleasedHidden: number;
} {
  const inputs = useGanttInputs();
  const board = useMemo(() => (inputs ? computeAssemblyGantt(inputs) : null), [inputs]);
  return useMemo(() => {
    if (!inputs || !board || !releasedOnly) return { board, shown: board, unreleasedHidden: 0 };
    const scoped = releasedOnlyInputs(inputs, board);
    return !scoped.removed
      ? { board, shown: board, unreleasedHidden: 0 }
      : { board, shown: computeAssemblyGantt(scoped.inputs), unreleasedHidden: scoped.hidden };
  }, [inputs, board, releasedOnly]);
}

/** The same inputs with the orders Released Only keeps off the board taken
 *  out, and how many orders that was. `board` is the full board over
 *  `inputs`, for the chains `releasedOrderNumbers` follows. */
function releasedOnlyInputs(
  inputs: GanttInputs,
  board: AssemblyGanttView,
): { inputs: GanttInputs; hidden: number; removed: boolean } {
  const keep = releasedOrderNumbers(board.groups.flatMap((group) => group.rows));
  const hiddenOrders = new Set<string>();
  let removed = false;
  const jobs = inputs.dataset.jobs.filter((job) => {
    const order = jobNumOf(String(job.id));
    if (job.released !== false || keep.has(order)) return true;
    // Counted for the switch's title: Assembly's own orders. Unreleased press
    // work leaves the PMD lane too, but that is not what the count is asked.
    if (job.department === 'assembly') hiddenOrders.add(order);
    removed = true;
    return false;
  });
  return {
    inputs: { ...inputs, dataset: { ...inputs.dataset, jobs } },
    hidden: hiddenOrders.size,
    removed,
  };
}

/** Every order in the export — the plan that is saved and synced. */
export function useAssemblyGantt(): AssemblyGanttView | null {
  return useAssemblyBoards(false).board;
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
  const inputs: GanttInputs = {
    dataset: { ...dataset, jobs: [...dataset.jobs, ...Object.values(plan.manualOrders).map(manualJob)] },
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
    virtualLines: plan.virtualLines,
    lineNames: plan.lineNames,
    workers: dataset.workers,
    workerOnLeave: plan.workerOnLeave,
    today: new Date(),
  };
  const board = computeAssemblyGantt(inputs);
  // Suggest on the board the supervisor is looking at: with Released Only on,
  // an order that is not on screen gets no crew suggested for it.
  if (!useUiStore.getState().releasedOnly) return board;
  const scoped = releasedOnlyInputs(inputs, board);
  return scoped.removed ? computeAssemblyGantt(scoped.inputs) : board;
}

/** The row for one order, if it is on a line. */
export function findOrderRow(
  board: AssemblyGanttView | null,
  jobId: string | null,
): OrderRow | null {
  if (!board || !jobId) return null;
  return board.rowsByJob.get(jobId) ?? null;
}
