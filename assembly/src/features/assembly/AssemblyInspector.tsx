/**
 * Detail panel for the selected assembly order.
 *
 * This is where the supervisor books the shift: enter what was finished today
 * and the Expect Date moves on its own — short of target it slips out, ahead of
 * target it pulls in. Also shows what crew size would be needed to hold the
 * ship date, and the material picture behind the release gate.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { findOrderRow } from '@/store/assemblySelectors';
import { usePlanStore } from '@/store/planStore';
import { useUiStore } from '@/store/uiStore';
import { remainingQty } from '@/engine/assembly/duration';
import { startEligibility } from '@/engine/assembly/release';
import { formatDay, formatTime } from '@/lib/time';
import { Badge, Button } from '@/ui';
import type { PauseReason, ProductionEntry } from '@/store/planStore';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { useDataStore } from '@/store/dataStore';

const NO_PRODUCTION: ProductionEntry[] = [];

const PAUSE_REASONS: { value: PauseReason; label: string }[] = [
  { value: 'material-shortage', label: 'Material Shortage' },
  { value: 'waiting-previous-stage', label: 'Waiting Previous Stage' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'quality', label: 'Quality' },
  { value: 'labour-reallocated', label: 'Labour Reallocated' },
];

/** Space between the pointer and the panel, and from the window's edges. */
const PANEL_GAP = 12;
/**
 * Widths to try, narrowest first: three sections side by side at 680, then
 * wider if this order will not fit the window's height at that. Wider sections
 * wrap less — a description, a badge row and a dependency list each come back
 * off a second line — so the panel gets shorter as it gets broader.
 */
const PANEL_WIDTHS = [900, 1120, 1360];

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, Math.max(lo, hi)));

/** Where and how big the panel is, once measured against the window. */
interface Place {
  left: number;
  top: number;
  width: number;
  /** `auto` whenever the order fits the window — which is nearly all of them. */
  height: number | 'auto';
}

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;

/** Fixed numeric date for the production popup, independent of browser locale. */
export const popupDate = (date: Date | null): string =>
  date ? formatDay(date) : '—';

export function AssemblyInspector({ board }: { board: AssemblyGanttView }) {
  const selectedJobId = useUiStore((s) => s.selectedJobId);
  const selectedAt = useUiStore((s) => s.selectedAt);
  const select = useUiStore((s) => s.select);
  const row = findOrderRow(board, selectedJobId);
  const inventoryByPart = useDataStore((s) => s.indexes?.inventoryByPart);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);

  // Size the panel to this order and put it beside the click. Measured rather
  // than assumed: an order with a dependency list and short components is much
  // taller than one with neither, and a fixed height either hangs off the
  // bottom or hides half of what the supervisor opened the panel to read. So
  // it takes the height it needs; if that is more than the window can show it
  // widens instead, and only a window too small for even the widest scrolls.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !selectedAt) return setPlace(null);

    const roomW = window.innerWidth - PANEL_GAP * 2;
    const roomH = window.innerHeight - PANEL_GAP * 2;

    // Try each width in turn, measuring free of the fit worked out for the
    // last order — the panel is still wearing that until React renders.
    el.style.height = 'auto';
    let width = Math.min(PANEL_WIDTHS[0], roomW);
    el.style.width = `${width}px`;
    for (const wider of PANEL_WIDTHS) {
      if (el.offsetHeight <= roomH) break;
      if (wider <= width || wider > roomW) continue;
      width = wider;
      el.style.width = `${width}px`;
    }

    // Settle the winning fit on the node as well as in state: two orders that
    // measure alike give React nothing to diff, and it would then leave
    // whatever the trials above wrote here in place.
    const height: number | 'auto' = el.offsetHeight > roomH ? roomH : 'auto';
    el.style.height = height === 'auto' ? 'auto' : `${height}px`;

    const boxH = el.offsetHeight;
    setPlace({
      width,
      height,
      left: clamp(selectedAt.x + PANEL_GAP, PANEL_GAP, roomW + PANEL_GAP - width),
      top: clamp(selectedAt.y - PANEL_GAP * 3, PANEL_GAP, roomH + PANEL_GAP - boxH),
    });
  }, [selectedAt, selectedJobId, row]);

  // A click anywhere outside closes the transient detail panel. Escape does
  // too, through the one handler in App that knows what else is open.
  useEffect(() => {
    if (!selectedJobId) return;
    const onOutside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) select(null);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [selectedJobId, select]);
  // Every row on the board, moulding included — an order can be waiting on a
  // press job, which is not among the scheduled assembly rows.
  const rowsById = useMemo(
    () =>
      new Map(
        board.groups.flatMap((g) => g.rows).map((r) => [String(r.job.id), r]),
      ),
    [board],
  );
  const startOrder = usePlanStore((s) => s.startOrder);
  const saveProductionEntry = usePlanStore((s) => s.saveProductionEntry);
  const setOrderStart = usePlanStore((s) => s.setOrderStart);
  const orderStarts = usePlanStore((s) => s.orderStarts);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gate = signInAt(useSupervisorStore((s) => s.hosted));
  const [draft, setDraft] = useState('');
  const productionByJob = usePlanStore((s) => s.production);
  const productionEntries = selectedJobId
    ? (productionByJob[selectedJobId] ?? NO_PRODUCTION)
    : NO_PRODUCTION;
  const [reject, setReject] = useState('0');
  const [rework, setRework] = useState('0');
  const [shiftOutput, setShiftOutput] = useState('0');
  const [paused, setPaused] = useState(false);
  const [jobCompleted, setJobCompleted] = useState(false);
  const [pauseReason, setPauseReason] = useState<PauseReason>('material-shortage');
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [startMessage, setStartMessage] = useState('');
  const [entryMessage, setEntryMessage] = useState('');
  const today = isoDay(new Date());

  useEffect(() => {
    const existing = productionEntries.find((entry) => entry.date === today);
    setDraft(existing ? String(existing.complete) : '');
    setReject(String(existing?.reject ?? 0));
    setRework(String(existing?.rework ?? 0));
    setShiftOutput(String(existing?.shiftOutput ?? 0));
    setPaused(Boolean(existing?.paused));
    setJobCompleted(Boolean(existing?.jobCompleted));
    setPauseReason(existing?.pauseReason ?? 'material-shortage');
    setNotes(existing?.notes ?? '');
    setOverrideReason('');
    setStartMessage('');
    setEntryMessage('');
  }, [selectedJobId, productionEntries, today]);

  // Nothing picked: the panel is simply not there. It opens on a click and
  // closes again, rather than sitting in a column asking to be filled.
  if (!row) return null;

  const { job, status } = row;
  /** The day the planner dragged this bar to, if they did. */
  const pinnedStart = orderStarts[String(job.id)];
  const left = remainingQty(job);
  const existingToday = productionEntries.find((entry) => entry.date === today);
  const maxComplete = left + (existingToday?.complete ?? 0);
  // Closed by the supervisor: the bar greys out and there is nothing left to
  // book, but the history stays readable.
  const closed = row.completedToday;
  // Open days in the middle of the run with nobody on the order, and what has
  // its crew on them.
  const pausedDays = (row.pauses ?? []).reduce(
    (sum, pause) => sum + pause.days.length,
    0,
  );
  const pausedFor = [
    ...new Set((row.pauses ?? []).flatMap((pause) => pause.heldBy)),
  ];
  // Days this order takes somebody another one already has — only ever a
  // pinned or started order, which consults no diary.
  const clashes = row.doubleBooked ?? [];
  const clashJobs = [...new Set(clashes.map((clash) => clash.withJob))];
  const clashNames = [
    ...new Set(
      clashes.map(
        (clash) =>
          row.workers.find((w) => String(w.id) === clash.workerId)?.name ??
          clash.workerId,
      ),
    ),
  ];
  /*
   * Who to record against today's shift.
   *
   * The day plan first — that is the crew the board has on it today. An order
   * planned to begin later in the week has nobody on it *today* and is still
   * fully crewed, so it falls back to the order's own people rather than
   * reading as unstaffed. The start gate below asks the second question, not
   * the first: it used to refuse an order with three people on it because
   * none of their days had come round yet.
   */
  const todayCrew = row.workers.filter((worker) =>
    (row.crewDays.find((day) => day.day === today)?.workerIds ?? []).includes(
      String(worker.id),
    ),
  );
  const activeCrew = todayCrew.length > 0 ? todayCrew : row.workers;
  const picks = row.pickList ?? [];

  const eligibility = startEligibility(
    job.released,
    row.release,
    row.workers.length,
  );

  const beginProduction = () => {
    if (row.actualStart) return;
    const reason = overrideReason.trim();
    if (!eligibility.allowed) {
      if (!eligibility.canOverride) {
        setStartMessage(eligibility.reasons.join(' · '));
        return;
      }
      if (!unlocked) {
        setStartMessage(`Sign in as ${gate} to override the start gate.`);
        return;
      }
      if (!reason) {
        setStartMessage('Enter an override reason before starting production.');
        return;
      }
    }
    startOrder(job.id, {
      startedAt: new Date().toISOString(),
      overrideReason: eligibility.allowed ? null : reason,
      operatorIds: activeCrew.map((worker) => String(worker.id)),
      operatorNames: activeCrew.map((worker) => worker.name),
    });
    setStartMessage('Production start confirmed.');
  };

  const book = () => {
    if (closed) {
      setEntryMessage('Completed entries are locked.');
      return;
    }
    const qty = Number(draft || 0);
    const numbers = [qty, Number(reject), Number(rework), Number(shiftOutput)];
    if (!numbers.every((n) => Number.isFinite(n) && n >= 0)) {
      setEntryMessage('All production quantities must be zero or greater.');
      return;
    }
    if (qty > maxComplete) {
      setEntryMessage(`Complete cannot exceed the ${maxComplete} units available.`);
      return;
    }
    if (!row.actualStart) {
      setEntryMessage('Confirm Start production before saving an entry.');
      return;
    }
    if (paused && jobCompleted) {
      setEntryMessage('An order cannot be paused and completed in the same entry.');
      return;
    }
    if (numbers.every((n) => n === 0) && !paused && !jobCompleted && !notes.trim()) {
      setEntryMessage('Enter production, a pause, completion, or a note before saving.');
      return;
    }
    const completedAt = jobCompleted ? new Date().toISOString() : null;
    saveProductionEntry(job.id, {
      date: today,
      complete: qty,
      reject: Number(reject),
      rework: Number(rework),
      shiftOutput: Number(shiftOutput),
      paused,
      pauseReason: paused ? pauseReason : null,
      jobCompleted,
      operatorIds: activeCrew.map((worker) => String(worker.id)),
      operatorNames: activeCrew.map((worker) => worker.name),
      completedAt,
      notes: notes.trim(),
    }, {
      remainingQty: row.sourceRemainingQty ?? row.job.remainingQty,
      completedQty: row.sourceCompletedQty ?? row.job.completedQty,
    });
    setEntryMessage(jobCompleted ? 'Entry saved. Crew released.' : 'Entry saved.');
  };

  return (
    <div
      ref={panel}
      className="inspector floating"
      role="dialog"
      aria-label={`Order ${String(job.id)}`}
      // Hidden for the first paint, while it is measured against the window —
      // otherwise it flashes at the top-left corner on the way to the click.
      // Every property is written on every render: the measuring pass sets
      // these on the node directly, and React only clears what it knows it set.
      style={
        place
          ? {
              left: place.left,
              top: place.top,
              width: place.width,
              height: place.height,
            }
          : {
              left: 0,
              top: 0,
              width: PANEL_WIDTHS[0],
              height: 'auto',
              visibility: 'hidden',
            }
      }
    >
      {/*
       * The order names itself once, across the top, instead of as the first
       * three rows of a narrow list — a part description is a sentence, and a
       * sentence set in a third of the panel's width was the tallest thing on
       * screen and the least readable. There is no close button: Esc and a
       * click anywhere outside both close it, which is how everything else on
       * the board behaves, and a button in the corner of a panel that opens at
       * the pointer is one more thing to aim at.
       */}
      <header className="inspector-title">
        <div className="inspector-ident">
          <span className="inspector-job">{String(job.id)}</span>
          <span className="inspector-part">{String(job.partNum)}</span>
          {job.description && (
            <span className="inspector-desc" title={job.description}>
              {job.description}
            </span>
          )}
        </div>
        <div className="inspector-flags">
          {closed && <Badge variant="neutral">Job completed</Badge>}
          {row.overtime && <Badge variant="warn">Weekend overtime</Badge>}
          <Badge
            variant={
              status.color === 'green'
                ? 'ok'
                : status.color === 'red'
                  ? 'error'
                  : 'neutral'
            }
          >
            {status.reason}
          </Badge>
          {row.waitingOn && (
            <Badge variant="neutral">
              Waits on {String(row.waitingOn.onJobId)}
            </Badge>
          )}
          {/*
            Why the Expect Date is blank, on the row itself. The board knew all
            along — it is the work the crew's own diaries left uncovered — and
            said only "—", which reads as a fault rather than as a shortfall
            somebody has to allocate their way out of.
          */}
          {!closed && (row.uncoveredHours ?? 0) > 0 && (
            <Badge variant="error">
              {row.uncoveredHours!.toFixed(1)} h not covered
              {(row.crewWithoutRoom?.length ?? 0) > 0 &&
                ` · no room: ${row.crewWithoutRoom!.map((w) => w.name).join(', ')}`}
            </Badge>
          )}
          {/*
            The bar is joined across the days nobody on it is free, so the one
            place that can say how many there are and what took them is here.
            Dragging the bar "back together" is the wrong answer — a pinned
            order consults no diary, so it only books the same person twice.
          */}
          {!closed && clashes.length > 0 && (
            <Badge
              variant="error"
              title={
                'A pinned or started order takes the days it was given without ' +
                'asking anyone’s diary. That is right for a decision somebody ' +
                'made — but the same person is on both orders on these days, ' +
                'so one of the two will not get them.'
              }
            >
              double-booked · {clashNames.join(', ')} also on{' '}
              {clashJobs.join(', ')}
            </Badge>
          )}
          {!closed && pausedDays > 0 && (
            <Badge
              variant="warn"
              title={
                'The order is put down on these days because everyone on it is ' +
                'elsewhere. Take somebody off the other order, or add crew to ' +
                'this one — dragging the bar only books the same person twice.'
              }
            >
              put down {pausedDays} day{pausedDays === 1 ? '' : 's'}
              {pausedFor.length > 0 && ` · crew on ${pausedFor.join(', ')}`}
            </Badge>
          )}
          <span className="inspector-dismiss">Esc or click away to close</span>
        </div>
      </header>

      <div className="inspector-grid">
        <section className="inspector-section job-info">
          <h3>Schedule</h3>
          {/* Plain date lines keep the narrow schedule section easy to scan. */}
          <div className="date-rail">
            <div className="date-cell" title="Order start date">
              <span className="date-label">Start</span>
              <span className="date-value">{popupDate(job.startDate)}</span>
            </div>
            <div className="date-cell">
              <span className="date-label">Due</span>
              <span className="date-value">
                {popupDate(job.dueDate)}
              </span>
            </div>
            {/* Last of the three, and the only one that carries a colour:
                the answer, under the two dates it is worked out from. */}
            <div className="date-cell">
              <span className="date-label">Expect</span>
              <span className={`date-value ${status.color}`}>
                {popupDate(row.expectDate)}
              </span>
            </div>
          </div>
          {/*
            The way back out of a drag.

            Dragging a bar pins it, and a pinned order stops being sequenced
            against its crew's diary — it holds the day it was given instead of
            falling in behind whatever those people are already on. That is
            right for an order somebody has placed deliberately, and wrong for
            one they were only nudging: there was no way to undo it, so a board
            worked over for an afternoon ended up pinned order by order, each
            one frozen out of the packing that would have pulled the week
            together. Releasing hands the order back to the schedule, which
            starts it as early as its crew, its line and its components allow.
          */}
          {pinnedStart && !row.actualStart && (
            <div className="pinned-start">
              <span>
                Start pinned by hand to <b>{popupDate(new Date(pinnedStart))}</b>
              </span>
              <Button
                onClick={() => setOrderStart(job.id, null)}
                disabled={!unlocked}
                title={
                  unlocked
                    ? 'Let the board schedule this order again — as early as its crew, its line and the orders it waits on allow'
                    : `Sign in as ${gate} to release the pinned start`
                }
              >
                Release
              </Button>
            </div>
          )}
          <dl className="kv">
            <dt>Progress</dt>
            <dd>
              <span className="progress-figure">
                {job.completedQty} <span className="of">of</span>{' '}
                {job.completedQty + left}
              </span>
              <span
                className="progress-meter"
                title={`${left} still to make`}
                aria-hidden="true"
              >
                <i
                  style={{
                    width: `${
                      (100 * job.completedQty) /
                      Math.max(1, job.completedQty + left)
                    }%`,
                  }}
                />
              </span>
            </dd>
          </dl>
          {row.predecessors.length > 0 && (
            <div className="inspector-subsection">
              <h4>Needs finished first</h4>
              <ul className="dep-list">
                {row.predecessors.map((dep) => {
                  const on = rowsById.get(String(dep.onJobId));
                  const holding = row.waitingOn?.onJobId === dep.onJobId;
                  return (
                    <li
                      key={String(dep.onJobId)}
                      className={holding ? 'holding' : ''}
                    >
                      <span className="dep-job">{String(dep.onJobId)}</span>
                      <span
                        className="dep-part"
                        title={
                          dep.part
                            ? `${String(dep.onJobId)} supplies ${String(dep.part)}`
                            : 'Named as this order’s part in the order export'
                        }
                      >
                        {dep.part ? String(dep.part) : 'named in the order export'}
                      </span>
                      <span className="dep-when">
                        {on?.line.name ?? '—'}
                        {on?.expectDate ? ` · ${formatDay(on.expectDate)}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {row.material.shortages.length > 0 && (
            <div className="inspector-subsection">
              <h4>Short components</h4>
              {row.material.shortages.map((shortage) => (
                <div className="shortage-row" key={String(shortage.componentPart)}>
                  <span className="part">{String(shortage.componentPart)}</span>
                  <span>
                    need {shortage.requiredQty}, free {shortage.freeOnHand} (−{shortage.shortQty})
                    {shortage.coverageDate
                      ? ` · PO ${shortage.poNum ?? ''} ${formatDay(shortage.coverageDate)}`
                      : ' · no PO'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="inspector-section pick-list-section">
          <h3>
            Warehouse pick list
            {picks.length > 0 && (
              <span className="count">
                {picks.length} line{picks.length === 1 ? '' : 's'}
              </span>
            )}
          </h3>
          {picks.length === 0 ? (
            <p className="hint">No materials found in JobMaterialReq.csv.</p>
          ) : (
            <div className="pick-list">
              <div className="pick-list-row pick-list-head" aria-hidden="true">
                <span>Part</span>
                <span>Required</span>
                <span>On hand</span>
                <span title="Calculated_Demand">Demand</span>
              </div>
              {picks.map((material, index) => (
                <div className="pick-list-row" key={`${String(material.childPart)}-${index}`}>
                  <span className="part" title={inventoryByPart?.get(material.childPart)?.description || String(material.childPart)}>
                    {String(material.childPart)}
                  </span>
                  <span
                    className={
                      material.requiredQty === null ? 'qty none' : 'qty'
                    }
                  >
                    {material.requiredQty === null ? '—' : material.requiredQty}
                  </span>
                  <span
                    className={
                      inventoryByPart?.has(material.childPart) ? 'qty on-hand' : 'qty none'
                    }
                    title={
                      inventoryByPart?.has(material.childPart)
                        ? 'Calculated_OnHand from OnHandInventory.csv'
                        : 'Part not found in the loaded OnHandInventory.csv'
                    }
                  >
                    {inventoryByPart?.get(material.childPart)?.onHand ?? '—'}
                  </span>
                  <span className="qty" title="Calculated_Demand from OnHandInventory.csv">
                    {inventoryByPart?.get(material.childPart)?.calculatedDemand ?? '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="production-start">
            {row.actualStart ? (
              <div className="production-history">
                <strong>Started</strong>{' '}
                {formatDay(new Date(row.actualStart.startedAt))}{' '}
                {formatTime(new Date(row.actualStart.startedAt))}
                {row.actualStart.overrideReason &&
                  ` · Override: ${row.actualStart.overrideReason}`}
              </div>
            ) : (
              <>
                {!eligibility.allowed && (
                  <p className="hint">
                    Start gate: {eligibility.reasons.join(' · ')}
                  </p>
                )}
                {!eligibility.allowed && eligibility.canOverride && unlocked && (
                  <textarea
                    className="production-input"
                    value={overrideReason}
                    placeholder="Supervisor override reason (required)"
                    onChange={(event) => setOverrideReason(event.target.value)}
                  />
                )}
                <Button
                  variant="primary"
                  disabled={
                    !eligibility.allowed &&
                    (!eligibility.canOverride || !unlocked)
                  }
                  onClick={beginProduction}
                >
                  Start production
                </Button>
              </>
            )}
            {startMessage && <p className="hint action-message" role="status">{startMessage}</p>}
          </div>
        </section>

        <section className="inspector-section production-entry">
          <h3>
            Production entry
            <span className="count">today</span>
          </h3>
          <div className="production-grid">
            <label><span>Shift output</span><input type="number" min={0} value={shiftOutput} onChange={(event) => setShiftOutput(event.target.value)} /></label>
            <label><span>Reject</span><input type="number" min={0} value={reject} onChange={(event) => setReject(event.target.value)} /></label>
            <label><span>Rework</span><input type="number" min={0} value={rework} onChange={(event) => setRework(event.target.value)} /></label>
            <label><span>Complete</span><input type="number" min={0} max={maxComplete} value={draft} placeholder={`≤ ${maxComplete}`} onChange={(event) => setDraft(event.target.value)} /></label>
          </div>
          <div className="production-actions">
            <label className="pause-toggle">
              <input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} /> Pause
            </label>
            <label className="pause-toggle">
              <input type="checkbox" checked={jobCompleted} onChange={(event) => setJobCompleted(event.target.checked)} /> Job completed
            </label>
          </div>
          {paused && (
            <select className="production-input" value={pauseReason} onChange={(event) => setPauseReason(event.target.value as PauseReason)}>
              {PAUSE_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
            </select>
          )}
          <textarea className="production-input" value={notes} placeholder="Notes (optional)" onChange={(event) => setNotes(event.target.value)} />
          {entryMessage && <p className="hint action-message" role="status">{entryMessage}</p>}
          {/* The note that explains the form sits with the button that submits
              it, so the section ends on its action rather than trailing off. */}
          <div className="section-foot book">
            <p className="hint">
              Entered at shift end. The Expect Date adjusts automatically.
            </p>
            <Button variant="primary" disabled={closed} onClick={book}>
              Save entry
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
