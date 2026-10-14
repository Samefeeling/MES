/**
 * The numbers the plan is built with. Every default is an assumption for
 * logistics to confirm, so each one is editable here and takes effect at once.
 */

import { useState } from 'react';
import {
  largestContainer,
  largestTruck,
  stagingCapacity,
  type DispatchSettings,
  type Equipment,
  type ShipmentOrder,
} from '@/domain/dispatch';
import { useDispatchStore } from '@/store/dispatchStore';
import { Button } from '@/ui';

const WEEKDAYS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
];

const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
  hint?: string;
}) {
  const [text, setText] = useState(String(value));
  return (
    <label className="field" title={hint}>
      {label && <span>{label}</span>}
      <span className="field-input">
        <input
          type="number"
          step={step}
          min={min}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min) onChange(n);
          }}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  );
}

/** A comma-separated list, committed when the field loses focus. */
function ListField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  hint?: string;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <label className="field wide" title={hint}>
      {label && <span>{label}</span>}
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(list(text))}
      />
    </label>
  );
}

/**
 * Who each Ship Via code is booked with. Lists the codes on the loaded
 * waybill (customer pickup aside) and any already named; a name is saved
 * when the field loses focus.
 */
function ContractorTable({
  orders,
  settings,
  onChange,
}: {
  orders: readonly ShipmentOrder[];
  settings: DispatchSettings;
  onChange: (contractors: Record<string, string>) => void;
}) {
  const pickup = new Set(settings.pickupZones.map((z) => z.trim()));
  const codes = new Map<string, { zones: Set<string>; orders: number }>();
  for (const o of orders) {
    const via = o.shipVia.trim();
    if (!via || pickup.has(o.zone.trim())) continue;
    const c = codes.get(via) ?? { zones: new Set<string>(), orders: 0 };
    c.zones.add(o.zone.trim());
    c.orders += 1;
    codes.set(via, c);
  }
  for (const via of Object.keys(settings.contractors)) {
    if (!codes.has(via)) codes.set(via, { zones: new Set(), orders: 0 });
  }
  const rows = [...codes.entries()].sort(([a, x], [b, y]) =>
    [...x.zones].join().localeCompare([...y.zones].join()) || a.localeCompare(b),
  );
  if (rows.length === 0) {
    return <p className="muted-note">Load a waybill to list its Ship Via codes here.</p>;
  }
  return (
    <table className="settings-table">
      <thead>
        <tr>
          <th>Ship Via</th>
          <th>Description</th>
          <th className="num">Open orders</th>
          <th>Contractor</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([via, c]) => (
          <tr key={via}>
            <td className="mono">{via}</td>
            <td>{[...c.zones].join(', ') || <span className="muted">not on this waybill</span>}</td>
            <td className="num">{c.orders || '—'}</td>
            <td>
              <input
                type="text"
                defaultValue={settings.contractors[via] ?? ''}
                placeholder="Transport company"
                aria-label={`Contractor for ${via}`}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name === (settings.contractors[via] ?? '')) return;
                  const next = { ...settings.contractors };
                  if (name) next[via] = name;
                  else delete next[via];
                  onChange(next);
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <span className="weekday-picker">
      {WEEKDAYS.map(([n, name]) => (
        <label key={n} className="check">
          <input
            type="checkbox"
            checked={value.includes(n)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...value, n].sort() : value.filter((d) => d !== n),
              )
            }
          />
          {name}
        </label>
      ))}
    </span>
  );
}

function EquipmentTable({
  items,
  onChange,
}: {
  items: Equipment[];
  onChange: (items: Equipment[]) => void;
}) {
  return (
    <table className="settings-table">
      <thead>
        <tr>
          <th>Name</th>
          <th className="num">Usable m³</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr key={item.id}>
            <td>
              <input
                type="text"
                value={item.name}
                onChange={(e) =>
                  onChange(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
            </td>
            <td className="num">
              <NumberField
                label=""
                value={item.capacityM3}
                step={0.5}
                onChange={(n) =>
                  onChange(items.map((x, j) => (j === i ? { ...x, capacityM3: n } : x)))
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DispatchSettingsPanel({ orders = [] }: { orders?: readonly ShipmentOrder[] }) {
  const settings = useDispatchStore((s) => s.settings);
  const update = useDispatchStore((s) => s.updateSettings);
  const reset = useDispatchStore((s) => s.resetSettings);
  // Remount every field after a reset so the inputs show the defaults.
  const [generation, setGeneration] = useState(0);

  const set = (change: (s: DispatchSettings) => DispatchSettings) => update(change);
  const { fleet, linehaul, container } = settings;
  const staging = stagingCapacity(settings);
  const derived = settings.trucksPerDay > 0 && settings.containersPerDay > 0;

  return (
    <div className="dispatch-settings" key={generation}>
      <p className="muted-note">
        Every value below is a starting assumption — confirm capacities, windows and
        departure days with logistics. Changes re-plan immediately and are kept in this
        browser.
      </p>

      <section>
        <h3>Warehouse</h3>
        <div className="field-row">
          <NumberField
            label="Firm window"
            suffix="working days"
            value={settings.firmDays}
            hint="Inside it, only orders whose goods are ready are pulled forward"
            onChange={(n) => set((s) => ({ ...s, firmDays: Math.round(n) }))}
          />
          <ListField
            label="Holidays (YYYY-MM-DD, comma separated)"
            value={settings.holidays}
            onChange={(v) => set((s) => ({ ...s, holidays: v.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) }))}
          />
        </div>
        <h4>Daily load-out</h4>
        <div className="field-row">
          <NumberField
            label="Trucks per day"
            suffix="0 = no limit"
            value={settings.trucksPerDay}
            hint="Whole trucks the dock loads out in a day: NSW truck runs and linehaul FTL; part loads aside"
            onChange={(n) => set((s) => ({ ...s, trucksPerDay: Math.round(n) }))}
          />
          <NumberField
            label="Containers per day"
            suffix="0 = no limit"
            value={settings.containersPerDay}
            hint="FCL containers stuffed in a day; LCL aside"
            onChange={(n) => set((s) => ({ ...s, containersPerDay: Math.round(n) }))}
          />
          {settings.stagingAuto && derived ? (
            <div className="field">
              <span>Marshalling capacity</span>
              <span className="field-derived">
                <b>{Math.round(staging)} m³</b> per day = {settings.trucksPerDay} × {largestTruck(settings)} m³ +{' '}
                {settings.containersPerDay} × {largestContainer(settings)} m³
              </span>
            </div>
          ) : (
            <NumberField
              label="Marshalling capacity"
              suffix="m³ per day"
              value={settings.stagingCapacityM3}
              hint="Volume the dispatch area can stage for one day's loads; 0 turns the check off"
              onChange={(n) => set((s) => ({ ...s, stagingCapacityM3: n }))}
            />
          )}
        </div>
        <div className="check-stack">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.stagingAuto}
              onChange={(e) => set((s) => ({ ...s, stagingAuto: e.target.checked }))}
            />
            Size the marshalling area from the daily limits (largest truck and container, full)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.levelToLimits}
              onChange={(e) => set((s) => ({ ...s, levelToLimits: e.target.checked }))}
            />
            Bring loads forward off a day over its limits, inside each order's pull-forward window
          </label>
        </div>
      </section>

      <section>
        <h3>Contractors</h3>
        <p className="muted-note">
          There is no own fleet: every load — NSW runs, linehaul and containers — is booked with a
          contractor. Name the company each Ship Via is booked with and it shows on the load cards, the
          booking sheet and its CSV.
        </p>
        <ContractorTable
          orders={orders}
          settings={settings}
          onChange={(contractors) => set((s) => ({ ...s, contractors }))}
        />
      </section>

      <section>
        <h3>NSW delivery — contractor trucks to the customer</h3>
        <div className="field-row">
          <NumberField
            label="Pull forward up to"
            suffix="working days"
            value={fleet.earlyDays}
            hint="How early an order may go to fill a truck. Tighten in peak season, when the warehouse is full."
            onChange={(n) => set((s) => ({ ...s, fleet: { ...s.fleet, earlyDays: Math.round(n) } }))}
          />
          <NumberField
            label="Part load (pallet freight) up to"
            suffix="m³"
            step={0.5}
            value={fleet.carrierMaxM3}
            hint="A run carrying no more than this is booked as pallet freight, not a whole truck; 0 turns it off"
            onChange={(n) => set((s) => ({ ...s, fleet: { ...s.fleet, carrierMaxM3: n } }))}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={fleet.keepShipViaApart}
            onChange={(e) => set((s) => ({ ...s, fleet: { ...s.fleet, keepShipViaApart: e.target.checked } }))}
          />
          Keep each zone and Ship Via on its own runs (off: nearby customers in neighbouring NSW zones share a
          truck)
        </label>
        <h4>Truck sizes to book</h4>
        <EquipmentTable
          items={fleet.trucks}
          onChange={(trucks) => set((s) => ({ ...s, fleet: { ...s.fleet, trucks } }))}
        />
        <h4>Run classes</h4>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Zones (Description)</th>
              <th className="num">Radius km</th>
              <th className="num">Max drops</th>
            </tr>
          </thead>
          <tbody>
            {fleet.runClasses.map((rc, i) => {
              const change = (patch: Partial<typeof rc>) =>
                set((s) => ({
                  ...s,
                  fleet: {
                    ...s.fleet,
                    runClasses: s.fleet.runClasses.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  },
                }));
              return (
                <tr key={rc.id}>
                  <td>
                    <input type="text" value={rc.label} onChange={(e) => change({ label: e.target.value })} />
                  </td>
                  <td>
                    <ListField label="" value={rc.zones} onChange={(zones) => change({ zones })} />
                  </td>
                  <td className="num">
                    <NumberField label="" value={rc.radiusKm} onChange={(radiusKm) => change({ radiusKm })} />
                  </td>
                  <td className="num">
                    <NumberField
                      label=""
                      value={rc.maxDrops}
                      min={1}
                      onChange={(n) => change({ maxDrops: Math.round(n) })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Interstate — linehaul to the hub city, local carrier delivers</h3>
        <p className="muted-note">
          Each delivery zone and carrier (Description + Ship Via, e.g. QLD- Metro / AQMC) is consolidated
          on its own: different carriers or regions never share a departure.
        </p>
        <div className="field-row">
          <NumberField
            label="Pull forward up to"
            suffix="working days"
            value={linehaul.earlyDays}
            onChange={(n) => set((s) => ({ ...s, linehaul: { ...s.linehaul, earlyDays: Math.round(n) } }))}
          />
          <NumberField
            label="Part load (LTL) up to"
            suffix="m³"
            value={linehaul.ltlMaxM3}
            onChange={(n) => set((s) => ({ ...s, linehaul: { ...s.linehaul, ltlMaxM3: n } }))}
          />
          <NumberField
            label="Build an FTL from early orders at"
            suffix="% fill"
            value={Math.round(linehaul.minFtlFill * 100)}
            onChange={(n) => set((s) => ({ ...s, linehaul: { ...s.linehaul, minFtlFill: Math.min(1, n / 100) } }))}
          />
          <NumberField
            label="FTL trailer"
            suffix="m³ usable"
            value={linehaul.trailer.capacityM3}
            onChange={(n) =>
              set((s) => ({ ...s, linehaul: { ...s.linehaul, trailer: { ...s.linehaul.trailer, capacityM3: n } } }))
            }
          />
        </div>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Hub</th>
              <th>Zone prefixes</th>
              <th>Departs</th>
            </tr>
          </thead>
          <tbody>
            {linehaul.hubs.map((hub, i) => {
              const change = (patch: Partial<typeof hub>) =>
                set((s) => ({
                  ...s,
                  linehaul: {
                    ...s.linehaul,
                    hubs: s.linehaul.hubs.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  },
                }));
              return (
                <tr key={hub.id}>
                  <td>
                    <input type="text" value={hub.label} onChange={(e) => change({ label: e.target.value })} />
                  </td>
                  <td>
                    <ListField label="" value={hub.zonePrefixes} onChange={(zonePrefixes) => change({ zonePrefixes })} />
                  </td>
                  <td>
                    <WeekdayPicker
                      value={hub.departureWeekdays}
                      onChange={(departureWeekdays) => change({ departureWeekdays })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Export — containers</h3>
        <div className="field-row">
          <NumberField
            label="Pull forward up to"
            suffix="working days"
            value={container.earlyDays}
            onChange={(n) => set((s) => ({ ...s, container: { ...s.container, earlyDays: Math.round(n) } }))}
          />
          <NumberField
            label="LCL up to"
            suffix="m³"
            value={container.lclMaxM3}
            onChange={(n) => set((s) => ({ ...s, container: { ...s.container, lclMaxM3: n } }))}
          />
          <NumberField
            label="Build an FCL from early orders at"
            suffix="% fill"
            value={Math.round(container.minFclFill * 100)}
            onChange={(n) => set((s) => ({ ...s, container: { ...s.container, minFclFill: Math.min(1, n / 100) } }))}
          />
          <label className="field">
            <span>Stuffing days</span>
            <WeekdayPicker
              value={container.departureWeekdays}
              onChange={(departureWeekdays) => set((s) => ({ ...s, container: { ...s.container, departureWeekdays } }))}
            />
          </label>
        </div>
        <div className="field-row">
          <ListField
            label="Export zone prefixes"
            value={container.zonePrefixes}
            onChange={(zonePrefixes) => set((s) => ({ ...s, container: { ...s.container, zonePrefixes } }))}
          />
          <ListField
            label="Zones consolidated per city (different ports)"
            value={container.splitByCityZones}
            onChange={(splitByCityZones) => set((s) => ({ ...s, container: { ...s.container, splitByCityZones } }))}
          />
        </div>
        <h4>Containers</h4>
        <EquipmentTable
          items={container.containers}
          onChange={(containers) => set((s) => ({ ...s, container: { ...s.container, containers } }))}
        />
      </section>

      <section>
        <h3>Order volume</h3>
        <div className="field-row">
          <label className="field">
            <span>When both are available, use</span>
            <select
              value={settings.preferVolume}
              onChange={(e) =>
                set((s) => ({ ...s, preferVolume: e.target.value as DispatchSettings['preferVolume'] }))
              }
            >
              <option value="cubics">Cubics sheet (stacked, per part)</option>
              <option value="freight">Freight CBM line on the order</option>
            </select>
          </label>
        </div>
        <p className="muted-note">
          A volume entered on the order always wins, then the packed cube in the pick-list
          comment (2C = 2 m³). After that the cubics sheet sizes an order only when it lists
          every goods line; otherwise the freight line is used, and failing that the part the
          sheet does cover.
        </p>
      </section>

      <section>
        <h3>Due date</h3>
        <div className="field-row">
          <label className="field">
            <span>Last day an order may leave</span>
            <select
              value={settings.deadline}
              onChange={(e) => set((s) => ({ ...s, deadline: e.target.value as DispatchSettings['deadline'] }))}
            >
              <option value="needBy">Need By (latest ship date)</option>
              <option value="shipBy">Ship By</option>
            </select>
          </label>
        </div>
        <p className="muted-note">
          ExpDeliveryDt is the day the customer receives the goods and is shown on every load. When
          an order has no date in the chosen column, the other one is used.
        </p>
      </section>

      <section>
        <h3>Shipments and SIFOT</h3>
        <div className="field-row">
          <label className="field">
            <span>Shipment dollars count</span>
            <select
              value={settings.shipmentValue}
              onChange={(e) =>
                set((s) => ({ ...s, shipmentValue: e.target.value as DispatchSettings['shipmentValue'] }))
              }
            >
              <option value="goods">Goods only (ReleaseVal of goods lines)</option>
              <option value="goods-freight">Goods and freight charged</option>
            </select>
          </label>
          <NumberField
            label="SIFOT target"
            suffix="%"
            value={Math.round(settings.sifotTarget * 100)}
            hint="Green at or above it, amber within 10 points, red below"
            onChange={(n) => set((s) => ({ ...s, sifotTarget: Math.min(1, Math.max(0, n / 100)) }))}
          />
        </div>
        <p className="muted-note">
          The waybill only lists open orders, so shipped dollars and SIFOT come from loads marked
          dispatched on the Day board. ReleaseVal is the value still open on each line; a split order's
          value is shared by m³. SIFOT counts orders due in the period: shipped complete by the due date
          is a hit; late, not in full (goods not ready when it left) and still open after its due date
          are misses. Counting starts at the first dispatched load.
        </p>
      </section>

      <section>
        <h3>Customer pickup</h3>
        <div className="field-row">
          <ListField
            label="Pickup zones"
            value={settings.pickupZones}
            onChange={(pickupZones) => set((s) => ({ ...s, pickupZones }))}
          />
        </div>
      </section>

      <Button
        onClick={() => {
          reset();
          setGeneration((g) => g + 1);
        }}
      >
        Reset to defaults
      </Button>
    </div>
  );
}
