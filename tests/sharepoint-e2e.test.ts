/**
 * The SharePoint data layer, end to end.
 *
 * One press, one shift, three devices, and a SharePoint site that only knows
 * REST (`fake-sharepoint`). Nothing inside the data layer is stubbed: each
 * step goes in through the methods the pages call and is checked by what
 * another device then reads, and by what is in the lists.
 *
 * The last test holds the whole conversation with the site — every request,
 * in order — against a stored copy. A change that is meant to move code and
 * nothing else must leave it exactly as it is.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';
import type { ProductionRecord } from '../src/types';
import { FakeSharePoint, evalFilter } from './fake-sharepoint';
import { rec } from './helpers';

/** Monday 16 Nov 2026, 10:05 on the floor — the Day shift's 7th half-hour. */
const NOW = new Date(2026, 10, 16, 10, 5, 0);
const SHIFT = '2026-11-16-Day';
const PRESS = '850T';
const JOB = 'SFM507001';

const site = new FakeSharePoint()
  .seed('PMD_Machine', [
    { Title: '850T', 'IsActive_x003a_Yes_x002f_No': true, DisplayOrder: 2 },
    { Title: '550T', 'IsActive_x003a_Yes_x002f_No': true, DisplayOrder: 1 },
    { Title: 'Retired', 'IsActive_x003a_Yes_x002f_No': false, DisplayOrder: 3 },
  ])
  .seed('PMD_Operator', [
    { Title: 'Tony Lee', Shift: 'Day', Position: 'Operator', Supervisor: 'Jeff Penn' },
    { Title: 'Karl Stevens', Shift: 'Afternoon', Position: 'Operator', Supervisor: 'Christopher King' },
  ])
  .seed('PMD_RejectCategories', [
    { Title: 'D01', Description: 'ShortShot' },
    { Title: 'D02', Description: 'FlashMelt-out' },
  ])
  .seed('PMD_BreakdownMaster', [
    { BDCODE: 'ELE-03', Cause: 'Servo / VFD drive fault or alarm', Category: 'Electrical', LikelyOwner: 'Maintenance' },
  ])
  .seed('PMD_Planning', [
    {
      JobHead_JobNum: JOB,
      JobHead_PartNum: '7911FR',
      JobHead_PartDescription: 'Encore shell',
      JobHead_ProdQty: 500,
      Calculated_RemainingQty: 400,
      QTYperHour: 60,
      StartDateTime: '2026-11-16T07:00:00Z',
      Due_Date: '2026-11-20T00:00:00Z',
      Duration: 8,
    },
  ])
  .seed('PMD_ManualOrders')
  .seed('PMD_Production')
  .seed('PMD_LiveStatus')
  .seed('PMD_Rejects')
  .seed('PMD_BreakDownlog')
  .seed('PMD_ShiftPlan')
  .seed('PMD_ProductDieColor')
  .seed('PMD_DieMaster');

/** A device on the site: the operator's iPad writes, an office PC only reads. */
const device = (writes: boolean): SharePointDataLayer =>
  new SharePointDataLayer({ siteUrl: site.siteUrl, canWrite: () => writes });

const slot = (slotIndex: number, extra: Partial<ProductionRecord> = {}): ProductionRecord =>
  rec({ machineCode: PRESS, shiftId: SHIFT, jobNumber: JOB, slotIndex, statusCode: 'R', ...extra });

const timeline = (records: ProductionRecord[]): string =>
  Array.from({ length: 16 }, (_, i) => records.find((r) => r.slotIndex === i)?.statusCode || '·').join('');

let uninstall: () => void;
let ipad: SharePointDataLayer;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  uninstall = site.install();
  ipad = device(true);
});

afterAll(() => {
  uninstall();
  vi.useRealTimers();
});

describe('the fake site reads the filters the data layer writes', () => {
  const row = { Title: "O'Brien", ShiftId: 'Day', Count: 3, Date: '2026-11-16T00:00:00Z', Empty: null };
  it.each([
    ["Title eq 'O''Brien' and ShiftId eq 'day'", true],
    ["Title eq 'x' or (Count ge 3 and Count lt 4)", true],
    ["Date ge datetime'2026-11-15T00:00:00Z' and Date le datetime'2026-11-17T00:00:00Z'", true],
    ["Date gt datetime'2026-11-16T00:00:00Z'", false],
    ["startswith(Title,'o''b') and substringof('rie',Title)", true],
    ['Empty eq null and Count ne 4', true],
  ])('%s → %s', (filter, expected) => {
    expect(evalFilter(filter, row)).toBe(expected);
  });
});

describe('a shift on one press, across devices', () => {
  it('reads the reference lists as the pages use them', async () => {
    // The presses, in the order the list holds them; plant that is not a
    // press ("Retired") is left out.
    const machines = await ipad.listMachines();
    expect(machines.map((m) => `${m.machineCode} #${m.sequence}`)).toEqual(['850T #2', '550T #1']);

    expect((await ipad.listOperators()).map((o) => `${o.operatorName} (${o.shift})`)).toEqual([
      'Tony Lee (Day)',
      'Karl Stevens (Afternoon)',
    ]);
    // Supervisors are whoever the operators report to.
    expect((await ipad.listSupervisors()).map((s) => s.operatorName).sort()).toEqual([
      'Christopher King',
      'Jeff Penn',
    ]);
    expect((await ipad.listRejectCategories()).map((c) => `${c.code} ${c.label}`)).toEqual([
      'D01 ShortShot',
      'D02 FlashMelt-out',
    ]);
    expect(await ipad.listBdCodes()).toMatchObject([{ code: 'ELE-03', subCategory: 'Electrical', owner: 'Maintenance' }]);

    const [order] = await ipad.listPlanning({});
    expect(order).toMatchObject({ jobNumber: JOB, partNumber: '7911FR', orderQty: 500 });
  });

  it('keeps an edit on the device: nothing is written to the record before sign-off', async () => {
    await ipad.upsertProductionRecord(slot(0, { operator: 'Tony Lee', supervisor: 'Jeff Penn', countStart: 0, countEnd: 150, qcBy: 'Tony Lee' }));
    await ipad.upsertProductionRecord(slot(1, { qcBy: 'Jeff Penn', rejectCount: 3, rejects: JSON.stringify({ D01: 3 }) }));
    await ipad.upsertProductionRecord(slot(2, { statusCode: 'B', bdIssue: 'ELE-03', bdCause: 'Servo / VFD drive fault or alarm' }));
    await ipad.upsertProductionRecord(slot(3));

    expect(site.writes()).toEqual([]);
    expect(site.rows('PMD_Production')).toEqual([]);
    // The device itself reads its own work back.
    const mine = await ipad.listProduction({ machineCode: PRESS, shiftId: SHIFT });
    expect(timeline(mine)).toBe('RRBR············');
    expect(mine.every((r) => !r.locked)).toBe(true);
  });

  it('mirrors work in progress so that other devices see it', async () => {
    await ipad.pushLiveSnapshot();
    expect(site.rows('PMD_LiveStatus')).toHaveLength(1);
    expect(site.rows('PMD_Production')).toEqual([]);

    const office = device(false);
    const seen = await office.listProduction({ machineCode: PRESS, shiftId: SHIFT });
    expect(timeline(seen)).toBe('RRBR············');
    expect(seen.every((r) => !r.locked)).toBe(true);
    expect(seen.find((r) => r.slotIndex === 0)).toMatchObject({ operator: 'Tony Lee', countStart: 0, countEnd: 150 });

    // A second push updates the row it wrote; it does not add another.
    await ipad.upsertProductionRecord(slot(4));
    await ipad.pushLiveSnapshot();
    expect(site.rows('PMD_LiveStatus')).toHaveLength(1);
    // And a device that may not write mirrors nothing, whatever it holds.
    await office.upsertProductionRecord(slot(9));
    await office.pushLiveSnapshot();
    expect(site.rows('PMD_LiveStatus')).toHaveLength(1);
    expect(timeline(await device(false).listProduction({ machineCode: PRESS, shiftId: SHIFT }))).toBe('RRBRR···········');
  });

  it('signs the shift off into the record, the breakdown log and the reject log', async () => {
    await ipad.lockShift(PRESS, SHIFT, 'Jeff Penn', 'Tony Lee', JOB);

    const [row] = site.rows('PMD_Production');
    expect(site.rows('PMD_Production')).toHaveLength(1);
    expect(row).toMatchObject({
      Title: PRESS,
      ShiftId: 'Day',
      JobNumber: JOB,
      JobHead_PartNum: '7911FR',
      Operator: 'Tony Lee',
      Supervisor: 'Jeff Penn',
      CountStart: 0,
      CountEnd: 150,
      Reject: 3,
      RunTime: 2,
      Downtime: 0.5,
      Reopened: false,
      Signoff: NOW.toISOString(),
    });
    expect(site.rows('PMD_BreakDownlog')).toMatchObject([
      { Title: PRESS, JobHead_JobNum: JOB, StatusTimeline: 'RRBRR···········', BDCode: 'ELE-03', B_BreakDown: 0.5 },
    ]);
    expect(site.rows('PMD_Rejects')).toMatchObject([{ Title: PRESS, JobHead_JobNum: JOB, RejectCode: 'D01', RejectNumber: 3 }]);
    // The mirror row is in-progress work only: it goes when the shift is signed.
    expect(site.rows('PMD_LiveStatus')).toEqual([]);
    expect(ipad.takeWriteWarnings()).toEqual([]);
  });

  it('gives every device the signed shift, locked, as it was entered', async () => {
    const office = device(false);
    const signed = await office.listProduction({ machineCode: PRESS, shiftId: SHIFT });
    expect(timeline(signed)).toBe('RRBRR···········');
    expect(signed.every((r) => r.locked && r.lockedBy === 'Jeff Penn' && !r.reopened)).toBe(true);
    expect(signed.find((r) => r.slotIndex === 0)).toMatchObject({
      operator: 'Tony Lee',
      supervisor: 'Jeff Penn',
      countStart: 0,
      countEnd: 150,
      qcBy: 'Tony Lee',
      partNumber: '7911FR',
    });
    expect(signed.find((r) => r.slotIndex === 1)).toMatchObject({ qcBy: 'Jeff Penn', rejectCount: 3 });
    expect(JSON.parse(signed.find((r) => r.slotIndex === 1)!.rejects)).toEqual({ D01: 3 });
    expect(signed.find((r) => r.slotIndex === 2)).toMatchObject({ statusCode: 'B', bdIssue: 'ELE-03' });

    // What the KPI pages read: signed rows only.
    const forKpi = await office.listSignedOffProduction({ shiftIdFrom: '2026-11-16', shiftIdTo: '2026-11-16-z' });
    expect(timeline(forKpi.filter((r) => r.machineCode === PRESS))).toBe('RRBRR···········');
    expect(await office.listRejectPareto({ from: '2026-11-16', to: '2026-11-16' })).toMatchObject([
      { code: 'D01', value: 3, byShift: { Day: 3 } },
    ]);
  });

  it('reopens a signed shift for every device, and re-signs it into the same row', async () => {
    const supervisorPc = device(true);
    await supervisorPc.unlockShift(PRESS, SHIFT, JOB);
    expect(site.rows('PMD_Production')).toMatchObject([{ Reopened: true }]);

    // Another iPad, which did not do the unlock, sees it open and corrects it.
    const otherIpad = device(true);
    const open = await otherIpad.listProduction({ machineCode: PRESS, shiftId: SHIFT });
    expect(open.every((r) => r.reopened)).toBe(true);
    const first = open.find((r) => r.slotIndex === 0)!;
    await otherIpad.upsertProductionRecord({ ...first, countEnd: 160 });
    await otherIpad.upsertProductionRecord(slot(5, { statusCode: 'M' }));
    await otherIpad.lockShift(PRESS, SHIFT, 'Jeff Penn', 'Tony Lee', JOB);

    // One row still — the correction went into it, and the lock is back on.
    const rows = site.rows('PMD_Production');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ CountEnd: 160, Reopened: false, Operator: 'Tony Lee', JobHead_PartNum: '7911FR' });
    expect(site.rows('PMD_BreakDownlog')).toMatchObject([{ StatusTimeline: 'RRBRRM··········' }]);
    expect(site.rows('PMD_Rejects')).toHaveLength(1);

    const after = await device(false).listProduction({ machineCode: PRESS, shiftId: SHIFT });
    expect(timeline(after)).toBe('RRBRRM··········');
    expect(after.every((r) => r.locked && !r.reopened)).toBe(true);
    expect(after.find((r) => r.slotIndex === 0)).toMatchObject({ countEnd: 160, qcBy: 'Tony Lee' });
  });

  it('adds an order the extract is missing, for every device', async () => {
    await ipad.createManualOrder({ jobNumber: 'SFM999001', partNumber: '400.410.70', partDescription: 'Rush job', orderQty: 50 });
    const orders = await device(false).listPlanning({});
    expect(orders.map((o) => o.jobNumber).sort()).toEqual([JOB, 'SFM999001']);
    expect(orders.find((o) => o.jobNumber === 'SFM999001')).toMatchObject({ source: 'Manual', orderQty: 50 });
  });

  it('asked the site for nothing it does not have', () => {
    expect(site.unanswered).toEqual([]);
  });

  it('held the same conversation with the site as the stored one', () => {
    // Two things differ from run to run and say nothing about the code: the
    // moment (in UTC, so it moves with the machine's time zone) and the id a
    // device with no storage makes up for itself.
    const now = NOW.toISOString();
    const stable = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (_key, v) =>
          v === now ? '<now>' : typeof v === 'string' && /^mem-[a-z0-9]+$/.test(v) ? '<device>' : v,
        ),
      );
    expect(stable(site.calls)).toMatchSnapshot();
  });
});
