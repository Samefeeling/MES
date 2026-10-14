/**
 * The size ladder behind a load's recommendation: every vehicle or container
 * its route can use, how full this load would make each, and which one the
 * plan picked — so the card says not just "a load" but what to book and why
 * the next size down would not do.
 */

import { PART_LOAD, type DispatchSettings, type Equipment } from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';

export interface SizeOption {
  name: string;
  /** Null for a part load (LTL / LCL / carrier), which has no fixed space. */
  capacityM3: number | null;
  fill: number | null;
  fits: boolean;
  chosen: boolean;
  note: string;
}

const bySize = (list: readonly Equipment[]) =>
  [...list].filter((e) => e.capacityM3 > 0).sort((a, b) => a.capacityM3 - b.capacityM3);

const rung = (e: Equipment, load: PlannedLoad): SizeOption => ({
  name: e.name,
  capacityM3: e.capacityM3,
  fill: load.volumeM3 / e.capacityM3,
  fits: load.volumeM3 <= e.capacityM3 + 1e-6,
  chosen: e.name === load.equipment,
  note: e.note ?? '',
});

const part = (name: string, maxM3: number, load: PlannedLoad, note: string): SizeOption => ({
  name,
  capacityM3: null,
  fill: null,
  fits: maxM3 <= 0 || load.volumeM3 <= maxM3 + 1e-6,
  chosen: load.equipment === name,
  note,
});

export function sizeLadder(load: PlannedLoad, settings: DispatchSettings): SizeOption[] {
  switch (load.mode) {
    case 'fleet':
      return [
        ...(settings.fleet.carrierMaxM3 > 0 || load.equipment === PART_LOAD
          ? [part(PART_LOAD, settings.fleet.carrierMaxM3, load, `Up to ${settings.fleet.carrierMaxM3} m³ as pallet freight`)]
          : []),
        ...bySize(settings.fleet.trucks).map((e) => rung(e, load)),
      ];
    case 'linehaul':
      return [
        part('LTL', settings.linehaul.ltlMaxM3, load, `Part load up to ${settings.linehaul.ltlMaxM3} m³`),
        rung(settings.linehaul.trailer, load),
      ];
    case 'container':
      return [
        part('LCL', settings.container.lclMaxM3, load, `Shared container up to ${settings.container.lclMaxM3} m³`),
        ...bySize(settings.container.containers).map((e) => rung(e, load)),
      ];
    case 'pickup':
      return [];
  }
}

/** The one-line recommendation a dock clerk books from. */
export function recommendation(load: PlannedLoad, settings: DispatchSettings): string {
  const chosen = sizeLadder(load, settings).find((o) => o.chosen);
  switch (load.equipment) {
    case 'Pickup':
      return 'Customer collects';
    case PART_LOAD:
      return 'Book a part load (pallet freight) — too small for a whole truck';
    case 'LTL':
      return 'Book a part load (LTL) with the linehaul carrier';
    case 'LCL':
      return 'Book LCL — too small to fill a container';
  }
  const noun = load.mode === 'container' ? 'container' : load.mode === 'linehaul' ? 'trailer' : 'truck';
  return chosen?.capacityM3
    ? `1 × ${load.equipment} ${noun} — ${chosen.capacityM3} m³ usable${chosen.note ? ` · ${chosen.note}` : ''}`
    : `1 × ${load.equipment}`;
}
