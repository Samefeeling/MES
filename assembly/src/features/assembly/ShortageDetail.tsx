/**
 * The Short material figure's panel: every part the orders in view are short
 * of, the orders short of it, and what is on order to cover them.
 *
 * Pressing an order opens its detail, where its pick list shows the same
 * figures line by line.
 */

import { formatDay, formatShortDay } from '@/lib/time';
import { useUiStore } from '@/store/uiStore';
import { MetricNote } from './Metric';
import type { ShortageReport, ShortOrder } from './shortageReport';

const orderTitle = (o: ShortOrder): string =>
  `${o.orderNum} on ${o.line} · short ${o.shortQty}` +
  (o.dueDate ? ` · due ${formatDay(o.dueDate)}` : ' · no Due Date') +
  (!o.covered
    ? o.availableDate
      ? `\nPart of it on order, the last of that by ${formatDay(o.availableDate)} — not enough to cover it`
      : '\nNothing left on order covers it'
    : o.availableDate
      ? `\nCovered by ${formatDay(o.availableDate)}` +
        (o.late ? ' — after its Due Date' : '')
      : '\nOn order, with no date');

export function ShortageDetail({
  report,
  onDone,
}: {
  report: ShortageReport;
  onDone: () => void;
}) {
  const select = useUiStore((s) => s.select);
  if (report.parts.length === 0) {
    return <MetricNote>No order in view is short of any pick-list part.</MetricNote>;
  }
  return (
    <div className="shortage-report">
      <MetricNote>
        {report.orders} {report.orders === 1 ? 'order' : 'orders'} in view short of material
        {report.uncoveredOrders > 0 && ` · ${report.uncoveredOrders} with nothing on order to cover it`}
        {report.lateOrders > 0 && ` · ${report.lateOrders} cannot have it all by the Due Date`}
        . Stock and purchase orders are shared out most urgent order first.
      </MetricNote>
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th className="num">Short</th>
            <th className="num" title="Calculated_OutstandingQty on PODetail.csv, every open release">
              On order
            </th>
            <th title="The latest an order in the list waits for the part">Available</th>
          </tr>
        </thead>
        <tbody>
          {report.parts.map((p, i) => [
            // Bought-in parts first, under their own heading, then those
            // made here — a supplier can be chased; our own orders are the
            // board's schedule.
            (i === 0 || report.parts[i - 1].purchased !== p.purchased) && (
              <tr key={`group-${String(p.purchased)}`} className="short-group">
                <th colSpan={4}>
                  {p.purchased ? 'Purchased' : 'Made in-house'}
                  <span>
                    {report.parts.filter((q) => q.purchased === p.purchased).length} parts
                  </span>
                </th>
              </tr>
            ),
            <tr key={p.part} className={p.uncovered > 0 ? 'uncovered' : undefined}>
              <td>
                <span className="short-part">{p.part}</span>
                {p.description && <span className="short-desc">{p.description}</span>}
                <span className="short-orders">
                  {p.orders.map((o) => (
                    <button
                      key={o.orderNum}
                      type="button"
                      className={`short-order${o.late ? ' late' : ''}`}
                      title={orderTitle(o)}
                      onClick={(e) => {
                        select(o.rowId, { x: e.clientX, y: e.clientY });
                        onDone();
                      }}
                    >
                      {o.orderNum}
                      <i>×{o.shortQty}</i>
                    </button>
                  ))}
                </span>
              </td>
              <td className="num">{p.shortQty}</td>
              <td className="num">{p.onOrder || '—'}</td>
              <td className={p.uncovered > 0 ? 'late' : undefined}>
                {p.lastArrival ? formatShortDay(p.lastArrival) : '—'}
                {p.uncovered > 0 && (
                  <span className="short-warn" title={`${p.uncovered} ${p.uncovered === 1 ? 'order' : 'orders'} not covered by any purchase order`}>
                    {' '}⚠ {p.uncovered}
                  </span>
                )}
              </td>
            </tr>,
          ])}
        </tbody>
      </table>
    </div>
  );
}
