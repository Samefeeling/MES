import { describe, expect, it } from 'vitest';
import {
  attainmentOfTuples,
  idleShiftTuples,
  keptPlanSnapshot,
  keptPlanTuples,
  keptShiftTuples,
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
/** A local wall-clock time as the ISO a plan's bar holds. */
const at = (local: string): string => new Date(local).toISOString();
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

describe('PMD_ShiftPlan: the plan of record of every press in a shift', () => {
  const NIGHT = '2026-10-12-Night';

  it('is the plan of the press, order by order, with the hours each was to run', () => {
    expect(shiftPlanFor(orders, '320T', NIGHT, MORNING_AFTER, CTX)).toEqual({
      machineCode: '320T',
      shiftId: NIGHT,
      plan: 200,
      // One shot making both parts, 2.72 h; × 45 is 122 of each, capped at
      // the 100 ordered.
      jobs: [
        { jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 100, hours: 2.72 },
        { jobNumber: 'SFM507922', partNumber: 'V11582-1', pieces: 100, hours: 2.72 },
      ],
      // Across the shift, for the Live Status bar: nothing says what the
      // press ran before, so the Lumba tool goes on first (23:00–03:00) and
      // both parts run from 03:00.
      bar: [
        { kind: 'change', jobNumber: 'SFM507921', partNumber: 'V11582-2', fromPart: '', start: at('2026-10-12T23:00'), end: at('2026-10-13T03:00') },
        { kind: 'run', jobNumber: 'SFM507921', partNumber: 'V11582-2', start: at('2026-10-13T03:00'), end: at('2026-10-13T05:43') },
        { kind: 'run', jobNumber: 'SFM507922', partNumber: 'V11582-1', start: at('2026-10-13T03:00'), end: at('2026-10-13T05:43') },
      ],
    });
    // Kept before or during the shift, it is the whole shift's plan.
    expect(shiftPlanFor(orders, '1300T', NIGHT, new Date('2026-10-12T23:30:00'), CTX)?.plan).toBe(128);
  });

  it('keeps "nothing planned" too, and nothing when a quantity is unknown', () => {
    // Batt2's order starts the next night.
    expect(shiftPlanFor(orders, 'Batt2', NIGHT, MORNING_AFTER, CTX)).toEqual({
      machineCode: 'Batt2', shiftId: NIGHT, plan: 0, jobs: [], bar: [],
    });
    // 550T's night was its die change (see above): kept as planned for
    // nothing, the change on its bar.
    const dieNight = shiftPlanFor(orders, '550T', NIGHT, MORNING_AFTER, CTX);
    expect(dieNight?.plan).toBe(0);
    expect(dieNight?.bar).toEqual([
      { kind: 'change', jobNumber: 'SFM507970', partNumber: 'V4528', fromPart: '', start: at('2026-10-13T03:00'), end: at('2026-10-13T07:00') },
    ]);
    const noRate = orders.map((o) => (o.jobNumber === 'SFM507921' ? { ...o, qtyPerHr: 0 } : o));
    expect(shiftPlanFor(noRate, '320T', NIGHT, MORNING_AFTER, CTX)).toBeNull();
  });

  it('is kept for every press, run or not', () => {
    const { save, remove } = shiftPlanChanges(PRESSES, [], orders, NIGHT, MORNING_AFTER, CTX);
    expect(save.map((p) => `${p.machineCode} ${p.plan}`)).toEqual([
      '1600T 184', '1300T 128', 'Batt1 0', 'Batt2 0', '850T 0', '550T 0', '320T 200', '150T 0', '125T 0', 'HStamp 0',
    ]);
    expect(remove).toEqual([]);
  });

  it('is never rewritten, signed or not, whatever Planning.csv says later', () => {
    const kept: SavedShiftPlan[] = [
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
      { machineCode: '1600T', shiftId: NIGHT, plan: 184, jobs: [] },
    ];
    // Planning.csv has moved on (no orders): the kept plans stand, and the
    // presses with none are kept as planned for nothing.
    const later = shiftPlanChanges(PRESSES, kept, [], NIGHT, MORNING_AFTER);
    expect(later.remove).toEqual([]);
    expect(later.save.map((p) => p.machineCode)).not.toContain('320T');
    expect(later.save.map((p) => p.machineCode)).not.toContain('1600T');
    expect(later.save.every((p) => p.plan === 0)).toBe(true);
  });

  it('clears a second row two devices wrote for the same press at once', () => {
    const twice: SavedShiftPlan[] = [
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
      { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [] },
    ];
    const next = shiftPlanChanges(['320T'], twice, orders, NIGHT, MORNING_AFTER);
    expect(next.remove).toEqual([twice[1]]);
    expect(next.save).toEqual([]);
  });
});

describe('a kept plan judges its shift', () => {
  const NIGHT = '2026-10-12-Night';
  const row: SavedShiftPlan = {
    machineCode: '320T',
    shiftId: NIGHT,
    plan: 200,
    jobs: [
      { jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 100, hours: 2.72 },
      { jobNumber: 'SFM507922', partNumber: 'V11582-1', pieces: 100, hours: 2.72 },
    ],
  };
  const night = (jobNumber: string, slotIndex: number, statusCode: 'R' | 'M', good = 0): ProductionRecord =>
    rec({
      machineCode: '320T', shiftId: NIGHT, jobNumber, slotIndex, statusCode,
      countStart: good ? 0 : null, countEnd: good ? good : null, locked: true,
    });

  it('a press that did not run: its plan, nothing credited', () => {
    const lines = keptPlanTuples(row, [], true);
    expect(lines.map((l) => [l.jobNumber, l.planned, l.credited, l.source, l.unsigned])).toEqual([
      ['SFM507921', 100, 0, 'saved', true],
      ['SFM507922', 100, 0, 'saved', true],
    ]);
    expect(attainmentOfTuples(lines)).toMatchObject({ expected: 200, actual: 0, pct: 0 });
  });

  it('a press that ran: min(Good, plan) per order; an order it did not have is unscheduled', () => {
    const lines = keptPlanTuples(row, [night('SFM507921', 2, 'R', 140), night('SFM600000', 9, 'R', 30)]);
    expect(lines.map((l) => [l.jobNumber, l.planned, l.good, l.credited, l.source])).toEqual([
      ['SFM507921', 100, 140, 100, 'saved'],
      ['SFM507922', 100, 0, 0, 'saved'],
      ['SFM600000', 0, 30, 0, 'unscheduled'],
    ]);
    expect(keptPlanSnapshot(row, [night('SFM507921', 2, 'R', 140)])).toEqual({
      pct: 50, plan: 200, fromPlanning: true, complete: true,
    });
  });

  it('is shared down only when the shift booked more smoko and changeover than the plan left room for', () => {
    const full: SavedShiftPlan = {
      machineCode: '320T', shiftId: NIGHT, plan: 160,
      jobs: [{ jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 160, hours: 8 }],
    };
    // Two hours of smoko: six hours to run in, so 6/8 of the plan.
    const smoko = [0, 1, 2, 3].map((slot) => night('SFM507921', slot, 'M'));
    expect(keptPlanTuples(full, [...smoko, night('SFM507921', 5, 'R', 100)])[0].planned).toBe(120);
    // The 320T plan above only fills 5.4 h: two hours off leaves it whole.
    expect(keptPlanTuples(row, smoko).map((l) => l.planned)).toEqual([100, 100]);
  });

  it('1600T, 26 Oct: the plan kept on the day stands after the next export moves the order', () => {
    // The 27 Oct export: SFM507844 under way, put to start at its 07:00.
    const exported27 = parsePlanningCsv([
      'Machine,JobHead_StartDate,JobOper_ProdStandard,JobHead_ReqDueDate,JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_ProdQty,no of shift',
      '"1600T","2026-10-27 07:00:00","20.8000013312001","2026-11-06 00:10:00","SFM507844","POPL00123","Postura Plus Linking Chair - 460h - Blue","3408","4176","MAN"',
    ].join('\n'));
    const DAY_26 = '2026-10-26-Day';
    const ran = rec({
      machineCode: '1600T', shiftId: DAY_26, jobNumber: 'SFM507844', slotIndex: 2, statusCode: 'R',
      countStart: 0, countEnd: 150, locked: true,
    });
    // Judged by the file as it stands now, the day ran nothing planned.
    const now = scheduleTuplesForShift([ran], exported27, '1600T', DAY_26, new Date('2026-10-27T09:00:00'));
    expect(now.map((l) => [l.planned, l.source])).toEqual([[0, 'unscheduled']]);
    // The plan kept while the day ran.
    const kept: SavedShiftPlan = {
      machineCode: '1600T', shiftId: DAY_26, plan: 166,
      jobs: [{ jobNumber: 'SFM507844', partNumber: 'POPL00123', pieces: 166, hours: 8 }],
    };
    expect(keptPlanTuples(kept, [ran]).map((l) => [l.planned, l.good, l.credited])).toEqual([[166, 150, 150]]);
  });
});

describe('wider periods', () => {
  const NIGHT = '2026-10-12-Night';
  const kept: SavedShiftPlan[] = [
    { machineCode: '320T', shiftId: NIGHT, plan: 200, jobs: [{ jobNumber: 'SFM507921', partNumber: 'V11582-2', pieces: 200 }] },
  ];
  const ran = rec({
    machineCode: '320T', shiftId: NIGHT, jobNumber: 'SFM507921', slotIndex: 2, statusCode: 'R',
    countStart: 0, countEnd: 150, locked: true,
  });

  it('judge a shift with a kept plan by it, run or not', () => {
    expect(keptShiftTuples(kept, [ran])).toEqual([
      expect.objectContaining({ jobNumber: 'SFM507921', planned: 200, good: 150, credited: 150, source: 'saved' }),
    ]);
    expect(keptShiftTuples(kept, [], new Set([NIGHT]))).toEqual([
      expect.objectContaining({ planned: 200, credited: 0, idle: true, unsigned: true }),
    ]);
  });

  it('count once each when the period has no plan sizes to weight by', () => {
    expect(keptShiftTuples(kept, [ran], new Set(), true)).toEqual([
      expect.objectContaining({ planned: 100, credited: 75, leadJob: 'SFM507921' }),
    ]);
  });

  it('fall back to what Planning.csv still holds for a press-shift nothing was kept for', () => {
    const [line] = idleShiftTuples('1300T', [NIGHT], orders, MORNING_AFTER, new Set([NIGHT]), false, CTX);
    expect(line).toMatchObject({ planned: 128, credited: 0, source: 'schedule', idle: true, unsigned: true });
    expect(idleShiftTuples('Batt2', [NIGHT], orders, MORNING_AFTER)).toEqual([]);
    const [equal] = idleShiftTuples('1300T', [NIGHT], orders, MORNING_AFTER, new Set(), true, CTX);
    expect(equal).toMatchObject({ planned: 100, credited: 0 });
  });
});

describe('keeping the plans', () => {
  it('memory DAL: sign-off keeps every press, signs by the kept plan, and never rewrites it', async () => {
    const dal = new MemoryDataLayer(new Date('2026-10-13T08:00:00'));
    const internals = dal as unknown as { planning: unknown[]; production: ProductionRecord[]; dieColors: unknown[] };
    internals.planning = orders;
    internals.dieColors = DIE_ROWS;
    internals.production = [
      rec({ machineCode: '1600T', shiftId: '2026-10-12-Night', jobNumber: 'SFM507571', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 150 }),
      rec({ machineCode: '320T', shiftId: '2026-10-12-Night', jobNumber: 'SFM507921', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 40 }),
    ];
    await dal.lockShift('1600T', '2026-10-12-Night', 'Sup', 'Op');
    const kept = await dal.listShiftPlans({ from: '2026-10-12', to: '2026-10-12' });
    // The demo's presses (no 1300T): the one signing, and 320T, run and
    // not signed yet; the rest kept as planned for nothing.
    expect(kept.filter((p) => p.plan > 0).map((p) => `${p.machineCode} ${p.plan}`).sort()).toEqual([
      '1600T 184', '320T 200',
    ]);
    expect(kept.length).toBeGreaterThan(2);
    const signed = internals.production.find((r) => r.machineCode === '1600T' && r.slotIndex === 0);
    expect(signed).toMatchObject({ schedulePlan: 184, scheduleAttain: Math.round((150 / 184) * 10_000) / 100 });
    // The file moves on; the next sign-off of the night changes nothing kept.
    internals.planning = [];
    await dal.lockShift('320T', '2026-10-12-Night', 'Sup', 'Op');
    expect(await dal.listShiftPlans({ from: '2026-10-12', to: '2026-10-12' })).toEqual(kept);
    const signed320 = internals.production.find((r) => r.machineCode === '320T' && r.slotIndex === 0);
    expect(signed320).toMatchObject({ schedulePlan: 200, scheduleAttain: 20 });
  });

  it('SharePoint DAL: creates PMD_ShiftPlan on first use, one row per press, and stops once all are kept', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x', canWrite: () => true });
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const deletes: string[] = [];
    const items: Record<string, unknown>[] = [];
    const o = dal as unknown as {
      listMachines: () => Promise<unknown[]>;
      listPlanning: () => Promise<unknown[]>;
      listProduction: () => Promise<unknown[]>;
      listProductDieColors: () => Promise<unknown[]>;
      getAllItems: (list: string) => Promise<unknown[]>;
      getJson: (url: string) => Promise<unknown>;
      itemType: () => Promise<string>;
      post: (url: string, body: Record<string, unknown>) => Promise<unknown>;
      del: (url: string) => Promise<void>;
    };
    o.listMachines = async () => PRESSES.map((machineCode) => ({ machineCode, active: true }));
    o.listProductDieColors = async () => DIE_ROWS;
    o.listPlanning = async () => orders;
    o.listProduction = async () => [];
    let listThere = false;
    o.getAllItems = async () => {
      if (!listThere) throw new Error('GET → 404');
      return items;
    };
    o.getJson = async () => {
      if (!listThere) throw new Error('GET → 404');
      return {};
    };
    o.itemType = async () => 'SP.Data.PMD_x005f_ShiftPlanListItem';
    o.post = async (url, body) => {
      posts.push({ url, body });
      if (url.endsWith('/_api/web/lists')) listThere = true;
      if (url.endsWith("getbytitle('PMD_ShiftPlan')/items")) items.push({ ID: items.length + 1, ...body });
      return {};
    };
    o.del = async (url) => {
      deletes.push(url);
    };
    const NIGHT = '2026-10-12-Night';
    const first = await dal.keepShiftPlans(NIGHT);
    expect(posts[0].body).toMatchObject({ Title: 'PMD_ShiftPlan', BaseTemplate: 100 });
    const rows = posts.filter((p) => p.url.endsWith("getbytitle('PMD_ShiftPlan')/items")).map((p) => p.body);
    expect(rows).toHaveLength(PRESSES.length);
    expect(rows).toContainEqual(
      expect.objectContaining({ Title: '320T|2026-10-12-Night', MachineCode: '320T', ShiftId: NIGHT, SchedulePlan: 200 }),
    );
    expect(rows).toContainEqual(expect.objectContaining({ Title: 'Batt2|2026-10-12-Night', SchedulePlan: 0, PlanJobs: '[]' }));
    // The two orders, then the bar — entries with no jobNumber, which an
    // older build reading PlanJobs as orders passes over.
    const planJobs = JSON.parse(rows.find((r) => r.MachineCode === '320T')!.PlanJobs as string) as Array<Record<string, unknown>>;
    expect(planJobs.filter((j) => j.jobNumber).map((j) => j.jobNumber)).toEqual(['SFM507921', 'SFM507922']);
    expect(planJobs.filter((j) => !j.jobNumber).map((j) => `${j.bar} ${j.job}`)).toEqual([
      'change SFM507921', 'run SFM507921', 'run SFM507922',
    ]);
    expect(first).toHaveLength(PRESSES.length);
    // Kept: read back as it was written, and nothing more is written.
    const before = posts.length;
    const again = await dal.keepShiftPlans(NIGHT);
    expect(posts.length).toBe(before);
    expect(again?.find((p) => p.machineCode === '320T')).toEqual(first?.find((p) => p.machineCode === '320T'));
    expect(deletes).toEqual([]);
  });
});
