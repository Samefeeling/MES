/**
 * The day's booking sheet: every load with what to book, and under it every
 * order with what the carrier will ask — ship-to name and address, zone,
 * pick-list comment, m³ and kg, due date and the customer's delivery date.
 *
 * Downloads as CSV (one row per order, the load repeated on each) and prints
 * on its own, so the dock can ring carriers from paper or a spreadsheet.
 */

import { DEADLINE_LABEL, DISPATCH_MODE_LABEL, dueDate, type DeadlineField } from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { useDispatchStore } from '@/store/dispatchStore';
import { bookingCsv, contractorOf, fullAddress, loadStatus } from './booking';
import { recommendation } from './equipment';
import { READINESS, dayLabel, m3, pct, shortDay } from './format';
import { SOURCE_MARK } from './LoadCard';
import { equipmentMix } from './summary';
import { BuildChip, buildCheckOf, buildText, useAssemblyLink } from './assemblyLink';

export function BookingSheet({
  day,
  loads,
  numbers,
  deadline,
  onOpenOrder,
}: {
  day: string;
  loads: readonly PlannedLoad[];
  numbers: ReadonlyMap<string, number>;
  deadline: DeadlineField;
  onOpenOrder: (id: string) => void;
}) {
  const settings = useDispatchStore((s) => s.settings);
  const link = useAssemblyLink();
  const dueLabel = DEADLINE_LABEL[deadline];
  const mix: Record<string, number> = {};
  for (const l of loads) if (l.mode !== 'pickup') mix[l.equipment] = (mix[l.equipment] ?? 0) + 1;
  const total = loads.reduce((s, l) => s + l.volumeM3, 0);
  const kg = loads.reduce((s, l) => s + l.weightKg, 0);

  const download = () => {
    const blob = new Blob([bookingCsv(loads, deadline, numbers, settings.contractors, (orderId, day) => buildText(buildCheckOf(link, orderId, day)))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dispatch-${day}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="booking-sheet" aria-label={`Booking sheet ${dayLabel(day)}`}>
      <header className="sheet-head">
        <div>
          <h3>Booking sheet · {dayLabel(day)}</h3>
          <p className="day-facts">
            {loads.length} load{loads.length === 1 ? '' : 's'} · {m3(total)}
            {kg > 0 && ` · ${Math.round(kg).toLocaleString('en-AU')} kg`}
            {Object.keys(mix).length > 0 && ` · To book: ${equipmentMix(mix)}`}
          </p>
        </div>
        <div className="sheet-actions">
          <button type="button" className="kpi-btn primary" onClick={download}>
            Download CSV
          </button>
          <button type="button" className="kpi-btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>

      <div className="table-scroll">
        <table className="summary-table sheet-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Ship to</th>
              <th>Address</th>
              <th>Description</th>
              <th>Ship Via</th>
              <th>Pick list</th>
              <th className="num">m³</th>
              <th className="num">kg</th>
              <th>{dueLabel}</th>
              <th>Deliver</th>
              <th>Goods</th>
            </tr>
          </thead>
          {loads.map((load) => (
            <tbody key={load.id}>
              <tr className={`sheet-load mode-${load.mode}`}>
                <th colSpan={11} scope="rowgroup">
                  <span className={`dot series-${load.mode}`} aria-hidden />
                  <b>L{numbers.get(load.id)}</b> · {DISPATCH_MODE_LABEL[load.mode]} · {load.label}
                  <span className="sheet-book">
                    {recommendation(load, settings)}
                    {contractorOf(load, settings.contractors) && ` · with ${contractorOf(load, settings.contractors)}`}
                  </span>
                  <span className="sheet-meta">
                    {m3(load.volumeM3)}
                    {load.fill !== null && ` · ${pct(load.fill)} full`}
                    {load.weightKg > 0 && ` · ${Math.round(load.weightKg).toLocaleString('en-AU')} kg`}
                    {' · '}
                    {loadStatus(load)}
                  </span>
                  {load.warnings.length > 0 && <span className="sheet-warn">{load.warnings.join(' · ')}</span>}
                </th>
              </tr>
              {load.drops.map((d, i) => {
                const o = d.order;
                const due = o ? dueDate(o, deadline) : null;
                return (
                  <tr key={`${d.orderId}-${i}`}>
                    <td>
                      <button type="button" className="link" onClick={() => onOpenOrder(d.orderId)}>
                        {d.orderId}
                      </button>
                      {d.piece && (
                        <span className="tag">
                          {d.piece.index}/{d.piece.of}
                        </span>
                      )}
                    </td>
                    <td>
                      <b>{o?.shipToName || o?.custId || '—'}</b>
                      {o?.shipToName && o.custId && <span className="ship-sub">{o.custId}</span>}
                    </td>
                    <td>{o ? fullAddress(o) || '—' : '—'}</td>
                    <td>{o?.zone}</td>
                    <td>{o?.shipVia}</td>
                    <td className="pick-cell">{o?.pickListComment || <span className="muted">—</span>}</td>
                    <td className="num">
                      {d.volumeKnown ? d.volumeM3.toFixed(2) : '?'}
                      {SOURCE_MARK[d.volumeSource] && <sup className="src">{SOURCE_MARK[d.volumeSource]}</sup>}
                    </td>
                    <td className="num">{d.weightKg === null ? '—' : Math.round(d.weightKg).toLocaleString('en-AU')}</td>
                    <td className={due && due < load.day ? 'tone-bad' : undefined}>{shortDay(due)}</td>
                    <td>{shortDay(o?.expDelivery ?? null)}</td>
                    <td>
                      {o ? READINESS[o.readiness].label : ''}
                      {o?.inPicking ? ' · Picking' : ''}
                      <BuildChip check={buildCheckOf(link, d.orderId, load.day)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      <p className="muted-note">
        m³ marks: P packed (pick-list comment), C cubics sheet, E entered, unmarked = freight line.
      </p>
    </section>
  );
}
