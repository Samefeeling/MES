/**
 * What a load card tells the dock to book: the recommended vehicle or
 * container, and the size ladder that explains the pick.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_DISPATCH_SETTINGS, type DispatchMode } from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { recommendation, sizeLadder } from '@/features/dispatch/equipment';
import { equipmentMix } from '@/features/dispatch/summary';

const load = (mode: DispatchMode, equipment: string, volumeM3: number, capacityM3: number | null): PlannedLoad => ({
  id: 'x',
  group: 'g',
  mode,
  label: 'Test',
  day: '2026-10-12',
  equipment,
  capacityM3,
  drops: [],
  volumeM3,
  fill: capacityM3 ? volumeM3 / capacityM3 : null,
  weightKg: 0,
  weightComplete: true,
  firm: null,
  warnings: [],
});

const s = DEFAULT_DISPATCH_SETTINGS;

describe('recommendation', () => {
  it('names the truck and its usable volume', () => {
    expect(recommendation(load('fleet', 'Rigid 12-pallet', 37, 45), s)).toBe(
      '1 × Rigid 12-pallet truck — 45 m³ usable · 12 pallet spaces',
    );
  });

  it('names the container with its internal size', () => {
    expect(recommendation(load('container', "40' HC", 61.5, 68), s)).toMatch(
      /^1 × 40' HC container — 68 m³ usable · Internal 12.03 × 2.35 × 2.69 m/,
    );
  });

  it('says how to book a part load', () => {
    expect(recommendation(load('linehaul', 'LTL', 5, null), s)).toMatch(/LTL/);
    expect(recommendation(load('container', 'LCL', 6, null), s)).toMatch(/LCL/);
    expect(recommendation(load('fleet', 'Part load', 1, null), s)).toMatch(/part load \(pallet freight\)/);
  });
});

describe('sizeLadder', () => {
  it('lists every truck with its fill, the smaller ones too small', () => {
    const ladder = sizeLadder(load('fleet', 'Rigid 12-pallet', 37, 45), s);
    expect(ladder.map((o) => o.name)).toEqual(['Part load', 'Rigid 8-pallet', 'Rigid 12-pallet', 'Semi 22-pallet']);
    const [partLoad, rigid8, rigid12, semi] = ladder;
    expect(partLoad.fits).toBe(false);
    expect(rigid8.fits).toBe(false);
    expect(rigid12).toMatchObject({ chosen: true, fits: true });
    expect(rigid12.fill).toBeCloseTo(37 / 45);
    expect(semi.fill).toBeCloseTo(37 / 75);
  });

  it('puts LCL below the containers', () => {
    const ladder = sizeLadder(load('container', "20' GP", 25, 28), s);
    expect(ladder.map((o) => o.name)).toEqual(['LCL', "20' GP", "40' GP", "40' HC"]);
    expect(ladder[0].fits).toBe(false);
    expect(ladder[1].chosen).toBe(true);
  });

  it('has nothing to choose for a pickup', () => {
    expect(sizeLadder(load('pickup', 'Pickup', 1, null), s)).toEqual([]);
  });
});

describe('equipmentMix', () => {
  it('reads as a booking list, most first', () => {
    expect(equipmentMix({ "40' HC": 1, 'Semi 22-pallet': 2, LTL: 1 })).toBe(
      "2 × Semi 22-pallet · 1 × 40' HC · 1 × LTL",
    );
  });
});
