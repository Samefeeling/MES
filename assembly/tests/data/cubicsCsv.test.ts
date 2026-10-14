/**
 * The cubics sheet and the cube worked out from it.
 *
 * The fixture is the first rows of "Drews Cubics and Freight Calc" in the
 * layout Excel saves it as CSV — unnamed category column, a two-line weight
 * header, section rows, rows without a code — plus a synthetic TEST ITEMS
 * section whose codes match the waybill fixture.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { looksLikeCubics, parseCubicsCsv } from '@/data/csv/cubics.parser';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import { cubicMaster, orderCube, stackedVolume } from '@/engine/dispatch/cube';
import { resolveVolume } from '@/engine/dispatch/plan';
import { cubicKey } from '@/domain/cubics';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const sheet = read('cubics.sample.csv');
const waybill = parseWaybillCsv(read('waybill.sample.csv'));
const parsed = parseCubicsCsv(sheet);
const master = cubicMaster(parsed.items);
const item = (code: string) => master.get(cubicKey(code))!;
const linesOf = (order: string) => waybill.lines.filter((l) => l.order === order);
const orderOf = (id: string) => waybill.orders.find((o) => o.id === id)!;

describe('parseCubicsCsv', () => {
  it('tells the sheet from a waybill by its header', () => {
    expect(looksLikeCubics(sheet)).toBe(true);
    expect(looksLikeCubics(read('waybill.sample.csv'))).toBe(false);
  });

  it('collects every stack size of a part under its code', () => {
    expect(parsed.error).toBeNull();
    expect(parsed.items.map((i) => i.code)).toEqual(['ASOT00000G029', 'BIOT01973', 'CHAIR-A', 'TABLE-B']);
    expect(item('ASOT00000G029').stacks.map((s) => [s.qty, s.volumeM3])).toEqual([
      [1, 0.41],
      [2, 0.68],
      [4, 1.27],
    ]);
  });

  it('reads the section, category and the two-line weight header', () => {
    const astral = item('ASOT00000G029');
    expect(astral.section).toBe('SOFT SEATING');
    expect(astral.category).toBe('SS');
    expect(astral.weightKg).toBe(19.5);
    expect(item('BIOT01973').weightKg).toBeNull();
    expect(item('CHAIR-A').section).toBe('TEST ITEMS');
  });

  it('works the stack volume out from the dimensions when the sheet leaves it blank', () => {
    expect(item('TABLE-B').stacks[0].volumeM3).toBeCloseTo(0.6);
  });

  it('keeps rows without a code out of the master and lists them', () => {
    expect(parsed.withoutCode).toHaveLength(4);
    expect(parsed.withoutCode[0]).toBe('BLOC JNR 1200 OTTOMAN CASTORS');
  });

  it('matches codes regardless of case and spacing', () => {
    expect(master.get(cubicKey(' asot00000g029 '))).toBeDefined();
  });

  it('refuses a file that is not the sheet', () => {
    expect(parseCubicsCsv('Order,Part\n1,A\n').error).toMatch(/Not a cubics sheet/);
  });
});

describe('stackedVolume', () => {
  const astral = () => item('ASOT00000G029').stacks;

  it('packs into the stacks that take least room', () => {
    // Four-high and a single, not two pairs and a single.
    expect(stackedVolume(5, astral())).toBeCloseTo(1.27 + 0.41);
    expect(stackedVolume(8, astral())).toBeCloseTo(2.54);
  });

  it('does not use a bigger stack when smaller ones are less room', () => {
    expect(stackedVolume(3, astral())).toBeCloseTo(0.68 + 0.41);
  });

  it('handles large quantities without searching every unit', () => {
    expect(stackedVolume(10_001, item('CHAIR-A').stacks)).toBeCloseTo(1000.25);
  });

  it('is zero for nothing to ship', () => {
    expect(stackedVolume(0, astral())).toBe(0);
  });
});

describe('orderCube', () => {
  it('sizes an order whose goods lines are all in the sheet', () => {
    const cube = orderCube(linesOf('90001'), master)!;
    expect(cube.matchedLines).toBe(1);
    expect(cube.goodsLines).toBe(1);
    expect(cube.volumeM3).toBeCloseTo(4); // 40 chairs, four stacks of ten
    expect(cube.weightKg).toBe(240);
  });

  it('lists the parts the sheet does not cover', () => {
    const cube = orderCube(linesOf('90003'), master)!;
    expect(cube.matchedLines).toBe(0);
    expect(cube.unmatched).toEqual([{ part: 'SOFA-C', qty: 5 }]);
  });

  it('is null for an order with only freight lines', () => {
    expect(orderCube(linesOf('90011'), master)).toBeNull();
  });
});

describe('resolveVolume', () => {
  const withCube = (id: string) => ({ ...orderOf(id), cube: orderCube(linesOf(id), master) });

  it('prefers the cubics sheet when it covers the order', () => {
    const v = resolveVolume(withCube('90001'), undefined, 'cubics');
    expect(v).toMatchObject({ source: 'cubics', known: true, weightKg: 240 });
    expect(v.volume).toBeCloseTo(4);
  });

  it('uses the freight line when that is preferred', () => {
    expect(resolveVolume(withCube('90001'), undefined, 'freight')).toMatchObject({ volume: 10, source: 'freight' });
  });

  it('falls back to freight when the sheet does not cover the order', () => {
    expect(resolveVolume(withCube('90003'), undefined, 'cubics')).toMatchObject({ volume: 5, source: 'freight' });
  });

  it('sizes an order with no freight line from the sheet', () => {
    const v = resolveVolume(withCube('90009'), undefined, 'cubics');
    expect(v.source).toBe('cubics');
    expect(v.volume).toBeCloseTo(1);
  });

  it('lets an entered volume win', () => {
    expect(resolveVolume(withCube('90001'), 7, 'cubics')).toMatchObject({ volume: 7, source: 'entered' });
  });
});

describe('planning with the cubics sheet', () => {
  it('loads trucks by the stacked cube and carries the weight', async () => {
    const { planDispatch } = await import('@/engine/dispatch/plan');
    const { DEFAULT_DISPATCH_SETTINGS, EMPTY_DECISIONS } = await import('@/domain/dispatch');
    const sized = waybill.orders.map((o) => ({ ...o, cube: orderCube(linesOf(o.id), master) }));
    const plan = planDispatch(sized, DEFAULT_DISPATCH_SETTINGS, EMPTY_DECISIONS, '2026-10-08');
    const liverpool = plan.loads.find((l) => l.drops.some((d) => d.orderId === '90001'))!;
    // 40 chairs (4.0) + 12 tables (7.2) + 4 chairs (1.0), all from the sheet.
    expect(liverpool.volumeM3).toBeCloseTo(12.2);
    expect(liverpool.drops.every((d) => d.volumeSource === 'cubics')).toBe(true);
    expect(liverpool.weightKg).toBe(240 + 240 + 24);
    expect(liverpool.weightComplete).toBe(true);
  });
});
