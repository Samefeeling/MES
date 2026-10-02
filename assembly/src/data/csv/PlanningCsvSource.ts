/**
 * The live source: orders from `Planning1.csv`, what those orders consume from
 * `JobMaterialReq.csv`, and people from the SharePoint list `ASSY_Operator`.
 *
 * The order export carries both PMD and assembly rows, so one fetch feeds the
 * whole board — the PMD lane mirrors moulding's plan and the three assembly
 * lines are scheduled here. The material export is what ties them together:
 * a chair cannot start before the press job making its shell is finished.
 *
 * On-hand inventory is optional and comes from `OnHandInventory.csv`, and
 * open purchase orders from `PODetail.csv` beside Planning1.csv. BOM and
 * demand still belong to the master workbook source.
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
} from '@/data/parsers/machine.parser';
import { BaseDataSource } from '@/data/DataSource';
import {
  readConfigFromEnv,
  type SharePointConfig,
} from '@/data/sharepoint/site';
import { fetchListItems } from '@/data/sharepoint/lists.client';
import { parseOperators } from '@/data/sharepoint/operator.parser';
import {
  fetchJobMaterialCsv,
  fetchPlanningCsv,
  fetchOnHandInventoryCsv,
  fetchPoDetailCsv,
  fetchProductLinesJson,
  fetchPressPlanningCsv,
  readCsvConfigFromEnv,
  type CsvSourceConfig,
} from './csv.client';
import { parsePlanningCsv } from './planning.parser';
import { parsePressPlanningCsv } from './pressPlanning.parser';
import {
  PRODUCT_DIE_COLOR_LIST,
  parseDieColors,
  withDieColors,
} from '@/data/sharepoint/dieColor.parser';
import { parseJobMaterialCsv } from './materialReq.parser';
import { parseOnHandInventoryCsv } from './onHandInventory.parser';
import { parsePoDetailCsv } from './poDetail.parser';
import { parseProductLines, EMPTY_PRODUCT_LINES } from '@/domain/productLines';
import { makeLineRouter, type LineRouter } from '@/engine/assembly/lineRouter';

/** Display name of the roster list in SharePoint. */
export const OPERATOR_LIST = 'ASSY_Operator';

export class PlanningCsvSource extends BaseDataSource {
  readonly name = 'planning-csv';

  /** Parse warnings from the last load, surfaced for diagnostics. */
  readonly warnings: string[] = [];

  private jobsOnce: Promise<Job[]> | null = null;
  private linksOnce: Promise<JobMaterialLink[]> | null = null;
  private inventoryOnce: Promise<InventoryItem[]> | null = null;
  private routerOnce: Promise<LineRouter> | null = null;

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
    return (this.jobsOnce ??= (async () => {
      // The router is needed to parse: ERP names only a department for most
      // assembly orders, and which line inside it comes from the BOM. Both
      // its inputs are memoised, so this costs no extra fetch.
      const [res, router, press] = await Promise.all([
        fetchPlanningCsv(this.csv, this.sp),
        this.lineRouter,
        this.pressJobs(),
      ]);
      if (!res.ok) throw new Error(res.error);
      const { values, errors } = parsePlanningCsv(res.value, router);
      this.warnings.push(...errors);
      if (values.length === 0) {
        throw new Error(errors[0] ?? 'Planning1.csv held no orders');
      }
      return mergePressPlan(values, press);
    })());
  }

  /**
   * Which line builds what: the reviewed routing table first, the material
   * export behind it for anything the table has never seen.
   *
   * Neither file failing stops the load. Without them every order falls back
   * to the line ERP named, which is where the board put them before there
   * were any BOM rules at all.
   */
  private get lineRouter(): Promise<LineRouter> {
    return (this.routerOnce ??= (async () => {
      const [tableRes, links] = await Promise.all([
        fetchProductLinesJson(this.csv, this.sp).catch(() => null),
        this.fetchJobLinks(),
      ]);
      let table = EMPTY_PRODUCT_LINES;
      if (tableRes && !tableRes.ok) {
        this.warnings.push(tableRes.error);
      } else if (tableRes && tableRes.value !== null) {
        table = parseProductLines(tableRes.value);
        this.warnings.push(...table.errors);
      }
      return makeLineRouter(table, links);
    })());
  }

  /**
   * The press plan from the PMD dashboard's `Planning.csv`, each order told
   * its die and colour from `PMD_ProductDieColor`. Neither being there stops
   * the load: the PMD lane then shows what Planning1.csv carries, as before.
   */
  private async pressJobs(): Promise<Job[]> {
    const res = await fetchPressPlanningCsv(this.csv, this.sp);
    if (!res.ok) {
      this.warnings.push(`${res.error} — the PMD lane shows Planning1.csv's press orders only.`);
      return [];
    }
    if (res.value === null) return [];
    const { values, errors } = parsePressPlanningCsv(res.value);
    this.warnings.push(...errors);
    if (values.length === 0) return [];
    const dies = await fetchListItems(this.sp, PRODUCT_DIE_COLOR_LIST);
    if (!dies.ok) {
      this.warnings.push(
        `${PRODUCT_DIE_COLOR_LIST} not read (${dies.error}) — every press changeover is taken as a die change.`,
      );
      return values;
    }
    return withDieColors(values, parseDieColors(dies.value));
  }

  /** Drop the memoised CSVs so the next load re-fetches. */
  invalidate(): void {
    this.jobsOnce = null;
    this.linksOnce = null;
    this.inventoryOnce = null;
    this.routerOnce = null;
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
  /** Open PO releases. Unreadable or absent is a warning, never a failed load. */
  async fetchPo(): Promise<PoLine[]> {
    const res = await fetchPoDetailCsv(this.csv, this.sp);
    if (!res.ok) {
      this.warnings.push(res.error);
      return [];
    }
    if (res.value === null) return [];
    const { values, errors } = parsePoDetailCsv(res.value);
    this.warnings.push(...errors);
    return values;
  }
  async fetchDemand(): Promise<DemandLine[]> {
    return [];
  }
}

/**
 * The orders, with the press plan standing in for Planning1.csv's press rows.
 *
 * Planning1.csv carries the press orders assembly waits on, but not the press
 * they run on; Planning.csv carries every press order with its machine. So a
 * press order in both is taken from Planning.csv, and one only Planning.csv
 * has is added — the PMD lane is the whole press plan, not just the part of it
 * assembly is waiting for.
 */
export function mergePressPlan(orders: readonly Job[], press: readonly Job[]): Job[] {
  if (press.length === 0) return [...orders];
  const pressById = new Map(press.map((job) => [String(job.id), job]));
  const merged = orders.map((job) => {
    const p = job.department === 'moulding' ? pressById.get(String(job.id)) : undefined;
    if (!p) return job;
    pressById.delete(String(job.id));
    return p;
  });
  const taken = new Set(orders.map((job) => String(job.id)));
  return [...merged, ...[...pressById.values()].filter((job) => !taken.has(String(job.id)))];
}
