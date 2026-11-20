/**
 * Yesterday's finished orders and who finished them — the dialog's state.
 *
 * Read from `CompletedJobs.csv`, `ASSY_Planning` and `ASSY_CompletedJobs` by
 * `features/assembly/completions`; nothing here talks to SharePoint.
 */

import { create } from 'zustand';
import type { Completion } from '@/engine/assembly/completedJobs';
import type { CompletionOrder, StoredDay } from '@/engine/assembly/completionRecord';

export interface Person {
  id: string;
  name: string;
}

export interface CompletionItem {
  completion: Completion;
  /** The completion's row in ASSY_CompletedJobs, once it has one. */
  row: StoredDay | null;
  /** The line the order is on. */
  line: string;
  /** The order's Due Date and quantity, for the row written. */
  order: CompletionOrder;
  /** The export's running total for the order through this day. */
  doneToDate: number;
  /** Who is down as having finished it — confirmed, or offered until it is. */
  people: Person[];
  /**
   * Where the names first offered came from: the saved confirmation, the
   * line's group on the board that day, the board's crew on the order, the
   * order's ASSY_Planning rows, or nowhere.
   */
  offeredFrom: 'saved' | 'line' | 'order' | 'planning' | 'none';
  /** The line's group that day who were on leave, and so not offered. */
  onLeave: Person[];
  /**
   * The supervisor has changed the names. Only then does a refresh keep them:
   * kept unconditionally, the empty offer of a first read made before the
   * roster and the line groups were in stuck for the whole session.
   */
  edited: boolean;
  confirmed: boolean;
  confirmedBy: string;
  /** Set while this one is being written. */
  saving: boolean;
  error: string | null;
}

/** A line's group in the dialog: who is offered on its orders, and who was away. */
export interface LineGroupCrew {
  /** The day the group is for — the line's latest completion day. */
  day: string;
  people: Person[];
  onLeave: Person[];
  /** Changed in the dialog; kept across a refresh. */
  edited: boolean;
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
  /**
   * Everything `CompletedJobs.csv` shows reported against each order, all
   * days. The planning sync takes an order off `ASSY_Planning` once this
   * reaches its quantity.
   */
  doneQty: Record<string, number>;
  /** Line name → its group, as the dialog's line headings show it. */
  lineGroups: Record<string, LineGroupCrew>;
  setOpen: (open: boolean) => void;
  setPeople: (key: string, people: Person[]) => void;
  /** Add one person to an order, if they are not on it already. */
  addPerson: (key: string, person: Person) => void;
  setLineGroup: (line: string, people: Person[]) => void;
  /** Put the line's group on every order of the line not yet confirmed. */
  fillLine: (line: string) => void;
}

const samePerson = (a: Person, b: Person): boolean =>
  (a.id !== '' && a.id === b.id) || a.name.toLowerCase() === b.name.toLowerCase();

export const useCompletionStore = create<CompletionState>((set) => ({
  status: 'idle',
  window: null,
  items: [],
  error: null,
  warnings: [],
  open: false,
  autoOpenedFor: null,
  local: false,
  doneQty: {},
  lineGroups: {},
  setOpen: (open) => set({ open }),
  setPeople: (key, people) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.completion.key === key ? { ...item, people, edited: true, error: null } : item,
      ),
    })),
  addPerson: (key, person) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.completion.key !== key || item.confirmed || item.people.some((p) => samePerson(p, person))
          ? item
          : { ...item, people: [...item.people, person], edited: true, error: null },
      ),
    })),
  setLineGroup: (line, people) =>
    set((s) => {
      const held = s.lineGroups[line];
      if (!held) return s;
      return { lineGroups: { ...s.lineGroups, [line]: { ...held, people, edited: true } } };
    }),
  fillLine: (line) =>
    set((s) => {
      const group = s.lineGroups[line];
      if (!group) return s;
      return {
        items: s.items.map((item) =>
          item.line !== line || item.confirmed ? item : { ...item, people: [...group.people], edited: true, error: null },
        ),
      };
    }),
}));

/** Orders in the window nobody has put names to yet. */
export const unconfirmedCount = (items: readonly CompletionItem[]): number =>
  items.filter((item) => !item.confirmed).length;

/** Orders with a completion in the window nobody has confirmed yet. */
export const unconfirmedJobs = (items: readonly CompletionItem[]): string[] =>
  [...new Set(items.filter((item) => !item.confirmed).map((item) => item.completion.jobNum))].sort();
