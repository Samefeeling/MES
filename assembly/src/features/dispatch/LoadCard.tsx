/**
 * One truck, linehaul departure, container or pickup: what to book, who it
 * goes to, what it carries, and the planner's actions on it.
 *
 * The title row names the route and the ship-to customers on it. The
 * recommendation follows — "1 × Rigid 12-pallet truck — 45 m³ usable" — with
 * the route's whole size ladder under it, each size showing how full this
 * load would make it. Each drop shows the pick-list comment (the packed cube
 * the warehouse wrote), its due date and the day the customer expects it.
 *
 * In edit mode (switched on for the whole day, since a change re-plans the
 * day and freezes loads under new ids) the card takes hand changes: move an
 * order to another load or onto one of its own, take it off for the
 * optimiser to place, pick the size from the ladder, or change the day.
 * Every change freezes the load (`Edited`); **Reset to plan** hands it back
 * to the optimiser.
 */

import {
  DEADLINE_LABEL,
  DISPATCH_MODE_LABEL,
  PART_LOAD,
  VOLUME_SOURCE_LABEL,
  dueDate,
  type DeadlineField,
  type VolumeSource,
} from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { useDispatchStore } from '@/store/dispatchStore';
import { Badge } from '@/ui';
import { contractorOf, fullAddress, shipToNames } from './booking';
import { BuildChip, buildCheckOf, useAssemblyLink } from './assemblyLink';
import { recommendation, sizeLadder } from './equipment';
import { LIMIT_LABEL, READINESS, dollars, dollarsFull, fillTone, m3, pct, shortDay, weekdayOf } from './format';
import { loadValue } from '@/engine/dispatch/shipments';

/** One-letter marker for where a volume came from; freight is the default. */
export const SOURCE_MARK: Partial<Record<VolumeSource, string>> = {
  packed: 'P',
  cubics: 'C',
  'cubics-partial': 'C?',
  entered: 'E',
};

const NEW = '__new';
const REPLAN = '__replan';

const noun = (load: PlannedLoad) =>
  load.mode === 'container' ? 'container' : load.mode === 'linehaul' ? 'linehaul' : 'truck';

export function LoadCard({
  load,
  number,
  targets,
  today,
  deadline,
  editing,
  onOpenOrder,
}: {
  load: PlannedLoad;
  /** The load's number on its day, shared with the booking sheet. */
  number: number;
  /** Loads an order on this one may be moved to. */
  targets: readonly PlannedLoad[];
  today: string;
  deadline: DeadlineField;
  editing: boolean;
  onOpenOrder: (id: string) => void;
}) {
  const settings = useDispatchStore((s) => s.settings);
  const confirmLoad = useDispatchStore((s) => s.confirmLoad);
  const markDispatched = useDispatchStore((s) => s.markDispatched);
  const releaseLoad = useDispatchStore((s) => s.releaseLoad);
  const moveOrder = useDispatchStore((s) => s.moveOrder);
  const resizeLoad = useDispatchStore((s) => s.resizeLoad);
  const redateLoad = useDispatchStore((s) => s.redateLoad);

  const drops = new Set(load.drops.map((d) => d.orderId)).size;
  const value = loadValue(load, settings.shipmentValue);
  const ladder = sizeLadder(load, settings);
  const names = shipToNames(load);
  const contractor = contractorOf(load, settings.contractors);
  const link = useAssemblyLink();
  const canEdit = load.firm !== 'dispatched' && load.mode !== 'pickup';
  const isEditing = editing && canEdit;
  // NSW runs may swap orders between run classes; a linehaul or container
  // order only moves to another departure of the same carrier and zone.
  const moveTo = targets.filter(
    (t) =>
      t.id !== load.id &&
      t.mode === load.mode &&
      ((load.mode === 'fleet' && !settings.fleet.keepShipViaApart) || t.group === load.group),
  );
  const dueLabel = DEADLINE_LABEL[deadline];

  const move = (orderId: string, value: string) => {
    if (!value) return;
    if (value === NEW) moveOrder(orderId, load, null);
    else if (value === REPLAN) moveOrder(orderId, load, 'replan');
    else {
      const to = moveTo.find((t) => t.id === value);
      if (to) moveOrder(orderId, load, to);
    }
  };

  return (
    <article
      className={`load-card mode-${load.mode}${load.firm ? ` firm-${load.firm}` : ''}${isEditing ? ' editing' : ''}`}
    >
      <header className="load-head">
        <div className="load-title">
          <span className="load-mode">
            L{number} · {DISPATCH_MODE_LABEL[load.mode]}
          </span>
          <div className="title-row">
            <strong>{load.label}</strong>
            <span className="ship-to" title={names.join('\n')}>
              {names.slice(0, 2).join(' · ')}
              {names.length > 2 && <span className="more"> +{names.length - 2}</span>}
            </span>
          </div>
        </div>
        <div className="load-status">
          {load.firm === 'edited' && (
            <Badge variant="warn" title="Changed by hand: re-planning keeps it as it is">
              Edited
            </Badge>
          )}
          {load.firm === 'confirmed' && <Badge variant="info">Booked</Badge>}
          {load.firm === 'dispatched' && <Badge variant="ok">Dispatched</Badge>}
          <span className="load-drops">
            {drops} {load.mode === 'fleet' ? 'drop' : 'order'}
            {drops === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <div className="load-reco">
        <span className="reco-label">
          {load.firm === 'confirmed' || load.firm === 'dispatched' ? 'Booked' : 'Recommended'}
        </span>
        <strong className="reco-value">
          {recommendation(load, settings)}
          {contractor && <span className="reco-contractor"> · with {contractor}</span>}
        </strong>
        <div className="load-volume">
          {load.fill !== null && load.capacityM3 ? (
            <>
              <span className="fill-track" aria-hidden>
                <span
                  className={`fill-bar tone-${fillTone(load.fill)}`}
                  style={{ width: `${Math.min(100, load.fill * 100)}%` }}
                />
              </span>
              <span>
                <b>{m3(load.volumeM3)}</b> of {m3(load.capacityM3)} · <b>{pct(load.fill)}</b> full
              </span>
            </>
          ) : (
            <span>
              <b>{m3(load.volumeM3)}</b>
            </span>
          )}
          {load.weightKg > 0 && (
            <span title={load.weightComplete ? 'From the cubics sheet' : 'Only the drops the cubics sheet weighs'}>
              <b>{Math.round(load.weightKg).toLocaleString('en-AU')} kg</b>
              {load.weightComplete ? '' : '+'}
            </span>
          )}
          <span title={`${dollarsFull(value)} — ${settings.shipmentValue === 'goods' ? 'goods value' : 'goods and freight'}, ReleaseVal`}>
            <b>{dollars(value)}</b>
          </span>
        </div>
        {load.levelled && (
          <p className="load-levelled">
            Brought forward from {weekdayOf(load.levelled.from)} {shortDay(load.levelled.from)} — that day is over
            its {LIMIT_LABEL[load.levelled.reason]}. The goods must be ready by this day.
          </p>
        )}
      </div>

      {ladder.length > 1 && (
        <ol className={`size-ladder${isEditing ? ' pickable' : ''}`} aria-label="Sizes this route can use">
          {ladder.map((o) => {
            const body = (
              <>
                <span className="rung-name">{o.name}</span>
                <span className="rung-cap">
                  {o.capacityM3 === null ? (o.name === PART_LOAD ? 'pallet freight' : 'part load') : `${o.capacityM3} m³`}
                </span>
                <span className="rung-fill">
                  {!o.fits ? 'too small' : o.fill === null ? (o.chosen ? 'chosen' : 'fits') : `${pct(o.fill)} full`}
                </span>
              </>
            );
            return (
              <li
                key={o.name}
                className={`${o.chosen ? 'chosen' : ''}${o.fits ? '' : ' too-small'}`}
                title={o.note || undefined}
              >
                {isEditing ? (
                  <button
                    type="button"
                    aria-pressed={o.chosen}
                    onClick={() => !o.chosen && resizeLoad(load, o.name, o.capacityM3)}
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ol>
      )}

      {isEditing && (
        <div className="edit-bar">
          <label>
            Dispatch day
            <input
              type="date"
              value={load.day}
              min={today}
              onChange={(e) => e.target.value >= today && redateLoad(load, e.target.value)}
            />
          </label>
          <span className="muted">
            Pick a size above, move orders below. Changes freeze this load; Reset to plan undoes them.
          </span>
        </div>
      )}

      {load.warnings.length > 0 && (
        <ul className="load-warnings">
          {load.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="table-scroll">
        <table className="summary-table drop-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Ship to</th>
              <th>Pick list</th>
              <th className="num">m³</th>
              <th>{dueLabel}</th>
              <th title="ExpDeliveryDt — the day the customer expects it">Deliver</th>
              <th>Goods</th>
              {isEditing && <th>Move to</th>}
            </tr>
          </thead>
          <tbody>
            {load.drops.map((d, i) => {
              const o = d.order;
              const due = o ? dueDate(o, deadline) : null;
              const late = due !== null && due < load.day;
              const afterDelivery = !!o?.expDelivery && o.expDelivery < load.day;
              return (
                <tr key={`${d.orderId}-${i}`}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpenOrder(d.orderId)}>
                      {d.orderId}
                    </button>
                    {d.piece && (
                      <span className="tag" title="Split across loads">
                        {d.piece.index}/{d.piece.of}
                      </span>
                    )}
                    {d.daysEarly > 0 && (
                      <span className="tag early" title={`Working days ahead of its last dispatch day`}>
                        +{d.daysEarly}d
                      </span>
                    )}
                  </td>
                  <td className="ship-cell" title={o ? fullAddress(o) || o.city : undefined}>
                    {o ? (
                      <>
                        <span className="ship-name">{o.shipToName || o.custId}</span>
                        <span className="ship-sub">
                          {o.city}
                          {o.shipToName && o.custId ? ` · ${o.custId}` : ''}
                        </span>
                      </>
                    ) : (
                      'Not in the waybill'
                    )}
                  </td>
                  <td className="pick-cell" title={o?.pickListComment || 'No pick-list comment'}>
                    {o?.pickListComment ? <span className="pick-note">{o.pickListComment}</span> : <span className="muted">—</span>}
                  </td>
                  <td className="num" title={VOLUME_SOURCE_LABEL[d.volumeSource]}>
                    {d.volumeKnown ? d.volumeM3.toFixed(2) : <span className="tone-bad">?</span>}
                    {SOURCE_MARK[d.volumeSource] && <sup className="src">{SOURCE_MARK[d.volumeSource]}</sup>}
                  </td>
                  <td className={late ? 'tone-bad' : undefined} title={late ? `Leaves after its ${dueLabel}` : undefined}>
                    {shortDay(due)}
                  </td>
                  <td
                    className={afterDelivery ? 'tone-bad' : undefined}
                    title={afterDelivery ? 'Leaves after the day the customer expects it' : undefined}
                  >
                    {shortDay(o?.expDelivery ?? null)}
                  </td>
                  <td>
                    {o && (
                      <Badge variant={READINESS[o.readiness].variant} title={READINESS[o.readiness].title}>
                        {READINESS[o.readiness].label}
                      </Badge>
                    )}
                    {o?.inPicking && <span className="tag">Picking</span>}
                    <BuildChip check={buildCheckOf(link, d.orderId, load.day)} />
                  </td>
                  {isEditing && (
                    <td>
                      <select
                        className="move-select"
                        value=""
                        aria-label={`Move order ${d.orderId}`}
                        onChange={(e) => move(d.orderId, e.target.value)}
                      >
                        <option value="">Keep here</option>
                        {drops > 1 && <option value={NEW}>Own {noun(load)}, same day</option>}
                        <option value={REPLAN}>Take off — let the plan place it</option>
                        {moveTo.length > 0 && (
                          <optgroup label="Onto another load">
                            {moveTo.map((t) => (
                              <option key={t.id} value={t.id}>
                                {weekdayOf(t.day)} {shortDay(t.day)} · {t.label} · {t.equipment} ·{' '}
                                {shipToNames(t)[0] ?? ''} · {t.volumeM3.toFixed(1)}
                                {t.capacityM3 ? `/${t.capacityM3}` : ''} m³
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="load-actions">
        {(load.firm === null || load.firm === 'edited') && (
          <button
            type="button"
            className="kpi-btn"
            onClick={() => confirmLoad(load)}
            title="Booked with the contractor: re-planning will no longer change it"
          >
            Mark booked
          </button>
        )}
        {load.firm === 'edited' && (
          <button
            type="button"
            className="kpi-btn"
            onClick={() => releaseLoad(load.id)}
            title="Drop the hand changes: the optimiser plans these orders again"
          >
            Reset to plan
          </button>
        )}
        {(load.firm === null || load.firm === 'edited') && load.day <= today && (
          <button
            type="button"
            className="kpi-btn primary"
            onClick={() => markDispatched(load)}
            title="It has left: log the shipment (for a load booked by phone and not marked booked)"
          >
            Mark dispatched
          </button>
        )}
        {load.firm === 'confirmed' && (
          <>
            <button type="button" className="kpi-btn primary" onClick={() => markDispatched(load)}>
              Mark dispatched
            </button>
            <button
              type="button"
              className="kpi-btn"
              onClick={() => releaseLoad(load.id)}
              title="Hand the orders back to the planner"
            >
              Release
            </button>
          </>
        )}
        {load.firm === 'dispatched' && (
          <button
            type="button"
            className="kpi-btn"
            onClick={() => releaseLoad(load.id)}
            title="Undo: the orders are planned again"
          >
            Undo dispatch
          </button>
        )}
      </footer>
    </article>
  );
}
