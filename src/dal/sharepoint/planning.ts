// SharePoint data layer — what is to be made: the Epicor extract and the
// orders a supervisor added by hand.
import { LISTS } from './schema';
import type { PlanningFilter, PlanningOrder } from '../../types';
import { str, getId, num, isoDate, sharePointDateTimeIso } from './values';
import { parsePlanningCsv } from './csv';
import { SharePointMaintenance } from './maintenance';

export class SharePointPlanning extends SharePointMaintenance {
  /**
   * Short-TTL `jobNumber → partNumber` map used by pushLiveSnapshot to
   * stamp PartNum onto every PMD_LiveStatus mirror. Without the cache,
   * every 60 s poll tick re-downloaded the full Planning CSV from SP
   * (cache-busted with `_t`) just to fill this one Map — on flaky iPad
   * Wi-Fi the recurring multi-second fetch piled up onto the next tick
   * and froze the page. Planning changes slowly (15-min Epicor sync),
   * so a 5-minute TTL is plenty fresh for the live mirror. User-facing
   * Planning reads still go through listPlanning() directly and stay
   * cache-bust-fresh.
   */
  protected partNumByJobCache: { value: Map<string, string>; expires: number } | null = null;

  protected static readonly PART_NUM_CACHE_TTL_MS = 5 * 60_000;

  async listPlanning(_filter: PlanningFilter): Promise<PlanningOrder[]> {
    // ERP orders + supervisor-added manual orders, ERP winning on a job
    // number collision (once Epicor picks the job up, its row takes over).
    const [erp, manual] = await Promise.all([
      this.listErpPlanning(),
      this.listManualOrders(),
    ]);
    if (manual.length === 0) return erp;
    const known = new Set(erp.map((o) => o.jobNumber.trim().toUpperCase()));
    return [...erp, ...manual.filter((m) => !known.has(m.jobNumber.trim().toUpperCase()))];
  }

  protected async listErpPlanning(): Promise<PlanningOrder[]> {
    // Two sources, picked by config:
    //  1. CSV file in a doc library (PREFERRED) — written by PowerShell on
    //     the shop-floor PC and uploaded via OneDrive sync. No SP write
    //     credentials needed anywhere; the script just touches the local
    //     synced folder. App reads via SP file REST.
    //  2. PMD_Planning list (legacy) — kept for tenants that haven't moved
    //     to the CSV pipeline yet.
    if (this.planningCsvPath) {
      return this.loadPlanningCsv(this.planningCsvPath);
    }
    const F = this.F.planning;
    const rows = await this.getAllItems(LISTS.planning, '');
    return rows.map((r) => {
      const start = isoDate(r[F.startDateTime]);
      const due = isoDate(r[F.dueDate]);
      const dur = num(r[F.duration]) || 0;
      const end = dur > 0 ? new Date(new Date(start).getTime() + dur * 3600_000).toISOString() : due;
      return {
        id: getId(r),
        jobNumber: str(r[F.jobNum]),
        machineCode: '',
        originalMachine: '',
        partNumber: str(r[F.partNum]),
        partDescription: str(r[F.partDesc]),
        plannedStart: start,
        plannedEnd: end,
        // Order Qty = total ProdQty; fall back to the remaining qty so the
        // field is never blank on a tenant that hasn't surfaced ProdQty yet.
        orderQty: num(r[F.prodQty]) || num(r[F.remaining]) || 0,
        jobRequired: num(r[F.remaining]) || 0,
        qtyPerHr: num(r[F.qtyHour]) || 0,
        duration: dur,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      };
    });
  }

  protected async loadPlanningCsv(rawPath: string): Promise<PlanningOrder[]> {
    return parsePlanningCsv(await this.fetchSiteFile(rawPath, 'Planning CSV'));
  }

  // ---- manual orders (PMD_ManualOrders) --------------------------------

  /** Set true once the list is known to exist so the ensure probe runs
   *  at most once per page load (same pattern as PMD_DieMaintenance). */
  protected manualOrdersEnsured = false;

  protected static manualPlanningOrder(o: {
    id: number;
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
    createdAt: string;
  }): PlanningOrder {
    return {
      id: o.id,
      jobNumber: o.jobNumber,
      machineCode: '',
      originalMachine: '',
      partNumber: o.partNumber,
      partDescription: o.partDescription,
      plannedStart: '',
      plannedEnd: '',
      orderQty: o.orderQty,
      jobRequired: o.orderQty,
      qtyPerHr: 0,
      duration: 0,
      released: true,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
      createdAt: o.createdAt,
    };
  }

  /** Supervisor-added orders as PlanningOrder rows; [] when the list
   *  hasn't been created yet (nothing manual to merge). */
  protected async listManualOrders(): Promise<PlanningOrder[]> {
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.manualOrders);
      this.manualOrdersEnsured = true;
      return rows
        .map((r) =>
          SharePointPlanning.manualPlanningOrder({
            id: getId(r),
            jobNumber: str(r['Title']).trim(),
            partNumber: str(r['PartNumber']).trim(),
            partDescription: str(r['PartDescription']).trim(),
            orderQty: num(r['OrderQty']) || 0,
            createdAt: sharePointDateTimeIso(r['Created']),
          }),
        )
        .filter((o) => o.jobNumber);
    } catch {
      return []; // no list yet — created on the first add
    }
  }

  protected async ensureManualOrdersList(): Promise<void> {
    if (this.manualOrdersEnsured) return;
    try {
      await this.getJson(`${this.listUrl(LISTS.manualOrders)}?$select=Title`);
      this.manualOrdersEnsured = true;
      return;
    } catch {
      /* not there — create it */
    }
    await this.post(`${this.siteUrl}/_api/web/lists`, {
      __metadata: { type: 'SP.List' },
      Title: LISTS.manualOrders,
      BaseTemplate: 100, // generic list
      Description:
        'Orders added by a supervisor on the PMD Operator Sheet when a job is missing from the Epicor planning extract. Title holds the JobNumber.',
    });
    const fieldsUrl = `${this.listUrl(LISTS.manualOrders)}/fields`;
    for (const title of ['PartNumber', 'PartDescription']) {
      await this.post(fieldsUrl, {
        __metadata: { type: 'SP.Field' },
        Title: title,
        FieldTypeKind: 2, // single-line text
      });
    }
    await this.post(fieldsUrl, {
      __metadata: { type: 'SP.Field' },
      Title: 'OrderQty',
      FieldTypeKind: 9, // number
    });
    console.info('[pmd] PMD_ManualOrders list created (auto-provisioned)');
    this.manualOrdersEnsured = true;
  }

  async createManualOrder(o: {
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
  }): Promise<PlanningOrder> {
    await this.ensureManualOrdersList();
    const res = await this.post(`${this.listUrl(LISTS.manualOrders)}/items`, {
      __metadata: { type: await this.itemType(LISTS.manualOrders) },
      Title: o.jobNumber,
      PartNumber: o.partNumber,
      PartDescription: o.partDescription,
      OrderQty: o.orderQty,
    });
    const j = (await res.json()) as { d?: { ID?: number; Id?: number; Created?: string } };
    return SharePointPlanning.manualPlanningOrder({
      id: j.d?.ID ?? j.d?.Id ?? 0,
      createdAt: sharePointDateTimeIso(j.d?.Created) || new Date().toISOString(),
      ...o,
    });
  }

  /**
   * 5-minute-TTL cache for the snapshot push's PartNum lookup. See
   * partNumByJobCache field comment for why this exists.
   */
  protected async getPartNumByJob(): Promise<Map<string, string>> {
    const c = this.partNumByJobCache;
    if (c && c.expires > Date.now()) return c.value;
    const planning = await this.listPlanning({}).catch(() => [] as PlanningOrder[]);
    const m = new Map<string, string>();
    for (const o of planning) m.set(o.jobNumber, o.partNumber);
    this.partNumByJobCache = { value: m, expires: Date.now() + SharePointPlanning.PART_NUM_CACHE_TTL_MS };
    return m;
  }
}
