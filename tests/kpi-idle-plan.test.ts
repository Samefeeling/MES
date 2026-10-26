import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  idleShiftTuples,
  keptPlanTuples,
  scheduleTuplesForShift,
  shiftPlanChanges,
  shiftPlanFor,
  type AttainmentTuple,
  type PlanContext,
  type SavedShiftPlan,
} from '../src/core/kpi-attainment';
import { MemoryDataLayer } from '../src/dal/memory';
import { parsePlanningCsv, SharePointDataLayer } from '../src/dal/sharepoint';
import { shiftTargetFor } from '../src/core/targets';
import type { ProductionRecord } from '../src/types';
import { rec } from './helpers';

// Planning.csv as PMD had it for Monday 12 Oct 2026 (the rows that touch the
// day). 1300T's second order runs Morning + Night only; 320T is planned for
// the night with a two-part tool. MES has nothing signed for either at night.
const PLAN_12_OCT = [
  'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
  '1300T,12/10/2026 7:30,16,12/10/2026 12:00,SFM507841,G1188100,Postura,200,1000,MAN',
  '1300T,12/10/2026 12:00,16,15/10/2026 8:18,SFM507942,G1188101,Postura,700,700,MN',
  '1600T,12/10/2026 7:30,23.00000046,14/10/2026 16:24,SFM507571,INSC0000,Integra,1180,3196,MAN',
  'Batt2,13/10/2026 23:00,26.09302372,15/10/2026 10:41,SFM507866,G0256004,Proteus,918,918,MAN',
  'Batt1,12/10/2026 7:30,24.00000384,12/10/2026 11:56,SFM507920,POPL0112,Postura,150,150,MAN',
  '550T,13/10/2026 3:00,17.99999856,14/10/2026 9:45,SFM507970,V4528,Podium,400,400,MN',
  '320T,12/10/2026 23:00,45.00450045,13/10/2026 1:43,SFM507921,V11582-2,Lumba Arm,100,100,MN',
  '320T,12/10/2026 23:00,45.00450045,13/10/2026 1:43,SFM507922,V11582-1,Lumba Arm,100,100,MN',
  'HS,12/10/2026 12:00,20.99958001,12/10/2026 18:36,018661-2,MAPSE000,Postura,65,65,MA',
].join('\n');
const orders = parsePlanningCsv(PLAN_12_OCT);
// PMD_ProductDieColor for these parts: 1300T's two orders are colours of one
// Postura shell, and 320T's two parts come off one tool.
const DIES: Record<string, string> = {
  G1188100: 'D-POSTURA', G1188101: 'D-POSTURA', 'V11582-1': 'D-LUMBA', 'V11582-2': 'D-LUMBA',
};
const CTX: PlanContext = { dieOf: (part) => DIES[part.toUpperCase()] };
/** The same, as PMD_ProductDieColor rows for a DAL to read. */
const DIE_ROWS = Object.entries(DIES).map(([partNumber, dieNumber]) => ({
  partNumber, dieNumber, hex: '', name: '', category: '', die: '', coRun: false,
}));
const MORNING_AFTER = new Date('2026-10-13T09:00:00');
const SHIFTS = ['Day', 'Afternoon', 'Night'].map((s) => `2026-10-12-${s}`);
const PRESSES = ['1600T', '1300T', 'Batt1', 'Batt2', '850T', '550T', '320T', '150T', '125T', 'HStamp'];

const made = (machineCode: string, shift: string, jobNumber: string, good: number): ProductionRecord =>
  rec({
    machineCode, shiftId: `2026-10-12-${shift}`, jobNumber, slotIndex: 2, statusCode: 'R',
    countStart: 0, countEnd: good, locked: true,
  });

// What MES had signed for the day, as the KPI table showed it.
const SIGNED = [
  made('1600T', 'Day', 'SFM507571', 67),
  made('1600T', 'Afternoon', 'SFM507571', 195),
  made('1600T', 'Night', 'SFM507571', 205),
  made('1300T', 'Day', 'SFM507841', 123),
  made('Batt1', 'Day', 'SFM507920', 114),
  made('550T', 'Night', 'SFM507970', 0),
  made('HStamp', 'Afternoon', '018661-2', 65),
];

const lastDay = (unsigned: (press: string, shiftId: string) => boolean): AttainmentTuple[] =>
  PRESSES.flatMap((press) => {
    const own = SIGNED.filter((r) => r.machineCode === press);
    return SHIFTS.flatMap((sid) =>
      scheduleTuplesForShift(own, orders, press, sid, MORNING_AFTER, unsigned(press, sid), CTX),
    );
  });

const plannedOn = (lines: AttainmentTuple[], press: string, shift: string): number =>
  lines
    .filter((l) => l.machineCode === press && l.shiftId === `2026-10-12-${shift}`)
    .reduce((sum, l) => sum + (l.planned ?? 0), 0);

describe('12 Oct 2026: a press planned and not signed stays in the plan', () => {
  it('asks each press for its share of the day, in whole pieces', () => {
    const lines = lastDay(() => false);
    expect(plannedOn(lines, '1600T', 'Day')).toBe(172); // 7.5 h × 23
    expect(plannedOn(lines, '1300T', 'Day')).toBe(120); // 72 + 48
    expect(plannedOn(lines, '1300T', 'Afternoon')).toBe(0); // "MN": no afternoon crew
    expect(plannedOn(lines, '1300T', 'Night')).toBe(128); // 8 h × 16
    expect(plannedOn(lines, 'Batt1', 'Day')).toBe(106);
    // 550T's order is its first in the file, not under way, and starts at
    // 03:00 — long after the export's 07:30 "now": those four hours put its
    // die on, and the press runs it from 07:00 (core/schedule
    // pressRunsAfterDieChanges). It made nothing that night either.
    expect(plannedOn(lines, '550T', 'Night')).toBe(0);
    expect(plannedOn(lines, '320T', 'Night')).toBe(200); // two parts off one tool
    // 3 h at 20.99958 is 62.9987: 63, and the 2 left of the order after it.
    expect(plannedOn(lines, 'HStamp', 'Day')).toBe(63);
    expect(plannedOn(lines, 'HStamp', 'Afternoon')).toBe(2);
  });

  it('judges the day against 1,159 pieces, not the 902 MES had rows for', () => {
    // 1300T's night booked work nobody signed off; 320T booked nothing.
    const lines = lastDay((press, sid) => press === '1300T' && sid.endsWith('Night'));
    const a = attainmentOfTuples(lines);
    // 1,231 before 550T's die change was given its four hours.
    expect(a.expected).toBe(1159);
    // 67 + 184 + 184 + 72 (1300T's first order, capped) + 106 + 0 + 2.
    expect(a.actual).toBe(615);
    expect(a.pct).toBe(Math.round((615 / 1159) * 100));
    const night1300 = lines.filter((l) => l.machineCode === '1300T' && l.shiftId.endsWith('Night'));
    expect(night1300.every((l) => l.unsigned && l.credited === 0)).toBe(true);
  });

  it('ShiftTarget is not a piece short either', () => {
    // 8 h at 17.99999856 an hour.
    expect(shiftTargetFor({ qtyPerHr: 1 / 17.99999856 }, 1000)).toBe(144);
  });
});

describe('PMD_ShiftPlan: the plan kept for a press with nothing signed', () => {
  const NIGHT = '2026-10-12-Night';

  it('is the Last 24h plan of a press that did not run, order by order', () => {
    expect(shiftPlanFor(orders, '320T', NIGHT, MORNING_AFTER, CTX)).toEqual({
      machineCode: '320T',
      shiftId: NIGHT,
      plan: 200,
      jobs: [
        { jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 100 },
        { jobNumber: 'SFM507922', partNumber: 'V11582-1', pieces: 100 },
      ],
    });
    // Judged to the end of the shift even when signed before it.
    expect(shiftPlanFor(orders, '1300T', NIGHT, new Date('2026-10-13T05:00:00'), CTX)?.plan).toBe(128);
    expect(shiftPlanFor(orders, 'Batt2', NIGHT, MORNING_AFTER, CTX)).toBeNull();
  });

  it('is kept by any sign-off of the shift, for every planned press with nothing signed', () => {
    const { save, remove } = shiftPlanChanges(PRESSES, new Set(['1600T', '550T']), [], orders, NIGHT, MORNING_AFTER, CTX);
    expect(save.map((p) => `${p.machineCode} ${p.plan}`)).toEqual(['1300T 128', '320T 200']);
    expect(remove).toEqual([]);
  });

  it('goes once the press signs, and is never rewritten while it has not', () => {
    const kept: SavedShiftPlan[] = [
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
      { machineCode: '1300T', shiftId: NIGHT, plan: 128, jobs: [] },
    ];
    // Planning.csv has moved on (no orders): the kept plans stand.
    const later = shiftPlanChanges(PRESSES, new Set(['1600T', '320T']), kept, [], NIGHT, MORNING_AFTER);
    expect(later.save).toEqual([]);
    expect(later.remove).toEqual([kept[0]]);
  });

  it('clears a second row two simultaneous sign-offs wrote for the same press', () => {
    const twice: SavedShiftPlan[] = [
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
    ];
    const next = shiftPlanChanges(PRESSES, new Set(['1600T', '550T']), twice, orders, NIGHT, MORNING_AFTER);
    expect(next.remove).toEqual([twice[1]]);
    expect(next.save.map((p) => p.machineCode)).toEqual(['1300T']);
  });
});

describe('Last 24h: a press with nothing signed and a kept plan', () => {
  it('is planned from the kept plan, order by order, nothing credited', () => {
    const row: SavedShiftPlan = {
      machineCode: '320T',
      shiftId: '2026-10-12-Night',
      plan: 200,
      jobs: [
        { jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 100 },
        { jobNumber: 'SFM507922', partNumber: 'V11582-1', pieces: 100 },
      ],
    };
    const lines = keptPlanTuples(row, true);
    expect(lines.map((l) => [l.jobNumber, l.planned, l.credited, l.source, l.unsigned])).toEqual([
      ['SFM507921', 100, 0, 'saved', true],
      ['SFM507922', 100, 0, 'saved', true],
    ]);
    expect(attainmentOfTuples(lines)).toMatchObject({ expected: 200, actual: 0, pct: 0 });
  });
});

describe('wider periods: machine-shifts with nothing signed', () => {
  const NIGHT = '2026-10-12-Night';
  const kept: SavedShiftPlan[] = [
    { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [{ jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 100 }] },
  ];

  it('count the plan kept at sign-off, with nothing credited', () => {
    const [line] = idleShiftTuples('320T', [NIGHT], kept, [], MORNING_AFTER);
    expect(line).toMatchObject({
      planned: 200, good: 0, credited: 0, source: 'saved', idle: true, leadJob: 'SFM507921',
    });
  });

  it('fall back to what Planning.csv still holds when nothing was kept', () => {
    const [line] = idleShiftTuples('1300T', [NIGHT], kept, orders, MORNING_AFTER, new Set([NIGHT]));
    expect(line).toMatchObject({ planned: 128, credited: 0, source: 'schedule', idle: true, unsigned: true });
    expect(idleShiftTuples('Batt2', [NIGHT], kept, orders, MORNING_AFTER)).toEqual([]);
  });

  it('count once each when the period has no plan sizes to weight by', () => {
    const [line] = idleShiftTuples('320T', [NIGHT], kept, [], MORNING_AFTER, new Set(), true);
    expect(line).toMatchObject({ planned: 100, credited: 0 });
  });
});

describe('sign-off keeps the plan of the presses nobody signed', () => {
  it('memory DAL: saved for each idle planned press, gone once it signs', async () => {
    const dal = new MemoryDataLayer(new Date('2026-10-13T08:00:00'));
    const internals = dal as unknown as { planning: unknown[]; production: ProductionRecord[]; dieColors: unknown[] };
    internals.planning = orders;
    internals.dieColors = DIE_ROWS;
    internals.production = [
      rec({ machineCode: '1600T', shiftId: '2026-10-12-Night', jobNumber: 'SFM507571', slotIndex: 2, statusCode: 'R', countStart: 0, countEnd: 205 }),
      rec({ machineCode: '320T', shiftId: '2026-10-12-Night', jobNumber: 'SFM507921', slotIndex: 2, statusCode: 'R', countStart: 0, countEnd: 40 }),
    ];
    await dal.lockShift('1600T', '2026-10-12-Night', 'Sup', 'Op');
    const kept = await dal.listShiftPlans({ from: '2026-10-12', to: '2026-10-12' });
    // 320T booked work that is not signed yet. 550T's night was its die
    // change — planned for nothing, so there is no plan to keep.
    expect(kept.map((p) => `${p.machineCode} ${p.plan}`).sort()).toEqual(['320T 200']);
    await dal.lockShift('320T', '2026-10-12-Night', 'Sup', 'Op');
    const after = await dal.listShiftPlans({ from: '2026-10-12', to: '2026-10-12' });
    expect(after.map((p) => p.machineCode)).toEqual([]);
  });

  it('SharePoint DAL: creates PMD_ShiftPlan on first use and writes one row per idle press', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x', canWrite: () => true });
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const deletes: string[] = [];
    const o = dal as unknown as {
      listMachines: () => Promise<unknown[]>;
      listPlanning: () => Promise<unknown[]>;
      fetchHeaders: (list: string) => Promise<unknown[]>;
      getAllItems: (list: string) => Promise<unknown[]>;
      getJson: (url: string) => Promise<unknown>;
      itemType: () => Promise<string>;
      post: (url: string, body: Record<string, unknown>) => Promise<unknown>;
      del: (url: string) => Promise<void>;
      saveShiftPlans: (shiftId: string, machine: string) => Promise<void>;
    };
    o.listMachines = async () => PRESSES.map((machineCode) => ({ machineCode, active: true }));
    (o as unknown as { listProductDieColors: () => Promise<unknown[]> }).listProductDieColors = async () => DIE_ROWS;
    o.listPlanning = async () => orders;
    o.fetchHeaders = async () => [{ machineCode: '1600T', date: '2026-10-12', shift: 'Night' }];
    let listThere = false;
    o.getAllItems = async () => {
      if (!listThere) throw new Error('GET → 404');
      return [];
    };
    o.getJson = async () => {
      if (!listThere) throw new Error('GET → 404');
      return {};
    };
    o.itemType = async () => 'SP.Data.PMD_x005f_ShiftPlanListItem';
    o.post = async (url, body) => {
      posts.push({ url, body });
      if (url.endsWith('/_api/web/lists')) listThere = true;
      return {};
    };
    o.del = async (url) => {
      deletes.push(url);
    };
    await o.saveShiftPlans('2026-10-12-Night', '550T');
    expect(posts[0].body).toMatchObject({ Title: 'PMD_ShiftPlan', BaseTemplate: 100 });
    const rows = posts.filter((p) => p.url.endsWith("getbytitle('PMD_ShiftPlan')/items")).map((p) => p.body);
    expect(rows).toEqual([
      expect.objectContaining({ Title: '1300T|2026-10-12-Night', MachineCode: '1300T', ShiftId: '2026-10-12-Night', SchedulePlan: 128 }),
      expect.objectContaining({ Title: '320T|2026-10-12-Night', MachineCode: '320T', SchedulePlan: 200 }),
    ]);
    expect(JSON.parse(rows[1].PlanJobs as string)).toHaveLength(2);
    expect(deletes).toEqual([]);
  });
});
