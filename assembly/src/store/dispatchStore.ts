/**
 * Dispatch planning state: the planner's decisions over the waybill, the
 * shipment log, and the logistics settings the plan is built with.
 *
 * The waybill itself is not here — it is read with the board's exports into
 * `waybillStore`. Where the `Waybill` SharePoint list is in use the decisions
 * and the log live on it too (`features/dispatch/waybillSource` reads them in
 * and writes every change back), so every screen plans from the same ones;
 * this browser keeps only the settings then. Without the list — the dev
 * server, the demo — the decisions are kept in this browser as before.
 *
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

/** Dispatched loads stay on the plan this long for reference. */
export const DISPATCHED_RETENTION_DAYS = 14;

interface DispatchState {
  settings: DispatchSettings;
  decisions: DispatchDecisions;
  /** What has left, for shipped dollars and SIFOT; kept apart from the waybill. */
  shipments: ShipmentRecord[];
  /**
   * The decisions and the log are the Waybill list's: read from it, written
   * to it, and not kept in this browser.
   */
  listBacked: boolean;
  /**
   * Load edits under way (Edit loads): the decisions and the log as they were
   * when editing began. Changes show at once but reach nobody else — not the
   * list, not this browser's saved copy — until **Save**; **Cancel** puts
   * these back.
   */
  editing: { decisions: DispatchDecisions; shipments: ShipmentRecord[] } | null;

  /** The decisions and the log as the Waybill list holds them. */
  fromList: (decisions: DispatchDecisions, shipments: ShipmentRecord[]) => void;
  /** Keep only what is recent enough to matter; for this browser's own copy. */
  prune: (today: DayKey) => void;
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
  beginEdit: () => void;
  /** Keep the load edits: they go to the list (or this browser) now. */
  saveEdit: () => void;
  /** Drop every change made since editing began. */
  cancelEdit: () => void;
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
      settings: DEFAULT_DISPATCH_SETTINGS,
      decisions: EMPTY_DECISIONS,
      shipments: [],
      listBacked: false,
      editing: null,

      fromList: (decisions, shipments) => set({ decisions, shipments, listBacked: true }),
      prune: (today) =>
        set((s) => {
          const loads = addCalendarDays(today, -DISPATCHED_RETENTION_DAYS);
          const log = addCalendarDays(today, -SHIPMENT_RETENTION_DAYS);
          return {
            decisions: {
              ...s.decisions,
              firmLoads: s.decisions.firmLoads.filter((l) => l.status !== 'dispatched' || l.day >= loads),
            },
            shipments: s.shipments.filter((r) => r.day >= log),
          };
        }),

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

      beginEdit: () =>
        set((s) => (s.editing ? s : { editing: { decisions: s.decisions, shipments: s.shipments } })),
      saveEdit: () => set({ editing: null }),
      cancelEdit: () =>
        set((s) => (s.editing ? { ...s.editing, editing: null } : s)),

      updateSettings: (change) => set((s) => ({ settings: change(s.settings) })),
      resetSettings: () => set({ settings: DEFAULT_DISPATCH_SETTINGS }),
    }),
    {
      name: 'resero.dispatch.v1',
      // The settings always; the decisions and the log only while they are
      // this browser's own — the Waybill list holds them otherwise — and as
      // they were before any load edits not yet saved.
      partialize: (s) =>
        (s.listBacked
          ? { settings: s.settings }
          : {
              settings: s.settings,
              decisions: s.editing?.decisions ?? s.decisions,
              shipments: s.editing?.shipments ?? s.shipments,
            }) as DispatchState,
      // v1: NSW runs keep each zone and Ship Via apart. Copies saved before
      // that carry the old default (mixed), which would otherwise win.
      // v2: no own fleet — the small NSW run once called `Carrier` is a
      // `Part load` booked with the contractor.
      // v3: Ship By is the last day an order may leave. Need By is the
      // customer's date, and the copies saved before said otherwise.
      version: 3,
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
        if (from < 3 && p.settings) p.settings = { ...p.settings, deadline: 'shipBy' };
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
