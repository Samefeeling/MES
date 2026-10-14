/**
 * Hand edits to the load plan.
 *
 * The optimiser proposes; the planner may know better — two customers who
 * must not share a truck, a site that only takes deliveries on Fridays, a
 * container the forwarder has already booked. Every edit freezes the loads
 * it touches (status `edited`), so the next re-plan keeps them as the planner
 * left them and plans everything else around them:
 *
 * - **move** an order to another load, or onto a load of its own;
 * - **take an order off** a load and let the optimiser place it elsewhere;
 * - **size** a load — pick the truck, container or part load to book;
 * - **re-date** a load.
 *
 * A moved order takes its whole volume with it; a split piece takes only
 * that piece, and the rest of the order stays planned. Unless the planner
 * picked the size, a load is re-sized to fit what it now carries.
 *
 * Pure functions over the frozen-load list, so the store and the tests share
 * one implementation.
 */

import type { DayKey, DispatchSettings, FirmLoad } from '@/domain/dispatch';
import { fitEquipment, type PlannedLoad } from './plan';

const newId = (): string =>
  `firm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** A proposed load as a frozen one, keeping split pieces as pieces. */
export function freeze(load: PlannedLoad, status: FirmLoad['status'], now: string): FirmLoad {
  const orderIds = [...new Set(load.drops.map((d) => d.orderId))];
  const volumes: Record<string, number> = {};
  const pieces: Record<string, number> = {};
  for (const d of load.drops) {
    volumes[d.orderId] = (volumes[d.orderId] ?? 0) + d.volumeM3;
    if (d.piece) pieces[d.orderId] = (pieces[d.orderId] ?? 0) + d.volumeM3;
  }
  return {
    id: newId(),
    group: load.group,
    mode: load.mode,
    label: load.label,
    day: load.day,
    equipment: load.equipment,
    capacityM3: load.capacityM3,
    orderIds,
    volumes,
    ...(Object.keys(pieces).length > 0 ? { pieces } : {}),
    status,
    confirmedAt: now,
  };
}

const copy = (f: FirmLoad): FirmLoad => ({
  ...f,
  orderIds: [...f.orderIds],
  volumes: { ...f.volumes },
  ...(f.pieces ? { pieces: { ...f.pieces } } : {}),
});

/**
 * The frozen load behind a planned one — a copy of the existing one when the
 * planner already froze it, else a new `edited` one appended to the list.
 */
function take(list: FirmLoad[], load: PlannedLoad, now: string): FirmLoad {
  const at = list.findIndex((f) => f.id === load.id);
  if (at >= 0) {
    list[at] = copy(list[at]);
    return list[at];
  }
  const f = freeze(load, 'edited', now);
  list.push(f);
  return f;
}

const carried = (f: FirmLoad): number =>
  f.orderIds.reduce((s, id) => s + (f.pieces?.[id] ?? f.volumes[id] ?? 0), 0);

function refit(f: FirmLoad, settings: DispatchSettings): void {
  if (f.sizeLocked) return;
  const fit = fitEquipment(f.mode, carried(f), settings);
  f.equipment = fit.equipment;
  f.capacityM3 = fit.capacityM3;
}

/**
 * Move an order (or the piece of it on `from`) to `to`; onto a new load of
 * its own on the same route and day when `to` is null; or, with `replan`,
 * off `from` and back to the optimiser, which will not put it on `from`
 * again because `from` is now frozen.
 */
export function moveOrder(
  firmLoads: readonly FirmLoad[],
  settings: DispatchSettings,
  orderId: string,
  from: PlannedLoad,
  to: PlannedLoad | null | 'replan',
  now: string,
): FirmLoad[] {
  if (to && to !== 'replan' && to.id === from.id) return [...firmLoads];
  const drops = from.drops.filter((d) => d.orderId === orderId);
  if (drops.length === 0) return [...firmLoads];
  const list = [...firmLoads];
  const src = take(list, from, now);

  const volume = drops.reduce((s, d) => s + d.volumeM3, 0);
  const isPiece = src.pieces?.[orderId] !== undefined;
  src.orderIds = src.orderIds.filter((id) => id !== orderId);
  delete src.volumes[orderId];
  if (src.pieces) delete src.pieces[orderId];

  if (to === 'replan') {
    refit(src, settings);
    return list.filter((f) => f.orderIds.length > 0);
  }

  let dst: FirmLoad;
  if (to) {
    dst = take(list, to, now);
  } else {
    dst = {
      id: newId(),
      group: from.group,
      mode: from.mode,
      label: from.label,
      day: from.day,
      equipment: from.equipment,
      capacityM3: from.capacityM3,
      orderIds: [],
      volumes: {},
      status: 'edited',
      confirmedAt: now,
    };
    list.push(dst);
  }
  if (!dst.orderIds.includes(orderId)) dst.orderIds.push(orderId);
  dst.volumes[orderId] = (dst.volumes[orderId] ?? 0) + volume;
  if (isPiece || dst.pieces?.[orderId] !== undefined) {
    dst.pieces = { ...dst.pieces, [orderId]: (dst.pieces?.[orderId] ?? 0) + volume };
  }

  refit(src, settings);
  refit(dst, settings);
  return list.filter((f) => f.orderIds.length > 0);
}

/** Book a load in a size the planner picked; it then keeps that size. */
export function resizeLoad(
  firmLoads: readonly FirmLoad[],
  load: PlannedLoad,
  equipment: string,
  capacityM3: number | null,
  now: string,
): FirmLoad[] {
  const list = [...firmLoads];
  const f = take(list, load, now);
  f.equipment = equipment;
  f.capacityM3 = capacityM3;
  f.sizeLocked = true;
  return list;
}

/** Send a load on another day. */
export function redateLoad(
  firmLoads: readonly FirmLoad[],
  load: PlannedLoad,
  day: DayKey,
  now: string,
): FirmLoad[] {
  const list = [...firmLoads];
  take(list, load, now).day = day;
  return list;
}

/** Book a load: a proposal is frozen as confirmed, an edited one promoted. */
export function confirm(firmLoads: readonly FirmLoad[], load: PlannedLoad, now: string): FirmLoad[] {
  if (load.firm === 'confirmed' || load.firm === 'dispatched') return [...firmLoads];
  const list = [...firmLoads];
  const f = take(list, load, now);
  f.status = 'confirmed';
  f.confirmedAt = now;
  return list;
}

/**
 * Mark a load gone — a proposal, an edited or a booked load alike, since a
 * load booked by phone is not always marked booked first. Returns the frozen load's id, which
 * the shipment record is filed under.
 */
export function dispatchLoad(
  firmLoads: readonly FirmLoad[],
  load: PlannedLoad,
  now: string,
): { firmLoads: FirmLoad[]; id: string } {
  if (load.firm === 'dispatched') return { firmLoads: [...firmLoads], id: load.id };
  const list = [...firmLoads];
  const f = take(list, load, now);
  f.status = 'dispatched';
  f.dispatchedAt = now;
  return { firmLoads: list, id: f.id };
}
