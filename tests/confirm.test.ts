import { describe, expect, it } from 'vitest';

import { confirmKey, pruneConfirmedKeys } from '../src/core/confirm';
import { MemoryDataLayer } from '../src/dal/memory';
import { rec } from './helpers';

describe('confirmKey / pruneConfirmedKeys', () => {
  it('builds machine|shiftId|job keys', () => {
    expect(confirmKey('125T', '2026-07-09-Day', 'SFM1')).toBe('125T|2026-07-09-Day|SFM1');
  });

  it('keeps keys within the prune window and drops old / malformed ones', () => {
    const keys = [
      confirmKey('125T', '2026-07-09-Day', 'A'), // today
      confirmKey('125T', '2026-07-07-Night', 'B'), // 2 days old — kept
      confirmKey('125T', '2026-07-01-Day', 'C'), // 8 days old — pruned
      'garbage-without-pipes',
      '125T|not-a-date-Day|X',
    ];
    expect(pruneConfirmedKeys(keys, '2026-07-09')).toEqual([
      '125T|2026-07-09-Day|A',
      '125T|2026-07-07-Night|B',
    ]);
  });
});

describe('MemoryDataLayer.discardUnconfirmedTuple', () => {
  it('drops the tuple’s unsigned rows but never signed ones or other tuples', async () => {
    const dal = new MemoryDataLayer();
    const mk = (over: Partial<ReturnType<typeof rec>>) =>
      dal.upsertProductionRecord(
        rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', ...over }),
      );
    await mk({ machineCode: 'M1', shiftId: '2026-07-09-Day', slotIndex: 0 }); // target, unsigned
    await mk({ machineCode: 'M1', shiftId: '2026-07-09-Day', slotIndex: 1 }); // target, unsigned
    await mk({ machineCode: 'M1', shiftId: '2026-07-09-Day', slotIndex: 2, locked: true }); // signed — kept
    await mk({ machineCode: 'M1', shiftId: '2026-07-09-Day', jobNumber: 'J2' }); // other job — kept
    await mk({ machineCode: 'M2', shiftId: '2026-07-09-Day' }); // other machine — kept

    await dal.discardUnconfirmedTuple('M1', '2026-07-09-Day', 'J1');

    const left = await dal.listProduction({});
    const tupleRows = left.filter(
      (r) => r.machineCode === 'M1' && r.shiftId === '2026-07-09-Day' && r.jobNumber === 'J1',
    );
    expect(tupleRows.length).toBe(1);
    expect(tupleRows[0].locked).toBe(true);
    expect(left.some((r) => r.jobNumber === 'J2')).toBe(true);
    expect(left.some((r) => r.machineCode === 'M2')).toBe(true);
  });
});
