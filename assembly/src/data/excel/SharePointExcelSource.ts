/**
 * Live data source: fetches the PMD master workbook from SharePoint and parses
 * each sheet with SheetJS. The workbook is read once and cached; the granular
 * `fetch*` methods slice the cached sheets through the per-sheet parsers.
 */

import * as XLSX from 'xlsx';
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
import { BaseDataSource } from '@/data/DataSource';
import { unwrap } from '@/lib/result';
import {
  fetchWorkbook,
  readConfigFromEnv,
  type SharePointConfig,
} from './sharepoint.client';
import type { RawRow, Sheet } from './parsers/cell';
import { parseJobs } from './parsers/job.parser';
import { parseWorkCenters } from './parsers/machine.parser';
import { parseInventory } from './parsers/inventory.parser';
import { parseBom } from './parsers/bom.parser';
import { parseSupply } from './parsers/supply.parser';
import { parseDemand } from './parsers/demand.parser';
import { parseRouting } from './parsers/toolToPart.parser';

/** Sheet names as they appear in the master workbook. */
const SHEET = {
  planning: 'planning',
  resource: 'resource',
  inventory: 'ohb',
  bom: 'part req',
  po: 'po',
  demand: 'total req',
} as const;

export class SharePointExcelSource extends BaseDataSource {
  readonly name = 'sharepoint-excel';
  private sheets: Map<string, Sheet> | null = null;

  constructor(private readonly config: SharePointConfig = readConfigFromEnv()) {
    super();
  }

  /** Load + parse the workbook into per-sheet array-of-arrays, cached. */
  private async sheetsOnce(): Promise<Map<string, Sheet>> {
    if (this.sheets) return this.sheets;
    const buffer = unwrap(await fetchWorkbook(this.config));
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const map = new Map<string, Sheet>();
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<RawRow>(ws, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: true,
      });
      map.set(name, rows as Sheet);
    }
    this.sheets = map;
    return map;
  }

  private async sheet(name: string): Promise<Sheet> {
    const map = await this.sheetsOnce();
    const s = map.get(name);
    if (!s) throw new Error(`Workbook is missing the "${name}" sheet`);
    return s;
  }

  /** Force a re-fetch on the next access (used by the hourly refresh). */
  invalidate(): void {
    this.sheets = null;
  }

  private report(label: string, errors: string[]): void {
    if (errors.length > 0) {
      // Non-fatal: lenient parsers keep good rows and report the rest.
      console.warn(`[${this.name}] ${label}: ${errors.length} row issue(s)`, errors.slice(0, 5));
    }
  }

  async fetchWorkCenters(): Promise<WorkCenter[]> {
    const { values, errors } = parseWorkCenters(await this.sheet(SHEET.resource));
    this.report('work centres', errors);
    return values;
  }

  async fetchJobs(): Promise<Job[]> {
    const { values, errors } = parseJobs(await this.sheet(SHEET.planning));
    this.report('jobs', errors);
    return values;
  }

  async fetchRouting(): Promise<RoutingEntry[]> {
    const { values, errors } = parseRouting(await this.sheet(SHEET.resource));
    this.report('routing', errors);
    return values;
  }

  async fetchInventory(): Promise<InventoryItem[]> {
    const { values, errors } = parseInventory(await this.sheet(SHEET.inventory));
    this.report('inventory', errors);
    return values;
  }

  async fetchBom(): Promise<BomLine[]> {
    const { values, errors } = parseBom(await this.sheet(SHEET.bom));
    this.report('bom', errors);
    return values;
  }

  async fetchPo(): Promise<PoLine[]> {
    const { values, errors } = parseSupply(await this.sheet(SHEET.po));
    this.report('po', errors);
    return values;
  }

  /**
   * The shift roster does not live in the workbook — it comes from the
   * attendance system, so this source has none until that feed is wired up.
   */
  async fetchWorkers(): Promise<Worker[]> {
    return [];
  }

  async fetchDemand(): Promise<DemandLine[]> {
    const { values, errors } = parseDemand(await this.sheet(SHEET.demand));
    this.report('demand', errors);
    return values;
  }
}
