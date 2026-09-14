import { describe, it, expect } from 'vitest';
import { materialAvailability } from '@/engine/materialAvailability';
import type { ComponentRequirement } from '@/engine/materialExplosion';
import { PartId } from '@/domain/ids';
import type { InventoryItem, PoLine } from '@/domain/types';

const req = (part: string, qty: number): ComponentRequirement => ({
  componentPart: PartId(part),
  requiredQty: qty,
});

const invMap = (
  rows: Array<[string, number]>,
): Map<PartId, InventoryItem> => {
  const m = new Map<PartId, InventoryItem>();
  for (const [part, free] of rows) {
    m.set(PartId(part), {
      partNum: PartId(part),
      description: `${part} desc`,
      typeCode: 'P',
      onHand: free,
      cmplWip: 0,
      supply: 0,
      demand: 0,
      freeOnHand: free,
    });
  }
  return m;
};

const po = (qty: number, due: string, num = 'PO1'): PoLine => ({
  partNum: PartId('x'),
  poNum: num,
  outstandingQty: qty,
  dueDate: new Date(due),
  promiseDate: null,
  buyer: null,
});

describe('materialAvailability', () => {
  it('is OK when every component is in stock', () => {
    const status = materialAvailability(
      [req('A', 10), req('B', 5)],
      invMap([
        ['A', 50],
        ['B', 5],
      ]),
      new Map(),
    );
    expect(status.level).toBe('ok');
    expect(status.earliestStart).toBeNull();
    expect(status.shortages).toHaveLength(0);
  });

  it('is "covered" when a PO clears the shortfall, dated at that PO', () => {
    const status = materialAvailability(
      [req('A', 100)],
      invMap([['A', 30]]), // short by 70
      new Map([[PartId('A'), [po(70, '2026-07-15')]]]),
    );
    expect(status.level).toBe('covered');
    expect(status.earliestStart).toEqual(new Date('2026-07-15'));
    expect(status.shortages[0].shortQty).toBe(70);
    expect(status.shortages[0].coverageDate).toEqual(new Date('2026-07-15'));
  });

  it('uses the cumulative receipt that first clears the shortfall', () => {
    const status = materialAvailability(
      [req('A', 100)],
      invMap([['A', 0]]), // short by 100
      new Map([
        [
          PartId('A'),
          [
            po(40, '2026-07-01', 'early'),
            po(80, '2026-07-20', 'late'), // 40+80 ≥ 100 here
          ],
        ],
      ]),
    );
    expect(status.level).toBe('covered');
    expect(status.earliestStart).toEqual(new Date('2026-07-20'));
    expect(status.shortages[0].poNum).toBe('late');
  });

  it('is "short" when no PO covers the shortfall', () => {
    const status = materialAvailability(
      [req('A', 100)],
      invMap([['A', 10]]),
      new Map([[PartId('A'), [po(20, '2026-07-01')]]]), // only 20, need 90
    );
    expect(status.level).toBe('short');
    expect(status.earliestStart).toBeNull();
    expect(status.shortages[0].shortQty).toBe(90);
  });

  it('takes the latest coverage date across several short components', () => {
    const status = materialAvailability(
      [req('A', 50), req('B', 50)],
      invMap([
        ['A', 0],
        ['B', 0],
      ]),
      new Map([
        [PartId('A'), [po(50, '2026-07-05')]],
        [PartId('B'), [po(50, '2026-08-10')]],
      ]),
    );
    expect(status.level).toBe('covered');
    expect(status.earliestStart).toEqual(new Date('2026-08-10'));
    expect(status.shortages).toHaveLength(2);
  });

  it('one uncovered component makes the whole job short', () => {
    const status = materialAvailability(
      [req('A', 50), req('B', 50)],
      invMap([
        ['A', 0],
        ['B', 0],
      ]),
      new Map([
        [PartId('A'), [po(50, '2026-07-05')]], // covered
        // B has no PO → uncovered
      ]),
    );
    expect(status.level).toBe('short');
    expect(status.earliestStart).toBeNull();
  });
});
