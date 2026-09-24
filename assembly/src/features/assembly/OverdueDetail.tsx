/**
 * The Overdue figure's panel: every order past its Due Date and not finished,
 * the date it is now expected, and the list copied out for logistics — the
 * people whose container or truck was booked against the date that has gone.
 */

import { useState } from 'react';
import { formatDay } from '@/lib/time';
import { useUiStore } from '@/store/uiStore';
import { MetricNote } from './Metric';
import { overdueTsv, type OverdueOrder } from './overdue';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard permission (an http page, an old browser): the textarea way.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function OverdueDetail({
  orders,
  onDone,
}: {
  orders: OverdueOrder[];
  onDone: () => void;
}) {
  const select = useUiStore((s) => s.select);
  const [copied, setCopied] = useState<string | null>(null);
  if (orders.length === 0) {
    return <MetricNote>Nothing is past its Due Date unfinished.</MetricNote>;
  }
  return (
    <div className="overdue-report">
      <MetricNote>
        Past the Due Date and not finished, most overdue first. Anything booked out against the
        Due Date — a container, a truck — needs moving to the expected finish.
      </MetricNote>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Line</th>
            <th className="num">Left</th>
            <th>Due</th>
            <th className="num">Over</th>
            <th title="The order's Expect Date — the date to rebook to">Expected</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.orderNum}>
              <td>
                <button
                  type="button"
                  className="overdue-order"
                  title={`${o.partNum} · ${o.description}`}
                  onClick={(e) => {
                    select(o.rowId, { x: e.clientX, y: e.clientY });
                    onDone();
                  }}
                >
                  {o.orderNum}
                </button>
              </td>
              <td>{o.line}</td>
              <td className="num">{o.qtyLeft}</td>
              <td>{formatDay(o.dueDate)}</td>
              <td className="num late">{o.daysOver} d</td>
              <td className={o.expectDate ? undefined : 'late'}>
                {o.expectDate ? formatDay(o.expectDate) : 'no crew'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="overdue-actions">
        <button
          type="button"
          onClick={async () =>
            setCopied(
              (await copyText(overdueTsv(orders)))
                ? `${orders.length} ${orders.length === 1 ? 'order' : 'orders'} copied — paste into Excel or an email`
                : 'Could not copy — select the table instead',
            )
          }
        >
          Copy for logistics
        </button>
        {copied && <span role="status">{copied}</span>}
      </div>
    </div>
  );
}
