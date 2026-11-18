/**
 * Yesterday's finished orders and who finished them — the dialog's state.
 *
 * Read from `CompletedJobs.csv` and `ASSY_Production` by
 * `features/assembly/completions`; nothing here talks to SharePoint.
 */

import { create } from 'zustand';
import type { Completion } from '@/engine/assembly/completedJobs';
import type { StoredDay } from '@/engine/assembly/completionRecord';

export interface Person {
  id: string;
  name: string;
}

export interface CompletionItem {
  completion: Completion;
  /** The order's row for that day in ASSY_Production, if it has one. */
  row: StoredDay | null;
  /** The line the order is on, for a row that has to be opened. */
  line: string;
  /** Who is down as having finished it — confirmed, or offered until it is. */
  people: Person[];
  confirmed: boolean;
  confirmedBy: string;
  /** Set while this one is being written. */
  saving: boolean;
  error: string | null;
}

interface CompletionState {
  status: 'idle' | 'loading' | 'ready' | 'off' | 'failed';
  window: { from: string; to: string } | null;
  items: CompletionItem[];
  error: string | null;
  /** Problems reading the file that did not stop it being read. */
  warnings: string[];
  open: boolean;
  /** Opened by itself once this session for this window; not again after a close. */
  autoOpenedFor: string | null;
  /** True when nothing is written to SharePoint (the demo board). */
  local: boolean;
  setOpen: (open: boolean) => void;
  setPeople: (key: string, people: Person[]) => void;
}

export const useCompletionStore = create<CompletionState>((set) => ({
  status: 'idle',
  window: null,
  items: [],
  error: null,
  warnings: [],
  open: false,
  autoOpenedFor: null,
  local: false,
  setOpen: (open) => set({ open }),
  setPeople: (key, people) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.completion.key === key ? { ...item, people, error: null } : item,
      ),
    })),
}));

/** Orders in the window nobody has put names to yet. */
export const unconfirmedCount = (items: readonly CompletionItem[]): number =>
  items.filter((item) => !item.confirmed).length;
