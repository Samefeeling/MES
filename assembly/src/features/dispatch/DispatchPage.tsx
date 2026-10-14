/**
 * The dispatch planner, for the warehouse manager, the dispatch office and
 * their manager.
 *
 * Laid out like the MES KPI page (`src/ui/kpi.ts`), which this page will sit
 * beside once the two projects merge: one white toolbar card with the views
 * as tabs, one row of headline tiles, then the content. Only the app's own
 * top bar is fixed — the toolbar and the tiles scroll away with the page.
 *
 * The headline tiles are the figures the operation is run on, the same on
 * every tab: dollars shipped today and month to date (with the month's
 * forecast), SIFOT, trucks today and containers this week. Each opens the
 * view behind it.
 *
 * The tabs follow the working day:
 * - **Day board** — today's loads: what to book, what is booked, what has
 *   gone, what is not ready; the booking sheet; hand edits;
 * - **Look-ahead** — the coming days and weeks: volume against marshalling
 *   space, vehicles to book ahead;
 * - **Orders** and **Exceptions** — every order, and what blocks one;
 * - **Performance** — the month: dollars by day, trucks, containers, SIFOT
 *   and every miss;
 * - **Settings** — vehicles, windows, departure days and targets.
 */

import { useMemo, useState } from 'react';
import { useDispatchStore } from '@/store/dispatchStore';
import { dispatchKpis } from '@/engine/dispatch/shipments';
import { formatDay, formatTime } from '@/lib/time';
import { useDispatchPlan } from './useDispatchPlan';
import { WaybillLoader } from './WaybillLoader';
import { DayBoard } from './DayBoard';
import { LookAhead } from './LookAhead';
import { OrdersTable } from './OrdersTable';
import { ExceptionsList, EXCEPTION_FLAGS } from './ExceptionsList';
import { Performance, sifotTone } from './Performance';
import { DispatchSettingsPanel } from './DispatchSettingsPanel';
import { OrderDrawer } from './OrderDrawer';
import { dollars, dollarsFull, pct, shortDay } from './format';
import { equipmentMix } from './summary';
import { AssemblyLinkContext, useAssemblyLinkValue } from './assemblyLink';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import './dispatch.css';

type Tab = 'day' | 'ahead' | 'orders' | 'exceptions' | 'performance' | 'settings';

const TAB_LABEL: Record<Tab, string> = {
  day: 'Day board',
  ahead: 'Look-ahead',
  orders: 'Orders',
  exceptions: 'Exceptions',
  performance: 'Performance',
  settings: 'Settings',
};

/** The MES traffic-light classes a stat tile can carry. */
type Tone = 'green' | 'amber' | 'red' | '';

const TONE: Record<'good' | 'mid' | 'bad', Tone> = { good: 'green', mid: 'amber', bad: 'red' };

export function DispatchPage({ assembly = null }: { assembly?: AssemblyGanttView | null }) {
  const model = useDispatchPlan();
  // Orders built on the Assembly board, read by every view that shows one.
  const link = useAssemblyLinkValue(assembly, model.linesByOrder);
  const { parsed, plan } = model;
  const fileName = useDispatchStore((s) => s.fileName);
  const loadedAt = useDispatchStore((s) => s.loadedAt);
  const cubicsFileName = useDispatchStore((s) => s.cubicsFileName);
  const settings = useDispatchStore((s) => s.settings);
  const log = useDispatchStore((s) => s.shipments);
  const [tab, setTab] = useState<Tab>('day');
  const [day, setDay] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const today = plan?.today ?? '';
  const shownDay = day ?? today;

  const exceptions = useMemo(
    () => (plan ? [...plan.orders.values()].filter((o) => o.flags.some((f) => EXCEPTION_FLAGS.includes(f))).length : 0),
    [plan],
  );
  const kpis = useMemo(
    () => (plan ? dispatchKpis(plan, log, model.orders, settings, plan.today) : null),
    [plan, log, model.orders, settings],
  );

  const openDay = (d: string) => {
    setDay(d);
    setTab('day');
  };

  return (
    <AssemblyLinkContext.Provider value={link}>
      <div className="dispatch">
        <div className="dispatch-scroll">
          <div className="kpi">
            <div className="kpi-head">
              <div className="shift-tabs" role="tablist" aria-label="Dispatch views">
                {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    className={`shift-btn${tab === key ? ' a' : ''}`}
                    onClick={() => setTab(key)}
                  >
                    {TAB_LABEL[key]}
                    {key === 'exceptions' && exceptions > 0 && <span className="tab-count">{exceptions}</span>}
                  </button>
                ))}
              </div>
              <div className="kpi-range">
                <span className="dispatch-source">
                  {fileName && loadedAt && (
                    <span title="The waybill the plan is built from">
                      Waybill <b>{fileName}</b> · {formatDay(new Date(loadedAt))} {formatTime(new Date(loadedAt))}
                    </span>
                  )}
                  {model.cubics && (
                    <span title="The product cube master orders are sized from">
                      Cubics <b>{cubicsFileName}</b> · {model.cubics.items.length} parts
                      {model.cubics.withoutCode.length > 0 && ` · ${model.cubics.withoutCode.length} rows without a code`}
                    </span>
                  )}
                </span>
                <WaybillLoader />
              </div>
            </div>

            {parsed?.error && <div className="banner">Waybill not loaded: {parsed.error}</div>}
            {parsed && parsed.warnings.length > 0 && (
              <div className="banner warn">
                {parsed.warnings.slice(0, 3).join(' · ')}
                {parsed.warnings.length > 3 && ` · +${parsed.warnings.length - 3} more`}
              </div>
            )}

            {kpis && (
              <div className="kpi-stats headline">
                <Stat
                  label="Shipped today"
                  value={dollars(kpis.today.shipped)}
                  sub={
                    kpis.today.planned > 0
                      ? `${dollars(kpis.today.planned)} still to go today`
                      : kpis.today.loadsShipped > 0
                        ? 'everything planned has gone'
                        : 'nothing planned today'
                  }
                  title={`${dollarsFull(kpis.today.shipped)} on ${kpis.today.loadsShipped} load(s) marked dispatched today`}
                  onClick={() => openDay(today)}
                />
                <Stat
                  label="Shipped month to date"
                  value={dollars(kpis.month.shipped)}
                  sub={`forecast ${dollars(kpis.month.forecast)} by month end`}
                  title={`${dollarsFull(kpis.month.shipped)} shipped since ${shortDay(kpis.month.from)}, plus ${dollarsFull(kpis.month.stillPlanned)} planned for the rest of the month`}
                  onClick={() => setTab('performance')}
                />
                <Stat
                  label="SIFOT month to date"
                  value={kpis.sifot.rate === null ? '—' : pct(kpis.sifot.rate)}
                  tone={kpis.sifot.rate === null ? '' : TONE[sifotTone(kpis.sifot.rate, settings.sifotTarget)]}
                  sub={
                    kpis.sifot.rate === null
                      ? 'counts from the first load dispatched'
                      : `${kpis.sifot.hits} of ${kpis.sifot.due} orders · target ${pct(settings.sifotTarget)}`
                  }
                  title="Shipped In Full, On Time: orders due this month that left complete by their due date"
                  onClick={() => setTab('performance')}
                />
                <Stat
                  label="Trucks today"
                  value={String(kpis.trucks.count)}
                  sub={`${kpis.trucks.dispatched} gone${kpis.trucks.partLoads > 0 ? ` · ${kpis.trucks.partLoads} part loads` : ''}`}
                  title="Contractor trucks leaving today: NSW truck runs and linehaul FTL trailers; NSW part loads and LTL counted apart"
                  onClick={() => openDay(today)}
                />
                <Stat
                  label="Containers this week"
                  value={String(kpis.containers.count)}
                  sub={
                    [equipmentMix(kpis.containers.mix), kpis.containers.lcl > 0 ? `${kpis.containers.lcl} × LCL` : '']
                      .filter(Boolean)
                      .join(' · ') || `week from ${shortDay(kpis.containers.weekStart)}`
                  }
                  title="FCL containers leaving Monday to Sunday this week"
                  onClick={() => setTab('ahead')}
                />
              </div>
            )}

            {tab === 'settings' ? (
              <DispatchSettingsPanel orders={parsed && !parsed.error ? parsed.orders : []} />
            ) : !parsed || parsed.error || !plan ? (
              <div className="dispatch-empty">
                <h2>No waybill loaded</h2>
                <p>
                  Load the waybill export (one row per order line: Order, PickListComment,
                  ShipToCustName, Ship Via, Description, ExpDeliveryDt, Need By, City, freight CBM
                  lines, Status) to build the dispatch plan. Settings can be reviewed before loading.
                </p>
              </div>
            ) : tab === 'day' ? (
              <DayBoard plan={plan} day={shownDay} onDay={setDay} onOpenOrder={setOpenOrder} />
            ) : tab === 'ahead' ? (
              <LookAhead
                plan={plan}
                day={shownDay}
                cubicsLoaded={!!model.cubics}
                onSelectDay={setDay}
                onOpenDay={openDay}
              />
            ) : tab === 'orders' ? (
              <OrdersTable model={model} onOpenOrder={setOpenOrder} />
            ) : tab === 'performance' ? (
              <Performance plan={plan} log={log} open={model.orders} />
            ) : (
              <ExceptionsList model={model} onOpenOrder={setOpenOrder} />
            )}
          </div>
        </div>

        {openOrder && plan && (
          <OrderDrawer key={openOrder} orderId={openOrder} model={model} onClose={() => setOpenOrder(null)} />
        )}
      </div>
    </AssemblyLinkContext.Provider>
  );
}

/**
 * One headline tile, in the MES `kpi-stat` shape — a label and a value —
 * with a line of context under it. It opens the view behind the figure.
 */
function Stat({
  label,
  value,
  sub,
  tone = '',
  title,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`kpi-stat${tone ? ` is-${tone}` : ''}`} title={title} onClick={onClick}>
      <span className="kpi-stat-label">{label}</span>
      <b className="kpi-stat-value">{value}</b>
      <span className="kpi-stat-sub">{sub}</span>
    </button>
  );
}
