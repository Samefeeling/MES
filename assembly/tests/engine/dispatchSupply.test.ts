/**
 * Stock and bought-in lines get a date from what is on hand, the open PO
 * releases and the stock jobs on the board — shared out by part, first due
 * first served, since neither export names the order a quantity is for.
 */

import { describe, expect, it } from 'vitest';
import type { WaybillLine } from '@/domain/dispatch';
import type { PoLine } from '@/domain/types';
import { PartId } from '@/domain/ids';
import { checkSupply, pegSupply, needsSupply } from '@/engine/dispatch/lineSupply';

const line = (order: string, ln: string, part: string, patch: Partial<WaybillLine> = {}): WaybillLine => ({
  order,
  line: ln,
  rel: '1',
  custId: 'C',
  shipVia: 'X',
  zone: 'NSW-Metro-South',
  city: 'Sydney',
  part,
  requestedQty: 0,
  shippedQty: 0,
  leftToShip: 1,
  allocatedQty: 0,
  uom: 'EA',
  expDelivery: null,
  shipBy: null,
  needBy: '2026-10-20',
  releaseValue: 0,
  fulfillment: 'Stock',
  status: '',
  inPicking: false,
  onHold: false,
  creditHold: false,
  pickListComment: '',
  shipToName: '',
  address: '',
  state: '',
  postcode: '',
  ...patch,
});

const po = (part: string, qty: number, due: Date | null, patch: Partial<PoLine> = {}): PoLine => ({
  partNum: PartId(part),
  poNum: `PO-${part}-${qty}`,
  outstandingQty: qty,
  dueDate: due,
  promiseDate: null,
  buyer: null,
  vendor: 'Acme',
  ...patch,
});

const today = '2026-10-14';

describe('pegSupply', () => {
  const lines = [
    line('100', '1', 'A', { leftToShip: 4, needBy: '2026-10-20' }),
    line('101', '1', 'A', { leftToShip: 10, needBy: '2026-10-18' }),
    // Allocated: on the shelf, so it comes off what is free.
    line('102', '2', 'A', { leftToShip: 5, allocatedQty: 5, status: 'Ready' }),
    line('103', '1', 'B', { leftToShip: 2, fulfillment: 'BTO', status: 'Non-Inventory' }),
    line('104', '1', 'C', { leftToShip: 3 }),
    line('105', '1', 'D', { leftToShip: 6, needBy: '2026-10-25' }),
    line('106', '1', 'E', { leftToShip: 1, fulfillment: 'Job' }),
    line('106', '9', 'FRTNSW', { leftToShip: 2, fulfillment: 'Other', uom: 'CBM' }),
  ];
  const supply = pegSupply({
    lines,
    inventory: [{ partNum: PartId('A'), onHand: 10 }],
    po: [
      po('A', 3, new Date(2026, 9, 25), { promiseDate: new Date(2026, 9, 27) }),
      po('A', 10, new Date(2026, 9, 22)),
      po('B', 2, null),
    ],
    stockJobs: [{ jobId: 'ASM900', partNum: 'D', qty: 6, expect: new Date(2026, 9, 19, 15), place: 'Assembly' }],
    today,
  });

  it('serves the line due first from free stock, then the earliest PO', () => {
    expect(supply.get('101')![0]).toMatchObject({
      shortQty: 10,
      uncoveredQty: 0,
      readyBy: '2026-10-22',
      pieces: [
        { source: 'stock', qty: 5, date: today },
        { source: 'po', ref: 'PO-A-10', qty: 5, date: '2026-10-22', note: 'Acme' },
      ],
    });
    expect(supply.get('100')![0]).toMatchObject({ readyBy: '2026-10-22', pieces: [{ source: 'po', qty: 4 }] });
  });

  it('counts a PO on the later of its due date and the promise', () => {
    const later = pegSupply({
      lines: [line('200', '1', 'A', { leftToShip: 3 })],
      inventory: [],
      po: [po('A', 3, new Date(2026, 9, 25), { promiseDate: new Date(2026, 9, 27) })],
      today,
    });
    expect(later.get('200')![0].readyBy).toBe('2026-10-27');
  });

  it('counts an overdue release as arriving today', () => {
    const overdue = pegSupply({
      lines: [line('200', '1', 'A', { leftToShip: 3 })],
      inventory: [],
      po: [po('A', 3, new Date(2026, 9, 1))],
      today,
    });
    expect(overdue.get('200')![0].readyBy).toBe(today);
  });

  it('has no date for a PO without one, or for a part nothing covers', () => {
    expect(supply.get('103')![0]).toMatchObject({ uncoveredQty: 0, readyBy: null, pieces: [{ source: 'po', date: null }] });
    expect(supply.get('104')![0]).toMatchObject({ shortQty: 3, uncoveredQty: 3, readyBy: null, pieces: [] });
  });

  it('waits on a stock job on the board', () => {
    expect(supply.get('105')![0]).toMatchObject({
      readyBy: '2026-10-19',
      pieces: [{ source: 'job', ref: 'ASM900', qty: 6, note: 'Assembly' }],
    });
  });

  it('leaves built-to-order, ready and freight lines alone', () => {
    expect(supply.has('106')).toBe(false);
    expect(supply.has('102')).toBe(false);
    expect(needsSupply(line('1', '1', 'A', { leftToShip: 2, allocatedQty: 2 }))).toBe(false);
  });

  it('matches part numbers whatever their case and spacing', () => {
    const s = pegSupply({ lines: [line('300', '1', 'ab 12')], inventory: [{ partNum: PartId('AB12'), onHand: 1 }], po: [], today });
    expect(s.get('300')![0].readyBy).toBe(today);
  });
});

describe('checkSupply', () => {
  const s = pegSupply({
    lines: [line('400', '1', 'A', { leftToShip: 2 }), line('400', '2', 'B', { leftToShip: 1 })],
    inventory: [{ partNum: PartId('A'), onHand: 2 }],
    po: [po('B', 1, new Date(2026, 9, 16))],
    today,
  });

  it('is decided by the last line in', () => {
    expect(checkSupply(s.get('400'), '2026-10-17')).toMatchObject({ verdict: 'ok', readyBy: '2026-10-16' });
    expect(checkSupply(s.get('400'), '2026-10-16')!.verdict).toBe('same-day');
    expect(checkSupply(s.get('400'), '2026-10-15')!.verdict).toBe('late');
  });

  it('is unknown when a line has no supply, and absent when nothing is short', () => {
    const none = pegSupply({ lines: [line('500', '1', 'Z')], inventory: [], po: [], today });
    expect(checkSupply(none.get('500'), '2026-10-30')!.verdict).toBe('unknown');
    expect(checkSupply(undefined, '2026-10-30')).toBeNull();
  });
});
