import { describe, expect, it } from 'vitest';

import {
  aggregateDies,
  buildDieTrend,
  dieHealth,
  dieServiceStatus,
  goodByJob,
  latestConditionByDie,
  machineTonnage,
  nextPlannedFor,
  parseDieCondition,
  parseToolStatus,
  serviceIntervalFor,
  TOOL_STATUS_META,
} from '../src/core/die';
import { MemoryDataLayer } from '../src/dal/memory';
import { parseMangoWorkOrdersCsv } from '../src/dal/sharepoint';
import type { DieChangeLog, DieMaintenanceRequest, ProductDieColor } from '../src/types';
import { order, rec } from './helpers';

const dc = (partNumber: string, dieNumber: string, over: Partial<ProductDieColor> = {}): ProductDieColor => ({
  partNumber,
  hex: '#123456',
  name: 'Grey',
  category: 'Seating',
  dieNumber,
  die: `Tool ${dieNumber}`,
  coRun: false,
  ...over,
});

const req = (over: Partial<DieMaintenanceRequest> & { dieNumber: string }): DieMaintenanceRequest => ({
  id: 1,
  status: 'open',
  maintType: 'repair',
  priority: 'normal',
  description: '',
  contact: '',
  requestedBy: '',
  machineCode: '',
  jobNumber: '',
  mangoTicket: '',
  createdAt: '2026-07-01T00:00:00Z',
  closedAt: '',
  ...over,
});

describe('dieHealth', () => {
  it('maps reject % onto the green/amber/red bands', () => {
    expect(dieHealth(null)).toBe('');
    expect(dieHealth(0)).toBe('green');
    expect(dieHealth(1.9)).toBe('green');
    expect(dieHealth(2)).toBe('amber');
    expect(dieHealth(5)).toBe('amber');
    expect(dieHealth(5.1)).toBe('red');
  });
});

describe('aggregateDies', () => {
  const master = [dc('P-A', 'DIE-1'), dc('P-B', 'DIE-1', { coRun: true }), dc('P-C', 'DIE-2')];

  it('charges shots, pieces (× cavities) and per-code rejects to the part’s die', () => {
    const records = [
      // DIE-1 via P-A on M1: slot 0 carries counts (100 shots, 2 cavities),
      // rejects spread over two slots.
      rec({ machineCode: 'M1', shiftId: '2026-07-08-Day', jobNumber: 'J1', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 100, countEnd: 200, cavities: 2, rejects: '{"D07":2}' }),
      rec({ machineCode: 'M1', shiftId: '2026-07-08-Day', jobNumber: 'J1', slotIndex: 1, statusCode: 'R', partNumber: 'P-A', rejects: '{"D07":1,"D05":1}' }),
      // DIE-1 again via P-B on M2 a day later.
      rec({ machineCode: 'M2', shiftId: '2026-07-09-Day', jobNumber: 'J2', slotIndex: 0, statusCode: 'R', partNumber: 'P-B', countStart: 0, countEnd: 50, rejects: '{}' }),
      // Part with no die mapping — must be ignored, not crash.
      rec({ machineCode: 'M3', shiftId: '2026-07-09-Day', jobNumber: 'J3', slotIndex: 0, statusCode: 'R', partNumber: 'UNMAPPED', countStart: 0, countEnd: 10 }),
    ];
    const dies = aggregateDies(master, records, []);
    expect(dies.map((d) => d.dieNumber).sort()).toEqual(['DIE-1', 'DIE-2']);
    const d1 = dies.find((d) => d.dieNumber === 'DIE-1')!;
    expect(d1.description).toBe('Tool DIE-1');
    expect(d1.parts.map((p) => p.partNumber)).toEqual(['P-A', 'P-B']);
    expect(d1.runs).toBe(2);
    expect(d1.shots).toBe(150); // 100 + 50 cycles
    expect(d1.pieces).toBe(250); // 100×2 + 50×1
    expect(d1.rejects).toBe(4);
    expect(d1.good).toBe(246);
    expect(d1.rejectPct).toBe(1.6);
    expect(d1.rejByCode).toEqual([
      { code: 'D07', qty: 3, byStatus: { R: 3 } },
      { code: 'D05', qty: 1, byStatus: { R: 1 } },
    ]);
    expect(d1.machines).toEqual(['M1', 'M2']);
    expect(d1.lastRun).toBe('2026-07-09');
    // DIE-2 never ran but still shows (usage zero).
    const d2 = dies.find((d) => d.dieNumber === 'DIE-2')!;
    expect(d2.runs).toBe(0);
    expect(d2.rejectPct).toBeNull();
    // Per-day series for the trend sparkline, day-ascending.
    expect(d1.daily).toEqual([
      { day: '2026-07-08', rejects: 4, pieces: 200, shots: 100, rejByStatus: { R: 4 } },
      { day: '2026-07-09', rejects: 0, pieces: 50, shots: 50, rejByStatus: {} },
    ]);
  });

  it('buildDieTrend fills gaps daily on short windows and weekly past 35 days', () => {
    const daily = [
      { day: '2026-07-02', rejects: 2, pieces: 100 },
      { day: '2026-07-05', rejects: 4, pieces: 80 },
    ];
    const short = buildDieTrend(daily, '2026-07-01', '2026-07-06');
    expect(short.map((b) => b.rejects)).toEqual([0, 2, 0, 0, 4, 0]);
    expect(short.every((b) => b.span === 1)).toBe(true);
    expect(short[1].pieces).toBe(100);

    const long = buildDieTrend(daily, '2026-06-01', '2026-07-26'); // 56 days → weekly
    expect(long.every((b) => b.span === 7)).toBe(true);
    expect(long.length).toBe(8);
    // Both production days land in the week starting 2026-06-29.
    const wk = long.find((b) => b.day === '2026-06-29')!;
    expect(wk.rejects).toBe(6);
    expect(wk.pieces).toBe(180);
  });

  it('floats dies with open requests to the top and counts only non-done ones', () => {
    const records = [
      rec({ machineCode: 'M1', shiftId: '2026-07-08-Day', jobNumber: 'J1', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 100, rejects: '{"D01":30}' }),
    ];
    const requests = [
      req({ id: 1, dieNumber: 'DIE-2', status: 'open' }),
      req({ id: 2, dieNumber: 'DIE-2', status: 'done' }),
    ];
    const dies = aggregateDies(master, records, requests);
    // DIE-1 has 30% rejects, but DIE-2 has an open request → first.
    expect(dies[0].dieNumber).toBe('DIE-2');
    expect(dies[0].openRequests).toBe(1);
    expect(dies[1].dieNumber).toBe('DIE-1');
  });
});

describe('tonnage service rule', () => {
  it('parses tonnage from machine codes (T and C suffixes, none for lines)', () => {
    expect(machineTonnage('850T')).toBe(850);
    expect(machineTonnage('320C')).toBe(320);
    expect(machineTonnage('1600T')).toBe(1600);
    expect(machineTonnage('Batt1')).toBeNull();
    expect(machineTonnage('HS')).toBeNull();
  });

  it('maps tonnages onto the service-interval bands', () => {
    expect(serviceIntervalFor(125).shots).toBe(100_000); // 100T-150T
    expect(serviceIntervalFor(320).shots).toBe(50_000); // 210T-350T
    expect(serviceIntervalFor(550).shots).toBe(20_000); // 450T-560T
    expect(serviceIntervalFor(850).shots).toBe(10_000); // 650T-850T
    expect(serviceIntervalFor(1000).shots).toBe(8_000); // 1000T+
    expect(serviceIntervalFor(1600).shots).toBe(8_000); // extended band
  });

  it('computes median run size and splits rejects by machine status', () => {
    const master = [dc('P-A', 'DIE-1')];
    const mk = (job: string, slot: number, st: string, shots: number | null, rej = '') =>
      rec({
        machineCode: '850T', shiftId: '2026-07-08-Day', jobNumber: job, slotIndex: slot,
        statusCode: st as never, partNumber: 'P-A',
        countStart: slot === 0 && shots != null ? 0 : null,
        countEnd: slot === 0 && shots != null ? shots : null,
        rejects: rej,
      });
    const records = [
      // Run J1: 1000 shots; startup scrap on the S slot, run scrap on R.
      mk('J1', 0, 'S', 1000, '{"D01":5}'),
      mk('J1', 1, 'R', null, '{"D01":2}'),
      // Runs J2/J3 give shots 3000 / 2000 → median of [1000,3000,2000] = 2000.
      rec({ machineCode: '850T', shiftId: '2026-07-09-Day', jobNumber: 'J2', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 3000 }),
      rec({ machineCode: '850T', shiftId: '2026-07-10-Day', jobNumber: 'J3', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 2000 }),
    ];
    const [d1] = aggregateDies(master, records, []);
    expect(d1.medianRunShots).toBe(2000);
    const day8 = d1.daily.find((x) => x.day === '2026-07-08')!;
    expect(day8.rejByStatus).toEqual({ S: 5, R: 2 });
    // The code Pareto carries the same per-status split for each code.
    expect(d1.rejByCode).toEqual([{ code: 'D01', qty: 7, byStatus: { S: 5, R: 2 } }]);
    // …and the trend buckets carry the split through.
    const buckets = buildDieTrend(d1.daily, '2026-07-08', '2026-07-10');
    expect(buckets[0].rejByStatus).toEqual({ S: 5, R: 2 });
    expect(buckets[1].rejByStatus).toEqual({});
  });

  it('records the most recent die change (status D slots) per die', () => {
    const master = [dc('P-A', 'DIE-1'), dc('P-B', 'DIE-2')];
    const records = [
      // Older change on 550T: two D slots (= 1 h).
      rec({ machineCode: '550T', shiftId: '2026-07-05-Day', jobNumber: 'J1', slotIndex: 0, statusCode: 'D', partNumber: 'P-A', countStart: 0, countEnd: 0 }),
      rec({ machineCode: '550T', shiftId: '2026-07-05-Day', jobNumber: 'J1', slotIndex: 1, statusCode: 'D', partNumber: 'P-A' }),
      rec({ machineCode: '550T', shiftId: '2026-07-05-Day', jobNumber: 'J1', slotIndex: 2, statusCode: 'R', partNumber: 'P-A' }),
      // Newer change on 850T Night: one D slot — this one must win.
      rec({ machineCode: '850T', shiftId: '2026-07-08-Night', jobNumber: 'J2', slotIndex: 0, statusCode: 'D', partNumber: 'P-A', countStart: 0, countEnd: 100 }),
      // DIE-2 never had a die change.
      rec({ machineCode: '320T', shiftId: '2026-07-08-Day', jobNumber: 'J3', slotIndex: 0, statusCode: 'R', partNumber: 'P-B', countStart: 0, countEnd: 50 }),
    ];
    const dies = aggregateDies(master, records, []);
    expect(dies.find((d) => d.dieNumber === 'DIE-1')!.lastDieChange).toEqual({
      day: '2026-07-08',
      shift: 'Night',
      machine: '850T',
      jobNumber: 'J2',
      slots: 1,
    });
    expect(dies.find((d) => d.dieNumber === 'DIE-2')!.lastDieChange).toBeNull();
  });

  it('counts shots since the last DONE service and flags soon/due', () => {
    const master = [dc('P-A', 'DIE-1')];
    const mkRec = (day: string, shots: number) =>
      rec({
        machineCode: '850T',
        shiftId: `${day}-Day`,
        jobNumber: `J${day}`,
        slotIndex: 0,
        statusCode: 'R',
        partNumber: 'P-A',
        countStart: 0,
        countEnd: shots,
      });
    // 6k shots before the service, 9k after → counter must read 9k.
    const records = [mkRec('2026-07-01', 6000), mkRec('2026-07-05', 4000), mkRec('2026-07-08', 5000)];
    const done = req({
      id: 9,
      dieNumber: 'DIE-1',
      status: 'done',
      closedAt: '2026-07-02T10:00:00Z',
    });
    const [d1] = aggregateDies(master, records, [done]);
    const s = dieServiceStatus(d1, [done])!;
    expect(s.intervalShots).toBe(10_000); // 850T band
    expect(s.shotsSince).toBe(9000);
    expect(s.sinceIsService).toBe(true);
    expect(s.since).toBe('2026-07-02');
    expect(s.level).toBe('soon'); // 90% of 10k

    // No completed service → counts everything, flagged as window-start.
    const s2 = dieServiceStatus(d1, [])!;
    expect(s2.shotsSince).toBe(15_000);
    expect(s2.sinceIsService).toBe(false);
    expect(s2.level).toBe('due');

    // PMD_DieMaster.LastServiceDate NEWER than the work order wins:
    // counter restarts there (only the 07-08 run of 5k remains).
    const s3 = dieServiceStatus(d1, [done], '2026-07-06T00:00:00Z')!;
    expect(s3.shotsSince).toBe(5000);
    expect(s3.since).toBe('2026-07-06');
    expect(s3.sinceIsService).toBe(true);

    // …and an OLDER LastServiceDate defers to the newer work order.
    const s4 = dieServiceStatus(d1, [done], '2026-06-20T00:00:00Z')!;
    expect(s4.since).toBe('2026-07-02');
    expect(s4.shotsSince).toBe(9000);

    // LastServiceDate alone (no work orders) is a real service marker.
    const s5 = dieServiceStatus(d1, [], '2026-07-06T00:00:00Z')!;
    expect(s5.shotsSince).toBe(5000);
    expect(s5.sinceIsService).toBe(true);
  });

  it('uses the STRICTEST band among the presses the die ran on and skips no-rule lines', () => {
    const master = [dc('P-A', 'DIE-1'), dc('P-B', 'DIE-2')];
    const records = [
      // DIE-1 ran on 125T (100k rule) AND 1600T (8k rule) → 8k governs.
      rec({ machineCode: '125T', shiftId: '2026-07-08-Day', jobNumber: 'J1', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 5000 }),
      rec({ machineCode: '1600T', shiftId: '2026-07-09-Day', jobNumber: 'J2', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 4000 }),
      // DIE-2 only ran on Batt1 → no tonnage rule → null.
      rec({ machineCode: 'Batt1', shiftId: '2026-07-09-Day', jobNumber: 'J3', slotIndex: 0, statusCode: 'R', partNumber: 'P-B', countStart: 0, countEnd: 9999 }),
    ];
    const dies = aggregateDies(master, records, []);
    const s1 = dieServiceStatus(dies.find((d) => d.dieNumber === 'DIE-1')!, [])!;
    expect(s1.intervalShots).toBe(8_000);
    expect(s1.press).toBe('1600T');
    expect(s1.level).toBe('due'); // 9k ≥ 8k
    expect(dieServiceStatus(dies.find((d) => d.dieNumber === 'DIE-2')!, [])).toBeNull();
  });
});

describe('nextPlannedFor', () => {
  const now = new Date('2026-07-10T12:00:00');
  const orders = [
    order({ jobNumber: 'PAST', partNumber: 'P-A', plannedStart: '2026-07-08T07:00:00', plannedEnd: '2026-07-08T15:00:00' }),
    order({ jobNumber: 'RUNNING', partNumber: 'P-A', machineCode: '850T', plannedStart: '2026-07-10T07:00:00', plannedEnd: '2026-07-10T15:00:00' }),
    order({ jobNumber: 'NEXT', partNumber: 'P-A', plannedStart: '2026-07-12T07:00:00', plannedEnd: '2026-07-12T15:00:00' }),
    order({ jobNumber: 'OTHER', partNumber: 'P-X', plannedStart: '2026-07-11T07:00:00', plannedEnd: '2026-07-11T15:00:00' }),
  ];

  it('prefers the order running right now and reports it as running', () => {
    const p = nextPlannedFor(['P-A'], orders, now)!;
    expect(p.jobNumber).toBe('RUNNING');
    expect(p.running).toBe(true);
    expect(p.machineCode).toBe('850T');
  });

  it('falls back to the soonest future start, and null when unscheduled', () => {
    const later = new Date('2026-07-10T16:00:00'); // RUNNING has ended
    const p = nextPlannedFor(['P-A'], orders, later)!;
    expect(p.jobNumber).toBe('NEXT');
    expect(p.running).toBe(false);
    expect(nextPlannedFor(['P-UNKNOWN'], orders, now)).toBeNull();
  });

  it('skips an order PMD already reports finished — shows the next one instead', () => {
    // RUNNING is complete → falls through to NEXT (not yet started).
    const done = (o: { jobNumber: string }) => o.jobNumber === 'RUNNING';
    const p = nextPlannedFor(['P-A'], orders, now, done)!;
    expect(p.jobNumber).toBe('NEXT');
    expect(p.running).toBe(false);
    // With no other order for the part, a finished die shows Free (null).
    const single = [orders[1]]; // just RUNNING
    expect(nextPlannedFor(['P-A'], single, now, done)).toBeNull();
  });
});

describe('goodByJob', () => {
  it('sums good pieces per job (pieces × cavities − rejects) for completion checks', () => {
    const recs = [
      // J1 on 2 cavities: 100 shots slot0 → 200 pieces, 5 reject over two slots.
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', partNumber: 'P-A', countStart: 0, countEnd: 100, cavities: 2, rejects: '{"D01":3}' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R', partNumber: 'P-A', rejects: '{"D02":2}' }),
      // J2 legacy row: rejectCount only.
      rec({ jobNumber: 'J2', slotIndex: 0, statusCode: 'R', partNumber: 'P-B', countStart: 0, countEnd: 50, cavities: 1, rejectCount: 4 }),
      // Blank job ignored.
      rec({ jobNumber: '', slotIndex: 0, statusCode: 'R', partNumber: 'P-C', countStart: 0, countEnd: 10 }),
    ];
    const g = goodByJob(recs);
    expect(g.get('J1')).toBe(195); // 200 − (3+2)
    expect(g.get('J2')).toBe(46); //  50 − 4
    expect(g.has('')).toBe(false);
  });
});

describe('MemoryDataLayer die maintenance lifecycle', () => {
  it('creates, advances and closes a request', async () => {
    const dal = new MemoryDataLayer();
    const created = await dal.createDieMaintenance({
      dieNumber: 'DIE-0091',
      status: 'open',
      maintType: 'cleaning',
      priority: 'high',
      description: 'Vents blocked',
      contact: 'Maintenance Team',
      requestedBy: 'Christopher King',
      machineCode: 'HS',
      jobNumber: '',
      mangoTicket: '',
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.createdAt).not.toBe('');

    await dal.updateDieMaintenance(created.id, { status: 'in-progress' });
    await dal.updateDieMaintenance(created.id, {
      status: 'done',
      closedAt: '2026-07-10T05:00:00Z',
      mangoTicket: 'MAN-31234',
    });
    const all = await dal.listDieMaintenance();
    const row = all.find((r) => r.id === created.id)!;
    expect(row.status).toBe('done');
    expect(row.closedAt).toBe('2026-07-10T05:00:00Z');
    expect(row.mangoTicket).toBe('MAN-31234');
    // Newest first.
    expect(all[0].id).toBe(created.id);
  });

  it('seeds the die master so the demo tab has data', async () => {
    const dal = new MemoryDataLayer();
    const colors = await dal.listProductDieColors();
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c.dieNumber)).toBe(true);
  });
});

describe('latestConditionByDie (PMD_DieChangeLog → toolroom flags)', () => {
  const log = (over: Partial<DieChangeLog>): DieChangeLog => ({
    id: 1,
    date: '2026-07-10',
    shift: 'Day',
    dieSetter: 'Van Minh Ma',
    machineCode: '550T',
    changeOver: ['Die'],
    jobNumber: 'SFM507268',
    dieNumberOut: '117',
    dieDescriptionOut: 'PROTEUS SEAT MOULDING',
    dieNumberIn: '174',
    dieDescriptionIn: 'PODIUM SEAT',
    components: {},
    problemDescription: '',
    createdAt: '2026-07-10T08:00:00Z',
    ...over,
  });

  it('extracts worn/damaged flags (damaged first) keyed by the OUT die', () => {
    const m = latestConditionByDie([
      log({ components: { MouldingSurfaces: 'worn', Cores: 'damaged', Bolts: 'good' } }),
    ]);
    const c = m.get('117')!;
    expect(c.flags.map((f) => `${f.label}:${f.condition}`)).toEqual([
      'Cores:damaged',
      'Moulding Surfaces:worn',
    ]);
    expect(c.hasDamaged).toBe(true);
    expect(m.has('174')).toBe(false); // IN die is not rated
  });

  it('the LATEST report wins — a newer all-good check clears older flags', () => {
    const m = latestConditionByDie([
      log({ id: 1, date: '2026-07-08', components: { Venting: 'damaged' } }),
      log({ id: 2, date: '2026-07-12', components: { Bolts: 'good' } }),
    ]);
    const c = m.get('117')!;
    expect(c.date).toBe('2026-07-12');
    expect(c.flags).toEqual([]);
    expect(c.hasDamaged).toBe(false);
  });

  it('normalises the die key and skips rows without a die out', () => {
    const m = latestConditionByDie([
      log({ dieNumberOut: ' die-0091 ', components: { GuidePins: 'worn' } }),
      log({ id: 3, dieNumberOut: '' }),
    ]);
    expect(m.get('DIE-0091')!.flags[0].key).toBe('GuidePins');
    expect(m.size).toBe(1);
  });
});

describe('parseToolStatus (PMD_DieMaster.ToolStatus normalisation)', () => {
  it('accepts the four canonical labels in any casing / spacing', () => {
    expect(parseToolStatus('Serviced')).toBe('serviced');
    expect(parseToolStatus('In service')).toBe('in-service');
    expect(parseToolStatus('IN-SERVICE')).toBe('in-service');
    expect(parseToolStatus('To be Serviced')).toBe('to-be-serviced');
    expect(parseToolStatus('  to  be  serviced ')).toBe('to-be-serviced');
    expect(parseToolStatus('Problems')).toBe('problems');
    expect(parseToolStatus('problem')).toBe('problems');
  });

  it('never mistakes "In service" or "To be Serviced" for "Serviced"', () => {
    // All three normalise to strings containing "service" — order matters.
    expect(parseToolStatus('inservice')).toBe('in-service');
    expect(parseToolStatus('tobeserviced')).toBe('to-be-serviced');
    expect(parseToolStatus('serviced')).toBe('serviced');
  });

  it('returns "" for empty / unrecognised cells', () => {
    expect(parseToolStatus('')).toBe('');
    expect(parseToolStatus('   ')).toBe('');
    expect(parseToolStatus('banana')).toBe('');
  });

  it('ranks worst-first for the Status column sort', () => {
    expect(TOOL_STATUS_META.problems.rank).toBeLessThan(TOOL_STATUS_META['to-be-serviced'].rank);
    expect(TOOL_STATUS_META['to-be-serviced'].rank).toBeLessThan(TOOL_STATUS_META['in-service'].rank);
    expect(TOOL_STATUS_META['in-service'].rank).toBeLessThan(TOOL_STATUS_META.serviced.rank);
  });
});

describe('parseMangoWorkOrdersCsv (Mango report → work-order mirror)', () => {
  // Shaped exactly like the real "AU - Minto Maintenance Request" export:
  // a junk ordering line, the header row, then whole-plant rows of which
  // only the "AU - Die <n> …" assets belong to Die Management. The
  // stage/comment log lives in "Actions taken" (quoted, multi-line).
  const MINTO_HEADER =
    'Number,Downtime,Labour Hours,Current Stage,Plant/Equipment,Brief Description,Employee,Created Date,Branch,To be completed by,Type of Maintenance ,Identified By,Date identified,Time,AM/PM,Work shift,Describe the issue,Actions taken,Region,Department,Assign to Action,Work can be done to,Summary of work completed,"Cost (parts, labour)",Corrective action taken,Preventative action taken,Summary';
  const row = (
    num: string,
    stage: string,
    plant: string,
    brief: string,
    employee: string,
    created: string,
    type: string,
    assign: string,
    actions: string,
    work = '',
    corrective = '',
  ): string =>
    `${num},,4,${stage},${plant},${brief},${employee},${created},Resero - Minto,,${type},,${created},7,AM,Day,,"${actions}",AU,Moulding,${assign},,${work},,${corrective},,`;

  const csv = [
    ',,,,1,2,4,,7,,3,,5,,,,,,6',
    MINTO_HEADER,
    row(
      'MWO 02029', 'Stage 4 Closed', 'AU - Die 81 Proteus Back Outer',
      'Plastic stuck inside due to nozzle leak', 'Anil Pattarath', '2/10/2025',
      '2. Breakdown', 'Anil Pattarath',
      'Thu, 02/10/2025, Avila Pushparaj (Stage 1 Coordinator Assessing): \nComment: Anil, please action \n Mon, 13/10/2025, Avila Pushparaj (Stage 3 Coordinator Reviewing):  Change Stage from Stage 3 Coordinator Reviewing to Stage 4 Closed',
      'Cleared nozzle leak; purged and polished sprue bush.',
      'Replaced nozzle seal.',
    ),
    row(
      'MWO 02038', 'Stage 2 Being Investigated', 'AU - Die 254 Postura Chair +460/510 mm',
      'Hydraulic cylinders problem holding pressure', 'Karl Stevens', '7/10/2025',
      '3. Preventive Maintenance', 'Manuel Taco', '',
    ),
    row(
      'MWO 02022', 'Stage 4 Closed', 'AU - Shredder & Granulator',
      'blocked mat in 2nd cutter', 'Steven Brough', '1/10/2025',
      '2. Breakdown', '', '',
    ),
    row(
      'MWO 02050', 'Stage 4 Closed', 'AU - Toyota Hilux - Minto Ute Diesel (Harry Singh)',
      'service', 'Harry Singh', '3/10/2025', '3. Preventive Maintenance', '', '',
    ),
  ].join('\n');

  it('keeps only Die rows and extracts the die number from Plant/Equipment', () => {
    const out = parseMangoWorkOrdersCsv(csv);
    // Shredder and the Diesel ute are the plant's problem, not ours.
    expect(out.length).toBe(2);
    expect(out.map((o) => o.dieNumber).sort()).toEqual(['254', '81']);
  });

  it('maps the Minto columns: ticket, stage→status, type, people, d/m/yyyy dates', () => {
    const out = parseMangoWorkOrdersCsv(csv);
    const closed = out.find((o) => o.mangoTicket === 'MWO 02029')!;
    expect(closed.status).toBe('done');
    expect(closed.maintType).toBe('repair'); // 2. Breakdown
    expect(closed.description).toBe('Plastic stuck inside due to nozzle leak');
    // Work-order detail columns for the drilldown.
    expect(closed.labourHours).toBe('4');
    expect(closed.workSummary).toBe('Cleared nozzle leak; purged and polished sprue bush.');
    expect(closed.correctiveAction).toBe('Replaced nozzle seal.');
    expect(closed.downtime).toBeUndefined(); // empty cell stays undefined
    expect(closed.requestedBy).toBe('Anil Pattarath');
    expect(closed.contact).toBe('Anil Pattarath');
    expect(closed.createdAt.slice(0, 10)).toBe('2025-10-02'); // 2/10/2025 is d/m
    const open = out.find((o) => o.mangoTicket === 'MWO 02038')!;
    expect(open.status).toBe('in-progress'); // Stage 2 Being Investigated
    expect(open.maintType).toBe('inspection'); // 3. Preventive Maintenance
    expect(open.closedAt).toBe('');
    // Newest first.
    expect(out[0].mangoTicket).toBe('MWO 02038');
  });

  it("parses the 'To be completed by' d/m/yyyy date into dueDate (drives the Maint traffic light)", () => {
    // Column 10 (index 9) is 'To be completed by' — fill it on a Die row.
    const withDue = [
      MINTO_HEADER,
      // Number,Downtime,Labour,Stage,Plant,Brief,Employee,Created,Branch,TBCB,Type,...
      'MWO 03001,,2,Stage 1 Coordinator Assessing,AU - Die 171 Podium Seat,Sprue gate wear,Karl Stevens,3/07/2026,Resero - Minto,31/07/2026,2. Breakdown,,3/07/2026,7,AM,Day,,"",AU,Moulding,Karl Stevens,,,,,,',
    ].join('\n');
    const out = parseMangoWorkOrdersCsv(withDue);
    expect(out.length).toBe(1);
    expect(out[0].dieNumber).toBe('171');
    expect(out[0].status).toBe('open'); // Stage 1 → open
    // 31/07/2026 (d/m) → a stable date, no time, no UTC day-shift.
    expect(out[0].dueDate).toBe('2026-07-31');
  });

  it('maps the outcome columns incl. the trailing Summary column', () => {
    // The export's last column is "Summary" — the closing note. Fill the
    // whole outcome group on one Die row and read them back.
    const withOutcome = [
      MINTO_HEADER,
      // …,Summary of work completed,"Cost (parts, labour)",Corrective,Preventative,Summary
      'MWO 05001,,3,Stage 4 Closed,AU - Die 88 Seat Base,Nozzle drip,Anil,2/10/2025,Resero - Minto,,2. Breakdown,,2/10/2025,7,AM,Day,,"",AU,Moulding,Manuel Taco,,Polished sprue bush.,"$120",Reseated nozzle.,Torque check added.,Monitor next run.',
    ].join('\n');
    const out = parseMangoWorkOrdersCsv(withOutcome);
    expect(out.length).toBe(1);
    expect(out[0].workSummary).toBe('Polished sprue bush.');
    expect(out[0].correctiveAction).toBe('Reseated nozzle.');
    expect(out[0].preventativeAction).toBe('Torque check added.');
    expect(out[0].summary).toBe('Monitor next run.');
    expect(out[0].cost).toBe('$120');
  });

  it('does NOT guess a differently-named completion column (header is fixed)', () => {
    // The export layout is stable, so mapping is strict/direct: a column
    // named anything other than "To be completed by" is not the due date.
    const alt = [
      'Number,Current Stage,Plant/Equipment,Brief Description,Employee,Created Date,Estimated Completion Date',
      'MWO 04001,Stage 1 Assessing,AU - Die 309 Lumba,Sprue gate,Karl Stevens,3/07/2026,3/07/2026',
    ].join('\n');
    const out = parseMangoWorkOrdersCsv(alt);
    expect(out.length).toBe(1);
    expect(out[0].dieNumber).toBe('309');
    expect(out[0].dueDate).toBeUndefined();
  });

  it("recovers the closure date from the Actions-taken log's 'to Stage 4 Closed' line", () => {
    const out = parseMangoWorkOrdersCsv(csv);
    const closed = out.find((o) => o.mangoTicket === 'MWO 02029')!;
    expect(closed.closedAt.slice(0, 10)).toBe('2025-10-13');
  });

  it('returns [] for an empty / header-only / title-only file', () => {
    expect(parseMangoWorkOrdersCsv('')).toEqual([]);
    expect(parseMangoWorkOrdersCsv(`${MINTO_HEADER}\n`)).toEqual([]);
    expect(
      parseMangoWorkOrdersCsv('AU - Minto Maintenance Request 1783728039982\nno real header here\n'),
    ).toEqual([]);
  });
});

describe('MemoryDataLayer die master (PMD_DieMaster parity)', () => {
  it('seeds one row per die covering all four ToolStatus values', async () => {
    const dal = new MemoryDataLayer();
    const master = await dal.listDieMaster();
    expect(master.length).toBeGreaterThanOrEqual(4);
    const statuses = new Set(master.map((m) => m.toolStatus));
    expect(statuses.has('serviced')).toBe(true);
    expect(statuses.has('in-service')).toBe(true);
    expect(statuses.has('to-be-serviced')).toBe(true);
    expect(statuses.has('problems')).toBe(true);
    // Every master row joins back to the part→die mapping.
    const colors = await dal.listProductDieColors();
    const dies = new Set(colors.map((c) => c.dieNumber));
    expect(master.every((m) => dies.has(m.dieNumber))).toBe(true);
    // Asset facts carried through.
    const d3597 = master.find((m) => m.dieNumber === 'DIE-3597')!;
    expect(d3597.cavities).toBe(2);
    expect(d3597.toolStatus).toBe('problems');
    expect(d3597.lifeCycle).toBe(1_000_000);
    // The recently serviced die carries a LastServiceDate.
    expect(master.find((m) => m.dieNumber === 'DIE-1422')!.lastServiceDate).not.toBe('');
  });

  it('die change log: create + list round-trip, condition parsing', async () => {
    const dal = new MemoryDataLayer();
    const created = await dal.createDieChangeLog({
      date: '2026-07-14',
      shift: 'Day',
      dieSetter: 'Anil Pattarath',
      machineCode: '1600T',
      changeOver: ['Die'],
      jobNumber: 'SFM507001',
      dieNumberOut: '280',
      dieDescriptionOut: 'Postura Max 430 & 460',
      dieNumberIn: '254',
      dieDescriptionIn: 'Postura Chair +460/510 mm',
      components: { Bolts: 'good', Venting: 'worn', OilLeaks: 'damaged' },
      problemDescription: 'Oil weep on the top cylinder; vents crusted.',
    });
    expect(created.id).toBeGreaterThan(0);
    const all = await dal.listDieChangeLog();
    expect(all[0].dieNumberOut).toBe('280');
    expect(all[0].components.OilLeaks).toBe('damaged');
    // Choice-string parser used by the SharePoint read path.
    expect(parseDieCondition('1. Good work order')).toBe('good');
    expect(parseDieCondition('2. Operational but worn')).toBe('worn');
    expect(parseDieCondition('3. Damaged or can’t be used')).toBe('damaged');
    expect(parseDieCondition('')).toBe('');
    expect(parseDieCondition('banana')).toBe('');
  });

  it('die change log is idempotent on machine+date+shift+job (no duplicate on refresh)', async () => {
    const dal = new MemoryDataLayer();
    const base = {
      date: '2026-07-14',
      shift: 'Day',
      dieSetter: 'Anil Pattarath',
      machineCode: '1600T',
      changeOver: ['Die'],
      jobNumber: 'SFM507001',
      dieNumberOut: '280',
      dieDescriptionOut: 'Postura Max',
      dieNumberIn: '254',
      dieDescriptionIn: 'Postura Chair',
      components: { Venting: 'worn' as const },
      problemDescription: 'Vents crusted.',
    };
    const first = await dal.createDieChangeLog(base);
    // A page reload re-fires the popup for the same tuple; the setter fixes a
    // rating and saves again. Only ONE row must exist, updated in place.
    const second = await dal.createDieChangeLog({
      ...base,
      // lower-case machine + padded job prove the key is normalised
      machineCode: '1600t',
      jobNumber: ' SFM507001 ',
      components: { Venting: 'damaged' as const },
      problemDescription: 'Vents cracked through.',
    });
    expect(second.id).toBe(first.id);
    // Count only THIS tuple's rows — the memory DAL also carries seeded
    // demo reports for other dies.
    const mine = (all: Awaited<ReturnType<typeof dal.listDieChangeLog>>) =>
      all.filter((r) => r.jobNumber.trim() === 'SFM507001');
    const all = await dal.listDieChangeLog();
    expect(mine(all).length).toBe(1);
    expect(mine(all)[0].components.Venting).toBe('damaged');
    expect(mine(all)[0].problemDescription).toBe('Vents cracked through.');
    // A genuinely different tuple (different job) still inserts a new row.
    const before = (await dal.listDieChangeLog()).length;
    await dal.createDieChangeLog({ ...base, jobNumber: 'SFM507002' });
    expect((await dal.listDieChangeLog()).length).toBe(before + 1);
  });

  it('OUT and IN condition rows for one change coexist (keyed by assessed die)', async () => {
    const dal = new MemoryDataLayer();
    const ctx = {
      date: '2026-07-14',
      shift: 'Day',
      dieSetter: 'Van Minh Ma',
      machineCode: '550T',
      jobNumber: 'SFM507268',
    };
    // Row 1: the change record + OUT die (117) condition.
    await dal.createDieChangeLog({
      ...ctx,
      changeOver: ['Die'],
      dieNumberOut: '117',
      dieDescriptionOut: 'Proteus Seat',
      dieNumberIn: '174',
      dieDescriptionIn: 'Podium Seat',
      components: { MouldingSurfaces: 'worn' },
      problemDescription: 'Surface wear near gate.',
    });
    // Row 2: the IN die (174) condition — stored under the fitted die.
    await dal.createDieChangeLog({
      ...ctx,
      changeOver: [],
      dieNumberOut: '174',
      dieDescriptionOut: 'Podium Seat',
      dieNumberIn: '174',
      dieDescriptionIn: 'Podium Seat',
      components: { Venting: 'damaged' },
      problemDescription: 'Vent blocked on fitting.',
    });
    const mine = (await dal.listDieChangeLog()).filter((r) => r.jobNumber === 'SFM507268');
    expect(mine.length).toBe(2); // same event, two assessed dies → two rows
    // latestConditionByDie attributes each to its own die.
    const cond = latestConditionByDie(mine);
    expect(cond.get('117')!.flags.map((f) => f.key)).toEqual(['MouldingSurfaces']);
    expect(cond.get('174')!.flags.map((f) => f.key)).toEqual(['Venting']);
    expect(cond.get('174')!.hasDamaged).toBe(true);
    // Re-saving the OUT row (same assessed die) updates in place, no dup.
    await dal.createDieChangeLog({
      ...ctx,
      changeOver: ['Die'],
      dieNumberOut: '117',
      dieDescriptionOut: 'Proteus Seat',
      dieNumberIn: '174',
      dieDescriptionIn: 'Podium Seat',
      components: { MouldingSurfaces: 'damaged' },
      problemDescription: 'Now cracked.',
    });
    const after = (await dal.listDieChangeLog()).filter((r) => r.jobNumber === 'SFM507268');
    expect(after.length).toBe(2);
    expect(latestConditionByDie(after).get('117')!.hasDamaged).toBe(true);
  });

  it('updateDieMaster changes ToolStatus and stamps the audit dates', async () => {
    const dal = new MemoryDataLayer();
    await dal.updateDieMaster('die-0091', {
      // case/space-insensitive die lookup on purpose
      toolStatus: 'serviced',
      dateStamp: '2026-07-13T02:00:00Z',
      lastServiceDate: '2026-07-13T02:00:00Z',
    });
    const master = await dal.listDieMaster();
    const row = master.find((m) => m.dieNumber === 'DIE-0091')!;
    expect(row.toolStatus).toBe('serviced');
    expect(row.dateStamp).toBe('2026-07-13T02:00:00Z');
    expect(row.lastServiceDate).toBe('2026-07-13T02:00:00Z');
    await expect(dal.updateDieMaster('NOPE', { toolStatus: 'problems' })).rejects.toThrow();
  });
});
