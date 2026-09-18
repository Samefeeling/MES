/**
 * The board's one row of chrome, and the only one it has.
 *
 * It reads left to right as a question and its answer. **Show** is what the
 * board is being asked to draw — which lines, which columns, which days — and
 * the one thing that adds to the board rather than narrowing it. **Timeline**
 * is how far the days are zoomed — every column at once; one day column on its
 * own is dragged by its right-hand edge in the heading below. Then the figures:
 * what is on the board, what is nearly due, how much of the roster is spoken
 * for, and what is waiting to be looked at.
 *
 * Controls to the left, figures to the right, and nothing in the middle that is
 * both. The board used to open with a band above this one carrying its name,
 * its source and two of these counts — and inside MES that band sat under a top
 * bar already naming it. There is no identity band now; what is left of it is
 * the time the export was read, beside the button that re-reads it.
 */

import { useMemo, useState } from 'react';
import type { AssemblyGanttView, OrderRow } from '@/engine/assembly/board';
import { LINES, virtualLineDef } from '@/domain/assembly';
import { JobId } from '@/domain/ids';
import { PLAN_RETENTION_DAYS, usePlanStore } from '@/store/planStore';
import { useDataStore } from '@/store/dataStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { Button } from '@/ui';
import { DATE_COLS, DATE_COL_LABEL, DUE_SOON_DAYS, useUiStore } from '@/store/uiStore';
import {
  countRunningOrders,
  isDueSoon,
  lineOfWorkerToday,
  strandedOrders,
  teamSummary,
} from './boardView';
import { ManualOrderButton } from './ManualOrders';
import { Metric, MetricNote } from './Metric';
import { ReviewOrders } from './SuggestCrew';
import { formatShortDay, fromDayKey, toDayKey } from '@/lib/time';

/** How much one press of − or + moves the day column, in pixels. */
const ZOOM_STEP = 16;

export function BoardTools({ board }: { board: AssemblyGanttView | null }) {
  const dayWidth = useUiStore((s) => s.dayWidth);
  const setDayWidth = useUiStore((s) => s.setDayWidth);
  const dateCols = useUiStore((s) => s.dateCols);
  const toggleDateCol = useUiStore((s) => s.toggleDateCol);
  const hiddenLines = useUiStore((s) => s.hiddenLines);
  const toggleLine = useUiStore((s) => s.toggleLine);
  const showEverything = useUiStore((s) => s.showEverything);
  const orderDay = useUiStore((s) => s.orderDay);
  const setOrderDay = useUiStore((s) => s.setOrderDay);
  const dueSoon = useUiStore((s) => s.dueSoon);
  const toggleDueSoon = useUiStore((s) => s.toggleDueSoon);
  const showWeekends = useUiStore((s) => s.showWeekends);
  const toggleWeekends = useUiStore((s) => s.toggleWeekends);
  const virtualLines = usePlanStore((s) => s.virtualLines);
  /* Which figure is open, held here rather than in each of them: they hang off
     one row an inch apart, and two panels open at once is two panels on top of
     each other. */
  const [openPanel, setOpenPanel] = useState<string | null>(null);

  const allRows = useMemo(
    () => board?.groups.flatMap((group) => group.rows) ?? [],
    [board],
  );
  // The same figure the Team column heading used to carry, worked out the same
  // way. It is about the whole roster on the whole board, so it belongs with
  // the other three totals rather than over one column of one table.
  const team = useMemo(
    () =>
      board
        ? teamSummary(board.workers, allRows, board.today, board.workerOnLeave)
        : null,
    [board, allRows],
  );

  if (!board || !team) return null;
  const hidden = DATE_COLS.filter((key) => !dateCols[key]);
  const allLines = [...LINES, ...virtualLines.map(virtualLineDef)];
  const foldedLines = allLines.filter((line) => hiddenLines.includes(line.key));
  const running = orderDay
    ? countRunningOrders(
        board.groups.flatMap((group) => group.rows),
        fromDayKey(orderDay),
      )
    : null;
  const dueCount = allRows
    .filter((row) => row.line.schedulable && isDueSoon(row, board.today, DUE_SOON_DAYS))
    .length;
  /*
   * Whether anything is being held back. Weekends are deliberately not in it:
   * the compact working week is how the board draws itself, not something
   * somebody hid, and counting it here would leave "Show all" on screen for the
   * whole life of every board — which is the same as not having it.
   */
  const narrowed =
    hidden.length > 0 || foldedLines.length > 0 || orderDay !== null || dueSoon;

  return (
    <div className="board-tools">
      <div className="tool-group show-group">
        <strong>Show</strong>
        <button
          className="date-restore"
          onClick={toggleWeekends}
          title={
            showWeekends
              ? 'Hide Saturday and Sunday'
              : 'Show Saturday and Sunday'
          }
        >
          {showWeekends ? '− Weekends' : '+ Weekends'}
        </button>
        {/* Only the columns someone has hidden, so the row stays quiet. */}
        {hidden.map((key) => (
          <button
            className="date-restore"
            key={key}
            onClick={() => toggleDateCol(key)}
            title={`Show the ${DATE_COL_LABEL[key]} column again`}
          >
            + {DATE_COL_LABEL[key]}
          </button>
        ))}
        {/* The same, for a folded-away line. TBP and PMD start here, so this
            row is where the board admits it is not showing all eight. */}
        {foldedLines.map((line) => (
          <button
            className="date-restore line-restore"
            key={line.key}
            onClick={() => toggleLine(line.key)}
            title={`Show the ${line.fullName ?? line.name} line again`}
          >
            + {line.name}
          </button>
        ))}
        {/* One press for all of them, and drawn only while there is something
            to undo. Chip by chip is fine for the one column somebody hid a
            minute ago; it is not how you get back from a board that opened
            folded, had a day picked on it and then Due ≤ 2d. */}
        {narrowed && (
          <button
            className="show-all"
            onClick={showEverything}
            title="Every line, every column and every order back on the board"
          >
            Show all
          </button>
        )}
        <AddLine />
        <ReopenOrders board={board} />
        <MarkedSet />
        {/* The one control on this row that adds to the board instead of
            narrowing it, and the reason it is on this row at all: it is not
            the action this board is opened for, and it used to have the
            far corner that says it is. */}
        <ManualOrderButton board={board} />
      </div>

      <div className="tool-group">
        <strong>Timeline</strong>
        <button
          className="zoom-step"
          onClick={() => setDayWidth(dayWidth - ZOOM_STEP)}
          aria-label="Zoom out"
          title="Narrower days — see further ahead. Every day column goes back to one width."
        >
          −
        </button>
        <button
          className="zoom-step"
          onClick={() => setDayWidth(dayWidth + ZOOM_STEP)}
          aria-label="Zoom in"
          title="Wider days. Every day column goes back to one width."
        >
          +
        </button>
      </div>

      {/*
        What the board comes back with: five figures that all open onto what
        they are made of. Press one and whichever was open closes, so two
        panels never hang off this row at once.
      */}
      <div className="head-metrics">
        {/* The board shows every order it has unless somebody picked a day from
            the chip under a column, and this is the only place that says so —
            and the way back. It is not a filter someone can leave on by
            accident: with nothing picked, nothing is drawn here. */}
        {orderDay && (
          <button
            className="day-filter-clear"
            onClick={() => setOrderDay(null)}
            title="Back to every order on the board"
          >
            {formatShortDay(fromDayKey(orderDay))} · {running}{' '}
            {running === 1 ? 'order' : 'orders'} ×
          </button>
        )}
        <Metric
          name="load"
          className="board-load"
          label="Hours on board"
          value={`${board.totals.remainingHours.toFixed(0)} h`}
          title="Standard hours still to run across every scheduled order — line by line"
          open={openPanel}
          onOpen={setOpenPanel}
          detail={() => <BoardLoadDetail board={board} />}
        />
        {/* What has to go out before the board is next looked at. Late orders
            are in it: one due last Tuesday is not less urgent than one due
            tomorrow, and a "due soon" list that drops them is the list you would
            least want to work from.

            The one figure whose press narrows the board rather than opening a
            panel — the orders themselves are the detail, and putting them in a
            340px box under the header would be the worse copy of a board that
            is already showing them. */}
        <button
          className={`metric due-soon${dueSoon ? ' active' : ''}`}
          onClick={toggleDueSoon}
          aria-pressed={dueSoon}
          title={`Show only the orders due within ${DUE_SOON_DAYS} working days, and anything already late`}
        >
          <span className="metric-label">Due within {DUE_SOON_DAYS} days</span>
          <b className="metric-value">{dueCount}</b>
        </button>
        <Metric
          name="crew"
          className="crew-allocated"
          label="Crew allocated"
          value={
            <>
              {team.allocated}
              <i>/{team.total}</i>
            </>
          }
          title="Allocated today / staff on site; includes orders outside the current view"
          open={openPanel}
          onOpen={setOpenPanel}
          detail={() => <CrewDetail board={board} rows={allRows} />}
        />
        {/* Orders that were not on the board when the day started. It used to
            be a line of small print under Refresh, which is the one place on
            this row it must not be: a count nobody is looking for, tucked under
            the button everyone presses. */}
        <ReviewOrders board={board} open={openPanel} onOpen={setOpenPanel} />
      </div>
    </div>
  );
}

/**
 * Where the hours on the board actually are.
 *
 * The total answers "is this week heavy?" and nothing else; the question it
 * always leads to is which line is carrying it. Heaviest first, with the crew
 * on each and how long that crew needs to clear it — a line with 80 hours and
 * six people is not the same board as a line with 80 hours and one.
 */
function BoardLoadDetail({ board }: { board: AssemblyGanttView }) {
  const lines = board.groups
    .filter((group) => group.line.schedulable && group.load.hours > 0)
    .sort((a, b) => b.load.hours - a.load.hours);
  if (lines.length === 0) return <MetricNote>Nothing left to run on any line.</MetricNote>;
  return (
    <>
      <MetricNote>Standard hours still to run, heaviest line first.</MetricNote>
      <table className="metric-table">
        <tbody>
          {lines.map((group) => (
            <tr key={group.line.key}>
              <th title={group.line.fullName ?? group.line.name}>{group.line.name}</th>
              <td>{group.load.hours.toFixed(0)} h</td>
              <td title={`${group.load.crew} on the line`}>{group.load.crew || '—'} crew</td>
              <td title="Working days to clear the queue at that crew">
                {group.load.daysOfWork == null ? '—' : `${group.load.daysOfWork.toFixed(1)} d`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Who the ratio is about.
 *
 * "11/14" is only half an answer: the useful half is the three names, because
 * they are who can be put on the order somebody is standing there looking at.
 * They were on the hover, which is no use on the touchscreen this board spends
 * most of its life on.
 */
function CrewDetail({ board, rows }: { board: AssemblyGanttView; rows: OrderRow[] }) {
  const overrides = usePlanStore((s) => s.workerLines);
  const team = teamSummary(board.workers, rows, board.today, board.workerOnLeave);
  const stranded = strandedOrders(rows, board.today);
  const byLine = lineOfWorkerToday(board.workers, rows, board.today, overrides);
  // The line's own name, not its key: "UPL-Gluing" is what is written on the
  // row this panel hangs over, and UPL_GLUING is not.
  const nameOf = new Map(board.groups.map((group) => [group.line.key, group.line.name]));
  const free = new Set(team.free.map((worker) => String(worker.id)));
  const placed = new Map<string, string[]>();
  // Exactly the people the figure's numerator counts: on site today, and on an
  // order. Anyone else in the roster belongs to the other half of the ratio.
  for (const worker of team.attendance) {
    const id = String(worker.id);
    if (free.has(id)) continue;
    const line = byLine.get(id);
    const label = (line && nameOf.get(line)) ?? line ?? '—';
    placed.set(label, [...(placed.get(label) ?? []), worker.name]);
  }
  return (
    <>
      <MetricNote>
        {team.total === 0
          ? 'Nobody is on site today.'
          : `${team.allocated} of ${team.total} on site are on an order today.`}
      </MetricNote>
      {team.free.length > 0 && (
        <p className="metric-free">
          <b>Free</b> {team.free.map((worker) => worker.name).join(', ')}
        </p>
      )}
      {/* The other half of the roll. Out of the ratio entirely — they are not
          on site — but the board used to let them leave it without saying so,
          and whatever they were part-way through is still on the line. */}
      {team.onLeave.length > 0 && (
        <p className="metric-free on-leave">
          <b>On leave</b> {team.onLeave.map((worker) => worker.name).join(', ')}
          {stranded.length > 0 && (
            <span>
              {' '}— nobody on {stranded.map((row) => String(row.job.id)).join(', ')}
            </span>
          )}
        </p>
      )}
      <table className="metric-table">
        <tbody>
          {[...placed.entries()].map(([line, names]) => (
            <tr key={line}>
              <th>{line}</th>
              <td>{names.length}</td>
              <td className="metric-names" title={names.join(', ')}>{names.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Open a line that is not one of the eight.
 *
 * The plant is built as eight lines; what it is *running* this week is a
 * different question — a second table bench for a rush, a bay set up for one
 * big order, a crew split off to clear a backlog. Those had nowhere to go, so
 * the work sat on a line it was not happening on and the people on it read as
 * booked somewhere else.
 *
 * Supervisor only, and it goes into the shared plan rather than this browser:
 * a bench opened this morning is a fact about the week, and every screen
 * reading the board has to see the same one.
 */
function AddLine() {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const addVirtualLine = usePlanStore((s) => s.addVirtualLine);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  if (!unlocked) return null;

  const submit = () => {
    if (!name.trim()) return setOpen(false);
    const key = addVirtualLine(name);
    if (!key) return setError('That name is already a line.');
    setName('');
    setError('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        className="date-restore add-line"
        onClick={() => { setOpen(true); setError(''); }}
        title="Open another production line on this board"
      >
        + Line
      </button>
    );
  }

  return (
    <span className="add-line-entry">
      <input
        autoFocus
        value={name}
        maxLength={32}
        placeholder="Line name"
        aria-label="New line name"
        onChange={(e) => { setName(e.target.value); setError(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setOpen(false); setName(''); setError(''); }
        }}
      />
      <button onClick={submit} title="Open the line">Add</button>
      {error && <em className="add-line-error">{error}</em>}
    </span>
  );
}

/**
 * The orders ticked to move together, and the way out of it.
 *
 * Marking is otherwise invisible from the header — the bars carry an outline,
 * but they may all be scrolled off — and a set left ticked by accident would
 * make the next drag move things the planner had forgotten about.
 */
function MarkedSet() {
  const marked = useUiStore((s) => s.marked);
  const clearMarks = useUiStore((s) => s.clearMarks);
  if (marked.length === 0) return null;
  return (
    <button
      className="marked-set"
      onClick={clearMarks}
      title={
        `Moving together — drag any one of them:\n${marked.join('\n')}` +
        '\n\nClick here, or press Esc, to let go.'
      }
    >
      {marked.length} marked ×
    </button>
  );
}

/**
 * The way back from an order closed by mistake, after the day it was closed.
 *
 * The inspector already reopens the order whose bar is still on the board —
 * that is the same-shift correction, made where the mistake is visible. This
 * is the other half: an order closed yesterday has already left the lanes and
 * the pool, so there is no bar left to click, and the morning after is exactly
 * when the wrong job number is noticed. It lists what the plan still remembers
 * being closed, and hands the order back to the board.
 *
 * Drawn only when there is something to undo, so an ordinary board does not
 * carry a control for a mistake nobody made.
 */
function ReopenOrders({ board }: { board: AssemblyGanttView }) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const production = usePlanStore((s) => s.production);
  const reopenOrder = usePlanStore((s) => s.reopenOrder);
  const dataset = useDataStore((s) => s.dataset);
  const [open, setOpen] = useState(false);

  // Only as far back as the plan itself goes: past that the order's crew,
  // start and bookings have been let go of anyway (see PLAN_RETENTION_DAYS).
  const since = useMemo(() => {
    const day = new Date(board.today);
    day.setDate(day.getDate() - PLAN_RETENTION_DAYS);
    return toDayKey(day);
  }, [board.today]);

  const closed = useMemo(
    () =>
      Object.entries(production)
        .flatMap(([jobId, entries]) =>
          entries
            .filter((entry) => entry.jobCompleted && entry.date >= since)
            .map((entry) => ({ jobId, day: entry.date })),
        )
        .sort((a, b) => b.day.localeCompare(a.day) || a.jobId.localeCompare(b.jobId)),
    [production, since],
  );

  if (!unlocked || closed.length === 0) return null;

  // What the export still knows about. An order Epicor has stopped sending
  // comes off its completion here, but no bar can be drawn for it and no row
  // of the production list can be corrected from a board it is not on — so say
  // so rather than letting the press look like it did nothing.
  const inExport = new Set(
    (dataset?.jobs ?? []).map((job) => String(job.id)),
  );

  return (
    <>
      <button
        className="date-restore"
        onClick={() => setOpen(true)}
        title="Take the completion back off an order closed by mistake"
      >
        Reopen order
      </button>
      {open && (
        <div
          className="manual-backdrop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div
            className="manual-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Reopen a completed order"
          >
            <h2>Reopen a completed order</h2>
            <p>
              Closed in the last {PLAN_RETENTION_DAYS} days. Reopening puts the
              order and its crew back on the board with the booked quantities
              untouched, so the shift can correct them and close it again.
            </p>
            <ul className="reopen-list">
              {closed.map((row) => (
                <li key={`${row.jobId}|${row.day}`}>
                  <span className="reopen-job">{row.jobId}</span>
                  <span className="reopen-day">
                    closed {formatShortDay(fromDayKey(row.day))}
                  </span>
                  {!inExport.has(row.jobId) && (
                    <em className="reopen-gone">not in the current export</em>
                  )}
                  <Button
                    onClick={() => {
                      reopenOrder(JobId(row.jobId));
                      setOpen(false);
                    }}
                  >
                    Reopen
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
