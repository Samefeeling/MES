/**
 * What someone has to act on: orders kept off every load, and orders on a
 * load that will not make their date or cannot be sized. Grouped by the
 * action each needs, worst first.
 */

import { DEADLINE_LABEL, dueDate } from '@/domain/dispatch';
import { ORDER_FLAG_LABEL, type OrderFlag } from '@/engine/dispatch/plan';
import type { DispatchModel } from './useDispatchPlan';
import { m3, shortDay } from './format';

/** Flags that are a problem, in the order they are worked. */
export const EXCEPTION_FLAGS: readonly OrderFlag[] = [
  'credit-hold',
  'on-hold',
  'unrouted',
  'no-date',
  'overdue',
  'late',
  'not-ready',
  'no-volume',
  'held',
];

/** Worth knowing but not a problem on its own. */
const NOTICE_FLAGS: readonly OrderFlag[] = ['cube-partial', 'no-location'];

const ACTION: Partial<Record<OrderFlag, string>> = {
  'credit-hold': 'Ask accounts to release, or hold the order',
  'on-hold': 'Order is on hold in Epicor',
  unrouted: 'Add the zone to an NSW run class, hub or export prefix in Settings',
  'no-date': 'Pin a dispatch day on the order',
  overdue: 'Planned on the first open day — confirm the customer can take it',
  late: 'No departure before its due date — pin a day or book a dedicated run',
  'not-ready': 'Chase production or move the order out',
  'no-volume': 'Enter the cube on the order; it is planned as 0 m³ until then',
  held: 'Release when the customer is ready',
  'no-location': 'Add the city to dispatchLocations.ts to group it by distance',
  'cube-partial': 'Sized from the freight line, or from the parts the sheet covers — see the parts list below',
};

export function ExceptionsList({
  model,
  onOpenOrder,
}: {
  model: DispatchModel;
  onOpenOrder: (id: string) => void;
}) {
  const { plan, ordersById, parsed, orders, cubics } = model;
  if (!plan) return null;

  // Every part the cubics sheet is missing, with how many open orders and
  // units it holds up: the list to add to the sheet, biggest first.
  const missing = new Map<string, { orders: Set<string>; qty: number }>();
  if (cubics && !cubics.error) {
    for (const o of orders) {
      for (const u of o.cube?.unmatched ?? []) {
        const m = missing.get(u.part) ?? { orders: new Set<string>(), qty: 0 };
        m.orders.add(o.id);
        m.qty += u.qty;
        missing.set(u.part, m);
      }
    }
  }
  const missingParts = [...missing].sort((a, b) => b[1].orders.size - a[1].orders.size || a[0].localeCompare(b[0]));

  const groups = [...EXCEPTION_FLAGS, ...NOTICE_FLAGS]
    .map((flag) => ({
      flag,
      ids: [...plan.orders.values()].filter((o) => o.flags.includes(flag)).map((o) => o.orderId),
    }))
    .filter((g) => g.ids.length > 0);

  const dataNotes = (parsed?.orders ?? []).filter((o) =>
    o.notes.some((n) => !n.startsWith('No freight') && n !== 'No Need By or Ship By date'),
  );

  if (groups.length === 0 && dataNotes.length === 0 && missingParts.length === 0) {
    return <p className="muted-note">No exceptions — every order is on a load that meets its date.</p>;
  }

  return (
    <div className="exceptions">
      {groups.map(({ flag, ids }) => (
        <section key={flag} className={`exception-group${NOTICE_FLAGS.includes(flag) ? ' notice' : ''}`}>
          <header>
            <h3>
              {ORDER_FLAG_LABEL[flag]} <span className="tab-count">{ids.length}</span>
            </h3>
            {ACTION[flag] && <p>{ACTION[flag]}</p>}
          </header>
          <ul>
            {ids.map((id) => {
              const o = ordersById.get(id);
              const op = plan.orders.get(id);
              return (
                <li key={id}>
                  <button className="link" onClick={() => onOpenOrder(id)}>
                    {id}
                  </button>
                  <span>
                    {o?.shipToName || o?.custId} · {o?.zone} · {o?.city}
                  </span>
                  <span>
                    {DEADLINE_LABEL[plan.deadline]} {shortDay(o ? dueDate(o, plan.deadline) : null)}
                  </span>
                  <span>{op?.volumeKnown ? m3(op.volumeM3) : 'm³ ?'}</span>
                  {op?.day && <span>Planned {shortDay(op.day)}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {missingParts.length > 0 && (
        <section className="exception-group notice">
          <header>
            <h3>
              Parts missing from the cubics sheet <span className="tab-count">{missingParts.length}</span>
            </h3>
            <p>
              Add these codes to the sheet to size their orders from it. Orders, then units left to
              ship.
            </p>
          </header>
          <div className="missing-parts">
            {missingParts.map(([part, m]) => (
              <span key={part} className="missing-part" title={[...m.orders].join(', ')}>
                <span className="mono">{part}</span> {m.orders.size} · {m.qty.toLocaleString('en-AU')}
              </span>
            ))}
          </div>
        </section>
      )}
      {dataNotes.length > 0 && (
        <section className="exception-group notice">
          <header>
            <h3>
              Export data notes <span className="tab-count">{dataNotes.length}</span>
            </h3>
            <p>Read from the waybill as noted; check the order in Epicor.</p>
          </header>
          <ul>
            {dataNotes.map((o) => (
              <li key={o.id}>
                <button className="link" onClick={() => onOpenOrder(o.id)}>
                  {o.id}
                </button>
                <span>{o.notes.filter((n) => !n.startsWith('No freight')).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
