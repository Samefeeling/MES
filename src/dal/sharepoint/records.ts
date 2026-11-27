// SharePoint data layer — writing the record: the header row of a shift, its
// breakdown and reject rows, the plan of record, photos and handover notes.
import { LISTS } from './schema';
import type {
  ProductionRecord,
  ProductDieColor,
  PlanningOrder,
  ProductionCounterRecord,
} from '../../types';
import { fetchThroughThrottle, type RollbackAction } from './http';
import { odataString, dateOnly, str, getId, num, sharePointItemId } from './values';
import {
  shiftDateRange,
  readPlanBarEntry,
  planBarEntry,
  parseShiftIdLoose,
  formatHandover,
  aggregateSlots,
  type HeaderInput,
  shiftDateMarker,
  sanitizeBodyStrings,
  type RejectEvent,
} from './rows';
import { type SavedShiftPlan, shiftPlanChanges, shiftPlanRevisions } from '../../core/kpi-attainment';
import { shiftBounds, previousShift } from '../../core/shifts';
import {
  type PlanBarItem,
  planningHoldsAPlan,
  lastRunLookback,
  lastJobsBefore,
  planningOrderMatchesMachine,
  ordersOpenAtShiftStart,
  dieLookup,
  lastRunFromTimelines,
} from '../../core/schedule';
import { leftAtShiftStart, retroJobLeftFixes } from '../../core/jobgood';
import { appendHandoverLine } from '../../core/handover';
import { SharePointProduction } from './production';

export class SharePointRecords extends SharePointProduction {
  /** Item ID of the tuple's PMD_Production header row, or null when the
   *  tuple hasn't been signed off yet. Same composite-key lookup as
   *  upsertHeaderInto: ±1d window for legacy-timestamp tolerance, then
   *  narrowed to the exact calendar date. */
  protected async findProductionRowId(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<number | null> {
    const F = this.F.production;
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shift)}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
      );
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.production, qs);
    const exact = rows.find((r) => dateOnly(r[F.date]) === date) as
      | { ID?: number; Id?: number }
      | undefined;
    return exact?.ID ?? exact?.Id ?? null;
  }

  async attachProductionPhoto(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    fileName: string,
    data: Blob,
  ): Promise<boolean> {
    const id = await this.findProductionRowId(machineCode, shiftId, jobNumber);
    if (id == null) return false; // not signed off yet — caller keeps it queued
    this.writesStarted++;
    const digest = await this.getDigest();
    // Attachment upload is raw binary, NOT the JSON post() path — SP
    // stores the request body verbatim as the file.
    const url = `${this.listUrl(LISTS.production)}/items(${id})/AttachmentFiles/add(FileName='${encodeURIComponent(odataString(fileName))}')`;
    const res = await fetchThroughThrottle(url, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose', 'X-RequestDigest': digest },
      body: data,
    });
    if (!res.ok) {
      const text = await res.text();
      // Duplicate filename = this exact photo already landed (retry after
      // a dropped response) — done, don't re-queue forever.
      if (/already exists/i.test(text)) return true;
      throw new Error(`Attachment upload ${res.status}: ${text.slice(0, 200)}`);
    }
    return true;
  }

  async listProductionPhotos(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<Array<{ name: string; url: string }>> {
    const id = await this.findProductionRowId(machineCode, shiftId, jobNumber);
    if (id == null) return [];
    const env = await this.getJson<{
      d: { results: Array<{ FileName: string; ServerRelativeUrl: string }> };
    }>(`${this.listUrl(LISTS.production)}/items(${id})/AttachmentFiles`);
    return env.d.results.map((a) => ({ name: a.FileName, url: a.ServerRelativeUrl }));
  }

  // ---- PMD_ShiftPlan -----------------------------------------------------

  /** PMD_ShiftPlan rows matching an OData filter on ShiftId; null when the
   *  list cannot be read (not created yet, or the read failed). */
  protected async readShiftPlans(
    filter: string,
  ): Promise<Array<SavedShiftPlan & { id: number }> | null> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.getAllItems(LISTS.shiftPlan, '$filter=' + encodeURIComponent(filter));
    } catch {
      return null;
    }
    const out: Array<SavedShiftPlan & { id: number }> = [];
    for (const r of rows) {
      const machineCode = str(r['MachineCode']).trim();
      const shiftId = str(r['ShiftId']).trim();
      const plan = num(r['SchedulePlan']);
      if (!machineCode || !shiftBounds(shiftId) || !(plan >= 0)) continue;
      let jobs: SavedShiftPlan['jobs'] = [];
      let bar: PlanBarItem[] | undefined;
      try {
        const parsed = JSON.parse(str(r['PlanJobs']) || '[]') as unknown;
        if (Array.isArray(parsed)) {
          const entries = parsed.filter((j): j is Record<string, unknown> => !!j && typeof j === 'object');
          const pieces = entries.filter((j) => j['bar'] === 'run' || j['bar'] === 'change');
          if (pieces.length) bar = pieces.map(readPlanBarEntry).filter((b): b is PlanBarItem => !!b);
          jobs = entries
            .filter((j) => j['bar'] == null)
            .map((j) => ({
              jobNumber: str(j['jobNumber']).trim(),
              partNumber: str(j['partNumber']).trim(),
              pieces: num(j['pieces']),
              ...(j['hours'] != null && Number.isFinite(Number(j['hours'])) ? { hours: Number(j['hours']) } : {}),
            }))
            .filter((j) => j.jobNumber);
        }
      } catch {
        /* the plan total still stands without its order detail */
      }
      out.push({ id: getId(r), machineCode, shiftId, plan, jobs, ...(bar ? { bar } : {}) });
    }
    return out;
  }

  async listShiftPlans(filter: { from: string; to: string }): Promise<SavedShiftPlan[]> {
    const rows = await this.readShiftPlans(
      `ShiftId ge '${odataString(filter.from)}-' and ShiftId le '${odataString(filter.to)}-z'`,
    );
    // Two devices keeping one shift at once can leave two rows for a
    // press until the next keep tidies up: the first one kept stands.
    const seen = new Set<string>();
    return (rows ?? [])
      .filter((p) => p.shiftId.slice(0, 10) >= filter.from && p.shiftId.slice(0, 10) <= filter.to)
      .sort((a, b) => a.id - b.id)
      .filter((p) => {
        const key = `${p.machineCode.trim().toUpperCase()}|${p.shiftId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ id: _id, ...plan }) => plan);
  }

  protected shiftPlanListReady = false;

  protected async shiftPlanListExists(): Promise<boolean> {
    if (this.shiftPlanListReady) return true;
    try {
      await this.getJson(`${this.listUrl(LISTS.shiftPlan)}?$select=Title`);
      this.shiftPlanListReady = true;
    } catch {
      /* not there */
    }
    return this.shiftPlanListReady;
  }

  protected async ensureShiftPlanList(): Promise<void> {
    if (await this.shiftPlanListExists()) return;
    await this.post(`${this.siteUrl}/_api/web/lists`, {
      __metadata: { type: 'SP.List' },
      Title: LISTS.shiftPlan,
      BaseTemplate: 100, // generic list
      Description:
        'The plan of record of each press in each shift for the KPI Schedule Adherence: written an hour before the shift (or at its first sign-off), kept up with Planning.csv for what is left of the shift while it runs, deleted after two months. Title = MachineCode|ShiftId.',
    });
    const fieldsUrl = `${this.listUrl(LISTS.shiftPlan)}/fields`;
    const field = (Title: string, FieldTypeKind: number) =>
      this.post(fieldsUrl, { __metadata: { type: 'SP.Field' }, Title, FieldTypeKind });
    await field('MachineCode', 2); // single-line text
    await field('ShiftId', 2);
    await field('SchedulePlan', 9); // number
    await field('PlanJobs', 3); // multi-line text (JSON)
    // Indexed, so the KPI page's ShiftId range filter keeps working past
    // SharePoint's 5,000-item view threshold.
    await this.post(
      `${fieldsUrl}/getbyinternalnameortitle('ShiftId')`,
      { __metadata: { type: 'SP.Field' }, Indexed: true },
      '*',
    ).catch((e) => console.warn('[pmd] PMD_ShiftPlan: could not index ShiftId:', e));
    console.info('[pmd] PMD_ShiftPlan list created (auto-provisioned)');
    this.shiftPlanListReady = true;
  }

  /**
   * What working out the plans of `shiftId` needs, read now: the active
   * presses, Planning.csv, die lookups, the presses' history and where they
   * stand when the shift starts. null when Planning.csv holds no plan at all
   * (planningHoldsAPlan): a header-only export, or one whose Machine / date
   * column was renamed, would put "nothing planned" onto every press.
   */
  protected async shiftPlanInputs(shiftId: string, presses?: string[]): Promise<{
    machines: string[];
    orders: PlanningOrder[];
    ctx: Parameters<typeof shiftPlanChanges>[5];
    history: ProductionRecord[];
    standing: Parameters<typeof shiftPlanChanges>[7];
  } | null> {
    const machines = presses ?? (await this.listMachines()).filter((m) => m.active).map((m) => m.machineCode);
    const orders = await this.listPlanning({});
    if (!planningHoldsAPlan(orders)) {
      console.warn(
        `[pmd] PMD_ShiftPlan: Planning.csv holds no order with a press and a Start–Due window — ${shiftId} not planned from it`,
      );
      return null;
    }
    // What each press ran before its first order opens, for that order's
    // die change: the shift before and this one so far. Not worth failing
    // the keep over — a press with no record starts on the file's rule.
    const prevSid = previousShift(shiftId);
    // And, where the press stood that long, what it last ran in the days
    // before: the die its next order is compared with.
    const lookback = lastRunLookback(shiftId);
    const [dieColors, history, headers] = await Promise.all([
      this.listProductDieColors().catch(() => [] as ProductDieColor[]),
      Promise.all(
        [prevSid, shiftId]
          .filter((sid): sid is string => !!sid)
          .map((sid) => this.listProduction({ shiftId: sid }).catch(() => [] as ProductionRecord[])),
      ).then((lists) => lists.flat()),
      lookback
        ? this.listProductionCounters(lookback).catch((e) => {
            console.warn('[pmd] PMD_ShiftPlan: last runs not read, die changes go by the shift before only:', e);
            return [] as ProductionCounterRecord[];
          })
        : Promise.resolve([] as ProductionCounterRecord[]),
    ]);
    // Where each press stands when the shift starts: the order it was last
    // running, and what is left of every order open by then (its quantity
    // less the good of the shifts before, signed or not). The plan runs the
    // order on the press for as long as that takes, and the orders behind it
    // wait (pressPlanFromShiftStart). An order whose records cannot be read
    // keeps Planning.csv's window.
    const startsAt = shiftBounds(shiftId)?.start.getTime() ?? Date.now();
    const lastJobsOf = lastJobsBefore(history, headers);
    const lastJobs = (code: string): string[] => lastJobsOf(code, startsAt);
    const onPress = (o: PlanningOrder): boolean => {
      const job = o.jobNumber.trim().toUpperCase();
      return machines.some((code) => planningOrderMatchesMachine(o, code) && lastJobs(code).includes(job));
    };
    const recordsByJob = new Map<string, ProductionRecord[]>();
    await Promise.all(
      [...new Set(ordersOpenAtShiftStart(orders, shiftId, onPress).map((o) => o.jobNumber.trim()))]
        .filter(Boolean)
        .map(async (jobNumber) => {
          try {
            recordsByJob.set(jobNumber.toUpperCase(), await this.listProduction({ jobNumber }));
          } catch (e) {
            console.warn(`[pmd] PMD_ShiftPlan: ${jobNumber} not read, planned by its Planning.csv window:`, e);
          }
        }),
    );
    const leftOf = (o: PlanningOrder): number | undefined => {
      const records = recordsByJob.get(o.jobNumber.trim().toUpperCase());
      return records ? leftAtShiftStart(o, records, shiftId) : undefined;
    };
    return {
      machines,
      orders,
      ctx: { dieOf: dieLookup(dieColors), lastRun: lastRunFromTimelines(headers) },
      history,
      standing: { leftOf, lastJobs },
    };
  }

  /** The PlanJobs / SchedulePlan columns of a plan, as PMD_ShiftPlan holds them. */
  protected static shiftPlanColumns(row: SavedShiftPlan): Record<string, unknown> {
    return {
      SchedulePlan: row.plan,
      PlanJobs: JSON.stringify([...row.jobs, ...(row.bar ?? []).map(planBarEntry)]),
    };
  }

  /** Write a plan as a new PMD_ShiftPlan row. */
  protected async addShiftPlan(row: SavedShiftPlan): Promise<void> {
    await this.post(`${this.listUrl(LISTS.shiftPlan)}/items`, {
      __metadata: { type: await this.itemType(LISTS.shiftPlan) },
      Title: `${row.machineCode}|${row.shiftId}`,
      MachineCode: row.machineCode,
      ShiftId: row.shiftId,
      ...SharePointRecords.shiftPlanColumns(row),
    });
  }

  /**
   * Keep the plan of every press in `shiftId` that has no row yet
   * (shiftPlanChanges) — the plan of record its Schedule Adherence is judged
   * by. Called an hour before the shift starts and while it runs (main.ts,
   * from a device that writes) and by every sign-off of the shift. Returns
   * the shift's rows as they stand after it; null when the list could not be
   * read, in which case nothing is written — a row may already be kept —
   * and when no row is kept yet and Planning.csv holds no plan to keep.
   */
  async keepShiftPlans(shiftId: string): Promise<SavedShiftPlan[] | null> {
    let saved = await this.readShiftPlans(`ShiftId eq '${odataString(shiftId)}'`);
    if (saved == null) {
      if (await this.shiftPlanListExists()) return null;
      saved = [];
    }
    const presses = (await this.listMachines()).filter((m) => m.active).map((m) => m.machineCode);
    const keys = new Set(saved.map((row) => row.machineCode.trim().toUpperCase()));
    if (presses.every((code) => keys.has(code.trim().toUpperCase())) && saved.length === keys.size) {
      return saved.map(({ id: _id, ...plan }) => plan);
    }
    // With no row kept yet the answer is null, so the keeper asks again and
    // the shift is kept as soon as the export is right.
    const inputs = await this.shiftPlanInputs(shiftId, presses);
    if (!inputs) return saved.length ? saved.map(({ id: _id, ...plan }) => plan) : null;
    const { machines, orders, ctx, history, standing } = inputs;
    const { save, remove } = shiftPlanChanges(machines, saved, orders, shiftId, new Date(), ctx, history, standing);
    for (const row of remove) {
      await this.del(`${this.listUrl(LISTS.shiftPlan)}/items(${row.id})`);
    }
    const kept: SavedShiftPlan[] = saved.filter((row) => !remove.includes(row)).map(({ id: _id, ...plan }) => plan);
    if (!save.length) return kept;
    await this.ensureShiftPlanList();
    for (const row of save) {
      await this.addShiftPlan(row);
      kept.push(row);
    }
    return kept;
  }

  /**
   * Replan `shiftId` from Planning.csv as it stands now (shiftPlanRevisions):
   * a row for every press without one, and a kept row rewritten in place
   * where the file now asks for something else in what is left of the shift
   * — what it asked for before `at` stays as kept. Called when the export
   * changes, for the shift under way and, in its last hour, the next one.
   * Returns the shift's rows after it; null when the list could not be read
   * or Planning.csv holds no plan, and nothing was written.
   */
  async replanShiftPlans(
    shiftId: string,
    at: Date = new Date(),
    planningVersion?: string | null,
  ): Promise<SavedShiftPlan[] | null> {
    let saved = await this.readShiftPlans(`ShiftId eq '${odataString(shiftId)}'`);
    if (saved == null) {
      if (await this.shiftPlanListExists()) return null;
      saved = [];
    }
    // Every device that writes watches the export; the first to see one
    // replans, and the rest find it done.
    const check = planningVersion ? await this.readPlanningCheck() : null;
    if (planningVersion && check?.planning === planningVersion && check.shifts.includes(shiftId)) {
      return saved.sort((a, b) => a.id - b.id).map(({ id: _id, ...plan }) => plan);
    }
    const inputs = await this.shiftPlanInputs(shiftId);
    if (!inputs) return null;
    const { machines, orders, ctx, history, standing } = inputs;
    // The first row kept for a press is the one read (listShiftPlans), so it
    // is the one rewritten.
    saved.sort((a, b) => a.id - b.id);
    const { save, rewrite, remove } = shiftPlanRevisions(machines, saved, orders, shiftId, at, ctx, history, standing);
    for (const row of remove) {
      await this.del(`${this.listUrl(LISTS.shiftPlan)}/items(${row.id})`);
    }
    const out = new Map<number, SavedShiftPlan>(
      saved.filter((row) => !remove.includes(row)).map(({ id, ...plan }) => [id, plan]),
    );
    for (const { row, plan } of rewrite) {
      await this.post(
        `${this.listUrl(LISTS.shiftPlan)}/items(${row.id})`,
        { __metadata: { type: await this.itemType(LISTS.shiftPlan) }, ...SharePointRecords.shiftPlanColumns(plan) },
        '*',
      );
      out.set(row.id, plan);
      console.info(`[pmd] PMD_ShiftPlan: ${row.machineCode} ${shiftId} replanned from Planning.csv (${row.plan} → ${plan.plan})`);
    }
    const rows = [...out.values()];
    if (save.length) {
      await this.ensureShiftPlanList();
      for (const row of save) {
        await this.addShiftPlan(row);
        rows.push(row);
      }
    }
    if (planningVersion) {
      const shifts = check?.planning === planningVersion ? [...check.shifts, shiftId] : [shiftId];
      await this.writePlanningCheck(check?.id ?? null, { planning: planningVersion, shifts }).catch((e) =>
        console.warn('[pmd] PMD_ShiftPlan: could not note the export replanned from:', e),
      );
    }
    return rows;
  }

  /** The one PMD_ShiftPlan row that notes which export the shifts were last
   *  replanned from. No MachineCode and no ShiftId, so no read of plans or
   *  prune ever takes it for one. */
  protected static readonly PLANNING_CHECK = 'PlanningChecked';

  protected async readPlanningCheck(): Promise<{ id: number; planning: string; shifts: string[] } | null> {
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(
        LISTS.shiftPlan,
        '$select=ID,PlanJobs&$filter=' + encodeURIComponent(`Title eq '${SharePointRecords.PLANNING_CHECK}'`),
      );
      const row = rows[0];
      if (!row) return null;
      const body = JSON.parse(str(row['PlanJobs']) || '{}') as { planning?: unknown; shifts?: unknown };
      return {
        id: getId(row),
        planning: typeof body.planning === 'string' ? body.planning : '',
        shifts: Array.isArray(body.shifts) ? body.shifts.filter((x): x is string => typeof x === 'string') : [],
      };
    } catch {
      return null;
    }
  }

  protected async writePlanningCheck(id: number | null, body: { planning: string; shifts: string[] }): Promise<void> {
    await this.ensureShiftPlanList();
    const fields = {
      __metadata: { type: await this.itemType(LISTS.shiftPlan) },
      PlanJobs: JSON.stringify(body),
    };
    if (id != null) {
      await this.post(`${this.listUrl(LISTS.shiftPlan)}/items(${id})`, fields, '*');
      return;
    }
    await this.post(`${this.listUrl(LISTS.shiftPlan)}/items`, {
      ...fields,
      Title: SharePointRecords.PLANNING_CHECK,
      MachineCode: '',
      ShiftId: '',
      SchedulePlan: 0,
    });
  }

  /**
   * Delete the PMD_ShiftPlan rows of shifts dated before `before`
   * (YYYY-MM-DD). The keeper keeps this month and the one before. Returns
   * how many went; a row another device deleted first is passed over.
   */
  async pruneShiftPlans(before: string): Promise<number> {
    if (!(await this.shiftPlanListExists())) return 0;
    const rows = await this.getAllItems<Record<string, unknown>>(
      LISTS.shiftPlan,
      // As text, as listShiftPlans reads it: '2026-10-01-' sorts after every
      // shift of 30 Sep and before every shift of 1 Oct.
      '$select=ID,ShiftId&$filter=' + encodeURIComponent(`ShiftId lt '${odataString(before)}-'`),
    );
    let gone = 0;
    for (const row of rows) {
      const shiftId = str(row['ShiftId']).trim();
      if (!shiftBounds(shiftId) || shiftId.slice(0, 10) >= before) continue;
      try {
        await this.del(`${this.listUrl(LISTS.shiftPlan)}/items(${getId(row)})`);
        gone++;
      } catch (e) {
        if (!/→ 404$/.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
    if (gone) console.info(`[pmd] PMD_ShiftPlan: ${gone} row(s) of shifts before ${before} deleted`);
    return gone;
  }

  /**
   * When Planning.csv was last written — the file's TimeLastModified, or the
   * legacy PMD_Planning list's last item change — so the keeper replans only
   * when the export changed. null when it cannot be told.
   */
  async planningVersion(): Promise<string | null> {
    try {
      if (this.planningCsvPath) return await this.siteFileModified(this.planningCsvPath);
      const res = await this.getJson<{ d: { LastItemModifiedDate?: string } }>(
        `${this.listUrl(LISTS.planning)}?$select=LastItemModifiedDate`,
      );
      return res.d?.LastItemModifiedDate || null;
    } catch {
      return null;
    }
  }

  async appendImpwHandover(machineCode: string, shiftId: string, ticket: string): Promise<void> {
    if (!ticket.trim()) throw new Error('Missing Mango ticket number');
    const { shift } = parseShiftIdLoose(shiftId);
    const rows = (await this.fetchHeaders(LISTS.production, { machineCode, shiftId }))
      .filter((row) => row.machineCode === machineCode && row.date === shiftId.slice(0, 10) && row.shift === shift);
    if (!rows.length) throw new Error('No PMD_Production row found for this shift');
    const field = this.F.production.handover;
    for (const row of rows) {
      const url = `${this.listUrl(LISTS.production)}/items(${row.id})`;
      // Re-read the note and use its ETag so another user's edit cannot be overwritten.
      const { d } = await this.getJson<{ d: Record<string, unknown> & { __metadata: { etag: string; type: string } } }>(url);
      const note = str(d[field]);
      const line = `IMPW: ${ticket.trim()}`;
      const updated = formatHandover(appendHandoverLine(note, 'method', line));
      if (updated === note) continue;
      if (!d.__metadata?.etag) throw new Error('SharePoint did not return an ETag');
      await this.post(url, {
        __metadata: { type: d.__metadata.type },
        [field]: updated,
      }, d.__metadata.etag);
    }
  }

  /**
   * Set PMD_Production.Reopened on the signed row(s) for a (machine, shift,
   * job) tuple — a minimal single-field MERGE that leaves every other column
   * untouched. Used by unlock (true) so all devices see the order as reopened.
   * Best-effort: if the Reopened column doesn't exist on the tenant,
   * postWithFieldRetry strips it and the caller falls back to device-local
   * unlock. Date is narrowed to the exact calendar day like upsertHeaderInto.
   */
  protected async setReopenedFlag(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    value: boolean,
  ): Promise<void> {
    if (!this.F.production.reopened) return;
    await this.setProductionColumn(machineCode, shiftId, jobNumber, this.F.production.reopened, value);
  }

  /** Narrow single-column MERGE onto every PMD_Production row of a
   *  (machine, shift, job) tuple — deliberately NOT upsertHeaderInto,
   *  whose full-body MERGE can blank sibling columns. Used for the
   *  Reopened flag and the retroactive JobLeft heal. */
  protected async setProductionColumn(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    field: string,
    value: unknown,
  ): Promise<void> {
    const F = this.F.production;
    const date = shiftId.slice(0, 10);
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shiftId.slice(11))}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
      );
    const windowRows = await this.getAllItems<Record<string, unknown>>(LISTS.production, qs);
    const existing = windowRows.filter((r) => dateOnly(r[F.date]) === date);
    const idOf = (r: Record<string, unknown>): number | undefined =>
      (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
    for (const row of existing) {
      const id = idOf(row);
      if (id == null) continue;
      const body: Record<string, unknown> = {
        __metadata: { type: await this.itemType(LISTS.production) },
        [field]: value,
      };
      this.stripRejectedFields(LISTS.production, body);
      if (!(field in body)) return; // column already known-absent
      await this.postWithFieldRetry(
        LISTS.production,
        `${this.listUrl(LISTS.production)}/items(${id})`,
        body,
        '*',
      );
    }
  }

  /**
   * After a tuple signs off, re-derive the JobLeft column of every
   * LATER-started signed tuple of the same job. Sign-off order on the
   * floor is not chronological — Night regularly signs before a
   * forgotten Afternoon — and JobLeft means "pieces still needed when
   * the shift began" (order TOTAL − Σ good of earlier-started signed
   * shifts), so a late-arriving earlier shift must flow into the later
   * rows or the per-shift ledger the KPIs / Trace / next-shift Job Left
   * read stays overstated forever. Pure decision logic lives in
   * core/jobgood.retroJobLeftFixes; this just executes the MERGEs.
   * Best-effort: a failed heal is retried by the NEXT sign-off of the
   * same job (the recompute always walks the full list).
   */
  protected async healLaterJobLeft(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    required: number,
  ): Promise<void> {
    const F = this.F.production;
    if (!F.jobLeft || !(required > 0)) return;
    const all = await this.listSignedOffProduction({ jobNumber });
    const fixes = retroJobLeftFixes(all, machineCode, shiftId, required);
    for (const f of fixes) {
      console.info(
        `[pmd] JobLeft heal: ${f.machineCode}|${f.shiftId}|${jobNumber} → ${f.jobLeft} (late sign-off of ${shiftId})`,
      );
      await this.setProductionColumn(f.machineCode, f.shiftId, jobNumber, F.jobLeft, f.jobLeft);
    }
  }

  protected async upsertProductionHeader(h: HeaderInput): Promise<void> {
    await this.upsertHeaderInto(LISTS.production, h);
  }

  protected async upsertHeaderInto(
    list: string,
    h: HeaderInput,
  ): Promise<void> {
    const F = this.F.production;
    // F.date is a DateTime column. Stamp noon UTC of the shift's calendar
    // date so the SP list displays the right date in every regional setting
    // (see shiftDateMarker for why local-clock start was a bad anchor).
    // F.machine is mapped to Title, so writing [F.machine] populates Title
    // with the machine code (e.g. "Batt1") — no separate Machine column.
    const shiftId = `${h.date}-${h.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(list) },
      [F.machine]: h.machineCode,
      [F.shift]: h.shift,
      [F.jobNumber]: h.jobNumber,
      [F.countStart]: h.countStart ?? null,
      [F.countEnd]: h.countEnd ?? null,
      [F.reject]: h.reject,
      [F.operator]: h.operator,
      [F.supervisor]: h.supervisor,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    // Optional columns: only write if the field map has a non-empty name,
    // otherwise SP rejects the whole POST with "property X does not exist".
    // The `MachineCode` column is repurposed to carry the 16-char status
    // timeline string — see DEFAULT_FIELDS.production for context.
    if (F.machineCodeAlt) body[F.machineCodeAlt] = h.timeline;
    if (F.timeline) body[F.timeline] = h.timeline;
    if (F.partNum) body[F.partNum] = h.partNumber;
    if (F.partDesc) body[F.partDesc] = h.partDescription;
    // Only write JobRequired when non-zero. 0 here usually means the
    // editCache had no rehydrated value (older rows pre-denormalisation)
    // — writing 0 over a real existing value via the MERGE path would
    // blank it. stripRejectedFields tolerates absence of the column.
    if (F.jobRequired && h.jobRequired > 0) body[F.jobRequired] = h.jobRequired;
    // CycleTime: only write a real rate. 0 means "unknown" (no planning
    // row + no cached value) — writing 0 via MERGE would blank a good
    // value, same rationale as JobRequired above.
    if (F.cycleTime && h.cycleTime > 0) body[F.cycleTime] = h.cycleTime;
    // ShiftTarget snapshot — write when we could compute one.
    if (F.shiftTarget && h.shiftTarget != null) body[F.shiftTarget] = h.shiftTarget;
    // The shift's Schedule % at sign-off. Null when nothing on the shift was
    // scheduled at all — there is no adherence to a plan that does not exist,
    // and writing 0 would read as "made none of what was planned".
    if (F.vsPlan && h.vsPlan != null) body[F.vsPlan] = h.vsPlan;
    // Schedule snapshot (sign-off only). The plan is written whenever there
    // is a snapshot — 0 says "nothing planned" — and the % only when there
    // was a plan to adhere to.
    if (F.schedulePlan && h.schedulePlan != null) body[F.schedulePlan] = h.schedulePlan;
    if (F.scheduleAttain && h.scheduleAttain != null) {
      body[F.scheduleAttain] = (await this.scheduleAttainAsFraction())
        ? Math.round(h.scheduleAttain * 100) / 10_000
        : h.scheduleAttain;
    } else if (F.scheduleAttain && h.schedulePlan === 0) {
      // A re-sign-off that now finds nothing planned clears the old %.
      body[F.scheduleAttain] = null;
    }
    if (F.downTime) body[F.downTime] = h.downTime;
    if (F.runTime) body[F.runTime] = h.runTime;
    if (F.handover) body[F.handover] = formatHandover(h.handover);
    if (F.qcChecks) body[F.qcChecks] = h.qcChecks;
    if (F.rejectsBySlot) body[F.rejectsBySlot] = h.rejectsBySlot;
    // OwnerDevice (PMD_LiveStatus only). Only write a non-empty id —
    // never blank an existing owner via MERGE. PMD_Production has no such
    // column, but HeaderInput.ownerDevice is left undefined for it so
    // this is skipped anyway; stripRejectedFields covers any tenant that
    // hasn't added the column to the live list yet.
    if (F.ownerDevice && h.ownerDevice) body[F.ownerDevice] = h.ownerDevice;
    // Signoff (PMD_Production only). Only write when lockShift supplied a
    // timestamp — a live snapshot push leaves it undefined so the column
    // is never stamped on an in-progress row.
    if (F.signOff && h.signOff) body[F.signOff] = h.signOff;
    // JobLeft (PMD_Production only). Only write when lockShift supplied a
    // value — live snapshots leave it undefined so the column isn't
    // touched on an in-progress row. The 0 value is meaningful ("job
    // complete") so write it explicitly rather than skipping like the
    // jobRequired guard does.
    if (F.jobLeft && h.jobLeft != null) body[F.jobLeft] = h.jobLeft;
    // Reopened (PMD_Production only). Written explicitly on sign-off (false,
    // re-locks the row) and unlock (true). undefined on live pushes leaves
    // the column untouched.
    if (F.reopened && h.reopened !== undefined) body[F.reopened] = h.reopened;
    // PlannedStart (PMD_Production only). Only write a known value —
    // never blank an existing one via MERGE when planning has since
    // dropped the order.
    if (F.plannedStart && h.plannedStart) body[F.plannedStart] = h.plannedStart;
    // Cavities: write whatever number the row carries, 1 included. It used
    // to be skipped at 1 as "the default", but a 2-cavity die run on one
    // because the other cavity is blocked off is set to 1 — and skipping
    // that write left the column at 2 and doubled the shift's Good. No
    // number (the register did not know the tool) leaves the column alone.
    const cavities = h.cavities && h.cavities > 0 ? h.cavities : 1;
    if (F.cavities && h.cavities != null && h.cavities > 0) body[F.cavities] = h.cavities;
    // Only an order that has batched carries the field at all, so a tenant
    // without the column is never told about it for an ordinary shift.
    if (F.batchJobs && h.batchJobs !== undefined) body[F.batchJobs] = h.batchJobs;
    if (F.totalGood) {
      const cs = h.countStart;
      const ce = h.countEnd;
      // Actual Good = cycles × cavities − rejects (rejects are counted as
      // actual parts, not cycles, so they are not multiplied).
      const good =
        cs != null && ce != null ? Math.max(0, (ce - cs) * cavities - h.reject) : 0;
      body[F.totalGood] = good;
    }
    // SharePoint rejects C0/C1 control characters (NUL, etc.) in text
    // columns with a generic 500 "Invalid text value. A text field
    // contains invalid data." that doesn't say WHICH column. Strip them
    // out of every string value in the body so a stray paste from
    // Excel/Epicor or a zero-width oddity in a handover note can't fail
    // the whole sign-off. Whitespace (\t \n \r) is preserved.
    sanitizeBodyStrings(body);
    // PMD_LiveStatus was rebuilt by the user to mirror PMD_Production's
    // schema, but they may not have added every column yet (e.g.
    // JobHead_PartNum). Strip any fields previously rejected by SP for
    // this list so the rest of the row still lands.
    this.stripRejectedFields(list, body);
    // Find existing by composite key; MERGE if found, else POST. The
    // fetch uses the ±1d window for legacy-timestamp tolerance, but the
    // MERGE target must then be narrowed to the EXACT calendar date —
    // the window also matches the same shift code on adjacent days
    // (same job running Day shift on consecutive days is normal), and
    // merging into yesterday's row destroys yesterday's signed-off
    // record while leaving today unreadable.
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(h.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(h.shift)}' and ${F.jobNumber} eq '${odataString(h.jobNumber)}'`,
      );
    const windowRows = await this.getAllItems<Record<string, unknown>>(list, qs);
    const existing = windowRows
      .filter((r) => dateOnly(r[F.date]) === h.date)
      .sort((a, b) => (sharePointItemId(a) ?? Number.MAX_SAFE_INTEGER) - (sharePointItemId(b) ?? Number.MAX_SAFE_INTEGER));
    const idOf = (r: Record<string, unknown>): number | undefined =>
      (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
    const target =
      existing.length > 0
        ? `${this.listUrl(list)}/items(${idOf(existing[0])})`
        : `${this.listUrl(list)}/items`;
    const ifMatch = existing.length > 0 ? '*' : undefined;
    await this.postWithFieldRetry(list, target, body, ifMatch);
    // Re-read AFTER the write. Cleaning only the pre-write snapshot misses
    // the exact race that creates duplicates: two iPads both read zero rows,
    // then both POST. Every writer deterministically keeps the lowest ID, so
    // concurrent cleanups converge on the same canonical row.
    try {
      const afterWindow = await this.getAllItems<Record<string, unknown>>(list, qs);
      const after = afterWindow
        .filter((r) => dateOnly(r[F.date]) === h.date)
        .sort(
          (a, b) =>
            (sharePointItemId(a) ?? Number.MAX_SAFE_INTEGER) -
            (sharePointItemId(b) ?? Number.MAX_SAFE_INTEGER),
        );
      if (after.length > 1) {
        console.warn(
          '[pmd] collapsing',
          after.length - 1,
          'duplicate row(s) on',
          list,
          'for',
          `${h.machineCode}|${shiftId}|${h.jobNumber}`,
        );
        for (const dup of after.slice(1)) {
          const id = idOf(dup);
          if (id == null) continue;
          await this.del(`${this.listUrl(list)}/items(${id})`).catch((e) => {
            console.warn('[pmd] duplicate-row delete failed (will retry next sign-off):', e);
          });
        }
      }
    } catch (e) {
      // The row itself is already written. Treat convergence as best-effort;
      // the next writer repeats this post-write check.
      console.warn('[pmd] post-write duplicate check failed (next write retries):', e);
    }
  }

  /**
   * Per-shift PMD_BreakDownlog write — one row per (machine, shift, job).
   * StatusTimeline is the 16-char string ("RRRBBBCCCRRRRRRR") so the whole
   * shift's status pattern is recoverable from a single row. R/B/C/D/I/M/
   * O/P/S columns are the per-status hour totals (slot count × 0.5h).
   * BDCode = the most frequent breakdown code among the B slots (the
   * dominant cause). Row count stays tiny — one per signed-off shift+job.
   */
  protected async replaceBreakdownEvents(
    key: {
      machineCode: string;
      date: string;
      shift: string;
      jobNumber: string;
      partNumber: string;
      timeline: string;
    },
    slots: ProductionRecord[],
  ): Promise<RollbackAction> {
    const F = this.F.breakdown;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const agg = aggregateSlots(slots);
    const body: Record<string, unknown> = {
      [F.machine]: key.machineCode,
      [F.shift]: key.shift,
      [F.jobNum]: key.jobNumber,
      [F.partNum]: key.partNumber,
      [F.statusTimeline]: key.timeline,
      [F.bdCode]: agg.bdCode,
      [F.bdCause]: agg.bdCause,
      [F.r]: agg.hours.R,
      [F.b]: agg.hours.B,
      [F.c]: agg.hours.C,
      [F.d]: agg.hours.D,
      [F.i]: agg.hours.I,
      [F.m]: agg.hours.M,
      [F.o]: agg.hours.O,
      [F.p]: agg.hours.P,
      [F.s]: agg.hours.S,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    return this.replaceRowsWithRollback(
      LISTS.breakdown,
      `${F.machine} eq '${odataString(key.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(key.shift)}' and ${F.jobNum} eq '${odataString(key.jobNumber)}'`,
      { field: F.date, date: key.date },
      [body],
      [
        F.machine, F.date, F.shift, F.jobNum, F.partNum, F.statusTimeline, F.bdCode,
        F.bdCause,
        F.r, F.b, F.c, F.d, F.i, F.m, F.o, F.p, F.s,
      ],
    );
  }

  /** Keep the single PMD_BreakDownLog tuple current while the shift is live.
   * Unlike sign-off replacement this MERGEs in place, so the 60-second live
   * mirror does not churn list rows or briefly erase the tooltip source. */
  protected async upsertBreakdownSnapshot(
    key: {
      machineCode: string;
      date: string;
      shift: string;
      jobNumber: string;
      partNumber: string;
      timeline: string;
    },
    slots: ProductionRecord[],
  ): Promise<void> {
    const F = this.F.breakdown;
    const shiftId = `${key.date}-${key.shift}`;
    const agg = aggregateSlots(slots);
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.breakdown) },
      [F.machine]: key.machineCode,
      [F.shift]: key.shift,
      [F.jobNum]: key.jobNumber,
      [F.partNum]: key.partNumber,
      [F.statusTimeline]: key.timeline,
      [F.bdCode]: agg.bdCode,
      [F.bdCause]: agg.bdCause,
      [F.r]: agg.hours.R,
      [F.b]: agg.hours.B,
      [F.c]: agg.hours.C,
      [F.d]: agg.hours.D,
      [F.i]: agg.hours.I,
      [F.m]: agg.hours.M,
      [F.o]: agg.hours.O,
      [F.p]: agg.hours.P,
      [F.s]: agg.hours.S,
    };
    const marker = shiftDateMarker(shiftId);
    if (marker) body[F.date] = marker;
    sanitizeBodyStrings(body);
    const qs = '$filter=' + encodeURIComponent(
      `${F.machine} eq '${odataString(key.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(key.shift)}' and ${F.jobNum} eq '${odataString(key.jobNumber)}'`,
    );
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.breakdown, qs);
    const existing = rows.find((row) => dateOnly(row[F.date]) === key.date);
    const id = existing ? sharePointItemId(existing) : null;
    const url = id == null
      ? `${this.listUrl(LISTS.breakdown)}/items`
      : `${this.listUrl(LISTS.breakdown)}/items(${id})`;
    await this.post(url, body, id == null ? undefined : '*');
  }

  protected async replaceRejectEvents(
    key: { machineCode: string; date: string; shift: string; jobNumber: string },
    events: RejectEvent[],
  ): Promise<RollbackAction> {
    const F = this.F.rejects;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const bodies = events.map((ev) => {
      const body: Record<string, unknown> = {
        // F.machine is mapped to Title; setting it populates Title with the
        // machine code. No separate Machine column exists.
        [F.machine]: key.machineCode,
        [F.shift]: key.shift,
        [F.timeline]: ev.timeline,
        [F.jobNum]: key.jobNumber,
        [F.rejectCode]: ev.code,
        [F.rejectCategory]: ev.category,
        [F.rejectNumber]: ev.qty,
      };
      if (slotStartIso) body[F.date] = slotStartIso;
      return body;
    });
    return this.replaceRowsWithRollback(
      LISTS.rejects,
      `${F.machine} eq '${odataString(key.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(key.shift)}' and ${F.jobNum} eq '${odataString(key.jobNumber)}'`,
      { field: F.date, date: key.date },
      bodies,
      [
        F.machine, F.date, F.shift, F.timeline, F.jobNum,
        F.rejectCode, F.rejectCategory, F.rejectNumber,
      ],
    );
  }
}
