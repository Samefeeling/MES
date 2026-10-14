/**
 * One order in full, as a side panel over the page: who and where it goes,
 * its dates against where the plan put it, what needs attention, the Assembly
 * jobs building it, where the goods for its stock and bought-in lines are
 * coming from, the planner's three levers (pin a day, hold it back, correct
 * its cube), and its lines — each saying where its goods are.
 *
 * It closes with ×, Escape, or a click anywhere outside it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DISPATCH_MODE_LABEL, VOLUME_SOURCE_LABEL, dueDate } from '@/domain/dispatch';
import { fullAddress } from './booking';
import { ORDER_FLAG_LABEL, type OrderFlag } from '@/engine/dispatch/plan';
import { useDispatchStore } from '@/store/dispatchStore';
import { Badge, Button } from '@/ui';
import type { DispatchModel } from './useDispatchPlan';
import { READINESS, dayLabel, dollarsFull, m3, shortDay, weekdayOf } from './format';
import {
  BuildChip,
  SupplyChip,
  buildCheckOf,
  lineSupplyText,
  supplyCheckOf,
  useAssemblyLink,
  type AssemblyLink,
} from './assemblyLink';
import type { WaybillLine } from '@/domain/dispatch';
import { lineKey, orderKey } from '@/domain/orderLink';
import { isGoodsLine, isLineReady } from '@/data/csv/waybill.parser';
import { formatShortDay, formatTime, toDayKey } from '@/lib/time';

/** Flags that say what the planner did, shown as badges by the title; the rest need attention. */
const STATUS_FLAGS: readonly OrderFlag[] = ['held', 'pinned', 'firm', 'split', 'pulled-forward'];
const STATUS_BADGE: Partial<Record<OrderFlag, { label: string; variant: 'warn' | 'info' | 'neutral' }>> = {
  held: { label: 'Held', variant: 'warn' },
  pinned: { label: 'Pinned', variant: 'info' },
  firm: { label: 'On a fixed load', variant: 'info' },
  split: { label: 'Split', variant: 'neutral' },
  'pulled-forward': { label: 'Pulled forward', variant: 'neutral' },
};

/** `Thu 15/10`: the weekday matters to a dock, the year does not. */
const tileDay = (day: string | null): string => (day ? `${weekdayOf(day)} ${shortDay(day)}` : '—');

function DateTile({ label, day, note, tone }: { label: string; day: string | null; note: string; tone?: 'bad' }) {
  return (
    <div className={`od-date${tone ? ` tone-${tone}` : ''}`}>
      <span className="od-date-label">{label}</span>
      <strong title={dayLabel(day)}>{tileDay(day)}</strong>
      <span className="od-date-note">{note}</span>
    </div>
  );
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`od-fact${wide ? ' wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

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
  const link = useAssemblyLink();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keyboard and screen reader land in the panel, not behind it.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  if (!order || !op) return null;
  const firm = op.flags.includes('firm');
  const due = dueDate(order, model.plan!.deadline);
  const attention = op.flags.filter((f) => !STATUS_FLAGS.includes(f));
  const leavesLate = op.day !== null && due !== null && op.day > due;
  const address = fullAddress(order);

  return (
    <>
      <div className="od-backdrop" aria-hidden onMouseDown={onClose} />
      <aside
        ref={panel}
        className="order-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${orderId}`}
        tabIndex={-1}
      >
        <header className="od-head">
          <div className="od-title">
            <span className="od-kicker">Order</span>
            <h2>{order.id}</h2>
            <div className="od-badges">
              <Badge variant={READINESS[order.readiness].variant} title={READINESS[order.readiness].title}>
                {READINESS[order.readiness].label}
              </Badge>
              {op.flags
                .filter((f) => STATUS_BADGE[f])
                .map((f) => (
                  <Badge key={f} variant={STATUS_BADGE[f]!.variant} title={ORDER_FLAG_LABEL[f]}>
                    {f === 'held' && held ? `Held: ${held}` : STATUS_BADGE[f]!.label}
                  </Badge>
                ))}
            </div>
          </div>
          <button type="button" className="od-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
          <p className="od-sub">
            <strong>{order.shipToName || order.custId || '—'}</strong>
            {order.city && <span> · {order.city}</span>}
            {order.custId && order.shipToName && <span className="muted"> · {order.custId}</span>}
          </p>
        </header>

        <div className="od-body">
          <div className="od-dates">
            <DateTile label="Ship By" day={order.shipBy} note="last day to leave" />
            <DateTile label="Need By" day={order.needBy} note="customer's date" />
            <DateTile label="Delivers" day={order.expDelivery} note="ExpDeliveryDt" />
            <DateTile
              label="Planned"
              day={op.day}
              tone={leavesLate || op.day === null ? 'bad' : undefined}
              note={
                op.day === null
                  ? 'not on a load'
                  : leavesLate
                    ? `after its ${model.plan!.deadline === 'shipBy' ? 'Ship By' : 'Need By'}`
                    : op.loadIds.length > 1
                      ? `${op.loadIds.length} loads`
                      : op.earliest
                        ? `window ${shortDay(op.earliest)}–${shortDay(op.latest)}`
                        : 'dispatch day'
              }
            />
          </div>

          {(attention.length > 0 || order.notes.length > 0) && (
            <div className="od-attention" role="note">
              <h3>Needs attention</h3>
              <ul>
                {attention.map((f) => (
                  <li key={f}>{ORDER_FLAG_LABEL[f]}</li>
                ))}
                {order.notes.map((n) => (
                  <li key={n} className="note">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <section className="od-card">
            <h3>Delivery</h3>
            <dl className="od-facts">
              <Fact label="Ship to" wide>
                <strong>{order.shipToName || '—'}</strong>
                {address && <span className="od-address">{address}</span>}
              </Fact>
              <Fact label="Customer">{order.custId || '—'}</Fact>
              <Fact label="Ship Via">{order.shipVia || '—'}</Fact>
              <Fact label="Zone">{order.zone || '—'}</Fact>
              <Fact label="City">{order.city || '—'}</Fact>
              <Fact label="Route" wide>
                {op.route ? (
                  <>
                    {DISPATCH_MODE_LABEL[op.route.mode]} <span className="muted">· {op.route.label}</span>
                  </>
                ) : (
                  <span className="tone-bad">Not routed</span>
                )}
              </Fact>
            </dl>
          </section>

          <section className="od-card">
            <h3>Size and value</h3>
            <dl className="od-facts">
              <Fact label="Volume">
                <strong className="od-figure">{op.volumeKnown ? m3(op.volumeM3) : 'Unknown'}</strong>
                <span className="od-hint">{VOLUME_SOURCE_LABEL[op.volumeSource]}</span>
              </Fact>
              <Fact label="Value">
                <strong className="od-figure">{dollarsFull(order.value)}</strong>
                <span className="od-hint">ReleaseVal</span>
              </Fact>
              <Fact label="Freight line">{order.volumeM3 === null ? '—' : m3(order.volumeM3)}</Fact>
              <Fact label="Packed">
                {order.packedM3 !== null ? m3(order.packedM3) : '—'}
                {order.pickListComment && <span className="od-hint">“{order.pickListComment}”</span>}
              </Fact>
              <Fact label="Cubics.csv">
                {order.cube
                  ? `${m3(order.cube.volumeM3)} · ${order.cube.matchedLines}/${order.cube.goodsLines} lines`
                  : model.cubics
                    ? 'No goods lines'
                    : 'Not loaded'}
              </Fact>
              <Fact label="Weight">{op.weightKg !== null ? `${Math.round(op.weightKg).toLocaleString('en-AU')} kg` : '—'}</Fact>
              <Fact label="Goods lines" wide>
                {order.readyLines}/{order.goodsLines} ready{order.inPicking ? ' · in picking' : ''}
              </Fact>
            </dl>
            {order.cube && order.cube.unmatched.length > 0 && (
              <p className="od-hint block">
                Not on the cubics sheet:{' '}
                <span className="mono">{order.cube.unmatched.map((u) => `${u.part} × ${u.qty}`).join(', ')}</span>. Add
                them to size the order from the sheet; until then the freight line is used.
              </p>
            )}
          </section>

          <AssemblySection orderId={order.id} day={op.day} due={due} />
          <GoodsSection orderId={order.id} day={op.day} due={due} />

          <section className="od-card od-actions">
            <h3>Planner actions</h3>
            {firm && (
              <p className="od-hint block">
                On an edited or booked load — move it with Edit loads, or reset the load to change it here.
              </p>
            )}
            <div className="od-form">
              <label htmlFor="pin-day">Pin to day</label>
              <input
                id="pin-day"
                type="date"
                value={pinDay}
                min={model.plan?.today}
                disabled={firm}
                onChange={(e) => setPinDay(e.target.value)}
              />
              <div className="od-buttons">
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
              <div className="od-buttons">
                <Button
                  disabled={firm || volume.trim() === '' || !(Number(volume) >= 0)}
                  onClick={() => setVolume(orderId, Number(volume))}
                >
                  Set
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

              {held !== undefined ? (
                <>
                  <span className="od-form-label">Hold back</span>
                  <span className="od-held">Held{held ? `: ${held}` : ''}</span>
                  <div className="od-buttons">
                    <Button onClick={() => hold(orderId, null)}>Release hold</Button>
                  </div>
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
                  <div className="od-buttons">
                    <Button disabled={firm} onClick={() => hold(orderId, holdReason.trim())}>
                      Hold
                    </Button>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="od-card">
            <h3>
              Lines <span className="od-count">{lines.length}</span>
            </h3>
            <div className="table-scroll">
              <table className="lines-table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Part</th>
                    <th className="num">Left</th>
                    <th className="num">Alloc</th>
                    <th>Method</th>
                    <th>Goods</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const goods = goodsFrom(link, orderId, l);
                    return (
                      <tr key={`${l.line}-${l.rel}`} className={isGoodsLine(l) ? undefined : 'non-goods'}>
                        <td className="nowrap">
                          {l.line}/{l.rel}
                        </td>
                        <td className="mono nowrap">{l.part}</td>
                        <td className="num">
                          {l.leftToShip.toLocaleString('en-AU')} <span className="uom">{l.uom}</span>
                        </td>
                        <td className="num">{l.allocatedQty.toLocaleString('en-AU')}</td>
                        <td>
                          <span className="nowrap">{l.fulfillment || '—'}</span>
                          {l.status && <span className="cell-sub nowrap">{l.status}</span>}
                        </td>
                        <td>
                          <span className={`nowrap${goods.tone ? ` tone-${goods.tone}` : ''}`}>{goods.text}</span>
                          {goods.sub && (
                            <span className={`cell-sub nowrap${goods.subTone ? ` tone-${goods.subTone}` : ''}`}>
                              {goods.sub}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </aside>
    </>
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
      <section className="od-card order-assembly">
        <h3>Assembly</h3>
        <p className="muted-note">No job on the Assembly board is built for this order (stock goods, or not in Planning1).</p>
      </section>
    );
  }
  const finishAfterDue = check.finish !== null && due !== null && check.finish > due;
  return (
    <section className="od-card order-assembly">
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
              <td
                className={
                  j.expect && day && toDayKey(j.expect) > day
                    ? 'tone-bad'
                    : !j.expect && j.state !== 'done'
                      ? 'tone-mid'
                      : undefined
                }
              >
                {j.expect ? `${formatShortDay(j.expect)} ${formatTime(j.expect)}` : j.state === 'done' ? '—' : 'no date'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One line's goods, in two parts: what covers it, and when. */
interface GoodsText {
  text: string;
  sub?: string;
  tone?: 'good' | 'bad';
  subTone?: 'good' | 'bad' | 'mid';
}

/**
 * Where one line's goods are: allocated, the job building it, or the stock,
 * PO or stock job it was credited (see `lineSupply`).
 */
function goodsFrom(link: AssemblyLink, orderId: string, l: WaybillLine): GoodsText {
  if (!isGoodsLine(l)) return { text: '—' };
  if (isLineReady(l)) return { text: 'Allocated', tone: 'good' };
  const key = orderKey(orderId);
  if (l.fulfillment.trim().toLowerCase() === 'job') {
    const job = link.builds
      .get(key)
      ?.jobs.find((j) => j.orderLine === lineKey(l.line) && (j.rel === null || j.rel === lineKey(l.rel)));
    if (!job) return { text: link.loaded ? 'No job on the board' : '—', tone: link.loaded ? 'bad' : undefined };
    if (job.state === 'done') return { text: `Job ${job.jobId}`, sub: 'done', subTone: 'good' };
    return job.expect
      ? { text: `Job ${job.jobId}`, sub: `expect ${formatShortDay(job.expect)}` }
      : { text: `Job ${job.jobId}`, sub: 'no date', subTone: 'mid' };
  }
  const supply = link.supply.get(key)?.find((x) => x.line === lineKey(l.line) && x.rel === lineKey(l.rel));
  if (supply) return { text: lineSupplyText(supply) || '—' };
  return link.stockRead.inventory ? { text: '—' } : { text: 'OnHandInventory.csv not read', tone: 'bad' };
}

/**
 * The stock and bought-in lines still short of goods, and when what covers
 * them is in: free stock, open PO releases, stock jobs on the board — shared
 * out by part, first due first served, because neither export says which
 * order a quantity is for.
 */
function GoodsSection({ orderId, day, due }: { orderId: string; day: string | null; due: string | null }) {
  const link = useAssemblyLink();
  if (!link.stockRead.inventory) return null;
  const check = supplyCheckOf(link, orderId, day ?? due ?? '9999-12-31');
  if (!check) return null;
  const afterDue = check.readyBy !== null && due !== null && check.readyBy > due;
  return (
    <section className="od-card order-assembly">
      <h3>
        Stock and bought-in goods <SupplyChip check={day ? check : null} />
      </h3>
      <p className="muted-note">
        {check.verdict === 'unknown'
          ? 'A line short of goods has no stock, open PO or stock job to cover it, or its PO has no date.'
          : `All in by ${dayLabel(check.readyBy)}${day ? `; planned to leave ${dayLabel(day)}` : ''}.`}
        {afterDue && ` That is after its due date (${dayLabel(due)}).`}
        {!link.stockRead.po && ' PODetail.csv was not read, so no purchase order is counted.'}
        {' '}An estimate: stock and POs carry no order number, so they go to the line due first.
      </p>
      <table className="summary-table assembly-jobs">
        <thead>
          <tr>
            <th>Line</th>
            <th>Part</th>
            <th className="num">Short</th>
            <th>From</th>
            <th>In by</th>
          </tr>
        </thead>
        <tbody>
          {check.lines.map((l) => (
            <tr key={`${l.line}-${l.rel}`}>
              <td>
                {l.line}/{l.rel}
              </td>
              <td className="mono">{l.part}</td>
              <td className="num">{l.shortQty}</td>
              <td>{lineSupplyText(l)}</td>
              <td className={l.readyBy === null || (day && l.readyBy > day) ? 'tone-bad' : undefined}>
                {l.readyBy ? dayLabel(l.readyBy) : 'no date'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
