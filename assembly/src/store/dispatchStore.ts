/**
 * Dispatch planning state: the loaded waybill, the planner's decisions over
 * it, and the logistics settings the plan is built with.
 *
 * Kept in browser storage, separately from the assembly plan, so the
 * dispatch office can work from its own export without touching the board.
 * The plan itself is never stored: it is rebuilt from these on every change.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_DISPATCH_SETTINGS,
  EMPTY_DECISIONS,
  PART_LOAD,
  type DayKey,
  type DispatchDecisions,
  type DispatchSettings,
  type Equipment,
} from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { confirm, dispatchLoad, moveOrder, redateLoad, resizeLoad } from '@/engine/dispatch/edits';
import { SHIPMENT_RETENTION_DAYS, shipmentRecord, type ShipmentRecord } from '@/engine/dispatch/shipments';
import { addCalendarDays } from '@/engine/dispatch/calendar';
import { toDayKey } from '@/lib/time';

/** Dispatched loads are kept this long for reference, then dropped. */
const DISPATCHED_RETENTION_DAYS = 14;

interface DispatchState {
  csvText: string | null;
  fileName: string | null;
  loadedAt: string | null;
  /** The cubics sheet (product cube master), as loaded. */
  cubicsText: string | null;
  cubicsFileName: string | null;
  cubicsLoadedAt: string | null;
  settings: DispatchSettings;
  decisions: DispatchDecisions;
  /** What has left, for shipped dollars and SIFOT; kept apart from the waybill. */
  shipments: ShipmentRecord[];

  loadWaybill: (text: string, fileName: string) => void;
  clearWaybill: () => void;
  loadCubics: (text: string, fileName: string) => void;
  clearCubics: () => void;
  pin: (orderId: string, day: DayKey | null) => void;
  hold: (orderId: string, reason: string | null) => void;
  setVolume: (orderId: string, m3: number | null) => void;
  /** Book a proposed or edited load. */
  confirmLoad: (load: PlannedLoad) => void;
  /**
   * Move an order to another load, onto a new one when `to` is null, or off
   * this one for the optimiser to place with `replan`.
   */
  moveOrder: (orderId: string, from: PlannedLoad, to: PlannedLoad | null | 'replan') => void;
  resizeLoad: (load: PlannedLoad, equipment: string, capacityM3: number | null) => void;
  redateLoad: (load: PlannedLoad, day: DayKey) => void;
  /** The load has left: freeze it as dispatched and log the shipment. */
  markDispatched: (load: PlannedLoad) => void;
  /**
   * Hand a frozen load's orders back to the optimiser; on a dispatched load
   * this undoes the dispatch and removes its shipment record.
   */
  releaseLoad: (loadId: string) => void;
  updateSettings: (change: (current: DispatchSettings) => DispatchSettings) => void;
  resetSettings: () => void;
}

/** Saved equipment from before notes existed picks up the default note by id. */
const withNotes = (saved: Equipment[] | undefined, defaults: Equipment[]): Equipment[] =>
  (saved ?? defaults).map((e) => ({
    ...e,
    note: e.note ?? defaults.find((d) => d.id === e.id)?.note,
  }));

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export const useDispatchStore = create<DispatchState>()(
  persist(
    (set) => ({
      csvText: null,
      fileName: null,
      loadedAt: null,
      cubicsText: null,
      cubicsFileName: null,
      cubicsLoadedAt: null,
      settings: DEFAULT_DISPATCH_SETTINGS,
      decisions: EMPTY_DECISIONS,
      shipments: [],

      loadWaybill: (csvText, fileName) =>
        set((s) => {
          const cutoff = addCalendarDays(toDayKey(new Date()), -DISPATCHED_RETENTION_DAYS);
          return {
            csvText,
            fileName,
            loadedAt: new Date().toISOString(),
            decisions: {
              ...s.decisions,
              firmLoads: s.decisions.firmLoads.filter(
                (l) => l.status !== 'dispatched' || l.day >= cutoff,
              ),
            },
          };
        }),
      clearWaybill: () => set({ csvText: null, fileName: null, loadedAt: null }),
      loadCubics: (cubicsText, cubicsFileName) =>
        set({ cubicsText, cubicsFileName, cubicsLoadedAt: new Date().toISOString() }),
      clearCubics: () => set({ cubicsText: null, cubicsFileName: null, cubicsLoadedAt: null }),

      pin: (orderId, day) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            pins: day ? { ...s.decisions.pins, [orderId]: day } : without(s.decisions.pins, orderId),
          },
        })),
      hold: (orderId, reason) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            holds:
              reason === null
                ? without(s.decisions.holds, orderId)
                : { ...s.decisions.holds, [orderId]: reason },
          },
        })),
      setVolume: (orderId, m3) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            volumeOverrides:
              m3 === null || !Number.isFinite(m3) || m3 < 0
                ? without(s.decisions.volumeOverrides, orderId)
                : { ...s.decisions.volumeOverrides, [orderId]: m3 },
          },
        })),

      confirmLoad: (load) =>
        set((s) => ({
          decisions: { ...s.decisions, firmLoads: confirm(s.decisions.firmLoads, load, new Date().toISOString()) },
        })),
      moveOrder: (orderId, from, to) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            firmLoads: moveOrder(s.decisions.firmLoads, s.settings, orderId, from, to, new Date().toISOString()),
          },
        })),
      resizeLoad: (load, equipment, capacityM3) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            firmLoads: resizeLoad(s.decisions.firmLoads, load, equipment, capacityM3, new Date().toISOString()),
          },
        })),
      redateLoad: (load, day) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            firmLoads: redateLoad(s.decisions.firmLoads, load, day, new Date().toISOString()),
          },
        })),
      markDispatched: (load) =>
        set((s) => {
          if (load.firm === 'dispatched') return s;
          const now = new Date().toISOString();
          const today = toDayKey(new Date());
          const { firmLoads, id } = dispatchLoad(s.decisions.firmLoads, load, now);
          const record = { ...shipmentRecord(load, s.settings.deadline, today, now), loadId: id };
          const cutoff = addCalendarDays(today, -SHIPMENT_RETENTION_DAYS);
          return {
            decisions: { ...s.decisions, firmLoads },
            shipments: [...s.shipments.filter((r) => r.loadId !== id && r.day >= cutoff), record],
          };
        }),
      releaseLoad: (loadId) =>
        set((s) => ({
          decisions: {
            ...s.decisions,
            firmLoads: s.decisions.firmLoads.filter((l) => l.id !== loadId),
          },
          shipments: s.shipments.filter((r) => r.loadId !== loadId),
        })),

      updateSettings: (change) => set((s) => ({ settings: change(s.settings) })),
      resetSettings: () => set({ settings: DEFAULT_DISPATCH_SETTINGS }),
    }),
    {
      name: 'resero.dispatch.v1',
      // v1: NSW runs keep each zone and Ship Via apart. Copies saved before
      // that carry the old default (mixed), which would otherwise win.
      // v2: no own fleet — the small NSW run once called `Carrier` is a
      // `Part load` booked with the contractor.
      version: 2,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<DispatchState>;
        if (from < 1 && p.settings?.fleet) {
          p.settings = { ...p.settings, fleet: { ...p.settings.fleet, keepShipViaApart: true } };
        }
        if (from < 2) {
          const rename = <T extends { equipment: string }>(x: T): T =>
            x.equipment === 'Carrier' ? { ...x, equipment: PART_LOAD } : x;
          if (p.decisions?.firmLoads) {
            p.decisions = { ...p.decisions, firmLoads: p.decisions.firmLoads.map(rename) };
          }
          if (p.shipments) p.shipments = p.shipments.map(rename);
        }
        return p as DispatchState;
      },
      // Settings added in a later release fall back to their defaults rather
      // than arriving as undefined from an older saved copy.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DispatchState>;
        const ps = p.settings;
        return {
          ...current,
          ...p,
          settings: ps
            ? {
                ...DEFAULT_DISPATCH_SETTINGS,
                ...ps,
                fleet: {
                  ...DEFAULT_DISPATCH_SETTINGS.fleet,
                  ...ps.fleet,
                  trucks: withNotes(ps.fleet?.trucks, DEFAULT_DISPATCH_SETTINGS.fleet.trucks),
                },
                linehaul: { ...DEFAULT_DISPATCH_SETTINGS.linehaul, ...ps.linehaul },
                container: {
                  ...DEFAULT_DISPATCH_SETTINGS.container,
                  ...ps.container,
                  containers: withNotes(ps.container?.containers, DEFAULT_DISPATCH_SETTINGS.container.containers),
                },
              }
            : current.settings,
          decisions: { ...EMPTY_DECISIONS, ...p.decisions },
        };
      },
    },
  ),
);
