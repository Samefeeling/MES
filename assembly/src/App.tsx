/**
 * Application shell: loads data, bootstraps/persists the plan, wires the global
 * drag-and-drop context, and lays out the assembly board and inspector.
 */

import { useCallback, useEffect } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useDataStore } from '@/store/dataStore';
import { usePlanStore } from '@/store/planStore';
import { useUiStore } from '@/store/uiStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useAssemblyBoards } from '@/store/assemblySelectors';
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
import { usePlanPersistence } from '@/features/sync/usePlanPersistence';
import { ORDER_TYPE_SHORT } from '@/domain/assembly';
import { Spinner } from '@/ui';

export default function App() {
  const error = useDataStore((s) => s.error);
  const load = useDataStore((s) => s.load);
  const warnings = useDataStore((s) => s.warnings);
  const hosted = useSupervisorStore((s) => s.hosted);

  const manualOrders = usePlanStore(s => s.manualOrders);
  const selectedJobId = useUiStore(s => s.selectedJobId);

  // `plan` is every order — what is saved and synced. `board` is what is
  // drawn, planned from released orders alone unless the Order header's
  // switch says All (see useAssemblyBoards).
  const releasedOnly = useUiStore((s) => s.releasedOnly);
  const { board: planBoard, shown: board, unreleasedHidden } = useAssemblyBoards(releasedOnly);
  const dnd = useDragDrop();
  const resetOrderSort = useUiStore((s) => s.resetOrderSort);

  /*
   * Reading and writing the one stored plan.
   *
   * Planning is published by the Save button and by nothing else, so this
   * board is a draft until somebody presses it — see `usePlanPersistence`.
   * The shift's own records are written as they are made, whoever's planning
   * is current underneath them.
   */
  const plan = usePlanPersistence();
  // Every refresh — the button and the five-minute timer alike — takes the
  // saved plan back, dropping whatever planning this browser was holding
  // unpublished. Re-sorting the rows is the button's alone: an automatic
  // refresh preserves the row order somebody chose (board-interaction-rules).
  const pull = plan.pull;
  const refresh = useScheduledRefresh(pull);
  const refreshAndSort = useCallback(async () => {
    await refresh();
    resetOrderSort();
  }, [refresh, resetOrderSort]);
  /*
   * Crew and dragged starts go back to SharePoint; a refreshed CSV carries
   * DueDate and RemainingQty in the other direction.
   *
   * Only from a board that is the published plan. The rows this writes carry
   * the line, the crew and the planned start as well as the shift's own
   * figures, so syncing a draft would put planning nobody has published into
   * the list PMD reads — and the Save gate would hold on this screen while
   * leaking straight past it downstream. A booking made while a draft is open
   * is not lost: it is in the stored plan within the second, and reaches the
   * list on the next Save or refresh. `settled` is the same rule for a board
   * that has not reached the repository at all yet.
   */
  const sync = usePlanSync(
    plan.stored === 'loaded' && plan.settled && !plan.dirty ? planBoard : null,
  );

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
          {/* Which export this is has left the row entirely — chip and hover
              both. The source has not changed since the board was built and
              never changes while anybody is looking at it, so it was a word in
              the header that answered a question nobody had. */}
          <RefreshControl
            onRefresh={() => void refreshAndSort()}
            onSave={plan.save}
            dirty={plan.dirty}
            saving={plan.saving}
            canSave={plan.stored === 'loaded'}
          />
        </div>
      </header>

      {error && <div className="banner">Data error: {error}</div>}
      {/*
        A plan that could not be read is not an empty plan. Say which of the
        two has happened, because the board looks identical either way, and
        make it plain that nothing is being written until it is read.
      */}
      {plan.stored === 'failed' ? (
        <div className="banner">
          Saved plan not loaded ({plan.error}). The board is showing the export
          on its own — crew, dragged starts and shift entries are still in the
          store and nothing is being saved over them.{' '}
          <button className="banner-action" onClick={plan.retry}>
            Try again
          </button>
        </div>
      ) : (
        plan.error && <div className="banner warn">Plan not saved: {plan.error}</div>
      )}
      {plan.archiveError && (
        <div className="banner warn">
          Yesterday’s plan not filed ({plan.archiveError}). The board is working
          normally; that day is missing from the history.
        </div>
      )}
      {/*
        The one thing a planner cannot see by looking at the board: whether
        what is on it has been published. Unsaved planning lives in this
        browser only and goes at the next refresh, so say so where the banners
        are rather than leaving it to the state of a button.
      */}
      {plan.dirty && (
        <div className="banner warn">
          Unsaved planning — this board is a draft held on this screen. Press
          Save to make it the current plan; a refresh takes the saved plan back
          and drops it.
        </div>
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
              <AssemblyGantt board={board} unreleasedHidden={unreleasedHidden} />
            ) : (
              <div className="center-fill">
                <Spinner />
                <span>Loading assembly orders…</span>
              </div>
            )}
          </div>
          {/*
            Orders on no line remain reachable in the bottom strip. When empty,
            its drag target overlays the header without taking board height.
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
