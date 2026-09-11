/**
 * Application shell: loads data, bootstraps/persists the plan, wires the global
 * drag-and-drop context, and lays out the assembly board and inspector.
 */

import { useEffect, useRef, useState } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useDataStore } from '@/store/dataStore';
import { useIgnoredOrders } from '@/store/ignoredOrders';
import { usePlanStore } from '@/store/planStore';
import { useUiStore } from '@/store/uiStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useAssemblyGantt } from '@/store/assemblySelectors';
import { createPlanRepository, CURRENT_PLAN_ID } from '@/persistence';
import { useDragDrop } from '@/features/assembly/useDragDrop';
import { AssemblyGantt } from '@/features/assembly/AssemblyGantt';
import { BoardTools } from '@/features/assembly/BoardTools';
import { ManualOrderInspector } from '@/features/assembly/ManualOrders';
import { AssemblyInspector } from '@/features/assembly/AssemblyInspector';
import { BarcodeOrderLookup } from '@/features/assembly/BarcodeOrderLookup';
import { AssemblyPool } from '@/features/assembly/AssemblyPool';
import { OvertimePrompt } from '@/features/assembly/OvertimePrompt';
import { ClashPrompt } from '@/features/assembly/ClashPrompt';
import { SupervisorLock } from '@/features/assembly/SupervisorLock';
import { useScheduledRefresh } from '@/features/refresh/useScheduledRefresh';
import { RefreshControl } from '@/features/refresh/RefreshControl';
import { usePlanSync } from '@/features/sync/usePlanSync';
import { ORDER_TYPE_SHORT } from '@/domain/assembly';
import { Spinner } from '@/ui';

const repo = createPlanRepository();

export default function App() {
  const status = useDataStore((s) => s.status);
  const error = useDataStore((s) => s.error);
  const dataset = useDataStore((s) => s.dataset);
  const load = useDataStore((s) => s.load);
  const warnings = useDataStore((s) => s.warnings);
  const sourceName = useDataStore((s) => s.source.name);
  const hosted = useSupervisorStore((s) => s.hosted);

  const ignoredOrderIds = useIgnoredOrders(s => s.ids);
  const containers = usePlanStore((s) => s.containers);
  const manualOrders = usePlanStore(s => s.manualOrders);
  const selectedJobId = useUiStore(s => s.selectedJobId);
  const lineLayoutVersion = usePlanStore(s => s.lineLayoutVersion);
  const workerLines = usePlanStore((s) => s.workerLines);
  const virtualLines = usePlanStore((s) => s.virtualLines);
  const lineOrder = usePlanStore((s) => s.lineOrder);
  const orderCrewAssignments = usePlanStore((s) => s.orderCrewAssignments);
  const orderStarts = usePlanStore((s) => s.orderStarts);
  const orderActualStarts = usePlanStore((s) => s.orderActualStarts);
  const orderOvertime = usePlanStore((s) => s.orderOvertime);
  const orderDoubleBooked = usePlanStore((s) => s.orderDoubleBooked);
  const progress = usePlanStore((s) => s.progress);
  const progressBaselines = usePlanStore((s) => s.progressBaselines);
  const production = usePlanStore((s) => s.production);
  const lastSeen = usePlanStore((s) => s.lastSeen);


  const board = useAssemblyGantt();
  const dnd = useDragDrop();
  const refresh = useScheduledRefresh();
  const resetOrderSort = useUiStore((s) => s.resetOrderSort);
  // Crew and dragged starts go back to SharePoint; a refreshed CSV carries
  // DueDate and RemainingQty in the other direction.


  const bootstrapped = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveGeneration = useRef(0);
  /**
   * How the read of the stored plan went.
   *
   * `loaded` also covers a repository that has nothing stored yet — a new
   * board is not a failure. `failed` is the state autosave must sit out: the
   * board has been laid out from the export alone, with nobody allocated and
   * no pins, and writing that back would put it over the plan the repository
   * is still holding.
   */
  const [stored, setStored] = useState<'reading' | 'loaded' | 'failed'>(
    'reading',
  );
  const [planSaved, setPlanSaved] = useState(false);
  const sync = usePlanSync(stored === 'loaded' && planSaved ? board : null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reason = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

  // Initial data load.
  useEffect(() => {
    void load();
  }, [load]);

  /*
   * One Escape closes one thing.
   *
   * Each thing that can be open used to listen for Escape itself, so one
   * press closed all of them at once: dismissing an order's detail also let
   * go of a run of orders somebody had spent a minute marking. The layers are
   * ordered in `dismissTop` instead, and this is the only listener.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUiStore.getState().dismissTop()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Bootstrap the plan from persistence on first ready; reconcile thereafter.
  useEffect(() => {
    if (status !== 'ready' || !dataset) return;
    const plan = usePlanStore.getState();
    if (bootstrapped.current) {
      plan.reconcile(dataset.workCenters, dataset.jobs);
      return;
    }
    bootstrapped.current = true;
    repo
      .load()
      .then((persisted) => {
        if (persisted?.containers) plan.setContainers(persisted.containers);
        if (persisted?.assembly) {
          plan.setAssemblyPlan(persisted.assembly);
          if (persisted.assembly.ignoredOrderIds) useIgnoredOrders.setState({ ids: persisted.assembly.ignoredOrderIds });
        }
        plan.reconcile(dataset.workCenters, dataset.jobs);
        setStored('loaded');
        setStoreError(null);
      })
      .catch((e) => {
        // Still lay the board out, so the export is readable while the
        // repository is unreachable — but say so, and save nothing.
        plan.reconcile(dataset.workCenters, dataset.jobs);
        setStored('failed');
        setStoreError(reason(e));
      });
  }, [status, dataset, attempt]);

  const retryStoredPlan = () => {
    bootstrapped.current = false;
    setStored('reading');
    setStoreError(null);
    setAttempt((n) => n + 1);
  };

  // Debounced autosave of the planner's layout.
  useEffect(() => {
    if (stored !== 'loaded') return;
    setPlanSaved(false);
    const generation = ++saveGeneration.current;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      repo
        .save({
          id: CURRENT_PLAN_ID,
          name: 'Working plan',
          savedAt: new Date().toISOString(),
          containers,
          assembly: {
            manualOrders,
            lineLayoutVersion,
            ignoredOrderIds,
            workerLines,
            virtualLines,
            lineOrder,
            orderCrewAssignments,
            orderStarts,
            orderActualStarts,
            orderOvertime,
            orderDoubleBooked,
            progress,
            progressBaselines,
            production,
            lastSeen,
          },
        })
        .then(() => { if (generation === saveGeneration.current) { setStoreError(null); setPlanSaved(true); } })
        .catch((e) => { setStoreError(reason(e)); setStored('failed'); });
    }, 600);
    return () => window.clearTimeout(saveTimer.current);
  }, [
    ignoredOrderIds,
    lineLayoutVersion,
    manualOrders,
    stored,
    containers,
    workerLines,
    virtualLines,
    lineOrder,
    orderCrewAssignments,
    orderStarts,
    orderActualStarts,
    orderOvertime,
    orderDoubleBooked,
    progress,
    progressBaselines,
    production,
    lastSeen,
  ]);

  const activeJob =
    dnd.activeJobId && board ? board.jobsById.get(dnd.activeJobId) : null;
  const activeWorker =
    dnd.activeWorkerId && board
      ? board.workers.find(
          (worker) => String(worker.id) === dnd.activeWorkerId,
        )
      : null;

  return (
    <div className="app">
      {/*
        One row, and it reads left to right as a question and its answer: what
        the board is being asked to show, how far the timeline is zoomed, and
        then the four figures it comes back with.
        `BoardTools` holds all three.

        There is no identity band. The board used to open with its own name, its
        source and its counts across the top, above the row that actually does
        something — and inside MES that name sits one band under a top bar
        already carrying it. What is left of that row is here: the source and
        the time it was read, at the end, where the control that re-reads it is.

        This row and the column heading under it are one block of chrome, on
        one ground — MES's top bar is the other, and the page gets no more
        than the two.
      */}
      <header className="app-header">
        {/*
          Standalone only — the dev server and the mock demo have no top bar
          above them, and a page with nothing naming it is a page nobody can
          say they are on.
        */}
        {!hosted && <h1>Assembly Board</h1>}
        <BoardTools board={board} />
        <div className="head-side end">
          <SupervisorLock />
          <BarcodeOrderLookup board={board} />
          {/* Which export this is stays on the hover of the time it was read,
              rather than as a chip: the source has not changed since the board
              was built and never changes while anybody is looking at it, so it
              was a word in the header that answered a question nobody had. */}
          <RefreshControl source={sourceName} onRefresh={async () => {
            await refresh();
            resetOrderSort();
          }} />
        </div>
      </header>

      {error && <div className="banner">Data error: {error}</div>}
      {/*
        A plan that could not be read is not an empty plan. Say which of the
        two has happened, because the board looks identical either way, and
        make it plain that nothing is being written until it is read.
      */}
      {stored === 'failed' ? (
        <div className="banner">
          Saved plan not loaded ({storeError}). The board is showing the export
          on its own — crew, dragged starts and shift entries are still in the
          store and nothing is being saved over them.{' '}
          <button className="banner-action" onClick={retryStoredPlan}>
            Try again
          </button>
        </div>
      ) : (
        storeError && (
          <div className="banner warn">Plan not saved: {storeError}</div>
        )
      )}
      {sync.errors.length > 0 && (
        <div className="banner warn">
          {sync.list} not updated: {sync.errors[0]}
          {sync.errors.length > 1 && ` · +${sync.errors.length - 1} more`}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="banner warn">
          {/* Only the first few; the rest are usually the same problem. */}
          {warnings.slice(0, 3).join(' · ')}
          {warnings.length > 3 && ` · +${warnings.length - 3} more`}
        </div>
      )}

      <DndContext
        sensors={dnd.sensors}
        autoScroll={!dnd.activeBar}
        collisionDetection={dnd.collisionDetection}
        onDragStart={dnd.onDragStart}
        onDragEnd={dnd.onDragEnd}
        onDragCancel={dnd.onDragCancel}
      >
        {/*
          The schedule has the whole width. An order's detail opens beside the
          pointer instead of in a column. Unassigned jobs remain in plan state
          but no pull-job side column is rendered.
        */}
        <div className="app-body">
          <div className="board-pane assembly-pane">
            {board ? (
              <AssemblyGantt board={board} />
            ) : (
              <div className="center-fill">
                <Spinner />
                <span>Loading assembly orders…</span>
              </div>
            )}
          </div>
          {/*
            Orders on no line remain reachable in the bottom strip. Reserve the
            empty target before dragging so the board viewport stays stable.
          */}
          {board && <AssemblyPool board={board} />}
          {board && (selectedJobId && manualOrders[selectedJobId] ? <ManualOrderInspector key={selectedJobId} board={board} id={selectedJobId} /> : <AssemblyInspector board={board} />)}
        </div>

        <DragOverlay dropAnimation={null}>
          {dnd.activeLineName ? (
            <div className="line-drag-overlay">{dnd.activeLineName}</div>
          ) : activeWorker ? (
            <div className="worker-drag-overlay">{activeWorker.name}</div>
          ) : activeJob ? (
            <div className="ord" style={{ cursor: 'grabbing', width: 240 }}>
              <div className="ord-head">
                <span className="ord-job">{String(activeJob.id)}</span>
                {activeJob.orderType && (
                  <span className="ord-type">
                    {ORDER_TYPE_SHORT[activeJob.orderType]}
                  </span>
                )}
              </div>
              <div className="ord-desc">{activeJob.description}</div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Asks before any work is written into a Saturday or Sunday. */}
      <OvertimePrompt />
      {/* …and before anyone is put on two orders at the same time. */}
      <ClashPrompt />
    </div>
  );
}
