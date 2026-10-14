/**
 * The waybill as this screen last read it, and the cubics sheet — what the
 * Dispatch page plans from and what the Assembly board reads each job's Ship
 * By off. Filled by `features/dispatch/waybillSource` each time the board
 * reads its own exports; nothing here is kept in the browser.
 */

import { create } from 'zustand';
import type { NewColumn } from '@/engine/dispatch/waybillList';

/**
 * Where the waybill comes from:
 * - `list` — the `Waybill` SharePoint list, kept up to date from Waybill.csv;
 * - `file` — Waybill.csv read straight, with no list (the dev server);
 * - `none` — neither is configured.
 */
export type WaybillMode = 'list' | 'file' | 'none';

export interface SyncReport {
  at: string;
  created: number;
  updated: number;
  closed: number;
  unchanged: number;
  errors: string[];
  /**
   * Open rows the export no longer lists but that were not closed, because
   * there were too many at once to be a normal day: a partial export closes
   * nothing. `closeAnyway` in waybillSource closes them.
   */
  heldCloses: number;
}

interface WaybillState {
  mode: WaybillMode;
  /** The waybill as CSV text, for the waybill parser. */
  csvText: string | null;
  /** What it was read from, in words: "Waybill list", "Waybill.csv". */
  source: string | null;
  readAt: string | null;
  cubicsText: string | null;
  cubicsSource: string | null;
  loading: boolean;
  /** The waybill could not be read. */
  error: string | null;
  /** Things worth knowing that do not stop the page: columns missing, and the like. */
  notes: string[];
  /** The last time this screen brought the list into line with Waybill.csv. */
  lastSync: SyncReport | null;
  /** The planner's last changes did not all reach the list. */
  writeError: string | null;
  /** Planner changes on their way to the list. */
  saving: number;
  /** When this screen's last planner changes reached the list. */
  savedAt: string | null;
  /**
   * Columns the list lacks — the export's and the planner's — as they would
   * be added (`addMissingColumns` in waybillSource). The export's are known
   * only on a screen that syncs.
   */
  missingColumns: NewColumn[];
  addingColumns: boolean;
  /** Adding them did not work, and why. */
  columnsError: string | null;
}

export const useWaybillStore = create<WaybillState>(() => ({
  mode: 'none',
  csvText: null,
  source: null,
  readAt: null,
  cubicsText: null,
  cubicsSource: null,
  loading: false,
  error: null,
  notes: [],
  lastSync: null,
  writeError: null,
  saving: 0,
  savedAt: null,
  missingColumns: [],
  addingColumns: false,
  columnsError: null,
}));
