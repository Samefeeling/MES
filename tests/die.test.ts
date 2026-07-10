import { describe, expect, it } from 'vitest';

import {
  aggregateDies,
  buildDieTrend,
  dieHealth,
  dieServiceStatus,
  machineTonnage,
  serviceIntervalFor,
} from '../src/core/die';
import { MemoryDataLayer } from '../src/dal/memory';
import type { DieMaintenanceRequest, ProductDieColor } from '../src/types';
import { rec } from './helpers';

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
      { code: 'D07', qty: 3 },
      { code: 'D05', qty: 1 },
    ]);
    expect(d1.machines).toEqual(['M1', 'M2']);
    expect(d1.lastRun).toBe('2026-07-09');
    // DIE-2 never ran but still shows (usage zero).
    const d2 = dies.find((d) => d.dieNumber === 'DIE-2')!;
    expect(d2.runs).toBe(0);
    expect(d2.rejectPct).toBeNull();
    // Per-day series for the trend sparkline, day-ascending.
    expect(d1.daily).toEqual([
      { day: '2026-07-08', rejects: 4, pieces: 200, shots: 100 },
      { day: '2026-07-09', rejects: 0, pieces: 50, shots: 50 },
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
