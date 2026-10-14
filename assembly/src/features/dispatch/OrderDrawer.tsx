/**
 * One order in full: its window and where the plan put it, the Assembly jobs
 * building it, the planner's three levers (pin a day, hold it back, correct
 * its cube), and its lines.
 */

import { useEffect, useState } from 'react';
import { DISPATCH_MODE_LABEL, VOLUME_SOURCE_LABEL, dueDate } from '@/domain/dispatch';
import { fullAddress } from './booking';
import { ORDER_FLAG_LABEL } from '@/engine/dispatch/plan';
import { useDispatchStore } from '@/store/dispatchStore';
import { Badge, Button } from '@/ui';
import type { DispatchModel } from './useDispatchPlan';
import { READINESS, dayLabel, m3, money } from './format';
import { BuildChip, buildCheckOf, useAssemblyLink } from './assemblyLink';
import { formatShortDay, formatTime, toDayKey } from '@/lib/time';

export function OrderDrawer({
  orderId,
  model,
  onClose,
}: {
  orderId: string;
  model: DispatchModel;
  onClose: () => void;
}) {
  const order = model.ordersById.get(orderId);
  const op = model.plan?.orders.get(orderId);
  const lines = model.linesByOrder.get(orderId) ?? [];
  const decisions = useDispatchStore((s) => s.decisions);
  const pin = useDispatchStore((s) => s.pin);
  const hold = useDispatchStore((s) => s.hold);
  const setVolume = useDispatchStore((s) => s.setVolume);

  const [pinDay, setPinDay] = useState(decisions.pins[orderId] ?? '');
  const [holdReason, setHoldReason] = useState('');
  const override = decisions.volumeOverrides[orderId];
  const [volume, setVolumeText] = useState(override !== undefined ? String(override) : '');
  const held = decisions.holds[orderId];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!order || !op) return null;
  const firm = op.flags.includes('firm');

  return (
    <aside className="order-drawer" role="dialog" aria-label={`Order ${orderId}`}>
      <header>
        <h2>Order {order.id}</h2>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <dl className="order-facts">
        <dt>Ship to</dt>
        <dd>
          <strong>{order.shipToName || '—'}</strong>
          {fullAddress(order) && <div>{fullAddress(order)}</div>}
        </dd>
        <dt>Customer</dt>
        <dd>{order.custId}</dd>
        <dt>Zone · City</dt>
        <dd>
          {order.zone} · {order.city}
        </dd>
        <dt>Ship Via</dt>
        <dd>{order.shipVia}</dd>
        <dt>Route</dt>
        <dd>{op.route ? `${DISPATCH_MODE_LABEL[op.route.mode]} — ${op.route.label}` : 'Not routed'}</dd>
        <dt>Volume</dt>
        <dd>
          <strong>{op.volumeKnown ? m3(op.volumeM3) : 'Unknown'}</strong> · {VOLUME_SOURCE_LABEL[op.volumeSource]}
        </dd>
        <dt>Pick list</dt>
        <dd>
          {order.pickListComment || '—'}
          {order.packedM3 !== null && ` · packed ${m3(order.packedM3)}`}
        </dd>
        <dt>Freight line</dt>
        <dd>{order.volumeM3 === null ? '—' : m3(order.volumeM3)}</dd>
        <dt>Cubics sheet</dt>
        <dd>
          {order.cube
            ? `${m3(order.cube.volumeM3)} · ${order.cube.matchedLines}/${order.cube.goodsLines} lines covered`
            : model.cubics
              ? 'No goods lines'
              : 'Not loaded'}
        </dd>
        {op.weightKg !== null && (
          <>
            <dt>Weight</dt>
            <dd>{Math.round(op.weightKg).toLocaleString('en-AU')} kg</dd>
          </>
        )}
        <dt>Value</dt>
        <dd>{money(order.value)}</dd>
        <dt>Goods</dt>
        <dd>
          <Badge variant={READINESS[order.readiness].variant}>{READINESS[order.readiness].label}</Badge>{' '}
          {order.readyLines}/{order.goodsLines} lines ready{order.inPicking ? ' · in picking' : ''}
        </dd>
        <dt>Need By</dt>
        <dd>{dayLabel(order.needBy)} · last ship day</dd>
        <dt>Customer receives</dt>
        <dd>{dayLabel(order.expDelivery)} · ExpDeliveryDt</dd>
        <dt>Ship By</dt>
        <dd>{dayLabel(order.shipBy)}</dd>
        <dt>Window</dt>
        <dd>
          {op.earliest ? `${dayLabel(op.earliest)} → ${dayLabel(op.latest)}` : '—'}
        </dd>
        <dt>Planned</dt>
        <dd>
          {dayLabel(op.day)}
          {op.loadIds.length > 1 && ` · ${op.loadIds.length} loads`}
        </dd>
      </dl>

      <AssemblySection orderId={order.id} day={op.day} due={dueDate(order, model.plan!.deadline)} />

      {op.flags.length > 0 && (
        <ul className="order-flags">
          {op.flags.map((f) => (
            <li key={f}>{ORDER_FLAG_LABEL[f]}</li>
          ))}
        </ul>
      )}
      {order.notes.length > 0 && (
        <ul className="order-flags notes">
          {order.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <section className="order-actions">
        <h3>Planner actions</h3>
        {firm && (
          <p className="muted-note">
            On an edited or confirmed load — move it with Edit loads, or reset the load to change it here.
          </p>
        )}
        <div className="action-row">
          <label htmlFor="pin-day">Pin to day</label>
          <input
            id="pin-day"
            type="date"
            value={pinDay}
            min={model.plan?.today}
            disabled={firm}
            onChange={(e) => setPinDay(e.target.value)}
          />
          <Button disabled={firm || !pinDay} onClick={() => pin(orderId, pinDay)}>
            Pin
          </Button>
          {decisions.pins[orderId] && (
            <Button
              disabled={firm}
              onClick={() => {
                pin(orderId, null);
                setPinDay('');
              }}
            >
              Unpin
            </Button>
          )}
        </div>
        <div className="action-row">
          <label htmlFor="volume">Volume m³</label>
          <input
            id="volume"
            type="number"
            min={0}
            step={0.1}
            value={volume}
            placeholder={order.volumeM3 === null ? 'unknown' : String(order.volumeM3)}
            disabled={firm}
            onChange={(e) => setVolumeText(e.target.value)}
          />
          <Button
            disabled={firm || volume.trim() === '' || !(Number(volume) >= 0)}
            onClick={() => setVolume(orderId, Number(volume))}
          >
            Save
          </Button>
          {override !== undefined && (
            <Button
              disabled={firm}
              onClick={() => {
                setVolume(orderId, null);
                setVolumeText('');
              }}
            >
              Use export
            </Button>
          )}
        </div>
        <div className="action-row">
          {held !== undefined ? (
            <>
              <span>Held{held ? `: ${held}` : ''}</span>
              <Button onClick={() => hold(orderId, null)}>Release hold</Button>
            </>
          ) : (
            <>
              <label htmlFor="hold">Hold back</label>
              <input
                id="hold"
                type="text"
                placeholder="Reason (optional)"
                value={holdReason}
                disabled={firm}
                onChange={(e) => setHoldReason(e.target.value)}
              />
              <Button disabled={firm} onClick={() => hold(orderId, holdReason.trim())}>
                Hold
              </Button>
            </>
          )}
        </div>
      </section>

      {order.cube && order.cube.unmatched.length > 0 && (
        <section>
          <h3>Parts missing from the cubics sheet</h3>
          <p className="muted-note">
            Add these codes to the sheet to size the order from it; until then the
            freight line is used where there is one.
          </p>
          <ul className="plain-list mono">
            {order.cube.unmatched.map((u) => (
              <li key={u.part}>
                {u.part} × {u.qty}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Lines</h3>
        <div className="table-scroll">
          <table className="lines-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Part</th>
                <th className="num">Left</th>
                <th className="num">Alloc</th>
                <th>UOM</th>
                <th>Method</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={`${l.line}-${l.rel}`}>
                  <td>
                    {l.line}/{l.rel}
                  </td>
                  <td className="mono">{l.part}</td>
                  <td className="num">{l.leftToShip}</td>
                  <td className="num">{l.allocatedQty}</td>
                  <td>{l.uom}</td>
                  <td>{l.fulfillment}</td>
                  <td>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  );
}

/**
 * The Assembly jobs building this order, from the board: which line, how
 * many still to build, and when the board expects them off it — against the
 * day the order is planned to leave and its due date.
 */
function AssemblySection({ orderId, day, due }: { orderId: string; day: string | null; due: string | null }) {
  const link = useAssemblyLink();
  if (!link.loaded) return null;
  const check = buildCheckOf(link, orderId, day ?? due ?? '9999-12-31');
  if (!check) {
    return (
      <section className="order-assembly">
        <h3>Assembly</h3>
        <p className="muted-note">No job on the Assembly board is built for this order (stock goods, or not in Planning1).</p>
      </section>
    );
  }
  const finishAfterDue = check.finish !== null && due !== null && check.finish > due;
  return (
    <section className="order-assembly">
      <h3>
        Assembly <BuildChip check={day ? check : null} />
      </h3>
      <p className="muted-note">
        {check.verdict === 'done'
          ? 'Every job is finished.'
          : check.verdict === 'unknown'
            ? 'A job still to build has no Expect Date: put it on a line and crew it on the Assembly board.'
            : `Off the line ${dayLabel(check.finish)}${day ? `; planned to leave ${dayLabel(day)}` : ''}.`}
        {finishAfterDue && ` That is after its due date (${dayLabel(due)}): it will miss SIFOT unless Assembly brings it forward.`}
      </p>
      <table className="summary-table assembly-jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Line</th>
            <th className="num">To build</th>
            <th>Start</th>
            <th>Expect</th>
          </tr>
        </thead>
        <tbody>
          {check.jobs.map((j) => (
            <tr key={j.jobId}>
              <td className="mono" title={`${j.partNum} · ${j.description}`}>
                {j.jobId}
              </td>
              <td>{j.lineName ?? <span className="muted">no line</span>}</td>
              <td className="num">{j.state === 'done' ? 'done' : j.remainingQty}</td>
              <td>{j.start ? formatShortDay(j.start) : '—'}</td>
              <td className={j.expect && day && toDayKey(j.expect) > day ? 'tone-bad' : undefined}>
                {j.expect ? `${formatShortDay(j.expect)} ${formatTime(j.expect)}` : j.state === 'done' ? '—' : 'no date'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
