/**
 * Every order on the waybill: where it is routed, its window, and the day and
 * load the plan gave it. Clicking a row opens the order.
 */

import { useMemo, useState } from 'react';
import { DEADLINE_LABEL, DISPATCH_MODE_LABEL, VOLUME_SOURCE_LABEL, dueDate, type DispatchMode } from '@/domain/dispatch';
import { ORDER_FLAG_LABEL, type OrderFlag } from '@/engine/dispatch/plan';
import { Badge } from '@/ui';
import type { DispatchModel } from './useDispatchPlan';
import { EXCEPTION_FLAGS } from './ExceptionsList';
import { READINESS, money, shortDay } from './format';
import { SOURCE_MARK } from './LoadCard';
import { BuildChip, buildCheckOf, useAssemblyLink } from './assemblyLink';
import { orderKey } from '@/domain/orderLink';

type SortKey = 'due' | 'planned' | 'volume' | 'order';

const FLAG_SHORT: Partial<Record<OrderFlag, string>> = {
  overdue: 'Overdue',
  late: 'Late',
  'not-ready': 'Not ready',
  'credit-hold': 'Credit hold',
  'on-hold': 'On hold',
  held: 'Held',
  'no-volume': 'No m³',
  'no-date': 'No date',
  unrouted: 'Unrouted',
  split: 'Split',
  'pulled-forward': 'Early',
  pinned: 'Pinned',
  firm: 'Firm',
  'no-location': 'No map',
  'cube-partial': 'Cube partial',
};

/** The fields worth checking, in the order a planner reads an order. */
const COLUMN_LABEL = {
  order: 'Order',
  pickListComment: 'Pick-list comment (packed m³)',
  custId: 'Customer ID',
  shipToName: 'Ship-to name',
  shipVia: 'Ship Via',
  zone: 'Delivery zone',
  expDelivery: 'Customer receives',
  shipBy: 'Ship By',
  needBy: 'Need By (last ship day)',
  city: 'Ship-to city',
  address1: 'Ship-to address',
  state: 'State',
  postcode: 'Postcode',
  part: 'Part',
  leftToShip: 'Left to ship',
  status: 'Status',
} as const;

export function OrdersTable({
  model,
  onOpenOrder,
}: {
  model: DispatchModel;
  onOpenOrder: (id: string) => void;
}) {
  const { parsed, plan } = model;
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<DispatchMode | 'all' | 'none'>('all');
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [sort, setSort] = useState<SortKey>('due');
  const link = useAssemblyLink();

  const rows = useMemo(() => {
    if (!parsed || !plan) return [];
    const q = query.trim().toLowerCase();
    const list = model.orders
      .map((order) => ({ order, op: plan.orders.get(order.id)! }))
      .filter(({ order, op }) => {
        if (mode === 'none' ? op.route !== null : mode !== 'all' && op.route?.mode !== mode) return false;
        if (onlyExceptions && !op.flags.some((f) => EXCEPTION_FLAGS.includes(f))) return false;
        if (!q) return true;
        return [order.id, order.custId, order.shipToName, order.city, order.zone, order.shipVia]
          .some((v) => v.toLowerCase().includes(q));
      });
    const key = (r: (typeof list)[number]): string | number => {
      switch (sort) {
        case 'due':
          return dueDate(r.order, plan.deadline) ?? '9999';
        case 'planned':
          return r.op.day ?? '9999';
        case 'volume':
          return -r.op.volumeM3;
        case 'order':
          return r.order.id;
      }
    };
    return list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : a.order.id.localeCompare(b.order.id);
    });
  }, [parsed, plan, model.orders, query, mode, onlyExceptions, sort]);

  const head = (label: string, key?: SortKey, className?: string) => (
    <th className={className}>
      {key ? (
        <button className={`th-sort${sort === key ? ' active' : ''}`} onClick={() => setSort(key)}>
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <div className="orders-view">
      <div className="load-filters">
        <input
          className="search"
          type="search"
          placeholder="Order, ship-to, customer, city, zone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="all">All routes</option>
          {(Object.keys(DISPATCH_MODE_LABEL) as DispatchMode[]).map((m) => (
            <option key={m} value={m}>
              {DISPATCH_MODE_LABEL[m]}
            </option>
          ))}
          <option value="none">Not routed</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyExceptions}
            onChange={(e) => setOnlyExceptions(e.target.checked)}
          />
          Exceptions only
        </label>
        <span className="muted-note">{rows.length} orders</span>
      </div>
      {link.loaded && parsed && <AssemblyCoverage model={model} />}
      {parsed && (
        <details className="columns-used">
          <summary>Waybill columns read</summary>
          <p>
            Check these against the export: the plan reads each field from the column shown.
            Fields not listed are not in the file.
          </p>
          <ul>
            {Object.entries(COLUMN_LABEL).map(([field, label]) => {
              const c = parsed.columns[field as keyof typeof parsed.columns];
              return (
                <li key={field} className={c ? undefined : 'muted'}>
                  <b>{label}</b> {c ? `← ${c.header} (column ${c.column})` : '— not in the file'}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <div className="table-scroll">
        <table className="summary-table orders-table">
          <thead>
            <tr>
              {head('Order', 'order')}
              <th>Ship to</th>
              <th>Zone · City</th>
              <th>Route</th>
              {head('m³', 'volume', 'num')}
              <th>Pick list</th>
              <th className="num">Value</th>
              {head(plan ? DEADLINE_LABEL[plan.deadline] : 'Need By', 'due')}
              <th title="ExpDeliveryDt">Deliver</th>
              <th>Ship By</th>
              <th>Goods</th>
              {link.loaded && <th title="When the Assembly board expects the order off the line">Assembly</th>}
              {head('Planned', 'planned')}
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ order, op }) => (
              <tr key={order.id} onClick={() => onOpenOrder(order.id)} className="clickable">
                <td className="mono">{order.id}</td>
                <td className="ellipsis" title={order.custId}>
                  {order.shipToName || order.custId}
                </td>
                <td className="ellipsis" title={`${order.zone} · ${order.city}`}>
                  {order.zone} · {order.city}
                </td>
                <td className="ellipsis">{op.route?.label ?? '—'}</td>
                <td className="num" title={VOLUME_SOURCE_LABEL[op.volumeSource]}>
                  {op.volumeKnown ? op.volumeM3.toFixed(2) : '?'}
                  {SOURCE_MARK[op.volumeSource] && <sup className="src">{SOURCE_MARK[op.volumeSource]}</sup>}
                </td>
                <td className="ellipsis" title={order.pickListComment}>
                  {order.pickListComment || <span className="muted">—</span>}
                </td>
                <td className="num">{money(order.value)}</td>
                <td>{shortDay(plan ? dueDate(order, plan.deadline) : order.needBy)}</td>
                <td>{shortDay(order.expDelivery)}</td>
                <td className="muted">{shortDay(order.shipBy)}</td>
                <td>
                  <Badge variant={READINESS[order.readiness].variant}>{READINESS[order.readiness].label}</Badge>
                </td>
                {link.loaded && (
                  <td>
                    <BuildChip check={op.day ? buildCheckOf(link, order.id, op.day) : null} />
                  </td>
                )}
                <td>{shortDay(op.day)}</td>
                <td className="flags">
                  {op.flags.map((f) => (
                    <span
                      key={f}
                      className={`flag${EXCEPTION_FLAGS.includes(f) ? ' bad' : ''}`}
                      title={ORDER_FLAG_LABEL[f]}
                    >
                      {FLAG_SHORT[f] ?? f}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Did the link land? Of the waybill orders with goods built to order
 * (`FulfillmentMethod` Job), how many the Assembly board has a job for —
 * matched on the job number, `0` + the order number. None found usually
 * means the board is showing another export (or the demo data).
 */
function AssemblyCoverage({ model }: { model: DispatchModel }) {
  const link = useAssemblyLink();
  const jobOrders = [...model.linesByOrder.entries()]
    .filter(([, lines]) => lines.some((l) => l.fulfillment.trim().toLowerCase() === 'job'))
    .map(([id]) => id);
  const found = jobOrders.filter((id) => link.builds.has(orderKey(id)));
  const missing = jobOrders.filter((id) => !link.builds.has(orderKey(id)));
  return (
    <details className="columns-used">
      <summary>
        Assembly link: {found.length} of {jobOrders.length} built-to-order orders found on the Assembly board
      </summary>
      <p>
        An Assembly job is matched to its sales order by its number: <code>018140-1-1</code> builds order{' '}
        <code>18140</code>, line 1, release 1. Orders whose waybill lines are all stock or freight are not
        expected on the board.
      </p>
      {missing.length > 0 && (
        <p className="muted">
          Not on the board: {missing.slice(0, 40).join(', ')}
          {missing.length > 40 && ` +${missing.length - 40} more`}
        </p>
      )}
    </details>
  );
}
