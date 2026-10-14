/**
 * The Day board: what leaves on one day, run from the dock office.
 *
 * It opens on today, the day the warehouse works. The head answers the
 * questions a dispatch office asks every morning, in order:
 *
 * 1. **Where are we?** — loads to book, booked and gone, with their m³ and
 *    value, so progress through the day reads at a glance;
 * 2. **Can it go?** — orders on the day's loads whose goods are not ready,
 *    and loads still open from earlier days;
 * 3. **Will it fit?** — the marshalling area against the day's volume, and
 *    what to book.
 *
 * Below, the loads by route as cards (with Edit loads for hand changes), or
 * as the booking sheet the dock rings carriers from.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { DISPATCH_MODE_LABEL, stagingCapacity, type DispatchMode } from '@/domain/dispatch';
import type { DispatchPlan, PlannedLoad } from '@/engine/dispatch/plan';
import { loadValue } from '@/engine/dispatch/shipments';
import { useDispatchStore } from '@/store/dispatchStore';
import { LoadCard } from './LoadCard';
import { BookingSheet } from './BookingSheet';
import { buildCheckOf, buildIssues, useAssemblyLink, type BuildIssue } from './assemblyLink';
import { MODES, equipmentMix } from './summary';
import { dayLabel, dollars, m3, pct, shortDay, stagingTone, weekdayOf } from './format';

type Stage = 'book' | 'booked' | 'gone';

const stageOf = (l: PlannedLoad): Stage =>
  l.firm === 'dispatched' ? 'gone' : l.firm === 'confirmed' ? 'booked' : 'book';

const STAGE_LABEL: Record<Stage, string> = {
  book: 'To book',
  booked: 'Booked',
  gone: 'Dispatched',
};

export function DayBoard({
  plan,
  day,
  onDay,
  onOpenOrder,
}: {
  plan: DispatchPlan;
  day: string;
  onDay: (day: string) => void;
  onOpenOrder: (id: string) => void;
}) {
  const settings = useDispatchStore((s) => s.settings);
  const [mode, setMode] = useState<DispatchMode | 'all'>('all');
  const [view, setView] = useState<'cards' | 'sheet'>('cards');
  const [editing, setEditing] = useState(false);
  const basis = settings.shipmentValue;

  const all = useMemo(() => plan.loads.filter((l) => l.day === day), [plan.loads, day]);
  const loads = all.filter((l) => mode === 'all' || l.mode === mode);
  // Numbered across every route of the day, so L3 on a card is L3 on the
  // booking sheet whatever route filter is on.
  const numbers = new Map(all.map((l, i) => [l.id, i + 1] as const));
  const targets = useMemo(
    () => plan.loads.filter((l) => l.firm !== 'dispatched' && l.mode !== 'pickup' && l.day >= plan.today),
    [plan.loads, plan.today],
  );

  // Days with something leaving, for stepping back and forth.
  const days = useMemo(
    () => [...new Set([plan.today, ...plan.loads.map((l) => l.day)])].sort(),
    [plan.loads, plan.today],
  );
  const prev = [...days].reverse().find((d) => d < day) ?? null;
  const next = days.find((d) => d > day) ?? null;

  const stages = (['book', 'booked', 'gone'] as Stage[]).map((stage) => {
    const ls = all.filter((l) => stageOf(l) === stage);
    return {
      stage,
      loads: ls.length,
      volume: ls.reduce((s, l) => s + l.volumeM3, 0),
      value: ls.reduce((s, l) => s + loadValue(l, basis), 0),
    };
  });
  const dayValue = stages.reduce((s, x) => s + x.value, 0);
  const pending = all.filter((l) => l.firm !== 'dispatched');
  const notReady = pending.flatMap((l) =>
    l.drops.filter((d) => d.order && (d.order.readiness === 'not-ready' || d.order.readiness === 'partial')),
  );
  const notReadyOrders = new Set(notReady.map((d) => d.orderId));
  const behind = plan.loads.filter((l) => l.day < plan.today && l.firm !== 'dispatched');
  const mix: Record<string, number> = {};
  for (const l of pending) if (l.mode !== 'pickup') mix[l.equipment] = (mix[l.equipment] ?? 0) + 1;
  const total = plan.days.find((d) => d.day === day);
  const staging = stagingCapacity(settings);
  const levelled = all.filter((l) => l.levelled).length;
  // What Assembly says about the orders still to go: built to order, and
  // whether the board has them off the line before their load leaves.
  const link = useAssemblyLink();
  const assy = buildIssues(link, pending);
  const assyLate = assy.filter((x) => x.check.verdict === 'late');
  const assySameDay = assy.filter((x) => x.check.verdict === 'same-day');
  const assyUnknown = assy.filter((x) => x.check.verdict === 'unknown');
  const builtToOrder = new Set(
    pending.flatMap((l) => l.drops.filter((d) => buildCheckOf(link, d.orderId, l.day)).map((d) => d.orderId)),
  ).size;
  const warned = pending.filter((l) => l.warnings.length > 0).length;

  const counts = new Map<DispatchMode, number>();
  for (const l of all) counts.set(l.mode, (counts.get(l.mode) ?? 0) + 1);

  return (
    <div className="day-board">
      <section className="dayboard-head">
        <div className="dayboard-nav">
          <button
            type="button"
            className="kpi-btn nav-btn"
            disabled={!prev}
            onClick={() => prev && onDay(prev)}
            aria-label="Previous dispatch day"
            title={prev ? dayLabel(prev) : undefined}
          >
            ‹
          </button>
          <h2>
            {dayLabel(day)}
            {day === plan.today && <span className="today-tag">Today</span>}
          </h2>
          <button
            type="button"
            className="kpi-btn nav-btn"
            disabled={!next}
            onClick={() => next && onDay(next)}
            aria-label="Next dispatch day"
            title={next ? dayLabel(next) : undefined}
          >
            ›
          </button>
          {day !== plan.today && (
            <button type="button" className="kpi-btn" onClick={() => onDay(plan.today)}>
              Today
            </button>
          )}
          <input
            className="dayboard-date"
            type="date"
            value={day}
            aria-label="Go to day"
            onChange={(e) => e.target.value && onDay(e.target.value)}
          />
          <span className="dayboard-sum">
            {all.length} load{all.length === 1 ? '' : 's'} · {m3(all.reduce((s, l) => s + l.volumeM3, 0))} ·{' '}
            {dollars(dayValue)}
          </span>
        </div>

        <div className="dayboard-status">
          <ol className="pipeline" aria-label="Loads by status">
            {stages.map((s) => (
              <li key={s.stage} className={`stage stage-${s.stage}${s.loads === 0 ? ' empty' : ''}`}>
                <span className="stage-label">{STAGE_LABEL[s.stage]}</span>
                <b className="stage-count">{s.loads}</b>
                <span className="stage-sub">
                  {m3(s.volume)} · {dollars(s.value)}
                </span>
              </li>
            ))}
          </ol>

          <div className={`dayboard-check${notReadyOrders.size > 0 ? ' alert' : ''}`}>
            <span className="stage-label">Goods not ready</span>
            <b className="stage-count">{notReadyOrders.size}</b>
            <span className="stage-sub">
              {notReadyOrders.size > 0
                ? `of ${new Set(pending.flatMap((l) => l.drops.map((d) => d.orderId))).size} orders still to go`
                : 'every order still to go is ready'}
            </span>
          </div>

          {builtToOrder > 0 && (
            <div className={`dayboard-check${assyLate.length > 0 ? ' alert' : ''}`}>
              <span className="stage-label">Assembly</span>
              <b className={`stage-count${assyLate.length > 0 ? ' tone-bad' : assy.length > 0 ? ' tone-mid' : ' tone-good'}`}>
                {assyLate.length > 0
                  ? `${assyLate.length} late`
                  : assySameDay.length > 0
                    ? `${assySameDay.length} same day`
                    : assyUnknown.length > 0
                      ? `${assyUnknown.length} no date`
                      : 'on time'}
              </b>
              <span className="stage-sub">
                of {builtToOrder} built-to-order order{builtToOrder === 1 ? '' : 's'} still to go
              </span>
            </div>
          )}

          {(settings.trucksPerDay > 0 || settings.containersPerDay > 0) && (
            <div className={`dayboard-check${total?.overTrucks || total?.overContainers ? ' alert' : ''}`}>
              <span className="stage-label">Load-out</span>
              <b className="stage-count">
                <span className={total?.overTrucks ? 'tone-bad' : undefined}>
                  {total?.trucks ?? 0}
                  {settings.trucksPerDay > 0 && <small>/{settings.trucksPerDay}</small>}
                </span>{' '}
                <small>trucks</small> ·{' '}
                <span className={total?.overContainers ? 'tone-bad' : undefined}>
                  {total?.containers ?? 0}
                  {settings.containersPerDay > 0 && <small>/{settings.containersPerDay}</small>}
                </span>{' '}
                <small>containers</small>
              </b>
              <span className="stage-sub">against the daily limits, part loads aside</span>
            </div>
          )}

          {staging > 0 && total && (
            <div className="dayboard-check">
              <span className="stage-label">Marshalling</span>
              <b className={`stage-count tone-${stagingTone(total.volumeM3 / staging)}`}>
                {pct(total.volumeM3 / staging)}
              </b>
              <span className="meter-track" aria-hidden>
                <span
                  className={`meter-fill tone-${stagingTone(total.volumeM3 / staging)}`}
                  style={{ width: `${Math.min(100, (total.volumeM3 / staging) * 100)}%` }}
                />
              </span>
              <span className="stage-sub">
                {m3(total.volumeM3)} of {m3(staging)}
              </span>
            </div>
          )}
        </div>

        {(behind.length > 0 ||
          warned > 0 ||
          total?.overTrucks ||
          total?.overContainers ||
          total?.overStaging ||
          levelled > 0 ||
          assy.length > 0 ||
          notReady.length > 0) && (
          <ul className="dayboard-alerts">
            {behind.length > 0 && (
              <li>
                <b>{behind.length}</b> load{behind.length === 1 ? '' : 's'} from earlier days not marked dispatched (
                {[...new Set(behind.map((l) => l.day))].map((d, i) => (
                  <span key={d}>
                    {i > 0 && ', '}
                    <button type="button" className="link plain" onClick={() => onDay(d)}>
                      {weekdayOf(d)} {shortDay(d)}
                    </button>
                  </span>
                ))}
                ) — mark them dispatched or release them.
              </li>
            )}
            {notReady.length > 0 && (
              <li>
                Not ready:{' '}
                {[...notReadyOrders].slice(0, 12).map((id, i) => (
                  <span key={id}>
                    {i > 0 && ', '}
                    <button type="button" className="link" onClick={() => onOpenOrder(id)}>
                      {id}
                    </button>
                  </span>
                ))}
                {notReadyOrders.size > 12 && ` +${notReadyOrders.size - 12} more`} — check with production
                before booking.
              </li>
            )}
            {assyLate.length > 0 && (
              <li>
                Assembly finishes after the load leaves: <BuildList items={assyLate} onOpenOrder={onOpenOrder} /> —
                move them to a later load, or ask Assembly to bring them forward.
              </li>
            )}
            {assySameDay.length > 0 && (
              <li>
                Assembly finishes the day they leave: <BuildList items={assySameDay} onOpenOrder={onOpenOrder} /> —
                book a late pickup or check with the line.
              </li>
            )}
            {assyUnknown.length > 0 && (
              <li>
                No Assembly date yet (no crew, or on no line):{' '}
                <BuildList items={assyUnknown} onOpenOrder={onOpenOrder} />.
              </li>
            )}
            {warned > 0 && (
              <li>
                <b>{warned}</b> load{warned === 1 ? ' has' : 's have'} warnings — see the cards.
              </li>
            )}
            {(total?.overTrucks || total?.overContainers || total?.overStaging) && (
              <li>
                Over the daily limit:{' '}
                {[
                  total.overTrucks && `${total.trucks} trucks (limit ${settings.trucksPerDay})`,
                  total.overContainers && `${total.containers} containers (limit ${settings.containersPerDay})`,
                  total.overStaging && `${m3(total.volumeM3)} to stage (marshalling ${m3(staging)})`,
                ]
                  .filter(Boolean)
                  .join(', ')}{' '}
                — nothing more could be brought forward inside the orders' windows. Book extra, or move a load by
                hand.
              </li>
            )}
            {levelled > 0 && (
              <li>
                <b>{levelled}</b> load{levelled === 1 ? ' was' : 's were'} brought forward to this day from a day
                over its limit — see the cards.
              </li>
            )}
          </ul>
        )}

        <div className="dayboard-tools">
          {Object.keys(mix).length > 0 && (
            <p className="day-book">
              <span className="reco-label">To book</span> {equipmentMix(mix)}
            </p>
          )}
          <div className="shift-tabs" role="group" aria-label="Route">
            <button type="button" className={`shift-btn${mode === 'all' ? ' a' : ''}`} onClick={() => setMode('all')}>
              All routes
            </button>
            {MODES.filter((m) => counts.has(m)).map((m) => (
              <button
                key={m}
                type="button"
                className={`shift-btn${mode === m ? ' a' : ''}`}
                onClick={() => setMode(m)}
              >
                <span className={`dot series-${m}`} aria-hidden />
                {DISPATCH_MODE_LABEL[m]} <span className="seg-count">{counts.get(m)}</span>
              </button>
            ))}
          </div>
          <div className="dayboard-tools-end">
            <div className="shift-tabs" role="group" aria-label="Show the day as">
              <button type="button" className={`shift-btn${view === 'cards' ? ' a' : ''}`} onClick={() => setView('cards')}>
                Load cards
              </button>
              <button
                type="button"
                className={`shift-btn${view === 'sheet' ? ' a' : ''}`}
                onClick={() => {
                  setView('sheet');
                  setEditing(false);
                }}
              >
                Booking sheet
              </button>
            </div>
            {view === 'cards' && all.length > 0 && (
              <button
                type="button"
                className={`kpi-btn${editing ? ' primary' : ''}`}
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
                title="Move orders between loads, pick sizes and days by hand"
              >
                {editing ? 'Done editing' : 'Edit loads'}
              </button>
            )}
          </div>
        </div>
      </section>

      {all.length === 0 ? (
        <div className="dispatch-empty">
          <h2>Nothing leaves on {dayLabel(day)}</h2>
          {next && (
            <p>
              Next dispatch day:{' '}
              <button type="button" className="kpi-btn" onClick={() => onDay(next)}>
                {dayLabel(next)}
              </button>
            </p>
          )}
        </div>
      ) : view === 'sheet' ? (
        <BookingSheet day={day} loads={loads} numbers={numbers} deadline={plan.deadline} onOpenOrder={onOpenOrder} />
      ) : (
        MODES.map((m) => {
          const group = loads.filter((l) => l.mode === m);
          if (group.length === 0) return null;
          return (
            <ModeGroup key={m} mode={m} loads={group} value={group.reduce((s, l) => s + loadValue(l, basis), 0)}>
              {group.map((load) => (
                <LoadCard
                  key={load.id}
                  load={load}
                  number={numbers.get(load.id) ?? 0}
                  targets={targets}
                  today={plan.today}
                  deadline={plan.deadline}
                  editing={editing}
                  onOpenOrder={onOpenOrder}
                />
              ))}
            </ModeGroup>
          );
        })
      )}
    </div>
  );
}

/** Order numbers with the day Assembly expects them, each opening the order. */
function BuildList({ items, onOpenOrder }: { items: BuildIssue[]; onOpenOrder: (id: string) => void }) {
  return (
    <>
      {items.slice(0, 12).map((x, i) => (
        <span key={x.orderId}>
          {i > 0 && ', '}
          <button type="button" className="link" onClick={() => onOpenOrder(x.orderId)}>
            {x.orderId}
          </button>
          {x.check.finish && ` (${weekdayOf(x.check.finish)} ${shortDay(x.check.finish)})`}
        </span>
      ))}
      {items.length > 12 && ` +${items.length - 12} more`}
    </>
  );
}

function ModeGroup({
  mode,
  loads,
  value,
  children,
}: {
  mode: DispatchMode;
  loads: PlannedLoad[];
  value: number;
  children: ReactNode;
}) {
  const volume = loads.reduce((s, l) => s + l.volumeM3, 0);
  return (
    <div className="mode-group">
      <h3>
        <span className={`dot series-${mode}`} aria-hidden />
        {DISPATCH_MODE_LABEL[mode]}
        <span className="mode-sum">
          {loads.length} load{loads.length === 1 ? '' : 's'} · {m3(volume)} · {dollars(value)}
        </span>
      </h3>
      <div className="load-grid">{children}</div>
    </div>
  );
}
