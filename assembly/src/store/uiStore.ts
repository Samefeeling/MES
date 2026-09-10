/**
 * Ephemeral view state that isn't part of the plan or the data: which order is
 * open and where, the Gantt zoom and columns, and the two questions that may
 * be waiting on the supervisor — weekend working, and one person on two orders
 * at once.
 */

import { create } from 'zustand';
import type { LineKey } from '@/domain/assembly';
import type { OrderSort, OrderSortKey } from '@/features/assembly/boardView';

/**
 * A bar dropped on a Saturday or Sunday. Nothing is written to the plan until
 * the supervisor answers: the factory is closed, so weekend work costs money
 * and is theirs to authorise.
 */
export interface OvertimeRequest {
  jobId: string;
  /** ISO day the bar was dropped on. */
  isoDay: string;
  /** First working day at or after `isoDay` — the "move it to Monday" answer. */
  nextWorkingIsoDay: string;
}

/** Day column width, in pixels: the default, and how far it may be pushed. */
export const DEFAULT_DAY_WIDTH = 92;
export const MIN_DAY_WIDTH = 44;
export const MAX_DAY_WIDTH = 160;

/**
 * The frozen columns down the left of the board, in the order it draws them,
 * and how wide each opens.
 *
 * Every one of them is dragged by its right-hand edge. Which column needs the
 * room is not something a default can know: one plant's order numbers are
 * twice another's, a line running four-handed needs a Team column a line
 * running singles does not, and the same board is read on a 13" laptop and on
 * a floor screen. So the widths are the reader's, not ours.
 */
export const COLUMN_KEYS = [
  'order',
  'qty',
  'hours',
  'start',
  'due',
  'expect',
  'team',
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type ColumnWidths = Record<ColumnKey, number>;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  order: 200,
  qty: 58,
  hours: 82,
  start: 62,
  due: 62,
  expect: 62,
  team: 172,
};

/**
 * How far each column may be dragged. The floor is what the heading itself
 * needs to stay readable — a column dragged to nothing is a column somebody
 * has to find again — and the ceiling keeps one column from taking the grid.
 */
export const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  order: { min: 120, max: 520 },
  qty: { min: 46, max: 200 },
  hours: { min: 58, max: 220 },
  start: { min: 48, max: 220 },
  due: { min: 48, max: 220 },
  expect: { min: 48, max: 220 },
  team: { min: 96, max: 460 },
};

/** CSS custom property carrying each column's width to the stylesheet. */
export const COLUMN_VAR: Record<ColumnKey, string> = {
  order: '--order-w',
  qty: '--qty-w',
  hours: '--hours-w',
  start: '--start-w',
  due: '--due-w',
  expect: '--expect-w',
  team: '--team-w',
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(n)));

/** The four date columns, in the order the board draws them. */
export const DATE_COLS = ['start', 'due', 'expect'] as const;
export type DateCol = (typeof DATE_COLS)[number];
export type DateCols = Record<DateCol, boolean>;

/**
 * Lines the board opens folded away.
 *
 * TBP and PMD are both context: neither is planned here — PMD mirrors
 * moulding's own schedule and TBP is scheduled elsewhere — so they were the
 * first two rows of a board whose subject is the assembly floor. They come
 * back from a chip in the header, so nothing is hidden without a way to see it.
 */
export const LINES_HIDDEN_BY_DEFAULT: readonly LineKey[] = ['TBP', 'PMD'];

/** Column headings, shared by the board and the chip that brings one back. */
export const DATE_COL_LABEL: Record<DateCol, string> = {
  start: 'Start Date',
  due: 'Due Date',
  expect: 'Expect Date',
};

/** Where on screen an order was clicked, so its detail opens beside it. */
export interface ClickPoint {
  x: number;
  y: number;
}

/**
 * Someone about to be put on an order they cannot be on: they are already
 * booked on another at the same time. Nothing is written until the supervisor
 * answers, because a person doing two jobs at once is a claim about the floor,
 * not about the plan.
 */
export interface ClashRequest {
  jobId: string;
  workerId: string;
  workerName: string;
  /** The orders they are already on across those days. */
  withJobIds: string[];
  /** How each of those reads on the board: "ASM8002 · UPL · 4 Sep – 8 Sep". */
  withLabels: string[];
  /** Optional bounded hand-over window; absent means the whole order. */
  fromDay?: string | null;
  toDayExclusive?: string | null;
}

interface UiState {
  /** Order shown in the inspector. */
  selectedJobId: string | null;
  /**
   * Orders ticked with Ctrl (or Cmd) held, to be moved as one. Separate from
   * `selectedJobId`, which is the single order the detail panel is showing:
   * marking a run of orders is a different act from opening one to read it.
   */
  marked: string[];
  /**
   * Where the pointer was when it was picked. The detail opens there rather
   * than in a fixed column: the supervisor is already looking at that row, and
   * the schedule keeps the whole width.
   */
  selectedAt: ClickPoint | null;
  overtimeRequest: OvertimeRequest | null;
  clashRequest: ClashRequest | null;
  /** The only employee picker allowed to be open on the board. */
  crewPickerJobId: string | null;
  /** The one person's week open on the board, by worker id. */
  workerLoadId: string | null;
  lastRefresh: Date | null;
  /**
   * Timeline zoom. It lives here rather than in the board because the zoom
   * buttons sit in the app header, above the board that answers to them.
   */
  dayWidth: number;
  /** Width of each frozen column, dragged by its right-hand edge. */
  colWidths: ColumnWidths;
  /** Which date columns are showing; hidden ones come back from the header. */
  dateCols: DateCols;
  /** Lines folded away; they come back from a chip in the header. */
  hiddenLines: LineKey[];
  /**
   * The one day the board is narrowed to, as a local YYYY-MM-DD, or null for
   * every order — which is how it opens.
   *
   * A board that opens already hiding two thirds of its orders, with no
   * visible reason, is not a filtered board: it is a wrong one, and that is
   * exactly how it read — rows appeared as bars were dragged into the window
   * and the arrows to the press work came and went with them. So the only
   * narrowing left is the day chip under a column, which says on its face
   * which day it picked.
   */
  orderDay: string | null;
  /** Weekend timeline columns; hidden by default to keep the working week compact. */
  showWeekends: boolean;
  /** Sort the displayed rows without changing the scheduler's line sequence. */
  orderSort: OrderSort;

  /** Show an order's detail; `at` moves the panel, omitting it leaves it. */
  select: (jobId: string | null, at?: ClickPoint) => void;
  /** Add or remove one order from the set being moved together. */
  toggleMark: (jobId: string) => void;
  clearMarks: () => void;
  setCrewPicker: (jobId: string | null) => void;
  setWorkerLoad: (workerId: string | null) => void;
  /**
   * Close the topmost thing that is open, and say whether there was one.
   *
   * Escape used to be five separate listeners, one per thing that could be
   * open, and they all fired at once: closing the order detail also let go of
   * a run of orders the planner had spent a minute marking. So the layers are
   * ordered here instead — worst interruption first — and one press closes
   * one of them.
   */
  dismissTop: () => boolean;
  setDayWidth: (px: number) => void;
  setColumnWidth: (key: ColumnKey, px: number) => void;
  toggleDateCol: (key: DateCol) => void;
  toggleLine: (key: LineKey) => void;
  setOrderDay: (day: string | null) => void;
  toggleWeekends: () => void;
  changeOrderSort: (key: OrderSortKey) => void;
  resetOrderSort: () => void;
  askOvertime: (request: OvertimeRequest) => void;
  clearOvertime: () => void;
  askClash: (request: ClashRequest) => void;
  clearClash: () => void;
  setLastRefresh: (when: Date) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  selectedJobId: null,
  marked: [],
  selectedAt: null,
  overtimeRequest: null,
  clashRequest: null,
  crewPickerJobId: null,
  workerLoadId: null,
  lastRefresh: null,
  dayWidth: DEFAULT_DAY_WIDTH,
  colWidths: { ...DEFAULT_COLUMN_WIDTHS },
  dateCols: { start: true, due: true, expect: true },
  hiddenLines: [...LINES_HIDDEN_BY_DEFAULT],
  orderDay: null,
  showWeekends: false,
  orderSort: { key: 'start', direction: 'asc' },

  // A follow-on pick — a predecessor in the detail itself — comes with no
  // point, and leaves the panel where the reader is already looking.
  select: (selectedJobId, at) =>
    set((state) => ({
      selectedJobId,
      selectedAt: at ?? state.selectedAt,
      crewPickerJobId: null,
      workerLoadId: null,
    })),
  toggleMark: (jobId) =>
    set((state) => ({
      marked: state.marked.includes(jobId)
        ? state.marked.filter((id) => id !== jobId)
        : [...state.marked, jobId],
    })),
  clearMarks: () => set({ marked: [] }),
  // The two popups that sit over the board are mutually exclusive, the way
  // opening an order's detail already closes the picker.
  setCrewPicker: (crewPickerJobId) =>
    set({ crewPickerJobId, workerLoadId: null }),
  setWorkerLoad: (workerLoadId) => set({ workerLoadId, crewPickerJobId: null }),

  dismissTop: () => {
    const state = get();
    // A question waiting on an answer first, then what sits over the board,
    // then the board's own state. Marking a run of orders is last: it is the
    // slowest thing here to rebuild and the least like a thing that is "open".
    const top =
      (state.overtimeRequest && { overtimeRequest: null }) ||
      (state.clashRequest && { clashRequest: null }) ||
      (state.crewPickerJobId && { crewPickerJobId: null }) ||
      (state.workerLoadId && { workerLoadId: null }) ||
      (state.selectedJobId && { selectedJobId: null }) ||
      (state.marked.length > 0 && { marked: [] });
    if (!top) return false;
    set(top);
    return true;
  },
  setDayWidth: (px) =>
    set({ dayWidth: clamp(px, MIN_DAY_WIDTH, MAX_DAY_WIDTH) }),
  setColumnWidth: (key, px) =>
    set((state) => ({
      colWidths: {
        ...state.colWidths,
        [key]: clamp(px, COLUMN_LIMITS[key].min, COLUMN_LIMITS[key].max),
      },
    })),
  toggleDateCol: (key) =>
    set((state) => ({
      dateCols: { ...state.dateCols, [key]: !state.dateCols[key] },
    })),
  toggleLine: (key) =>
    set((state) => ({
      hiddenLines: state.hiddenLines.includes(key)
        ? state.hiddenLines.filter((line) => line !== key)
        : [...state.hiddenLines, key],
    })),
  setOrderDay: (orderDay) => set({ orderDay }),
  toggleWeekends: () => set((state) => ({ showWeekends: !state.showWeekends })),
  changeOrderSort: (key) => set((state) => ({
    orderSort: {
      key,
      direction: state.orderSort.key === key && state.orderSort.direction === 'asc'
        ? 'desc' : 'asc',
    },
  })),
  resetOrderSort: () => set({ orderSort: { key: 'start', direction: 'asc' } }),
  askOvertime: (overtimeRequest) => set({ overtimeRequest }),
  clearOvertime: () => set({ overtimeRequest: null }),
  askClash: (clashRequest) => set({ clashRequest }),
  clearClash: () => set({ clashRequest: null }),
  setLastRefresh: (lastRefresh) => set({ lastRefresh }),
}));
