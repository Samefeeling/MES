/**
 * PMD_ShiftPlan kept up with Planning.csv, over the wire: a fake SharePoint
 * site (`fake-sharepoint`), nothing inside the data layer stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';
import { FakeSharePoint } from './fake-sharepoint';

const CSV_PATH = '/sites/pmd/Shared Documents/PMD/Planning.csv';
const HEAD =
  'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift';
const DAY = '2026-10-13-Day';
const ALL_DAY = [HEAD, '1600T,13/10/2026 6:00,20,14/10/2026 6:00,SFM1,PART-A,Shell,1200,1200,MAN'].join('\n');
const URGENT = [
  HEAD,
  '1600T,13/10/2026 11:00,20,13/10/2026 13:00,SFM9,PART-U,Urgent,100,100,MAN',
  '1600T,13/10/2026 13:00,20,14/10/2026 13:00,SFM1,PART-A,Shell,1200,1200,MAN',
].join('\n');

let site: FakeSharePoint;
let undo: () => void;
const device = () =>
  new SharePointDataLayer({ siteUrl: site.siteUrl, canWrite: () => true, planningCsvPath: CSV_PATH });

beforeEach(() => {
  site = new FakeSharePoint()
    .seed('PMD_Machine', [{ Title: '1600T', 'IsActive_x003a_Yes_x002f_No': true, DisplayOrder: 1 }])
    .seed('PMD_ShiftPlan')
    .seed('PMD_ManualOrders')
    .seed('PMD_Production')
    .seed('PMD_LiveStatus')
    .seed('PMD_ProductDieColor')
    .seedFile(CSV_PATH, ALL_DAY);
  undo = site.install();
});
afterEach(() => undo());

describe('PMD_ShiftPlan over the wire', () => {
  it('writes ahead, rewrites in place when the export changes, and one device does it', async () => {
    const ipad = device();
    const other = device();
    // An hour before the Day: one row for the press.
    await ipad.keepShiftPlans(DAY);
    const v1 = await ipad.planningVersion();
    expect(v1).toMatch(/^2026-01-01T/);
    expect(site.rows('PMD_ShiftPlan').filter((r) => r.MachineCode)).toHaveLength(1);
    expect(site.rows('PMD_ShiftPlan')[0].SchedulePlan).toBe(160);

    // 11:00: an urgent order goes in front.
    site.seedFile(CSV_PATH, URGENT);
    const v2 = await ipad.planningVersion();
    expect(v2).not.toBe(v1);
    site.calls.length = 0;
    await ipad.replanShiftPlans(DAY, new Date('2026-10-13T11:00:00'), v2);
    expect(site.writes()).toEqual(['MERGE PMD_ShiftPlan', 'POST PMD_ShiftPlan']);
    const plans = site.rows('PMD_ShiftPlan').filter((r) => r.MachineCode);
    expect(plans).toHaveLength(1);
    const jobs = (JSON.parse(String(plans[0].PlanJobs)) as Array<{ jobNumber: string; pieces?: number }>).filter(
      (j) => j.jobNumber,
    );
    expect(jobs).toEqual([
      expect.objectContaining({ jobNumber: 'SFM1', pieces: 120 }),
      expect.objectContaining({ jobNumber: 'SFM9', pieces: 40 }),
    ]);

    // The other iPad on the same export: one read of the note, nothing more.
    site.calls.length = 0;
    await other.replanShiftPlans(DAY, new Date('2026-10-13T11:03:00'), v2);
    expect(site.writes()).toEqual([]);
    expect(site.calls.some((c) => c.url.includes('Planning.csv'))).toBe(false);
    expect(site.unanswered).toEqual([]);
    expect(await other.listShiftPlans({ from: '2026-10-13', to: '2026-10-13' })).toEqual([
      expect.objectContaining({ machineCode: '1600T', shiftId: DAY, plan: 160 }),
    ]);
  });

  it('keeps last month and this one', async () => {
    site.seed('PMD_ShiftPlan', [
      { Title: '1600T|2026-09-30-Night', MachineCode: '1600T', ShiftId: '2026-09-30-Night', SchedulePlan: 1, PlanJobs: '[]' },
      { Title: '1600T|2026-10-01-Day', MachineCode: '1600T', ShiftId: '2026-10-01-Day', SchedulePlan: 1, PlanJobs: '[]' },
      { Title: 'PlanningChecked', MachineCode: '', ShiftId: '', SchedulePlan: 0, PlanJobs: '{}' },
    ]);
    expect(await device().pruneShiftPlans('2026-10-01')).toBe(1);
    expect(site.rows('PMD_ShiftPlan').map((r) => r.Title)).toEqual(['1600T|2026-10-01-Day', 'PlanningChecked']);
    expect(site.unanswered).toEqual([]);
  });
});
