import { describe, expect, it } from 'vitest';

import {
  aggregateDieServiceUsage,
  aggregateDies,
  appendDieNote,
  assetNamesMachine,
  buildDieTrend,
  defaultPmPlanText,
  dieHealth,
  dieServiceStatus,
  formatDieNoteLine,
  formatToolStatusNotice,
  goodByJob,
  latestConditionByDie,
  machineCodeForAsset,
  machineWorkOrderLevel,
  machineWorkOrdersFor,
  nextPlannedFor,
  parseDieCondition,
  parseDieNotes,
  parsePmPlan,
  parseToolStatus,
  pmShotLevel,
  TOOL_MAINTENANCE_RULES,
  TOOL_STATUS_META,
} from '../src/core/die';
import { MemoryDataLayer } from '../src/dal/memory';
import { parseMangoMachineWorkOrdersCsv, parseMangoWorkOrdersCsv } from '../src/dal/sharepoint';
import {
  activeMaintenanceRequests,
  dieNumberSortKey,
  fmtPlanned,
  isWorkOrderOverdue,
  parseMangoActionComments,
  woRow,
} from '../src/ui/die';
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

describe('die drill-down date rendering', () => {
  it('converts zoned planned starts to the viewer local clock', () => {
    const iso = '2026-07-01T08:00:00+14:00';
    const d = new Date(iso);
    const p = (n: number): string => String(n).padStart(2, '0');
    expect(fmtPlanned(iso)).toBe(
      `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    );
  });

  it('shows the due date on closed work and judges closure, never today-overdue', () => {
    const html = woRow(
      req({
        dieNumber: '280',
        status: 'done',
        createdAt: '2026-07-01',
        dueDate: '2026-07-10',
        closedAt: '2026-07-12',
      }),
    );
    expect(html).toContain('To be completed by 10/07/2026');
    expect(html).toContain('Completed late');
    expect(html).not.toContain('OVERDUE');
  });

  it('shows only actionable work on the board and derives Overdue from its due date', () => {
    const open = req({ dieNumber: '280', dueDate: '2026-07-10' });
    const done = req({ dieNumber: '281', status: 'done', dueDate: '2026-07-01' });
    expect(activeMaintenanceRequests([open, done])).toEqual([open]);
    expect(isWorkOrderOverdue(open, '2026-07-11')).toBe(true);
    expect(isWorkOrderOverdue(open, '2026-07-10')).toBe(false);
    expect(isWorkOrderOverdue(done, '2026-07-11')).toBe(false);
  });

  it('reduces Mango Actions taken to newest-first dated comments', () => {
    const raw = [
      'Sun, 30/11/2025, Avila Pushparaj (Stage 1 Coordinator Assessing):\nComment: Please attend',
      'Wed, 14/01/2026, Avila Pushparaj (Stage 1 Coordinator Assessing): Change Stage from Stage 1 Coordinator Assessing to Stage 2 Being Investigated',
      'Wed, 22/04/2026, Avila Pushparaj (Stage 3 Coordinator Reviewing):\nComment: Date extended as requested',
      'Wed, 27/05/2026, Peter McMillan (Stage 2 Being Investigated): Completed',
      'Wed, 27/05/2026, Peter McMillan (Stage 2 Being Investigated):\nComment: This issue relates to the internal bridge cutter.',
      'Thu, 28/05/2026, Avila Pushparaj (Stage 3 Coordinator Reviewing):\nComment: Spare parts acquired.',
    ].join('\n');
    expect(parseMangoActionComments(raw)).toEqual([
      { date: '28/05/2026', comment: 'Spare parts acquired.' },
      { date: '27/05/2026', comment: 'This issue relates to the internal bridge cutter.' },
      { date: '22/04/2026', comment: 'Date extended as requested' },
      { date: '30/11/2025', comment: 'Please attend' },
    ]);
    const html = woRow(req({ dieNumber: '309', actionsTaken: raw }));
    expect(html).toContain('28/05/2026:');
    expect(html).toContain('Spare parts acquired.');
    expect(html).not.toContain('Stage 1 Coordinator Assessing');
    expect(html).not.toContain('Change Stage');
    expect(html).not.toContain('Completed');
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

describe('moulding-tool service policy', () => {
  it('defines the A/B/C shot-only rule bands', () => {
    expect(TOOL_MAINTENANCE_RULES.A).toEqual({ level: 'A', label: '50,000 shots', shots: 50_000 });
    expect(TOOL_MAINTENANCE_RULES.B).toEqual({ level: 'B', label: '15,000 shots', shots: 15_000 });
    expect(TOOL_MAINTENANCE_RULES.C).toEqual({ level: 'C', label: '5,000 shots', shots: 5_000 });
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

  it('counts the service day, uses the newest reset source, and applies the shot trigger', () => {
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
    // 6k before service, 4k on the service date, 1k after. PMD stores no
    // service time-of-day, so the service date must be included instead of
    // disappearing as Die #280 did.
    const records = [mkRec('2026-07-01', 6000), mkRec('2026-07-05', 4000), mkRec('2026-07-08', 1000)];
    const done = req({
      id: 9,
      dieNumber: 'DIE-1',
      status: 'done',
      closedAt: '2026-07-05T10:00:00Z',
    });
    const [d1] = aggregateDies(master, records, [done]);
    const s = dieServiceStatus(d1, [done], undefined, 'B', false)!;
    expect(s.intervalShots).toBe(15_000);
    expect(s.shotsSince).toBe(5000);
    expect(s.sinceIsService).toBe(true);
    expect(s.since).toBe('2026-07-05');
    expect(s.level).toBe('ok');

    // The same 5k is immediately due under Level C's shot trigger.
    const c = dieServiceStatus(d1, [done], undefined, 'C', false)!;
    expect(c.shotPct).toBe(1);
    expect(c.level).toBe('due');

    // PMD_DieMaster.LastServiceDate NEWER than the work order wins:
    // counter restarts there (only the 07-08 run of 1k remains).
    const s3 = dieServiceStatus(d1, [done], '2026-07-06T00:00:00Z', 'B', false)!;
    expect(s3.shotsSince).toBe(1000);
    expect(s3.since).toBe('2026-07-06');
    expect(s3.sinceIsService).toBe(true);

    // …and an OLDER LastServiceDate defers to the newer work order.
    const s4 = dieServiceStatus(d1, [done], '2026-06-20T00:00:00Z', 'B', false)!;
    expect(s4.since).toBe('2026-07-05');
    expect(s4.shotsSince).toBe(5000);

    // No service marker means the first ledger date is an "at least" base.
    const s5 = dieServiceStatus(d1, [], undefined, 'B', false)!;
    expect(s5.shotsSince).toBe(11_000);
    expect(s5.since).toBe('2026-07-01');
    expect(s5.sinceIsService).toBe(false);
  });

  it('does not make an idle die due merely because calendar time passes', () => {
    const zero = { dieNumber: '280', daily: [] };
    const idle = dieServiceStatus(
      zero,
      [],
      '2026-04-10T00:00:00Z',
      'B',
      false,
    )!;
    expect(idle.shotsSince).toBe(0);
    expect(idle.shotPct).toBe(0);
    expect(idle.level).toBe('ok');
  });

  it('forces Level C when the latest condition has any rating above 1', () => {
    const usage = { dieNumber: '117', daily: [{ day: '2026-07-01', shots: 4000 }] };
    const normal = dieServiceStatus(usage, [], undefined, 'A', false)!;
    expect(normal.maintenanceLevel).toBe('A');
    expect(normal.level).toBe('ok');
    const forced = dieServiceStatus(usage, [], undefined, 'A', true)!;
    expect(forced.configuredLevel).toBe('A');
    expect(forced.maintenanceLevel).toBe('C');
    expect(forced.conditionTriggered).toBe(true);
    expect(forced.intervalShots).toBe(5000);
    expect(forced.level).toBe('soon'); // 4k / 5k = 80%
  });

  it('builds an independent daily shot ledger and de-duplicates tuple snapshots', () => {
    const usage = aggregateDieServiceUsage(
      [dc('P-A', '280')],
      [
        { machineCode: '1600T', shiftId: '2026-07-05-Day', jobNumber: 'J1', partNumber: 'P-A', countStart: 0, countEnd: 3000 },
        // Same canonical tuple seen twice: take the fresher/larger counter,
        // never sum both snapshots.
        { machineCode: '1600T', shiftId: '2026-07-05-Day', jobNumber: 'J1', partNumber: 'P-A', countStart: 0, countEnd: 4000 },
        { machineCode: 'Batt1', shiftId: '2026-07-06-Night', jobNumber: 'J2', partNumber: 'P-A', countStart: 100, countEnd: 600 },
      ],
    );
    expect(usage.get('280')?.daily).toEqual([
      { day: '2026-07-05', shots: 4000 },
      { day: '2026-07-06', shots: 500 },
    ]);
  });

  it('returns null only when both service baseline and production are absent', () => {
    expect(dieServiceStatus({ dieNumber: 'EMPTY', daily: [] }, [])).toBeNull();
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

  it('updateDieMaster stamps the In-service return date (availableDate)', async () => {
    const dal = new MemoryDataLayer();
    const first = (await dal.listDieMaster())[0];
    await dal.updateDieMaster(first.dieNumber, {
      toolStatus: 'in-service',
      dateStamp: '2026-07-22T01:00:00.000Z',
      availableDate: '2026-08-01T00:00:00.000Z',
    });
    const again = (await dal.listDieMaster()).find((m) => m.dieNumber === first.dieNumber)!;
    expect(again.toolStatus).toBe('in-service');
    expect(again.availableDate).toBe('2026-08-01T00:00:00.000Z');
    // The rest of the row is untouched.
    expect(again.description).toBe(first.description);
    expect(again.lastServiceDate).toBe(first.lastServiceDate);
  });
});

describe('dieNumberSortKey (Die # column sorts numerically)', () => {
  it('orders plain numeric die numbers by value, not first digit', () => {
    const sorted = ['1050', '280', '9', '75'].sort((a, b) =>
      dieNumberSortKey(a) < dieNumberSortKey(b) ? -1 : 1,
    );
    expect(sorted).toEqual(['9', '75', '280', '1050']);
  });

  it('keeps prefixed/suffixed numbers in natural order', () => {
    const sorted = ['DIE-1050', 'DIE-280', '280A', '280'].sort((a, b) =>
      dieNumberSortKey(a) < dieNumberSortKey(b) ? -1 : 1,
    );
    expect(sorted).toEqual(['280', '280A', 'DIE-280', 'DIE-1050']);
  });

  it('is trim- and case-insensitive like the rest of the die joins', () => {
    expect(dieNumberSortKey(' 280 ')).toBe(dieNumberSortKey('280'));
    expect(dieNumberSortKey('die-7')).toBe(dieNumberSortKey('DIE-7'));
  });
});

describe('assetNamesMachine / machineCodeForAsset (explicit Plant/Equipment map)', () => {
  it('maps every registered Mango asset to its Machine-column code', () => {
    expect(machineCodeForAsset('AU - 125T Superjack Injection Molding Machine')).toBe('125T');
    expect(machineCodeForAsset('AU - 1300T LS Mtron Injection Molding Machine')).toBe('1300T');
    expect(machineCodeForAsset('AU - 150T Borche Injection Molding Machine')).toBe('150T');
    expect(machineCodeForAsset('AU - 1600T Toshiba Injection Molding Machine')).toBe('1600T');
    expect(machineCodeForAsset('AU - 320T Macosys Injection Molding Machine')).toBe('320T');
    expect(machineCodeForAsset('AU - 550T Meiki Injection Molding Machine')).toBe('550T');
    expect(machineCodeForAsset('AU - 850T Meiki Injection Molding Machine')).toBe('850T');
    expect(machineCodeForAsset('AU - Batt-1 BattenFeld Injection Molding Machine (1000T)')).toBe('Batt1');
    expect(
      machineCodeForAsset('AU - Batt-2 BattenFeld Injection Molding Machine (1000T Modified Screw & Barrel)'),
    ).toBe('Batt2');
  });

  it('is trim- and whitespace-insensitive (Mango sometimes doubles a space)', () => {
    // The real "150T Borche" row ships with two spaces before "Injection".
    expect(machineCodeForAsset('AU - 150T Borche  Injection Molding Machine')).toBe('150T');
    expect(machineCodeForAsset('  AU - 550T Meiki Injection Molding Machine  ')).toBe('550T');
  });

  it('returns no code for an unregistered asset', () => {
    expect(machineCodeForAsset('AU - Forklift 7')).toBe('');
    expect(machineCodeForAsset('AU - 999T Nonexistent Press')).toBe('');
    expect(machineCodeForAsset('')).toBe('');
  });

  it('assetNamesMachine is the exact-map predicate', () => {
    expect(assetNamesMachine('AU - Batt-1 BattenFeld Injection Molding Machine (1000T)', 'Batt1')).toBe(true);
    expect(assetNamesMachine('AU - Batt-1 BattenFeld Injection Molding Machine (1000T)', 'Batt2')).toBe(false);
    expect(assetNamesMachine('AU - 550T Meiki Injection Molding Machine', '850T')).toBe(false);
    expect(assetNamesMachine('AU - 550T Meiki Injection Molding Machine', '')).toBe(false);
    expect(assetNamesMachine('', '850T')).toBe(false);
  });
});

describe('machineWorkOrder grouping + colour level', () => {
  const wo = (over: Partial<DieMaintenanceRequest> & { asset: string }): DieMaintenanceRequest => ({
    id: 1,
    dieNumber: '',
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
  const reqs = [
    wo({ id: 1, asset: 'AU - 850T Meiki Injection Molding Machine', status: 'open', dueDate: '2026-08-10' }),
    wo({ id: 2, asset: 'AU - 850T Meiki Injection Molding Machine', status: 'done', closedAt: '2026-07-05T00:00:00Z' }),
    wo({ id: 3, asset: 'AU - 1600T Toshiba Injection Molding Machine', status: 'in-progress', dueDate: '2026-07-01' }),
    wo({ id: 4, asset: 'AU - 550T Meiki Injection Molding Machine', status: 'done', closedAt: '2026-07-02T00:00:00Z' }),
  ];
  const today = '2026-07-23';

  it('groups work orders to the press that owns them', () => {
    expect(machineWorkOrdersFor('850T', reqs).map((r) => r.id)).toEqual([1, 2]);
    expect(machineWorkOrdersFor('1600T', reqs).map((r) => r.id)).toEqual([3]);
    expect(machineWorkOrdersFor('125T', reqs)).toEqual([]);
  });

  it('colours a press green for an on-time open order', () => {
    expect(machineWorkOrderLevel('850T', reqs, today)).toBe('open');
  });

  it('colours a press red when an open order is overdue', () => {
    expect(machineWorkOrderLevel('1600T', reqs, today)).toBe('overdue');
  });

  it('leaves a press blue (null) when it has only closed orders or none', () => {
    expect(machineWorkOrderLevel('550T', reqs, today)).toBeNull(); // done only
    expect(machineWorkOrderLevel('125T', reqs, today)).toBeNull(); // none
  });
});

describe('parseMangoMachineWorkOrdersCsv (machine half of the report)', () => {
  const HEADER =
    'Number,Downtime,Labour Hours,Current Stage,Plant/Equipment,Brief Description,Employee,Created Date,Branch,To be completed by,Type of Maintenance ,Identified By,Date identified,Time,AM/PM,Work shift,Describe the issue,Actions taken,Region,Department,Assign to Action,Work can be done to,Summary of work completed,"Cost (parts, labour)",Corrective action taken,Preventative action taken,Summary';
  const dieRow =
    'MWO 001,,4,Stage 1 Coordinator Assessing,AU - Die 171 Podium Seat,Sprue gate wear,Karl Stevens,3/07/2026,Resero - Minto,31/07/2026,2. Breakdown,,3/07/2026,7,AM,Day,,,Minto (AU),Moulding,Karl Stevens,,,,,,';
  const pressRow =
    'MWO 002,,3,Stage 2 In Progress,AU - 850T Meiki Injection Molding Machine,Hydraulic filter change,Jeff Penn,3/07/2026,Resero - Minto,10/08/2026,1. Preventative,,3/07/2026,7,AM,Day,,,Minto (AU),Maintenance,Maintenance Team,,,,,,';

  it('keeps the machine row and drops the die row, preserving the raw asset', () => {
    const out = parseMangoMachineWorkOrdersCsv([HEADER, dieRow, pressRow].join('\n'));
    expect(out.length).toBe(1);
    expect(out[0].asset).toBe('AU - 850T Meiki Injection Molding Machine');
    expect(out[0].dieNumber).toBe(''); // machine rows carry no die number
    expect(out[0].dueDate).toBe('2026-08-10');
    // …and it resolves to the press by code.
    expect(assetNamesMachine(out[0].asset ?? '', '850T')).toBe(true);
  });

  it('is the complement of the die parser on the same file', () => {
    const dies = parseMangoWorkOrdersCsv([HEADER, dieRow, pressRow].join('\n'));
    const machines = parseMangoMachineWorkOrdersCsv([HEADER, dieRow, pressRow].join('\n'));
    expect(dies.map((r) => r.dieNumber)).toEqual(['171']);
    expect(machines.map((r) => r.asset)).toEqual(['AU - 850T Meiki Injection Molding Machine']);
  });
});


describe('latestConditionByDie (PMD_DieChangeLog → toolroom flags)', () => {
  const log = (over: Partial<DieChangeLog>): DieChangeLog => ({
    id: 1,
    eventKey: '550T|2026-07-10|DAY|SFM507268|0',
    eventStartSlot: 0,
    eventEndSlot: 3,
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
    componentsIn: {},
    problemDescription: '',
    problemDescriptionIn: '',
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
    expect(closed.actionsTaken).toContain('to Stage 4 Closed');
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

  it('accepts a valid header-only report but rejects empty/title-only corruption', () => {
    expect(parseMangoWorkOrdersCsv(`${MINTO_HEADER}\n`)).toEqual([]);
    expect(() => parseMangoWorkOrdersCsv('')).toThrow(/empty/i);
    expect(() =>
      parseMangoWorkOrdersCsv(
        'AU - Minto Maintenance Request 1783728039982\nno real header here\n',
      ),
    ).toThrow(/schema invalid/i);
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
    // DIE-3597 seeds a CUSTOMISED multi-level PM plan (the other rows
    // stay '' and fall back to the default template).
    expect(parsePmPlan(d3597.maintenanceLevel).map((l) => l.level)).toEqual([1, 2, 3]);
    expect(parsePmPlan(d3597.maintenanceLevel)[1].intervalShots).toBe(8_000);
    // The recently serviced die carries a LastServiceDate.
    expect(master.find((m) => m.dieNumber === 'DIE-1422')!.lastServiceDate).not.toBe('');
  });

  it('die change log: create + list round-trip, condition parsing', async () => {
    const dal = new MemoryDataLayer();
    const created = await dal.createDieChangeLog({
      eventKey: '1600T|2026-07-14|DAY|SFM507001|2',
      eventStartSlot: 2,
      eventEndSlot: 5,
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
      componentsIn: { Bolts: 'good' },
      problemDescription: 'Oil weep on the top cylinder; vents crusted.',
      problemDescriptionIn: '',
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
      eventKey: '1600T|2026-07-14|DAY|SFM507001|2',
      eventStartSlot: 2,
      eventEndSlot: 5,
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
      componentsIn: {},
      problemDescription: 'Vents crusted.',
      problemDescriptionIn: '',
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

  it('stores OUT + IN inspections on one continuous-event row, keyed by start slot', async () => {
    const dal = new MemoryDataLayer();
    const ctx = {
      eventKey: '550T|2026-07-14|DAY|SFM507268|2',
      eventStartSlot: 2,
      eventEndSlot: 5,
      date: '2026-07-14',
      shift: 'Day',
      dieSetter: 'Van Minh Ma',
      machineCode: '550T',
      jobNumber: 'SFM507268',
    };
    // One event row owns both sides of the physical change.
    await dal.createDieChangeLog({
      ...ctx,
      changeOver: ['Die'],
      dieNumberOut: '117',
      dieDescriptionOut: 'Proteus Seat',
      dieNumberIn: '174',
      dieDescriptionIn: 'Podium Seat',
      components: { MouldingSurfaces: 'worn' },
      componentsIn: { Venting: 'damaged' },
      problemDescription: 'Surface wear near gate.',
      problemDescriptionIn: 'Vent blocked on fitting.',
    });
    const mine = (await dal.listDieChangeLog()).filter((r) => r.jobNumber === 'SFM507268');
    expect(mine.length).toBe(1);
    // latestConditionByDie attributes each to its own die.
    const cond = latestConditionByDie(mine);
    expect(cond.get('117')!.flags.map((f) => f.key)).toEqual(['MouldingSurfaces']);
    expect(cond.get('174')!.flags.map((f) => f.key)).toEqual(['Venting']);
    expect(cond.get('174')!.hasDamaged).toBe(true);
    // Re-saving the same block updates in place, no duplicate.
    await dal.createDieChangeLog({
      ...ctx,
      changeOver: ['Die'],
      dieNumberOut: '117',
      dieDescriptionOut: 'Proteus Seat',
      dieNumberIn: '174',
      dieDescriptionIn: 'Podium Seat',
      components: { MouldingSurfaces: 'damaged' },
      componentsIn: { Venting: 'damaged' },
      problemDescription: 'Now cracked.',
      problemDescriptionIn: 'Vent blocked on fitting.',
    });
    const after = (await dal.listDieChangeLog()).filter((r) => r.jobNumber === 'SFM507268');
    expect(after.length).toBe(1);
    expect(latestConditionByDie(after).get('117')!.hasDamaged).toBe(true);
    // A second disjoint D/I block for the same machine/date/shift/job is a
    // distinct event because its start slot differs.
    await dal.createDieChangeLog({
      ...ctx,
      eventKey: '550T|2026-07-14|DAY|SFM507268|9',
      eventStartSlot: 9,
      eventEndSlot: 10,
      changeOver: ['Insert'],
      dieNumberOut: '117',
      dieDescriptionOut: 'Proteus Seat',
      dieNumberIn: '117',
      dieDescriptionIn: 'Proteus Seat',
      components: { Bolts: 'good' },
      componentsIn: { Bolts: 'good' },
      problemDescription: '',
      problemDescriptionIn: '',
    });
    expect(
      (await dal.listDieChangeLog()).filter((r) => r.jobNumber === 'SFM507268'),
    ).toHaveLength(2);
  });

  it('updateDieMaster changes ToolStatus and stamps the audit dates', async () => {
    const dal = new MemoryDataLayer();
    await dal.updateDieMaster('die-0091', {
      // case/space-insensitive die lookup on purpose
      toolStatus: 'serviced',
      dateStamp: '2026-07-13T02:00:00Z',
      lastServiceDate: '2026-07-13T02:00:00Z',
      maintenanceLevel: 'A',
    });
    const master = await dal.listDieMaster();
    const row = master.find((m) => m.dieNumber === 'DIE-0091')!;
    expect(row.toolStatus).toBe('serviced');
    expect(row.dateStamp).toBe('2026-07-13T02:00:00Z');
    expect(row.lastServiceDate).toBe('2026-07-13T02:00:00Z');
    expect(row.maintenanceLevel).toBe('A');
    await expect(dal.updateDieMaster('NOPE', { toolStatus: 'problems' })).rejects.toThrow();
  });

  it('updateDieMaster appends SOC notes to the Notes column', async () => {
    const dal = new MemoryDataLayer();
    const die = (await dal.listDieMaster())[0].dieNumber;
    const first = formatDieNoteLine({
      date: '2026-07-23',
      shift: 'Day',
      machine: '550T',
      operator: 'Karl Stevens',
      body: 'Colour changed to grey; barrel temp 210°C',
    });
    await dal.updateDieMaster(die, { notes: appendDieNote('', first) });
    const second = formatDieNoteLine({
      date: '2026-07-23',
      shift: 'Night',
      machine: '550T',
      operator: 'Jo Lee',
      body: 'Injection speed 45%',
    });
    const row0 = (await dal.listDieMaster()).find((m) => m.dieNumber === die)!;
    await dal.updateDieMaster(die, { notes: appendDieNote(row0.notes, second) });
    const row = (await dal.listDieMaster()).find((m) => m.dieNumber === die)!;
    // Two notes stored, newest-first when parsed.
    const notes = parseDieNotes(row.notes);
    expect(notes).toHaveLength(2);
    expect(notes[0].body).toBe('Injection speed 45%');
    expect(notes[0].shift).toBe('Night');
    expect(notes[1].body).toBe('Colour changed to grey; barrel temp 210°C');
    // Keyword search reaches into the body and the captured context.
    expect(parseDieNotes(row.notes, 'temp')).toHaveLength(1);
    expect(parseDieNotes(row.notes, 'jo lee')).toHaveLength(1);
    expect(parseDieNotes(row.notes, 'pressure')).toHaveLength(0);
  });
});

describe('SOC note helpers (PMD_DieMaster.Notes)', () => {
  it('formats a note as one Date/Shift/Machine/Operator: body line', () => {
    expect(
      formatDieNoteLine({
        date: '2026-07-23',
        shift: 'Day',
        machine: '550T',
        operator: 'Karl Stevens',
        body: 'Hold pressure 60 bar',
      }),
    ).toBe('2026-07-23/Day/550T/Karl Stevens: Hold pressure 60 bar');
  });

  it('collapses newlines in the body so every note stays one line', () => {
    const line = formatDieNoteLine({
      date: '2026-07-23',
      shift: 'Day',
      machine: '550T',
      operator: 'Ann',
      body: 'Temp up\nSpeed down',
    });
    expect(line).not.toContain('\n');
    expect(line).toBe('2026-07-23/Day/550T/Ann: Temp up Speed down');
  });

  it('round-trips a note whose body itself contains ": "', () => {
    const line = formatDieNoteLine({
      date: '2026-07-23',
      shift: 'Night',
      machine: '850T',
      operator: 'Bob',
      body: 'Note: raise the temp',
    });
    const [note] = parseDieNotes(line);
    expect(note.machine).toBe('850T');
    expect(note.operator).toBe('Bob');
    expect(note.body).toBe('Note: raise the temp');
  });

  it('parses blank lines away and orders newest-first', () => {
    const blob = ['2026-07-01/Day/550T/A: one', '', '2026-07-02/Day/550T/B: two'].join('\n');
    const notes = parseDieNotes(blob);
    expect(notes.map((n) => n.body)).toEqual(['two', 'one']);
  });

  it('appendDieNote starts a blob and then adds newline-separated lines', () => {
    const a = appendDieNote('', 'x: 1');
    expect(a).toBe('x: 1');
    const b = appendDieNote(a, 'y: 2');
    expect(b).toBe('x: 1\ny: 2');
    // Trailing whitespace on the existing blob doesn't produce a blank note.
    expect(parseDieNotes(appendDieNote('x: 1\n', 'y: 2'))).toHaveLength(2);
  });
});

describe('formatToolStatusNotice (ToolStatus-change email)', () => {
  it('names the die and the from→to transition in the subject and body', () => {
    const { subject, body } = formatToolStatusNotice({
      dieNumber: 'DIE-0689',
      description: 'Postura Plus Linking Chair',
      from: 'to-be-serviced',
      to: 'serviced',
      changedAt: '2026-07-24T05:32:00.000Z',
    });
    expect(subject).toBe('PMD Tool Status: DIE-0689 → Serviced');
    expect(body).toContain('DIE-0689 — Postura Plus Linking Chair');
    expect(body).toContain('To be Serviced → Serviced');
    // A non-in-service change carries no Available line.
    expect(body).not.toContain('Available');
  });

  it('carries a markup-free copy of the same content for the plain-text retry', () => {
    const { body, text } = formatToolStatusNotice({
      dieNumber: 'DIE-0689',
      description: 'Postura Plus Linking Chair',
      from: 'to-be-serviced',
      to: 'in-service',
      availableDate: '2026-08-10T00:00:00.000Z',
      changedAt: '2026-07-24T05:32:00.000Z',
      changedBy: 'A. Toolmaker',
    });
    expect(text).not.toMatch(/[<>]/); // no tags survive into the text part
    // Every field the HTML body carries is in the text body too.
    expect(text).toContain('Die: DIE-0689 — Postura Plus Linking Chair');
    expect(text).toContain('Status: To be Serviced → In service');
    expect(text).toContain('Available (back from maintenance): 10/08/2026');
    expect(text).toContain('Changed by: A. Toolmaker');
    expect(body).toContain('Changed by:</b> A. Toolmaker');
  });

  it('escapes markup in die text so a stray < cannot break the HTML body', () => {
    const { body, text } = formatToolStatusNotice({
      dieNumber: 'DIE-1',
      description: 'Bracket <A&B>',
      from: '',
      to: 'problems',
      changedAt: '2026-07-24T05:32:00.000Z',
    });
    expect(body).toContain('Bracket &lt;A&amp;B&gt;');
    expect(text).toContain('Bracket <A&B>'); // plain text stays plain
  });

  it('shows the Available return date only on the In-service transition', () => {
    const { subject, body } = formatToolStatusNotice({
      dieNumber: 'DIE-3597',
      from: 'problems',
      to: 'in-service',
      availableDate: '2026-08-10T00:00:00.000Z',
      changedAt: '2026-07-24T05:32:00.000Z',
    });
    expect(subject).toBe('PMD Tool Status: DIE-3597 → In service');
    expect(body).toContain('Available (back from maintenance):</b> 10/08/2026');
  });

  it('renders "(none)" when the die had no prior status', () => {
    const { body } = formatToolStatusNotice({
      dieNumber: 'DIE-1',
      from: '',
      to: 'problems',
      changedAt: '2026-07-24T05:32:00.000Z',
    });
    expect(body).toContain('(none) → Problems');
  });
});

describe('parsePmPlan (PMD_DieMaster.MaintenanceLevel → PM tiers)', () => {
  it('parses the default 3-level template with shot intervals', () => {
    const levels = parsePmPlan(defaultPmPlanText(10_000));
    expect(levels.map((l) => l.level)).toEqual([1, 2, 3]);
    expect(levels[0].intervalShots).toBeNull(); // "every die change" — event-based
    expect(levels[1].intervalShots).toBe(10_000);
    expect(levels[2].intervalShots).toBe(100_000); // 10× L2
    expect(levels[0].tasks).toContain('Blow out vents');
    expect(levels[2].tasks.some((t) => /ultrasonic/i.test(t))).toBe(true);
  });

  it('the default L2 follows the governing service interval', () => {
    const levels = parsePmPlan(defaultPmPlanText(15_000));
    expect(levels[1].intervalShots).toBe(15_000);
    expect(levels[2].intervalShots).toBe(150_000);
  });

  it('tolerates "Level 2:" headers, k-suffix shots and full-width separators', () => {
    const text = [
      'Level 1: every die change | Wipe parting line；Blow vents',
      'Level 2 - 8k shots ｜ Polish vent land； Grease pins',
      'L3｜80,000 cycles｜Full strip',
    ].join('\n');
    const levels = parsePmPlan(text);
    expect(levels.length).toBe(3);
    expect(levels[0].intervalShots).toBeNull();
    expect(levels[0].tasks).toEqual(['Wipe parting line', 'Blow vents']);
    expect(levels[1].intervalShots).toBe(8_000);
    expect(levels[1].tasks).toEqual(['Polish vent land', 'Grease pins']);
    expect(levels[2].intervalShots).toBe(80_000);
  });

  it('a bare-number interval reads as shots', () => {
    const levels = parsePmPlan('L2 | 12000 | Clean vents');
    expect(levels[0].intervalShots).toBe(12_000);
  });

  it('continuation lines extend the previous level; free-form text yields []', () => {
    const cont = parsePmPlan('L2 | 10,000 shots | First task\nSecond task; Third task');
    expect(cont[0].tasks).toEqual(['First task', 'Second task', 'Third task']);
    // Nothing level-shaped at all → [] so the UI shows the raw text.
    expect(parsePmPlan('Grease everything monthly, ask Dave.')).toEqual([]);
    expect(parsePmPlan('')).toEqual([]);
  });

  it('sorts levels regardless of line order', () => {
    const levels = parsePmPlan('L3 | 100k shots | Teardown\nL1 | every die change | Wipe');
    expect(levels.map((l) => l.level)).toEqual([1, 3]);
  });

  it('pmShotLevel bands match the tonnage rule (80% soon / 100% due)', () => {
    expect(pmShotLevel(7_999, 10_000).level).toBe('ok');
    expect(pmShotLevel(8_000, 10_000).level).toBe('soon');
    expect(pmShotLevel(10_000, 10_000).level).toBe('due');
    expect(pmShotLevel(5_000, 10_000).pct).toBeCloseTo(0.5);
  });
});
