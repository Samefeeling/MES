import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDataLayer } from '../src/dal/memory';
import { currentShift } from '../src/core/shifts';

const NOW = new Date(2026, 4, 17, 10, 0, 0); // 17 May 2026, Day shift

describe('MemoryDataLayer — PmdDataLayer contract', () => {
  let dal: MemoryDataLayer;
  beforeEach(() => {
    dal = new MemoryDataLayer(NOW);
  });

  it('serves seeded reference data', async () => {
    expect((await dal.listMachines()).length).toBe(8);
    const rcats = await dal.listRejectCategories();
    expect(rcats.length).toBe(10);
    // The 10 D-codes are all fixed rows; no "other" dropdown codes.
    expect(rcats.map((r) => r.code)).toEqual([
      'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10',
    ]);
    expect(rcats.find((r) => r.code === 'D01')?.label).toBe('ShortShot');
    expect(rcats.find((r) => r.code === 'D08')?.label).toBe('CrackedDelamination');
    const bd = await dal.listBdCodes();
    expect(bd.length).toBe(91); // 11 categories × 6–11 causes, taxonomy MD
    expect(bd.find((b) => b.code === 'ELE-01')?.subCategory).toBe('Electrical');
    expect(bd.find((b) => b.code === 'OTH-99')).toBeTruthy();
    expect((await dal.listOperators()).length).toBeGreaterThan(0);
    expect((await dal.listSupervisors()).length).toBe(3);
  });

  it('filters planning by machine and released flag', async () => {
    const all = await dal.listPlanning({ machineCode: '125T' });
    expect(all.every((p) => p.machineCode === '125T')).toBe(true);
    const released = await dal.listPlanning({ machineCode: '125T', released: true });
    expect(released.every((p) => p.released)).toBe(true);
  });

  it('does not leak internal state to callers (deep copy)', async () => {
    const a = await dal.listMachines();
    a[0].displayName = 'MUTATED';
    const b = await dal.listMachines();
    expect(b[0].displayName).not.toBe('MUTATED');
  });

  it('upsert inserts then updates on the composite key (§3.6, last-write-wins §5.6)', async () => {
    const sid = currentShift(NOW).shiftId;
    const created = await dal.upsertProductionRecord({
      id: 0,
      machineCode: '850T',
      shiftId: sid,
      jobNumber: 'JT1',
      partNumber: '',
      slotIndex: 7,
      statusCode: 'R',
      countStart: null,
      countEnd: null,
      rejectCount: 0,
      rejects: '{}',
      purgeKg: null,
      operator: 'Op',
      supervisor: '',
      bdIssue: '',
      mangoTicket: '',
      handoverNote: '',
      locked: false,
      lockedBy: '',
      lockedAt: '',
      createdAt: '',
      updatedAt: '',
    });
    expect(created.id).toBeGreaterThan(0);

    const updated = await dal.upsertProductionRecord({
      ...created,
      id: 0, // simulate a different device with no id — match on composite key
      statusCode: 'B',
    });
    expect(updated.id).toBe(created.id);

    const rows = await dal.listProduction({
      machineCode: '850T',
      shiftId: sid,
      jobNumber: 'JT1',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe('B');
  });

  it('lockShift freezes all records for the (machine, shift)', async () => {
    const sid = currentShift(NOW).shiftId;
    await dal.upsertProductionRecord({
      id: 0,
      machineCode: '320T',
      shiftId: sid,
      jobNumber: 'JL',
      partNumber: '',
      slotIndex: 0,
      statusCode: 'R',
      countStart: 0,
      countEnd: 10,
      rejectCount: 0,
      rejects: '{}',
      purgeKg: null,
      operator: 'Op',
      supervisor: '',
      bdIssue: '',
      mangoTicket: '',
      handoverNote: '',
      locked: false,
      lockedBy: '',
      lockedAt: '',
      createdAt: '',
      updatedAt: '',
    });
    await dal.lockShift('320T', sid, 'Jeff Penn', 'Tin Maung');
    const rows = await dal.listProduction({ machineCode: '320T', shiftId: sid });
    expect(rows.every((r) => r.locked && r.lockedBy === 'Jeff Penn')).toBe(true);

    await dal.unlockShift('320T', sid);
    const after = await dal.listProduction({ machineCode: '320T', shiftId: sid });
    expect(after.every((r) => !r.locked)).toBe(true);
  });

  it('lockShift on an empty shift creates a SlotIndex=0 placeholder (§5.5)', async () => {
    await dal.lockShift('HS', '2026-05-10-Afternoon', 'Jeff Penn', 'Tin');
    const rows = await dal.listProduction({
      machineCode: 'HS',
      shiftId: '2026-05-10-Afternoon',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].slotIndex).toBe(0);
    expect(rows[0].locked).toBe(true);
  });

  it('whoAmI returns an identity', async () => {
    const me = await dal.whoAmI();
    expect(me.name).toBeTruthy();
    expect(['operator', 'supervisor', 'admin']).toContain(me.role);
  });
});
