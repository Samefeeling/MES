import { describe, expect, it } from 'vitest';
import {
  remainderChanged,
  replannedShiftPlan,
  shiftPlanFor,
  shiftPlanRevisions,
  type SavedShiftPlan,
} from '../src/core/kpi-attainment';
import { parsePlanningCsv, SharePointDataLayer } from '../src/dal/sharepoint';
import { MemoryDataLayer } from '../src/dal/memory';
import { planBarEntry } from '../src/dal/sharepoint/rows';

const HEAD =
  'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift';
const DAY = '2026-10-13-Day'; // Tuesday 07:00 → 15:00
const csv = (...rows: string[]) => parsePlanningCsv([HEAD, ...rows].join('\n'));
const at = (local: string) => new Date(local);

// The export of 06:45: 1600T runs SFM1 all day.
const BEFORE = csv('1600T,13/10/2026 6:00,20,14/10/2026 6:00,SFM1,PART-A,Shell,1200,1200,MAN');
const kept = shiftPlanFor(BEFORE, '1600T', DAY, at('2026-10-13T06:45:00'))!;

describe('PMD_ShiftPlan replanned when Planning.csv changes', () => {
  it('the shift is kept from the file before it starts', () => {
    expect(kept.plan).toBeGreaterThan(0);
    expect(kept.jobs.map((j) => j.jobNumber)).toEqual(['SFM1']);
  });

  it('an export that only moves the order under way to "now" changes nothing', () => {
    // The 11:00 export after a four-hour breakdown: SFM1 starts at 11:00.
    const moved = csv('1600T,13/10/2026 11:00,20,14/10/2026 11:00,SFM1,PART-A,Shell,1200,1200,MAN');
    const fresh = shiftPlanFor(moved, '1600T', DAY, at('2026-10-13T11:05:00'))!;
    // Taken whole, the file would forgive the breakdown: half the plan.
    expect(fresh.plan).toBeLessThan(kept.plan * 0.6);
    expect(remainderChanged(kept, fresh, at('2026-10-13T11:05:00'))).toBe(false);
    const { rewrite } = shiftPlanRevisions(['1600T'], [kept], moved, DAY, at('2026-10-13T11:05:00'));
    expect(rewrite).toEqual([]);
  });

  it('an order put in front mid-shift is asked for from then on; the morning stays as kept', () => {
    const urgent = csv(
      '1600T,13/10/2026 11:00,20,13/10/2026 13:00,SFM9,PART-U,Urgent,100,100,MAN',
      '1600T,13/10/2026 13:00,20,14/10/2026 13:00,SFM1,PART-A,Shell,1200,1200,MAN',
    );
    const now = at('2026-10-13T11:00:00');
    const fresh = shiftPlanFor(urgent, '1600T', DAY, now)!;
    expect(remainderChanged(kept, fresh, now)).toBe(true);
    const replanned = replannedShiftPlan(kept, fresh, now);
    const sfm1 = replanned.jobs.find((j) => j.jobNumber === 'SFM1')!;
    const sfm9 = replanned.jobs.find((j) => j.jobNumber === 'SFM9')!;
    // 07–11 of SFM1 as kept, and 13–15 of it from the new file.
    expect(sfm1.pieces).toBeCloseTo(kept.jobs[0].pieces * 0.75, -1);
    expect(sfm9.pieces).toBe(fresh.jobs.find((j) => j.jobNumber === 'SFM9')!.pieces);
    expect(replanned.plan).toBe(sfm1.pieces + sfm9.pieces);
    // The bar: SFM1 to 11:00, then what the new file runs.
    expect(replanned.bar!.filter((b) => b.kind === 'run').map((b) => b.jobNumber)).toEqual(['SFM1', 'SFM9', 'SFM1']);
    expect(replanned.bar![0].end).toBe(now.toISOString());
  });

  it('an order taken off the press is not asked for from then on', () => {
    const off = csv('1300T,13/10/2026 6:00,20,14/10/2026 6:00,SFM1,PART-A,Shell,1200,1200,MAN');
    const now = at('2026-10-13T09:00:00');
    const fresh = shiftPlanFor(off, '1600T', DAY, now)!;
    expect(fresh.plan).toBe(0);
    const replanned = replannedShiftPlan(kept, fresh, now);
    expect(replanned.plan).toBe(Math.round(kept.plan * 0.25));
  });

  it('before the shift starts the whole of it is replanned; once it is over, none of it', () => {
    const later = csv('1600T,13/10/2026 11:00,20,14/10/2026 11:00,SFM1,PART-A,Shell,1200,1200,MAN');
    const early = at('2026-10-13T06:15:00');
    const fresh = shiftPlanFor(later, '1600T', DAY, early)!;
    expect(remainderChanged(kept, fresh, early)).toBe(true);
    expect(replannedShiftPlan(kept, fresh, early)).toEqual(fresh);
    const over = at('2026-10-13T15:30:00');
    expect(remainderChanged(kept, fresh, over)).toBe(false);
    expect(replannedShiftPlan(kept, fresh, over)).toBe(kept);
  });

  it('a press with no row gets one, and only the changed press is rewritten', () => {
    const both = csv(
      '1600T,13/10/2026 6:00,20,14/10/2026 6:00,SFM1,PART-A,Shell,1200,1200,MAN',
      '550T,13/10/2026 10:00,20,14/10/2026 6:00,SFM5,PART-B,Arm,600,600,MAN',
    );
    const idle550: SavedShiftPlan = { machineCode: '550T', shiftId: DAY, plan: 0, jobs: [], bar: [] };
    const { save, rewrite, remove } = shiftPlanRevisions(
      ['1600T', '550T', '320T'],
      [kept, idle550],
      both,
      DAY,
      at('2026-10-13T09:30:00'),
    );
    expect(remove).toEqual([]);
    expect(save.map((p) => p.machineCode)).toEqual(['320T']);
    expect(rewrite.map((r) => r.row.machineCode)).toEqual(['550T']);
    expect(rewrite[0].plan.jobs.map((j) => j.jobNumber)).toEqual(['SFM5']);
  });
});

describe('SharePoint DAL: replanShiftPlans and pruneShiftPlans', () => {
  // A PMD_ShiftPlan list in memory, behind the DAL's REST helpers.
  function site(planning: ReturnType<typeof csv>) {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x', canWrite: () => true });
    const items: Array<Record<string, unknown>> = [];
    const merges: Array<{ id: number; body: Record<string, unknown> }> = [];
    const deletes: number[] = [];
    let planningReads = 0;
    const o = dal as unknown as Record<string, unknown>;
    o.listMachines = async () => ['1600T'].map((machineCode) => ({ machineCode, active: true }));
    o.listProductDieColors = async () => [];
    o.listPlanning = async () => {
      planningReads++;
      return planning;
    };
    o.listProduction = async () => [];
    o.listProductionCounters = async () => [];
    o.getJson = async () => ({ d: {} });
    o.itemType = async () => 'SP.Data.PMD_x005f_ShiftPlanListItem';
    o.getAllItems = async (_list: string, query = '') => {
      const q = decodeURIComponent(query);
      const eq = /ShiftId eq '([^']+)'/.exec(q)?.[1];
      const lt = /ShiftId lt '([^']+)'/.exec(q)?.[1];
      const title = /Title eq '([^']+)'/.exec(q)?.[1];
      return items.filter((r) =>
        eq ? r.ShiftId === eq : lt ? String(r.ShiftId) < lt : title ? r.Title === title : true,
      );
    };
    o.post = async (url: string, body: Record<string, unknown>, ifMatch?: string) => {
      const id = /items\((\d+)\)$/.exec(url)?.[1];
      if (id && ifMatch) {
        merges.push({ id: Number(id), body });
        Object.assign(items.find((r) => r.ID === Number(id))!, body);
      } else if (url.endsWith('/items')) items.push({ ID: items.length + 1, ...body });
      return {};
    };
    o.del = async (url: string) => {
      const id = Number(/items\((\d+)\)$/.exec(url)?.[1]);
      deletes.push(id);
      items.splice(items.findIndex((r) => r.ID === id), 1);
    };
    return { dal, items, merges, deletes, planningReads: () => planningReads };
  }
  const row = (id: number, plan: SavedShiftPlan) => ({
    ID: id,
    Title: `${plan.machineCode}|${plan.shiftId}`,
    MachineCode: plan.machineCode,
    ShiftId: plan.shiftId,
    SchedulePlan: plan.plan,
    PlanJobs: JSON.stringify([
      ...plan.jobs,
      ...(plan.bar ?? []).map(planBarEntry),
    ]),
  });
  const URGENT = csv(
    '1600T,13/10/2026 11:00,20,13/10/2026 13:00,SFM9,PART-U,Urgent,100,100,MAN',
    '1600T,13/10/2026 13:00,20,14/10/2026 13:00,SFM1,PART-A,Shell,1200,1200,MAN',
  );

  it('rewrites the kept row in place, and the next device on the same export does nothing', async () => {
    const sp = site(URGENT);
    sp.items.push(row(1, kept));
    const now = at('2026-10-13T11:00:00');
    const rows = await sp.dal.replanShiftPlans(DAY, now, '2026-10-13T00:58:00Z');
    expect(rows?.map((r) => r.plan)).toEqual([160]);
    expect(sp.merges.map((m) => m.id)).toEqual([1]);
    expect(sp.merges[0].body.SchedulePlan).toBe(160);
    // Still one row for the press, and the note of the export it came from.
    expect(sp.items.filter((r) => r.MachineCode === '1600T')).toHaveLength(1);
    expect(sp.items.find((r) => r.Title === 'PlanningChecked')).toMatchObject({ MachineCode: '', ShiftId: '' });
    const reads = sp.planningReads();
    await sp.dal.replanShiftPlans(DAY, at('2026-10-13T11:04:00'), '2026-10-13T00:58:00Z');
    expect(sp.planningReads()).toBe(reads);
    // The marker is no plan.
    expect(await sp.dal.listShiftPlans({ from: '2026-10-13', to: '2026-10-13' })).toHaveLength(1);
  });

  it('leaves the row alone when the export only moved the order under way', async () => {
    const sp = site(csv('1600T,13/10/2026 11:00,20,14/10/2026 11:00,SFM1,PART-A,Shell,1200,1200,MAN'));
    sp.items.push(row(1, kept));
    await sp.dal.replanShiftPlans(DAY, at('2026-10-13T11:05:00'), 'v2');
    expect(sp.merges.filter((m) => m.id === 1)).toEqual([]);
  });

  it('prunes shifts before the date given, and never the marker', async () => {
    const sp = site(URGENT);
    sp.items.push(
      row(1, { ...kept, shiftId: '2026-08-31-Night' }),
      row(2, { ...kept, shiftId: '2026-09-01-Day' }),
      row(3, { ...kept, shiftId: '2026-10-01-Day' }),
      { ID: 4, Title: 'PlanningChecked', MachineCode: '', ShiftId: '', SchedulePlan: 0, PlanJobs: '{}' },
    );
    expect(await sp.dal.pruneShiftPlans('2026-10-01')).toBe(2);
    expect(sp.items.map((r) => r.ID)).toEqual([3, 4]);
  });
});

describe('MemoryDataLayer: the same, in the demo', () => {
  it('rewrites in place and prunes by shift date', async () => {
    const dal = new MemoryDataLayer(at('2026-10-13T06:00:00'));
    const internals = dal as unknown as { planning: unknown; shiftPlans: SavedShiftPlan[] };
    internals.planning = csv('1600T,13/10/2026 6:00,20,14/10/2026 6:00,SFM1,PART-A,Shell,1200,1200,MAN');
    internals.shiftPlans = [];
    const first = await dal.keepShiftPlans(DAY, at('2026-10-13T06:00:00'));
    const count = first.length;
    expect(first.find((p) => p.machineCode === '1600T')?.plan).toBe(160);
    internals.planning = URGENT_MEMORY;
    const after = await dal.replanShiftPlans(DAY, at('2026-10-13T11:00:00'));
    expect(after).toHaveLength(count);
    expect(after.find((p) => p.machineCode === '1600T')?.jobs.map((j) => j.jobNumber)).toEqual(['SFM1', 'SFM9']);
    expect(await dal.pruneShiftPlans('2026-10-14')).toBe(count);
    expect(await dal.listShiftPlans({ from: '2026-10-01', to: '2026-10-31' })).toEqual([]);
  });
});

const URGENT_MEMORY = csv(
  '1600T,13/10/2026 11:00,20,13/10/2026 13:00,SFM9,PART-U,Urgent,100,100,MAN',
  '1600T,13/10/2026 13:00,20,14/10/2026 13:00,SFM1,PART-A,Shell,1200,1200,MAN',
);
