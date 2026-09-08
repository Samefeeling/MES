/**
 * The contract every data source implements. The app talks only to this
 * interface, so the bundled mock and the live SharePoint/Excel source are
 * fully interchangeable (see `data/mock` and `data/excel`).
 */

import type {
  BomLine,
  DemandLine,
  InventoryItem,
  Job,
  JobMaterialLink,
  WorkCenter,
  PlanningDataset,
  PoLine,
  RoutingEntry,
} from '@/domain/types';
import type { Worker } from '@/domain/assembly';
import { ok, err, type Result } from '@/lib/result';

export interface DataSource {
  /** Identifier for diagnostics, e.g. "mock" or "sharepoint-excel". */
  readonly name: string;

  /**
   * Non-fatal problems from the last load — a column that could not be
   * matched, a person with no usable skill. The data still loaded; these are
   * shown to the planner so bad source data is visible rather than silent.
   */
  readonly warnings?: readonly string[];

  fetchWorkCenters(): Promise<WorkCenter[]>;
  fetchJobs(): Promise<Job[]>;
  fetchRouting(): Promise<RoutingEntry[]>;
  fetchInventory(): Promise<InventoryItem[]>;
  fetchBom(): Promise<BomLine[]>;
  fetchPo(): Promise<PoLine[]>;
  fetchDemand(): Promise<DemandLine[]>;
  fetchWorkers(): Promise<Worker[]>;
  /**
   * Order-to-order material links. Optional: a source with none simply
   * schedules every order independently.
   */
  fetchJobLinks?(): Promise<JobMaterialLink[]>;

  /** Fetch everything needed for one planning session. */
  loadAll(): Promise<Result<PlanningDataset, string>>;
}

/**
 * Implements `loadAll()` in terms of the granular `fetch*` methods, so each
 * concrete source only has to say how to read individual tables.
 */
export abstract class BaseDataSource implements DataSource {
  abstract readonly name: string;

  abstract fetchWorkCenters(): Promise<WorkCenter[]>;
  abstract fetchJobs(): Promise<Job[]>;
  abstract fetchRouting(): Promise<RoutingEntry[]>;
  abstract fetchInventory(): Promise<InventoryItem[]>;
  abstract fetchBom(): Promise<BomLine[]>;
  abstract fetchPo(): Promise<PoLine[]>;
  abstract fetchDemand(): Promise<DemandLine[]>;
  abstract fetchWorkers(): Promise<Worker[]>;

  /** No links unless a source overrides this — see `PlanningCsvSource`. */
  async fetchJobLinks(): Promise<JobMaterialLink[]> {
    return [];
  }

  async loadAll(): Promise<Result<PlanningDataset, string>> {
    try {
      const [
        workCenters,
        jobs,
        routing,
        inventory,
        bom,
        po,
        demand,
        workers,
        jobLinks,
      ] = await Promise.all([
        this.fetchWorkCenters(),
        this.fetchJobs(),
        this.fetchRouting(),
        this.fetchInventory(),
        this.fetchBom(),
        this.fetchPo(),
        this.fetchDemand(),
        this.fetchWorkers(),
        this.fetchJobLinks(),
      ]);
      return ok({
        workCenters,
        jobs,
        routing,
        inventory,
        bom,
        po,
        demand,
        jobLinks,
        workers,
        fetchedAt: new Date(),
      });
    } catch (e) {
      return err(
        `[${this.name}] load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
