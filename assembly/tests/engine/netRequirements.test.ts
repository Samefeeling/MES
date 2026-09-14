import { describe, it, expect } from 'vitest';
import { netRequirements, netQtyForPart } from '@/engine/netRequirements';
import { PartId } from '@/domain/ids';
import type { DemandLine, InventoryItem } from '@/domain/types';

const demand = (partNum: string, reqQty: number): DemandLine => ({
  partNum: PartId(partNum),
  reqDate: null,
  reqQty,
});

const inv = (partNum: string, freeOnHand: number): InventoryItem => ({
  partNum: PartId(partNum),
  description: '',
  typeCode: 'M',
  onHand: freeOnHand,
  cmplWip: 0,
  supply: 0,
  demand: 0,
  freeOnHand,
});

describe('netRequirements', () => {
  it('aggregates demand per part and nets against free-on-hand', () => {
    const reqs = netRequirements(
      [demand('A', 100), demand('A', 50), demand('B', 30)],
      [inv('A', 120), inv('B', 0)],
    );
    expect(reqs.get(PartId('A'))?.grossDemand).toBe(150);
    expect(reqs.get(PartId('A'))?.netQty).toBe(30); // 150 − 120
    expect(reqs.get(PartId('B'))?.netQty).toBe(30); // 30 − 0
  });

  it('never returns a negative net requirement', () => {
    const reqs = netRequirements([demand('A', 10)], [inv('A', 100)]);
    expect(reqs.get(PartId('A'))?.netQty).toBe(0);
  });

  it('treats parts with no inventory record as zero free-on-hand', () => {
    const reqs = netRequirements([demand('Z', 40)], []);
    expect(reqs.get(PartId('Z'))?.freeOnHand).toBe(0);
    expect(reqs.get(PartId('Z'))?.netQty).toBe(40);
  });

  it('netQtyForPart returns 0 for an unknown part', () => {
    const reqs = netRequirements([demand('A', 10)], []);
    expect(netQtyForPart(PartId('A'), reqs)).toBe(10);
    expect(netQtyForPart(PartId('missing'), reqs)).toBe(0);
  });
});
