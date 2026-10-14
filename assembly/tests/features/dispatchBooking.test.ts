/**
 * The booking sheet CSV: one row per order, the load repeated on each, and
 * the fields a carrier asks for — ship-to, address, zone, pick-list comment,
 * m³, Need By and the customer's delivery date.
 */

import { describe, it, expect } from 'vitest';
import { parseCsv } from '@/lib/csv';
import type { ShipmentOrder } from '@/domain/dispatch';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import { bookingCsv, contractorOf, fullAddress, loadStatus, shipToNames } from '@/features/dispatch/booking';

const order = (id: string, patch: Partial<ShipmentOrder> = {}): ShipmentOrder => ({
  id,
  custId: `C${id}`,
  shipToName: `Site ${id}, "North"`,
  address: '1 Hume Hwy',
  state: 'NSW',
  postcode: '2170',
  shipVia: 'ANMS',
  zone: 'NSW-Metro-South',
  city: 'Liverpool',
  shipBy: '2026-10-09',
  needBy: '2026-10-12',
  expDelivery: '2026-10-13',
  pickListComment: '2C',
  packedM3: 2,
  volumeM3: 3,
  value: 0,
  goodsValue: 0,
  freightValue: 0,
  lineCount: 1,
  goodsLines: 1,
  readyLines: 1,
  readiness: 'ready',
  inPicking: true,
  onHold: false,
  creditHold: false,
  notes: [],
  ...patch,
});

const load: PlannedLoad = {
  id: 'x',
  group: 'fleet:metro',
  mode: 'fleet',
  label: 'Sydney metro',
  day: '2026-10-12',
  equipment: 'Rigid 8-pallet',
  capacityM3: 30,
  drops: ['1', '2'].map((id) => ({
    orderId: id,
    order: order(id),
    volumeM3: 2,
    volumeKnown: true,
    volumeSource: 'packed' as const,
    weightKg: null,
    piece: null,
    share: 1,
    daysEarly: 0,
  })),
  volumeM3: 4,
  fill: 4 / 30,
  weightKg: 0,
  weightComplete: false,
  firm: 'edited',
  warnings: [],
};

describe('bookingCsv', () => {
  const rows = parseCsv(bookingCsv([load], 'needBy', new Map([['x', 3]])));
  const header = rows[0];
  const col = (name: string) => rows[1][header.indexOf(name)];

  it('writes one row per order after the header', () => {
    expect(rows.filter((r) => r.some(Boolean))).toHaveLength(3);
  });

  it('carries what a carrier asks for, quoting where needed', () => {
    expect(col('Load')).toBe('L3');
    expect(col('Book')).toBe('Rigid 8-pallet');
    expect(col('ShipToCustName')).toBe('Site 1, "North"');
    expect(col('PickListComment')).toBe('2C');
    expect(col('m3')).toBe('2');
    expect(col('Need By')).toBe('12/10/2026');
    expect(col('ExpDeliveryDt')).toBe('13/10/2026');
    expect(col('Status')).toBe('Edited');
    expect(col('Description')).toBe('NSW-Metro-South');
    expect(col('Contractor')).toBe('');
  });

  it('names the contractor booked for the Ship Via', () => {
    const named = parseCsv(bookingCsv([load], 'needBy', undefined, { ANMS: 'Metro Freight' }));
    expect(named[1][named[0].indexOf('Contractor')]).toBe('Metro Freight');
  });
});

describe('sheet helpers', () => {
  it('names each ship-to once and writes the address on one line', () => {
    expect(shipToNames(load)).toEqual(['Site 1, "North"', 'Site 2, "North"']);
    expect(fullAddress(order('1'))).toBe('1 Hume Hwy, Liverpool NSW 2170');
    expect(loadStatus({ ...load, firm: null })).toBe('Proposed');
    expect(contractorOf(load, { ANMS: ' Metro Freight ', AQMC: 'Other' })).toBe('Metro Freight');
    expect(contractorOf(load, {})).toBe('');
  });
});
