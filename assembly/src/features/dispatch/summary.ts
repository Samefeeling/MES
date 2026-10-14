/**
 * The plan rolled up by day and by ISO week, for the volume chart and the
 * weekly table. Pure, so the two views and their tests agree on every number.
 */

import { dueDate, type DayKey, type DeadlineField, type DispatchMode } from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { addCalendarDays, isoWeekday } from '@/engine/dispatch/calendar';
import { fromDayKey } from '@/lib/time';

export const MODES: DispatchMode[] = ['fleet', 'linehaul', 'container', 'pickup'];

export interface Bucket {
  /** The day, or the Monday that starts the week. */
  key: DayKey;
  days: DayKey[];
  volume: Record<DispatchMode, number>;
  loads: Record<DispatchMode, number>;
  total: number;
  orders: number;
  weightKg: number;
  /** NSW truck runs, linehaul trailers and containers (not part loads). */
  vehicles: number;
  /** NSW part loads, plus LTL and LCL shipments. */
  partLoads: number;
  /** How many of each vehicle, container or part load: what to book. */
  equipment: Record<string, number>;
  /** Fill of vehicles and containers, by volume over capacity. */
  fill: number | null;
  pulledForward: number;
  /** Orders leaving after their due date (Need By, or Ship By). */
  late: number;
}

const zero = (): Record<DispatchMode, number> => ({ fleet: 0, linehaul: 0, container: 0, pickup: 0 });

/** The Monday of the week a day falls in. */
export const weekStart = (day: DayKey): DayKey => addCalendarDays(day, 1 - isoWeekday(day));

/** ISO 8601 week number. */
export function isoWeek(day: DayKey): number {
  const d = fromDayKey(day);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export function summarise(
  loads: readonly PlannedLoad[],
  by: 'day' | 'week',
  deadline: DeadlineField = 'needBy',
): Bucket[] {
  const buckets = new Map<DayKey, Bucket & { capacity: number; filled: number; orderIds: Set<string> }>();
  for (const load of loads) {
    const key = by === 'day' ? load.day : weekStart(load.day);
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        days: [],
        volume: zero(),
        loads: zero(),
        total: 0,
        orders: 0,
        weightKg: 0,
        vehicles: 0,
        partLoads: 0,
        equipment: {},
        fill: null,
        pulledForward: 0,
        late: 0,
        capacity: 0,
        filled: 0,
        orderIds: new Set(),
      };
      buckets.set(key, b);
    }
    if (!b.days.includes(load.day)) b.days.push(load.day);
    b.volume[load.mode] += load.volumeM3;
    b.loads[load.mode] += 1;
    b.total += load.volumeM3;
    b.weightKg += load.weightKg;
    if (load.mode !== 'pickup') {
      b.equipment[load.equipment] = (b.equipment[load.equipment] ?? 0) + 1;
      if (load.capacityM3) {
        b.vehicles += 1;
        b.capacity += load.capacityM3;
        b.filled += load.volumeM3;
      } else {
        b.partLoads += 1;
      }
    }
    for (const d of load.drops) {
      if (b.orderIds.has(d.orderId)) continue;
      b.orderIds.add(d.orderId);
      if (d.daysEarly > 0) b.pulledForward += 1;
      const due = d.order ? dueDate(d.order, deadline) : null;
      if (due && due < load.day) b.late += 1;
    }
  }
  return [...buckets.values()]
    .map(({ capacity, filled, orderIds, ...b }) => ({
      ...b,
      days: b.days.sort(),
      orders: orderIds.size,
      fill: capacity > 0 ? filled / capacity : null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** `2 × Semi 22-pallet · 1 × 40' HC · 3 × LTL`, largest count first. */
export const equipmentMix = (mix: Record<string, number>): string =>
  Object.entries(mix)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} × ${name}`)
    .join(' · ');
