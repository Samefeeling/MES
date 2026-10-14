/**
 * Dispatch (outbound logistics) domain: what a waybill order is, how each
 * delivery zone is routed, and the equipment each route ships in.
 *
 * Three ways an order leaves the factory, decided by the waybill's
 * `Description` (the delivery zone):
 *
 * - **NSW delivery** — a contractor's truck, booked for the run, delivers to
 *   the customer (there is no own fleet: every load is booked). Orders for
 *   nearby customers in the same zone and Ship Via share a run; an order is
 *   only split when it is bigger than the biggest truck. A run of a pallet or
 *   two is booked as a part load instead of a truck.
 * - **Interstate linehaul** — orders are consolidated per delivery zone and
 *   carrier (`Description` + `Ship Via`, e.g. `QLD- Metro` / `AQMC`) and
 *   trucked to the state's hub city; the local carrier there does the last
 *   mile. Different carriers or zones never share a departure. A departure is
 *   a full truck (FTL) or, when small, a part load (LTL).
 * - **Export containers** — consolidated per destination into FCL containers,
 *   or LCL when too small to fill one. Volume decides the container count, so
 *   fill is shown on every container.
 *
 * Customer pickup orders are only scheduled for the dock, never loaded.
 */

import type { OrderCube } from './cubics';

/** ISO local day, `YYYY-MM-DD`. */
export type DayKey = string;

export type DispatchMode = 'fleet' | 'linehaul' | 'container' | 'pickup';

export const DISPATCH_MODE_LABEL: Record<DispatchMode, string> = {
  fleet: 'NSW delivery',
  linehaul: 'Interstate linehaul',
  container: 'Export containers',
  pickup: 'Customer pickup',
};

/**
 * What an NSW run too small for a whole truck is booked as: pallet freight
 * with the contractor. Saved before contractors replaced the own-fleet
 * model, such loads were called `Carrier`.
 */
export const PART_LOAD = 'Part load';

/** One row of the waybill export, with source field values preserved. */
export interface WaybillLine {
  order: string;
  line: string;
  rel: string;
  custId: string;
  shipVia: string;
  /** Delivery zone, the export's `Description` column (e.g. `NSW-Metro-South`). */
  zone: string;
  city: string;
  part: string;
  requestedQty: number;
  shippedQty: number;
  leftToShip: number;
  allocatedQty: number;
  uom: string;
  expDelivery: DayKey | null;
  shipBy: DayKey | null;
  needBy: DayKey | null;
  releaseValue: number;
  /** `Stock`, `Job`, `BTO` or `Other` (freight and services). */
  fulfillment: string;
  /** `Ready`, `PARTIAL`, `Non-Inventory` or blank. */
  status: string;
  inPicking: boolean;
  onHold: boolean;
  creditHold: boolean;
  /**
   * The export's `PickListComment`: what the warehouse wrote on the pick list
   * once the goods were packed, e.g. `2C` for 2 m³ packed.
   */
  pickListComment: string;
  /** `ShipToCustName`: who the consignment is addressed to. */
  shipToName: string;
  /** Ship-to street address, state and postcode, when the export has them. */
  address: string;
  state: string;
  postcode: string;
}

/**
 * Whether the goods on an order are in the warehouse.
 *
 * `no-goods` is an order carrying nothing but freight or service lines.
 */
export type Readiness = 'ready' | 'partial' | 'not-ready' | 'no-goods';

/** One customer order, the unit dispatch plans with. */
export interface ShipmentOrder {
  id: string;
  custId: string;
  /** `ShipToCustName`; blank when the export does not carry it. */
  shipToName: string;
  address: string;
  state: string;
  postcode: string;
  shipVia: string;
  zone: string;
  city: string;
  shipBy: DayKey | null;
  /** `Need By`: the last day the order may leave the factory. */
  needBy: DayKey | null;
  /** `ExpDeliveryDt`: the day the customer expects to receive it. */
  expDelivery: DayKey | null;
  /** Pick-list comments on the order, as written (`2C`). */
  pickListComment: string;
  /**
   * Packed cube read from the pick-list comment (`2C` = 2 m³): measured after
   * packing, so the best volume there is. Null when no comment gives one.
   */
  packedM3: number | null;
  /**
   * Cubic metres still to ship, from the order's freight line (a `CBM` line
   * such as `FRTNSW`). Null when the order carries no freight volume.
   */
  volumeM3: number | null;
  /**
   * Sum of `ReleaseVal` over the order's lines: the value still to ship
   * (Epicor carries the open release value, not the original order value).
   */
  value: number;
  /** `ReleaseVal` of the goods lines (everything but `Other`). */
  goodsValue: number;
  /** `ReleaseVal` of the freight and service lines (`Other`). */
  freightValue: number;
  lineCount: number;
  goodsLines: number;
  readyLines: number;
  readiness: Readiness;
  inPicking: boolean;
  onHold: boolean;
  creditHold: boolean;
  /** Data problems found while reading the order, for the exceptions list. */
  notes: string[];
  /** Cube worked out from the cubics sheet, when one is loaded. */
  cube?: OrderCube | null;
}

/** Where an order's volume came from, best first. */
export type VolumeSource = 'entered' | 'packed' | 'cubics' | 'freight' | 'cubics-partial' | 'none';

export const VOLUME_SOURCE_LABEL: Record<VolumeSource, string> = {
  entered: 'Entered by the planner',
  packed: 'Packed — from the pick-list comment',
  cubics: 'Cubics sheet (stacked)',
  freight: 'Freight CBM line',
  'cubics-partial': 'Cubics sheet — some parts missing',
  none: 'Unknown',
};

/**
 * Freight lines whose quantity is the order's shipping volume in m³.
 *
 * `FRT911` is deliberately absent: it carries a quantity of 1 with a charge,
 * a surcharge rather than a volume.
 */
export const FREIGHT_VOLUME_PARTS = [
  'FRTNSW',
  'FRTACT',
  'FRTQLD',
  'FRTVIC',
  'FRTSA',
  'FRTWAU',
  'FRTTAS',
  'FRTNT',
  'FRTSEB',
  'FRTEXP',
] as const;

/** A truck, linehaul trailer or shipping container, by usable volume. */
export interface Equipment {
  id: string;
  name: string;
  /** Usable (loadable) volume, not the internal cube. */
  capacityM3: number;
  /** What the dock needs to know to book it: deck, pallet spaces, internal size. */
  note?: string;
}

/**
 * A family of NSW delivery runs. Only orders in the same class share a truck,
 * and only when they are within `radiusKm` of every other drop on it.
 */
export interface FleetRunClass {
  id: string;
  label: string;
  zones: string[];
  radiusKm: number;
  maxDrops: number;
}

/** An interstate hub: every order for the state is consolidated to it. */
export interface LinehaulHub {
  id: string;
  label: string;
  /** Zone prefixes routed to this hub, e.g. `QLD` covers `QLD- Metro`. */
  zonePrefixes: string[];
  /** ISO weekdays the linehaul leaves: 1 = Monday … 5 = Friday. */
  departureWeekdays: number[];
}

export interface DispatchSettings {
  fleet: {
    trucks: Equipment[];
    runClasses: FleetRunClass[];
    /**
     * How many working days before its due date an order may go to fill a truck.
     * This is the warehouse limit: an order pulled forward has to be finished
     * and staged that much earlier.
     */
    earlyDays: number;
    /**
     * A run carrying no more than this is booked as a part load (pallet
     * freight) rather than a whole truck; 0 disables.
     */
    carrierMaxM3: number;
    /**
     * Keep each delivery zone and `Ship Via` (`NSW-Metro-South` / `ANMS`) on
     * its own runs, as interstate and export do. On by default; off lets
     * nearby customers in neighbouring zones of a run class share a truck.
     */
    keepShipViaApart: boolean;
  };
  linehaul: {
    hubs: LinehaulHub[];
    /** The full-truck trailer used for an FTL departure. */
    trailer: Equipment;
    /** Below this volume a departure is booked as a part load (LTL). */
    ltlMaxM3: number;
    /** An FTL is only built from pulled-forward orders if it reaches this fill. */
    minFtlFill: number;
    earlyDays: number;
  };
  container: {
    containers: Equipment[];
    /** Zone prefixes shipped by container. */
    zonePrefixes: string[];
    /** Zones whose cities are different ports, consolidated per city. */
    splitByCityZones: string[];
    /** ISO weekdays a container can be stuffed and leave for the port. */
    departureWeekdays: number[];
    /** Below this volume the shipment goes LCL. */
    lclMaxM3: number;
    /** A container is only built from pulled-forward orders if it reaches this fill. */
    minFclFill: number;
    earlyDays: number;
  };
  pickupZones: string[];
  /**
   * Which volume wins when both are there: the cubics sheet (stack-aware, per
   * part) or the freight CBM line on the order. The cubics sheet is only used
   * when it covers every goods line; a partial match falls back to freight.
   */
  preferVolume: 'cubics' | 'freight';
  /**
   * Which waybill date is the last day an order may leave. `Need By` is the
   * latest ship date and `ExpDeliveryDt` the day the customer receives it;
   * `Ship By` is kept for exports that only fill that one in. Either way the
   * other date is the fallback when an order has none.
   */
  deadline: DeadlineField;
  /**
   * What shipment dollars count: the goods only (`ReleaseVal` of goods
   * lines), or goods plus the freight charged on the order.
   */
  shipmentValue: 'goods' | 'goods-freight';
  /** SIFOT target, 0–1: green at or above it, amber within 10 points. */
  sifotTarget: number;
  /**
   * The contractor booked for each `Ship Via` code (`ANMS` → the transport
   * company), shown on load cards and the booking sheet. Blank codes show
   * the Ship Via alone.
   */
  contractors: Record<string, string>;
  /**
   * Firm (frozen) window in working days from today. Inside it, an order is
   * only pulled forward when its goods are already ready.
   */
  firmDays: number;
  /**
   * Whole trucks the dock loads out in a day — NSW truck runs and linehaul
   * FTL trailers; part loads aside. 0 means no limit.
   */
  trucksPerDay: number;
  /** FCL containers stuffed in a day; LCL aside. 0 means no limit. */
  containersPerDay: number;
  /**
   * Bring loads forward, within their pull-forward window, off a day that is
   * over its truck or container limit or its marshalling capacity.
   */
  levelToLimits: boolean;
  /**
   * Size the marshalling area from the daily limits (see
   * `stagingCapacity`) instead of the figure below.
   */
  stagingAuto: boolean;
  /** Volume the marshalling area holds for one day's loads, when not derived. */
  stagingCapacityM3: number;
  /** Non-working days as `YYYY-MM-DD`, on top of weekends. */
  holidays: DayKey[];
}

/**
 * Starting values. Every capacity, window and departure day here is an
 * assumption to be confirmed by logistics and is editable on the Settings tab.
 */
export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  fleet: {
    trucks: [
      { id: 'rigid-8', name: 'Rigid 8-pallet', capacityM3: 30, note: '8 pallet spaces' },
      { id: 'rigid-12', name: 'Rigid 12-pallet', capacityM3: 45, note: '12 pallet spaces' },
      { id: 'semi-22', name: 'Semi 22-pallet', capacityM3: 75, note: '22 pallet spaces, tautliner' },
    ],
    runClasses: [
      {
        id: 'metro',
        label: 'Sydney metro',
        zones: [
          'NSW-Metro',
          'NSW-Metro-North',
          'NSW-Metro-South',
          'NSW-WINC',
          'NSW Conroys',
        ],
        radiusKm: 30,
        maxDrops: 8,
      },
      {
        id: 'reg-north',
        label: 'NSW regional north',
        zones: ['NSW-Reg-North'],
        radiusKm: 120,
        maxDrops: 4,
      },
      {
        id: 'reg-south',
        label: 'NSW regional south',
        zones: ['NSW-Reg-South'],
        radiusKm: 120,
        maxDrops: 4,
      },
    ],
    earlyDays: 3,
    carrierMaxM3: 2,
    keepShipViaApart: true,
  },
  linehaul: {
    hubs: [
      { id: 'QLD', label: 'Brisbane hub', zonePrefixes: ['QLD'], departureWeekdays: [2, 4] },
      { id: 'VIC', label: 'Melbourne hub', zonePrefixes: ['VIC'], departureWeekdays: [2, 4] },
      { id: 'SA', label: 'Adelaide hub', zonePrefixes: ['SA'], departureWeekdays: [3] },
      { id: 'WA', label: 'Perth hub', zonePrefixes: ['WA'], departureWeekdays: [1] },
      { id: 'TAS', label: 'Hobart hub', zonePrefixes: ['TAS'], departureWeekdays: [3] },
      { id: 'NT', label: 'Darwin hub', zonePrefixes: ['NT'], departureWeekdays: [1] },
    ],
    trailer: { id: 'ftl-semi', name: 'FTL semi', capacityM3: 75, note: '22 pallet spaces' },
    ltlMaxM3: 25,
    minFtlFill: 0.8,
    earlyDays: 3,
  },
  container: {
    containers: [
      { id: '20GP', name: "20' GP", capacityM3: 28, note: 'Internal 5.90 × 2.35 × 2.39 m (33 m³)' },
      { id: '40GP', name: "40' GP", capacityM3: 58, note: 'Internal 12.03 × 2.35 × 2.39 m (67 m³)' },
      { id: '40HC', name: "40' HC", capacityM3: 68, note: 'Internal 12.03 × 2.35 × 2.69 m (76 m³)' },
    ],
    zonePrefixes: ['NZ', 'Export', 'Hong Kong'],
    splitByCityZones: ['Export-ROW'],
    departureWeekdays: [4],
    lclMaxM3: 15,
    minFclFill: 0.85,
    earlyDays: 10,
  },
  pickupZones: ['NSW-Customer Pickup'],
  preferVolume: 'cubics',
  deadline: 'needBy',
  shipmentValue: 'goods',
  sifotTarget: 0.95,
  contractors: {},
  firmDays: 2,
  trucksPerDay: 3,
  containersPerDay: 2,
  levelToLimits: true,
  stagingAuto: true,
  stagingCapacityM3: 150,
  holidays: [],
};

/**
 * The marshalling area's daily capacity, m³. Derived by default from what the
 * dock can load out in a day: the truck limit at the largest truck or
 * trailer, plus the container limit at the largest container — 3 × 75 m³ +
 * 2 × 68 m³ = 361 m³ with the default sizes. Falls back to the set figure when
 * derivation is off or a limit is 0.
 */
export function stagingCapacity(s: DispatchSettings): number {
  if (!s.stagingAuto || s.trucksPerDay <= 0 || s.containersPerDay <= 0) return s.stagingCapacityM3;
  return s.trucksPerDay * largestTruck(s) + s.containersPerDay * largestContainer(s);
}

export const largestTruck = (s: DispatchSettings): number =>
  Math.max(0, s.linehaul.trailer.capacityM3, ...s.fleet.trucks.map((e) => e.capacityM3));

export const largestContainer = (s: DispatchSettings): number =>
  Math.max(0, ...s.container.containers.map((e) => e.capacityM3));

export type DeadlineField = 'needBy' | 'shipBy';

export const DEADLINE_LABEL: Record<DeadlineField, string> = {
  needBy: 'Need By',
  shipBy: 'Ship By',
};

/** The last day an order may leave, from the date the settings name. */
export const dueDate = (order: ShipmentOrder, field: DeadlineField): DayKey | null =>
  field === 'needBy' ? order.needBy ?? order.shipBy : order.shipBy ?? order.needBy;

/** Where an order is routed. `group` is what may be consolidated together. */

/** The part of a group before its zone and carrier: `linehaul:QLD`. */
export const groupBase = (group: string): string => group.split('|')[0];
export type Route =
  | { mode: 'fleet'; group: string; label: string; runClass: FleetRunClass }
  | { mode: 'linehaul'; group: string; label: string; hub: LinehaulHub }
  | { mode: 'container'; group: string; label: string }
  | { mode: 'pickup'; group: string; label: string };

const startsWithToken = (zone: string, prefix: string): boolean => {
  const z = zone.trim().toUpperCase();
  const p = prefix.trim().toUpperCase();
  if (!p || !z.startsWith(p)) return false;
  // `SA` must not claim a zone that merely begins with the letters, such as
  // `SAMOA`; the prefix has to end at a separator or the end of the zone.
  const next = z.charAt(p.length);
  return next === '' || /[\s\-_/]/.test(next);
};

/**
 * Route a zone, or null if unmapped. `group` is what may share a load:
 *
 * - NSW delivery: run class + zone + Ship Via (or the run class alone, when
 *   neighbouring zones may share a truck);
 * - linehaul: hub + zone + Ship Via — each carrier and region its own;
 * - containers: destination (per city for split zones) + Ship Via.
 */
export function routeFor(
  zone: string,
  city: string,
  settings: DispatchSettings,
  shipVia = '',
): Route | null {
  const key = zone.trim();
  const via = shipVia.trim();
  const tail = via ? ` · ${via}` : '';
  if (settings.pickupZones.some((z) => z.trim() === key)) {
    return { mode: 'pickup', group: 'pickup', label: 'Customer pickup' };
  }
  const runClass = settings.fleet.runClasses.find((c) =>
    c.zones.some((z) => z.trim() === key),
  );
  if (runClass) {
    return settings.fleet.keepShipViaApart
      ? { mode: 'fleet', group: `fleet:${runClass.id}|${key}|${via}`, label: `${key}${tail}`, runClass }
      : { mode: 'fleet', group: `fleet:${runClass.id}`, label: runClass.label, runClass };
  }
  const hub = settings.linehaul.hubs.find((h) =>
    h.zonePrefixes.some((p) => startsWithToken(key, p)),
  );
  if (hub) {
    return {
      mode: 'linehaul',
      group: `linehaul:${hub.id}|${key}|${via}`,
      label: `${hub.label} · ${key}${tail}`,
      hub,
    };
  }
  if (settings.container.zonePrefixes.some((p) => startsWithToken(key, p))) {
    const perCity = settings.container.splitByCityZones.some((z) => z.trim() === key);
    const destination = perCity ? `${key} · ${city.trim()}` : key;
    return { mode: 'container', group: `container:${destination}|${via}`, label: `${destination}${tail}` };
  }
  return null;
}

/**
 * A load the planner has taken over from the optimiser: frozen, no longer
 * re-planned.
 *
 * - `edited` — changed by hand (an order moved, a size or day picked) but not
 *   booked yet;
 * - `confirmed` — booked with the carrier or the fleet;
 * - `dispatched` — gone.
 */
export interface FirmLoad {
  id: string;
  group: string;
  mode: DispatchMode;
  label: string;
  day: DayKey;
  /** Equipment name, `Part load`, `LTL`, `LCL` or `Pickup`. */
  equipment: string;
  capacityM3: number | null;
  orderIds: string[];
  /** Volume per order when frozen, for orders that later leave the export. */
  volumes: Record<string, number>;
  /**
   * Orders only partly on this load (a split piece), with the m³ carried
   * here. The rest of such an order is still planned.
   */
  pieces?: Record<string, number>;
  /** The planner picked the size: keep it when orders move on or off. */
  sizeLocked?: boolean;
  status: 'edited' | 'confirmed' | 'dispatched';
  confirmedAt: string;
  dispatchedAt?: string;
}

/** Planner decisions layered over the export. */
export interface DispatchDecisions {
  /** Order → the day it must go, overriding the optimiser. */
  pins: Record<string, DayKey>;
  /** Orders held back from planning (customer asked to wait, etc.). */
  holds: Record<string, string>;
  /** Order → volume in m³, overriding or filling in the freight line. */
  volumeOverrides: Record<string, number>;
  firmLoads: FirmLoad[];
}

export const EMPTY_DECISIONS: DispatchDecisions = {
  pins: {},
  holds: {},
  volumeOverrides: {},
  firmLoads: [],
};
