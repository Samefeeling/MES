/**
 * The FactoryCalendar list, as the board holds it: read on every load and
 * refresh, written the moment a day is added or removed.
 *
 * The engine's calendar (`setFactoryCalendar`) follows `rows`, set before the
 * board is worked out again — `rows` is one of the board's inputs (see
 * `assemblySelectors`) for exactly that reason.
 */

import { create } from 'zustand';
import { setFactoryCalendar } from '@/engine/assembly/dates';
import {
  createCalendarBackend,
  type CalendarBackend,
  type CalendarRow,
} from '@/data/sharepoint/factoryCalendar.list';

interface CalendarState {
  rows: CalendarRow[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The last read or write that failed, for the panel. */
  error: string | null;
  /** A write is on its way. */
  busy: boolean;
  backend: CalendarBackend;
  load: () => Promise<void>;
  add: (day: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Swap the backend (tests). Does not load. */
  setBackend: (backend: CalendarBackend) => void;
}

const sorted = (rows: CalendarRow[]) => [...rows].sort((a, b) => a.day.localeCompare(b.day));

export const useCalendarStore = create<CalendarState>((set, get) => ({
  rows: [],
  status: 'idle',
  error: null,
  busy: false,
  backend: createCalendarBackend(),

  async load() {
    set({ status: 'loading' });
    const res = await get().backend.load();
    // A failed read keeps the days already known: a list outage must not
    // quietly reopen the factory on its RDOs.
    if (res.ok) set({ rows: res.value, status: 'ready', error: null });
    else set({ status: 'error', error: res.error });
  },

  async add(day, name) {
    set({ busy: true });
    const res = await get().backend.add(day, name);
    if (res.ok) {
      set((s) => ({ rows: sorted([...s.rows.filter((r) => r.day !== day), res.value]), busy: false, error: null }));
      return true;
    }
    set({ busy: false, error: res.error });
    return false;
  },

  async remove(id) {
    set({ busy: true });
    const res = await get().backend.remove(id);
    if (res.ok) {
      set((s) => ({ rows: s.rows.filter((r) => r.id !== id), busy: false, error: null }));
      return true;
    }
    set({ busy: false, error: res.error });
    return false;
  },

  setBackend(backend) {
    set({ backend, rows: [], status: 'idle', error: null });
  },
}));

setFactoryCalendar({ listed: useCalendarStore.getState().rows });
useCalendarStore.subscribe((state, prev) => {
  if (state.rows !== prev.rows) setFactoryCalendar({ listed: state.rows });
});
