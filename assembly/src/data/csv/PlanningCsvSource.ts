/**
 * The live source: orders from `Planning1.csv`, what those orders consume from
 * `JobMaterialReq.csv`, and people from the SharePoint list `ASSY_Operator`.
 *
 * The order export carries both PMD and assembly rows, so one fetch feeds the
 * whole board — the PMD lane mirrors moulding's plan and the three assembly
 * lines are scheduled here. The material export is what ties them together:
 * a chair cannot start before the press job making its shell is finished.
 *
 * On-hand inventory is optional and comes from `OnHandInventory.csv`. BOM,
 * purchase orders and demand still belong to the master workbook source.
 */

import type {
  BomLine,
  DemandLine,
  InventoryItem,
  Job,
  JobMaterialLink,
  PoLine,
  RoutingEntry,
  WorkCenter,
} from '@/domain/types';
import type { Worker } from '@/domain/assembly';
import {
  assemblyWorkCenters,
  makeMachine,
} from '@/data/excel/parsers/machine.parser';
import { BaseDataSource } from '@/data/DataSource';
import {
  readConfigFromEnv,
  type SharePointConfig,
} from '@/data/excel/sharepoint.client';
import { fetchListItems } from '@/data/sharepoint/lists.client';
import { parseOperators } from '@/data/sharepoint/operator.parser';
import {
  fetchJobMaterialCsv,
  fetchPlanningCsv,
  fetchOnHandInventoryCsv,
  readCsvConfigFromEnv,
  type CsvSourceConfig,
} from './csv.client';
import { parsePlanningCsv } from './planning.parser';
import { parseJobMaterialCsv } from './materialReq.parser';
import { parseOnHandInventoryCsv } from './onHandInventory.parser';

/** Display name of the roster list in SharePoint. */
export const OPERATOR_LIST = 'ASSY_Operator';

export class PlanningCsvSource extends BaseDataSource {
  readonly name = 'planning-csv';

  /** Parse warnings from the last load, surfaced for diagnostics. */
  readonly warnings: string[] = [];

  private jobsOnce: Promise<Job[]> | null = null;
  private linksOnce: Promise<JobMaterialLink[]> | null = null;
  private inventoryOnce: Promise<InventoryItem[]> | null = null;

  constructor(
    private readonly csv: CsvSourceConfig = readCsvConfigFromEnv(),
    private readonly sp: SharePointConfig = readConfigFromEnv(),
  ) {
    super();
  }

  /**
   * One fetch per load. `loadAll` calls the `fetch*` methods in parallel and
   * two of them need the CSV, so the promise is memoised.
   */
  private get orders(): Promise<Job[]> {
    return (this.jobsOnce ??= fetchPlanningCsv(this.csv, this.sp).then((res) => {
      if (!res.ok) throw new Error(res.error);
      const { values, errors } = parsePlanningCsv(res.value);
      this.warnings.push(...errors);
      if (values.length === 0) {
        throw new Error(errors[0] ?? 'Planning1.csv held no orders');
      }
      return values;
    }));
  }

  /** Drop the memoised CSVs so the next load re-fetches. */
  invalidate(): void {
    this.jobsOnce = null;
    this.linksOnce = null;
    this.inventoryOnce = null;
    this.warnings.length = 0;
  }

  /**
   * The hourly refresh must actually see new rows, so each full load starts
   * from a fresh fetch — the memo only spans the one `loadAll`.
   */
  override async loadAll(): ReturnType<BaseDataSource['loadAll']> {
    this.invalidate();
    return super.loadAll();
  }

  async fetchJobs(): Promise<Job[]> {
    return this.orders;
  }

  /**
   * The dependency chain. Absent or unreadable links leave every order
   * standing on its own, which is worth a warning but never a failed load —
   * the schedule is more useful with no dependencies than not at all.
   */
  override async fetchJobLinks(): Promise<JobMaterialLink[]> {
    return (this.linksOnce ??= fetchJobMaterialCsv(this.csv, this.sp).then(
      (res) => {
        if (!res.ok) {
          this.warnings.push(res.error);
          return [];
        }
        if (res.value === null) return []; // no material export configured
        const { values, errors } = parseJobMaterialCsv(res.value);
        this.warnings.push(...errors);
        return values;
      },
    ));
  }

  /**
   * The four lanes, plus any moulding press the CSV actually names. The presses
   * are not lanes on this board, but having them as work centres keeps their
   * orders filed by machine instead of piling into the un-scheduled pool.
   */
  async fetchWorkCenters(): Promise<WorkCenter[]> {
    const presses = new Map<string, WorkCenter>();
    for (const job of await this.orders) {
      const id = job.preferredMachine;
      if (!id || presses.has(String(id))) continue;
      presses.set(String(id), makeMachine(String(id)));
    }
    return [
      ...[...presses.values()].sort((a, b) => a.sortIndex - b.sortIndex),
      ...assemblyWorkCenters(),
    ];
  }

  /** Read the real roster. An unreadable list never substitutes demo workers. */
  async fetchWorkers(): Promise<Worker[]> {
    const res = await fetchListItems(this.sp, OPERATOR_LIST);
    if (!res.ok) {
      this.warnings.push(
        `${OPERATOR_LIST} not read (${res.error}) — no crew will be allocated.`,

      );
      return [];
    }
    const { values, errors } = parseOperators(res.value);
    this.warnings.push(...errors);
    if (values.length === 0) {
      this.warnings.push(
        `${OPERATOR_LIST} is empty — no crew will be allocated.`,
      );
      return [];
    }
    return values;
  }

  // Not in these exports — see the note at the top of the file.
  async fetchRouting(): Promise<RoutingEntry[]> {
    return [];
  }
  async fetchInventory(): Promise<InventoryItem[]> {
    return (this.inventoryOnce ??= fetchOnHandInventoryCsv(this.csv, this.sp).then(
      (res) => {
        if (!res.ok) {
          this.warnings.push(res.error);
          return [];
        }
        if (res.value === null) return [];
        const { values, errors } = parseOnHandInventoryCsv(res.value);
        this.warnings.push(...errors);
        return values;
      },
    ));
  }
  async fetchBom(): Promise<BomLine[]> {
    return [];
  }
  async fetchPo(): Promise<PoLine[]> {
    return [];
  }
  async fetchDemand(): Promise<DemandLine[]> {
    return [];
  }
}
