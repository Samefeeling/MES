/**
 * Giving out what is already on the shelf.
 *
 * The point of allocating rather than looking up: forty covers cover one order
 * for forty or two orders for twenty, and never two orders for forty.
 */

import { describe, it, expect } from 'vitest';
import { JobId, PartId } from '@/domain/ids';
import type { InventoryItem, Job, JobMaterialLink } from '@/domain/types';
import { allocateStock, coverageOf } from '@/engine/assembly/stockAllocation';

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId('CHAIR'),
  description: id,
  remainingQty: 10,
  qtyPerHr: null,
  laborHrs: 8,
  dueDate: null,
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: null,
  line: null,
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const link = (
  jobNum: string,
  child: string,
  requiredQty: number | null,
): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId('CHAIR'),
  childPart: PartId(child),
  requiredQty,
  childDescription: child,
  uom: 'EA',
});

const shelf = (...held: [string, number][]): Map<PartId, InventoryItem> =>
  new Map(
    held.map(([part, freeOnHand]) => [
      PartId(part),
      {
        partNum: PartId(part),
        description: part,
        typeCode: null,
        onHand: freeOnHand,
        cmplWip: 0,
        supply: 0,
        demand: 0,
        calculatedDemand: null,
        freeOnHand,
      },
    ]),
  );

const day = (n: number) => new Date(2026, 8, n);

describe('allocateStock', () => {
  it('covers an order whose component is in the racks', () => {
    const cover = allocateStock(
      [job('ASM1')],
      [link('ASM1', 'COVER', 10)],
      shelf(['COVER', 40]),
    );
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBe(1);
  });

  it('covers the part of it the shelf can, and no more', () => {
    const cover = allocateStock(
      [job('ASM1')],
      [link('ASM1', 'COVER', 10)],
      shelf(['COVER', 4]),
    );
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBeCloseTo(0.4, 10);
  });

  it('gives the same stock to one order, not to every order that wants it', () => {
    const cover = allocateStock(
      [
        job('ASM2', { dueDate: day(25) }),
        job('ASM1', { dueDate: day(18) }),
      ],
      [link('ASM1', 'COVER', 10), link('ASM2', 'COVER', 10)],
      shelf(['COVER', 10]),
    );
    // Earliest need date first, whatever order the jobs arrive in.
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBe(1);
    expect(coverageOf(cover, 'ASM2', 'COVER')).toBe(0);
  });

  it('prefers a dated start over a due date, and dates over neither', () => {
    const cover = allocateStock(
      [
        job('ASM1', { dueDate: day(12) }),
        job('ASM2', { dueDate: day(30), startDate: day(11) }),
        job('ASM3'),
      ],
      [
        link('ASM1', 'COVER', 10),
        link('ASM2', 'COVER', 10),
        link('ASM3', 'COVER', 10),
      ],
      shelf(['COVER', 20]),
    );
    expect(coverageOf(cover, 'ASM2', 'COVER')).toBe(1);
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBe(1);
    // An undated order sorts last: it cannot say when it wants the stock.
    expect(coverageOf(cover, 'ASM3', 'COVER')).toBe(0);
  });

  it('breaks a tie on job number, so the same export allocates the same way', () => {
    const args = [
      [job('ASM9', { dueDate: day(12) }), job('ASM1', { dueDate: day(12) })],
      [link('ASM1', 'COVER', 10), link('ASM9', 'COVER', 10)],
      shelf(['COVER', 10]),
    ] as const;
    const first = allocateStock(...args);
    const again = allocateStock(...args);
    expect(coverageOf(first, 'ASM1', 'COVER')).toBe(1);
    expect(coverageOf(again, 'ASM1', 'COVER')).toBe(1);
  });

  it('sums the rows when one order names a component twice', () => {
    const cover = allocateStock(
      [job('ASM1')],
      [link('ASM1', 'COVER', 6), link('ASM1', 'COVER', 6)],
      shelf(['COVER', 6]),
    );
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBeCloseTo(0.5, 10);
  });

  it('leaves a finished order holding nothing', () => {
    const cover = allocateStock(
      [job('DONE', { remainingQty: 0, dueDate: day(11) }), job('ASM1', { dueDate: day(12) })],
      [link('DONE', 'COVER', 10), link('ASM1', 'COVER', 10)],
      shelf(['COVER', 10]),
    );
    expect(coverageOf(cover, 'DONE', 'COVER')).toBe(0);
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBe(1);
  });

  it('cannot net a row with no quantity on it', () => {
    const cover = allocateStock(
      [job('ASM1')],
      [link('ASM1', 'COVER', null)],
      shelf(['COVER', 999]),
    );
    expect(coverageOf(cover, 'ASM1', 'COVER')).toBe(0);
  });

  it('matches part numbers whatever case the exports use', () => {
    const cover = allocateStock(
      [job('ASM1')],
      [link('ASM1', 'Cover', 10)],
      shelf(['COVER ', 10]),
    );
    expect(coverageOf(cover, 'ASM1', 'cover')).toBe(1);
  });

  it('reads nothing as nothing rather than as an error', () => {
    expect(coverageOf(undefined, 'ASM1', 'COVER')).toBe(0);
    expect(coverageOf(allocateStock([], [], shelf()), 'ASM1', null)).toBe(0);
  });
});
