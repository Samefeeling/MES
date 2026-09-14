/**
 * Composition root for the data layer: pick a source from configuration.
 *   VITE_DATA_SOURCE = "mock" (default) | "planning-csv" | "excel"
 *
 * The live Excel source (and its heavy SheetJS dependency) is loaded lazily, so
 * neither the mock nor the CSV build ships the parser.
 */

import type {
  BomLine,
  DemandLine,
  InventoryItem,
  Job,
  WorkCenter,
  PoLine,
  RoutingEntry,
} from '@/domain/types';
import type { Worker } from '@/domain/assembly';
import { BaseDataSource, type DataSource } from './DataSource';
import { MockSource } from './mock/MockSource';
import { PlanningCsvSource } from './csv/PlanningCsvSource';

export type DataSourceKind = 'mock' | 'planning-csv' | 'excel';

/**
 * Defers loading `SharePointExcelSource` (and `xlsx`) until the first fetch,
 * keeping them out of the main bundle when the mock source is used.
 */
class LazyExcelSource extends BaseDataSource {
  readonly name = 'sharepoint-excel';
  private impl: Promise<DataSource> | null = null;
  /** The loaded source, once it is there — a getter cannot await. */
  private loaded: DataSource | null = null;

  private get source(): Promise<DataSource> {
    return (this.impl ??= import('./excel/SharePointExcelSource').then((m) => {
      this.loaded = new m.SharePointExcelSource();
      return this.loaded;
    }));
  }

  /**
   * Everything the real source exposes has to be forwarded, including the
   * parts it does not have yet. A wrapper that quietly answers "no links" and
   * "no warnings" on its behalf is a wrapper that will keep answering that
   * once it does, and neither has a symptom anyone would notice.
   */
  get warnings(): readonly string[] {
    return this.loaded?.warnings ?? [];
  }

  override async fetchJobLinks(): ReturnType<
    NonNullable<DataSource['fetchJobLinks']>
  > {
    const source = await this.source;
    return source.fetchJobLinks?.() ?? [];
  }

  async fetchWorkCenters(): Promise<WorkCenter[]> {
    return (await this.source).fetchWorkCenters();
  }
  async fetchJobs(): Promise<Job[]> {
    return (await this.source).fetchJobs();
  }
  async fetchRouting(): Promise<RoutingEntry[]> {
    return (await this.source).fetchRouting();
  }
  async fetchInventory(): Promise<InventoryItem[]> {
    return (await this.source).fetchInventory();
  }
  async fetchBom(): Promise<BomLine[]> {
    return (await this.source).fetchBom();
  }
  async fetchPo(): Promise<PoLine[]> {
    return (await this.source).fetchPo();
  }
  async fetchDemand(): Promise<DemandLine[]> {
    return (await this.source).fetchDemand();
  }
  async fetchWorkers(): Promise<Worker[]> {
    return (await this.source).fetchWorkers();
  }
}

export function createDataSource(
  kind: DataSourceKind = (import.meta.env.VITE_DATA_SOURCE as DataSourceKind) ??
    (import.meta.env.VITE_BACKEND === 'sharepoint' || import.meta.env.VITE_SHAREPOINT_SITE_URL ? 'planning-csv' : 'mock'),
): DataSource {
  switch (kind) {
    case 'planning-csv':
      return new PlanningCsvSource();
    case 'excel':
      return new LazyExcelSource();
    case 'mock':
    default:
      return new MockSource();
  }
}

export type { DataSource } from './DataSource';
