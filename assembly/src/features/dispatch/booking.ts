/**
 * A day's loads as a booking sheet: one row per order on each load, with
 * everything a carrier asks for when the dock rings to book — who it goes to,
 * where, how much, by when — and the load it rides on repeated on every row,
 * so the CSV still makes sense once sorted or filtered in a spreadsheet.
 */

import {
  DEADLINE_LABEL,
  DISPATCH_MODE_LABEL,
  VOLUME_SOURCE_LABEL,
  dueDate,
  type DeadlineField,
} from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { toCsv } from '@/lib/csv';
import { READINESS } from './format';

/** `Proposed`, `Edited`, `Booked` or `Dispatched`. */
export const loadStatus = (load: PlannedLoad): string =>
  load.firm === 'confirmed'
    ? 'Booked'
    : load.firm === 'dispatched'
      ? 'Dispatched'
      : load.firm === 'edited'
        ? 'Edited'
        : 'Proposed';

/** The ship-to names on a load, in drop order, each once. */
export const shipToNames = (load: PlannedLoad): string[] => [
  ...new Set(load.drops.map((d) => d.order?.shipToName || d.order?.custId || d.orderId)),
];

/**
 * The contractor booked for a load, from its orders' Ship Via codes and the
 * names set in Settings; blank when none is set.
 */
export const contractorOf = (load: PlannedLoad, contractors: Readonly<Record<string, string>>): string =>
  [
    ...new Set(
      load.drops.map((d) => (contractors[d.order?.shipVia.trim() ?? ''] ?? '').trim()).filter(Boolean),
    ),
  ].join(' / ');

/** `1 Hume Hwy, Liverpool NSW 2170` from whatever the export carries. */
export const fullAddress = (o: { address: string; city: string; state: string; postcode: string }): string =>
  [o.address, [o.city, o.state, o.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

const day = (d: string | null): string => {
  if (!d) return '';
  const [y, m, dd] = d.split('-');
  return `${Number(dd)}/${m}/${y}`;
};

const round = (v: number, places = 2) => String(Math.round(v * 10 ** places) / 10 ** places);

export function bookingCsv(
  loads: readonly PlannedLoad[],
  deadline: DeadlineField,
  numbers?: ReadonlyMap<string, number>,
  contractors: Readonly<Record<string, string>> = {},
  /** The Assembly status of an order leaving on a day, when the board is loaded. */
  assembly?: (orderId: string, day: string) => string,
): string {
  const header = [
    'Dispatch day',
    'Load',
    'Status',
    'Mode',
    'Route',
    'Book',
    'Contractor',
    'Capacity m3',
    'Load m3',
    'Fill %',
    'Load kg',
    'Order',
    'Piece',
    'ShipToCustName',
    'Cust. ID',
    'Address',
    'City',
    'State',
    'Postcode',
    'Description',
    'Ship Via',
    'PickListComment',
    'm3',
    'Volume from',
    'kg',
    DEADLINE_LABEL[deadline],
    'ExpDeliveryDt',
    'Goods',
    'InPicking',
    'Assembly',
  ];
  const rows: string[][] = [header];
  loads.forEach((load, i) => {
    for (const d of load.drops) {
      const o = d.order;
      rows.push([
        day(load.day),
        `L${numbers?.get(load.id) ?? i + 1}`,
        loadStatus(load),
        DISPATCH_MODE_LABEL[load.mode],
        load.label,
        load.equipment,
        contractorOf(load, contractors),
        load.capacityM3 === null ? '' : String(load.capacityM3),
        round(load.volumeM3),
        load.fill === null ? '' : String(Math.round(load.fill * 100)),
        load.weightKg > 0 ? String(Math.round(load.weightKg)) : '',
        d.orderId,
        d.piece ? `${d.piece.index}/${d.piece.of}` : '',
        o?.shipToName ?? '',
        o?.custId ?? '',
        o?.address ?? '',
        o?.city ?? '',
        o?.state ?? '',
        o?.postcode ?? '',
        o?.zone ?? '',
        o?.shipVia ?? '',
        o?.pickListComment ?? '',
        d.volumeKnown ? round(d.volumeM3) : '',
        VOLUME_SOURCE_LABEL[d.volumeSource],
        d.weightKg === null ? '' : String(Math.round(d.weightKg)),
        day(o ? dueDate(o, deadline) : null),
        day(o?.expDelivery ?? null),
        o ? READINESS[o.readiness].label : '',
        o?.inPicking ? 'Yes' : '',
        assembly?.(d.orderId, load.day) ?? '',
      ]);
    }
  });
  return toCsv(rows);
}
