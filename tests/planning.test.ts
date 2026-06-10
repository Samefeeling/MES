import { describe, it, expect } from 'vitest';
import { generateDieChanges } from '../src/core/planning';
import { order } from './helpers';

describe('auto die-change generation (§5.3)', () => {
  it('inserts a DC between consecutive same-machine orders with different parts', () => {
    const orders = [
      order({
        id: 1,
        jobNumber: 'A',
        partNumber: 'P1',
        plannedStart: '2026-05-15T07:00:00',
        plannedEnd: '2026-05-15T11:00:00',
      }),
      order({
        id: 2,
        jobNumber: 'B',
        partNumber: 'P2',
        plannedStart: '2026-05-15T11:00:00',
        plannedEnd: '2026-05-15T15:00:00',
      }),
    ];
    const out = generateDieChanges(orders);
    const dc = out.filter((o) => o.isDieChange);
    expect(dc).toHaveLength(1);
    expect(dc[0].jobNumber).toBe('DC_A_B');
    expect(dc[0].jobRequired).toBe(0);
    expect(dc[0].duration).toBe(0.5);
    expect(dc[0].source).toBe('Auto-DC');
  });

  it('does not insert a DC when the part number is unchanged', () => {
    const orders = [
      order({ id: 1, jobNumber: 'A', partNumber: 'P1' }),
      order({
        id: 2,
        jobNumber: 'B',
        partNumber: 'P1',
        plannedStart: '2026-05-15T11:00:00',
        plannedEnd: '2026-05-15T15:00:00',
      }),
    ];
    expect(generateDieChanges(orders).filter((o) => o.isDieChange)).toHaveLength(0);
  });
});
