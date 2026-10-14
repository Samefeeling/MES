/**
 * The month for the dispatch manager: dollars shipped by day against what is
 * still planned, the week-by-week figures — value, trucks, containers, SIFOT
 * — and every order that missed, with why.
 *
 * Shipped figures come from the shipment log (loads marked dispatched); the
 * planned ones from the current plan. The basis (goods only, or goods and
 * freight) and the SIFOT target are set on the Settings tab.
 */

import { useState } from 'react';
import { DEADLINE_LABEL, type ShipmentOrder } from '@/domain/dispatch';
import type { DispatchPlan } from '@/engine/dispatch/plan';
import { addCalendarDays } from '@/engine/dispatch/calendar';
import {
  dispatchKpis,
  monthDays,
  monthWeeks,
  type DayValue,
  type ShipmentRecord,
  type SifotOutcome,
} from '@/engine/dispatch/shipments';
import { useDispatchStore } from '@/store/dispatchStore';
import { isoWeek } from './summary';
import { dayLabel, dollars, dollarsFull, pct, shortDay, weekdayOf } from './format';
import { niceScale, roundedTop, useWidth } from './VolumeChart';

const OUTCOME_LABEL: Record<SifotOutcome, string> = {
  hit: 'On time, in full',
  late: 'Late',
  short: 'Not in full',
  open: 'Not shipped',
};

/** Green at or above target, amber within 10 points, red below. */
export const sifotTone = (rate: number, target: number): 'good' | 'mid' | 'bad' =>
  rate >= target - 1e-9 ? 'good' : rate >= target - 0.1 ? 'mid' : 'bad';

export function Performance({
  plan,
  log,
  open,
}: {
  plan: DispatchPlan;
  log: readonly ShipmentRecord[];
  open: readonly ShipmentOrder[];
}) {
  const settings = useDispatchStore((s) => s.settings);
  const today = plan.today;
  const days = monthDays(plan, log, settings, today);
  const weeks = monthWeeks(plan, log, open, settings, today);
  const k = dispatchKpis(plan, log, open, settings, today);
  const month = new Date(`${today}T00:00:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const misses = k.sifot.orders.filter((o) => o.outcome !== 'hit');
  const basis = settings.shipmentValue === 'goods' ? 'goods value' : 'goods and freight';

  return (
    <div className="performance">
      {log.length === 0 && (
        <div className="banner warn">
          Nothing has been marked dispatched yet. Shipped dollars and SIFOT count from the first load marked
          dispatched on the Day board — the waybill only lists what is still open.
        </div>
      )}

      <section className="kpi-chart" aria-label="Shipped per day">
        <header className="summary-head">
          <h4>
            {month}: shipped per day, $ ({basis})
          </h4>
          <span className="muted-note">
            {dollars(k.month.shipped)} shipped · {dollars(k.month.stillPlanned)} still planned · forecast{' '}
            <b>{dollars(k.month.forecast)}</b>
          </span>
        </header>
        <ValueChart days={days} today={today} />
      </section>

      <section className="kpi-chart" aria-label="Weeks">
        <h4>Week by week</h4>
        <div className="table-scroll">
          <table className="summary-table perf-table">
            <thead>
              <tr>
                <th>Week</th>
                <th className="num">Shipped $</th>
                <th className="num">Still planned $</th>
                <th className="num" title="NSW truck runs and linehaul FTL trailers, shipped and planned">
                  Trucks
                </th>
                <th className="num" title="FCL containers, shipped and planned">
                  Containers
                </th>
                <th className="num" title="NSW part loads, LTL and LCL">
                  Part loads
                </th>
                <th className="num">Orders due</th>
                <th className="num">SIFOT</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.weekStart} className={w.weekStart <= today && today < addCalendarDays(w.weekStart, 7) ? 'selected' : ''}>
                  <td>
                    <strong>Wk {isoWeek(w.weekStart)}</strong> <span className="muted">from {shortDay(w.weekStart)}</span>
                  </td>
                  <td className="num" title={dollarsFull(w.shipped)}>
                    {w.shipped > 0 ? dollars(w.shipped) : <span className="muted">—</span>}
                  </td>
                  <td className="num" title={dollarsFull(w.planned)}>
                    {w.planned > 0 ? dollars(w.planned) : <span className="muted">—</span>}
                  </td>
                  <td className="num">{w.trucks}</td>
                  <td className="num">{w.containers}</td>
                  <td className="num">{w.partLoads}</td>
                  <td className="num">{w.sifot.due || <span className="muted">—</span>}</td>
                  <td className="num">
                    {w.sifot.rate === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <b className={`tone-${sifotTone(w.sifot.rate, settings.sifotTarget)}`}>{pct(w.sifot.rate)}</b>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted-note">
          Trucks and containers count what shipped plus what is still planned in the week. SIFOT counts the orders
          due in the week ({DEADLINE_LABEL[plan.deadline]}), target {pct(settings.sifotTarget)}.
        </p>
      </section>

      <section className="kpi-chart" aria-label="SIFOT misses">
        <header className="summary-head">
          <h4>SIFOT this month</h4>
          {k.sifot.rate !== null && (
            <span className="sifot-split">
              <b className={`tone-${sifotTone(k.sifot.rate, settings.sifotTarget)}`}>{pct(k.sifot.rate)}</b> ·{' '}
              {k.sifot.hits} of {k.sifot.due} on time in full · {k.sifot.late} late · {k.sifot.short} not in full ·{' '}
              {k.sifot.open} not shipped
              {k.sifot.since && ` · open orders counted from ${shortDay(k.sifot.since)}`}
            </span>
          )}
        </header>
        {misses.length === 0 ? (
          <p className="muted-note">
            {k.sifot.rate === null ? 'Nothing counted yet.' : 'No misses this month.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Ship to</th>
                  <th>{DEADLINE_LABEL[plan.deadline]}</th>
                  <th>Shipped</th>
                  <th>Miss</th>
                </tr>
              </thead>
              <tbody>
                {misses.map((o) => (
                  <tr key={o.orderId}>
                    <td className="mono">{o.orderId}</td>
                    <td>{o.shipToName || o.custId}</td>
                    <td>{shortDay(o.due)}</td>
                    <td>{o.shipped ? shortDay(o.shipped) : <span className="muted">—</span>}</td>
                    <td className="tone-bad">{OUTCOME_LABEL[o.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const HEIGHT = 240;
const MARGIN = { top: 24, right: 16, bottom: 44, left: 60 };
const GAP = 2;

/** Columns per working day: shipped (dark) under still planned (light). */
function ValueChart({ days, today }: { days: DayValue[]; today: string }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(0, ...days.map((d) => d.shipped + d.planned));
  const { top, step } = niceScale(peak * 1.05);
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = days.length > 0 ? innerW / days.length : innerW;
  const barW = Math.max(6, Math.min(24, band * 0.6));
  const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(innerW / 48))));
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div className="volume-chart value-chart" ref={wrap}>
      <ul className="chart-legend" aria-label="Series">
        <li>
          <span className="swatch shipped" aria-hidden />
          Shipped
        </li>
        <li>
          <span className="swatch planned" aria-hidden />
          Still planned
        </li>
      </ul>
      <svg width={width} height={HEIGHT} role="img" aria-label="Dollars shipped and still planned per working day">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {dollars(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = MARGIN.left + band * i + band / 2;
          const x = cx - barW / 2;
          const total = d.shipped + d.planned;
          const hShip = Math.max(0, y(0) - y(d.shipped));
          const hPlan = Math.max(0, y(d.shipped) - y(total) - (d.shipped > 0 ? GAP : 0));
          return (
            <g
              key={d.day}
              className={`col${hover === i ? ' hovered' : ''}`}
              tabIndex={0}
              aria-label={`${dayLabel(d.day)}: shipped ${dollarsFull(d.shipped)}, still planned ${dollarsFull(d.planned)}`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
            >
              <rect className="band" x={MARGIN.left + band * i} y={MARGIN.top} width={band} height={innerH} />
              {hShip > 0 &&
                (d.planned > 0 ? (
                  <rect className="seg shipped" x={x} y={y(d.shipped)} width={barW} height={hShip} />
                ) : (
                  <path className="seg shipped" d={roundedTop(x, y(d.shipped), barW, hShip, 3)} />
                ))}
              {hPlan > 0 && <path className="seg planned" d={roundedTop(x, y(total), barW, hPlan, 3)} />}
              {i % labelEvery === 0 && (
                <text className={`xlabel${d.day === today ? ' today' : ''}`} x={cx} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle">
                  {weekdayOf(d.day)}
                  <tspan x={cx} dy="1.25em">
                    {shortDay(d.day)}
                  </tspan>
                </text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} />
      </svg>
      {hovered && hover !== null && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(0, MARGIN.left + band * hover + band / 2 - 135), Math.max(0, width - 280)), top: 36 }}
          role="status"
        >
          <div className="tt-title">{dayLabel(hovered.day)}</div>
          <div className="tt-total">
            <strong>{dollarsFull(hovered.shipped + hovered.planned)}</strong>
          </div>
          <div className="tt-row">
            <span className="tt-key shipped" aria-hidden />
            <strong>{dollarsFull(hovered.shipped)}</strong>
            <span>shipped</span>
          </div>
          <div className="tt-row">
            <span className="tt-key planned" aria-hidden />
            <strong>{dollarsFull(hovered.planned)}</strong>
            <span>still planned{hovered.day === today ? ' (incl. overdue loads)' : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}
