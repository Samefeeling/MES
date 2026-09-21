/**
 * Holds the loaded source data and its derived look-up indexes. The data
 * source is swappable (mock ↔ live Excel) via `setSource`.
 */

import { create } from 'zustand';
import type { PlanningDataset } from '@/domain/types';
import { createDataSource, type DataSource } from '@/data';
import { buildIndexes, type DataIndexes } from '@/engine/indexes';
import { trackNewOrders } from '@/features/refresh/newOrders';
import { withStepOrders } from '@/engine/assembly/steps';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface DataState {
  status: LoadStatus;
  dataset: PlanningDataset | null;
  indexes: DataIndexes | null;
  error: string | null;
  /** Non-fatal source problems from the last load. */
  warnings: string[];
  /** Assembly orders first seen today after the initial baseline was created. */
  newOrderIds: string[];
  source: DataSource;

  /** Fetch everything from the current source and rebuild indexes. */
  load: () => Promise<void>;
  /** Swap the active data source (does not auto-load). */
  setSource: (source: DataSource) => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  status: 'idle',
  dataset: null,
  indexes: null,
  error: null,
  warnings: [],
  newOrderIds: [],
  source: createDataSource(),

  async load() {
    set({ status: 'loading', error: null, warnings: [] });
    const source = get().source;
    const result = await source.loadAll();
    // Collected during the load, so read them after it settles.
    const warnings = [...(source.warnings ?? [])];
    if (result.ok) {
      /*
       * UPL-SSS and UPL-Gluing are three benches each, and the export gives
       * one order for all three. Splitting it here rather than inside the
       * board is what lets the plan store, the pool, the crew picker and the
       * SharePoint mirror all see the same orders the board does.
       */
      const dataset = withStepOrders(result.value);
      const newOrderIds = trackNewOrders(
        dataset.jobs
          .filter((job) => job.department === 'assembly')
          // A bench the board made up is not an order that arrived today.
          .filter((job) => !job.step?.derived)
          .map((job) => String(job.id)),
        new Date(),
        source.name,
      );
      set({
        status: 'ready',
        dataset,
        indexes: buildIndexes(dataset),
        error: null,
        warnings,
        newOrderIds,
      });
    } else {
      set({ status: 'error', error: result.error, warnings });
    }
  },

  setSource(source) {
    set({ source, warnings: [] });
  },
}));
