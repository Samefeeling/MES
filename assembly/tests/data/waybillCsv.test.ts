/**
 * The waybill adapter: lines rolled up into orders, volume from the freight
 * line, readiness from the goods lines. The fixture is synthetic, in the
 * export's exact column layout.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { columnLetter, parseAuDate, parsePackedCube, parseWaybillCsv } from '@/data/csv/waybill.parser';

const sample = readFileSync(
  fileURLToPath(new URL('../fixtures/waybill.sample.csv', import.meta.url)),
  'utf8',
);

const parsed = parseWaybillCsv(sample);
const order = (id: string) => parsed.orders.find((o) => o.id === id)!;

describe('parseAuDate', () => {
  it('reads Australian day-first dates', () => {
    expect(parseAuDate('5/02/2027')).toBe('2027-02-05');
    expect(parseAuDate('14/10/2026')).toBe('2026-10-14');
  });

  it('rejects impossible dates and blanks', () => {
    expect(parseAuDate('31/02/2026')).toBeNull();
    expect(parseAuDate('')).toBeNull();
    expect(parseAuDate('next week')).toBeNull();
  });
});

describe('parseWaybillCsv', () => {
  it('rolls lines up into one order each', () => {
    expect(parsed.error).toBeNull();
    expect(parsed.lines).toHaveLength(23);
    expect(parsed.orders).toHaveLength(12);
  });

  it('takes the volume from the freight CBM line and ignores the FRT911 charge', () => {
    expect(order('90001').volumeM3).toBe(10);
    expect(order('90001').value).toBeCloseTo(8918.75);
  });

  it('keeps the source values: zone, city, ship via, dates', () => {
    const o = order('90006');
    expect(o.zone).toBe('QLD- Metro');
    expect(o.shipVia).toBe('AQMC');
    expect(o.shipBy).toBe('2026-10-16');
    expect(o.needBy).toBe('2026-10-16');
    expect(o.expDelivery).toBe('2026-10-30');
  });

  it('reads readiness from the goods lines only', () => {
    expect(order('90001').readiness).toBe('ready');
    expect(order('90001').inPicking).toBe(true);
    expect(order('90003').readiness).toBe('not-ready');
    expect(order('90009').readiness).toBe('partial');
    expect(order('90011').readiness).toBe('no-goods');
  });

  it('flags an order with no freight line as unknown volume', () => {
    expect(order('90009').volumeM3).toBeNull();
    expect(order('90009').notes.join()).toMatch(/volume unknown/);
  });

  it('does not double a consignment priced on two freight lines', () => {
    expect(order('90011').volumeM3).toBe(2.2);
    expect(order('90011').notes.join()).toMatch(/largest used/);
  });

  it('reads the credit hold', () => {
    expect(order('90008').creditHold).toBe(true);
    expect(order('90001').creditHold).toBe(false);
  });

  it('reports the columns it read, by spreadsheet letter', () => {
    expect(parsed.columns.zone).toEqual({ header: 'Description', column: 'F' });
    expect(parsed.columns.city).toEqual({ header: 'City', column: 'V' });
    expect(parsed.columns.pickListComment).toBeUndefined();
  });

  it('refuses a file that is not a waybill', () => {
    const result = parseWaybillCsv('JobNum,PartNum\nA,B\n');
    expect(result.error).toMatch(/Not a waybill export/);
    expect(result.orders).toHaveLength(0);
  });
});

/** The fuller export: pick-list comment, ship-to name, a second Description and City. */
const FULL = [
  'InPicking,PickListComment,Cust. ID,On Hold,CreditHold,ShipToCustName,Ship Via,Part,Description,Description,Order,Line,Rel,UOM,LeftToShip,AllocatedQty,FulfillmentMethod,Status,ExpDeliveryDt,Ship By,Need By,City,ShipToAddress1,ShipToState,ShipToZip,City',
  'FALSE,2C,ACME01,FALSE,FALSE,Acme Fitout Pty Ltd,ANMS,CHAIR-A,Task chair,NSW-Metro-South,70001,1,1,EA,10,10,Stock,Ready,23/10/2026,12/10/2026,20/10/2026,Sydney,1 Hume Hwy,NSW,2170,Liverpool',
  'FALSE,2C,ACME01,FALSE,FALSE,Acme Fitout Pty Ltd,ANMS,FRTNSW,Freight,NSW-Metro-South,70001,2,1,CBM,3,3,Other,Non-Inventory,23/10/2026,12/10/2026,20/10/2026,Sydney,1 Hume Hwy,NSW,2170,Liverpool',
  'FALSE,,BETA01,FALSE,FALSE,Beta School,AQMC,DESK-B,Desk,QLD- Metro,70002,1,1,EA,4,0,Job,,,,30/10/2026,Brisbane,,QLD,4000,Brisbane',
].join('\n');

describe('the fuller waybill export', () => {
  const full = parseWaybillCsv(FULL);
  const o = (id: string) => full.orders.find((x) => x.id === id)!;

  it('reads the pick-list comment as packed cube and keeps the text', () => {
    expect(o('70001').pickListComment).toBe('2C');
    expect(o('70001').packedM3).toBe(2);
    expect(o('70002').packedM3).toBeNull();
  });

  it('reads the ship-to name and address', () => {
    expect(o('70001').shipToName).toBe('Acme Fitout Pty Ltd');
    expect(o('70001').address).toBe('1 Hume Hwy');
    expect(o('70001').state).toBe('NSW');
    expect(o('70001').postcode).toBe('2170');
  });

  it('takes the Description that holds delivery zones and the last City', () => {
    expect(o('70001').zone).toBe('NSW-Metro-South');
    expect(o('70001').city).toBe('Liverpool');
    expect(full.columns.zone?.column).toBe('J');
    expect(full.columns.city?.column).toBe('Z');
    expect(full.warnings.join()).toMatch(/delivery zone read from column J/);
  });

  it('keeps Need By and ExpDeliveryDt apart', () => {
    expect(o('70001').needBy).toBe('2026-10-20');
    expect(o('70001').expDelivery).toBe('2026-10-23');
    expect(o('70002').shipBy).toBeNull();
    expect(o('70002').needBy).toBe('2026-10-30');
  });
});

describe('parsePackedCube', () => {
  it('reads cube written the ways the dock writes it', () => {
    expect(parsePackedCube('2C')).toBe(2);
    expect(parsePackedCube('1.5 c')).toBe(1.5);
    expect(parsePackedCube('3CBM')).toBe(3);
    expect(parsePackedCube('0.8 m3')).toBe(0.8);
    expect(parsePackedCube('1C + 0.5C')).toBe(1.5);
    expect(parsePackedCube('Packed 4C, 2 pallets')).toBe(4);
  });

  it('does not mistake counts of things for cube', () => {
    expect(parsePackedCube('2 cartons')).toBeNull();
    expect(parsePackedCube('3 chairs')).toBeNull();
    expect(parsePackedCube('')).toBeNull();
    expect(parsePackedCube('call before delivery')).toBeNull();
  });
});

describe('columnLetter', () => {
  it('counts like a spreadsheet', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(22)).toBe('W');
  });
});
