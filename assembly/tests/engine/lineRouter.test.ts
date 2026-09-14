/**
 * Which of the three sources gets to decide a line, and in what order.
 *
 * The order is the whole point: `product-lines.v3.json` carries a human
 * review, and a review that the live rules quietly overrule every load is not
 * a review.
 */

import { describe, it, expect } from 'vitest';
import { makeLineRouter } from '@/engine/assembly/lineRouter';
import { parseProductLines, EMPTY_PRODUCT_LINES } from '@/domain/productLines';
import { JobId, PartId } from '@/domain/ids';
import type { JobMaterialLink } from '@/domain/types';

const link = (
  jobNum: string,
  parent: string,
  child: string,
  childDescription = '',
  uom = 'EA',
  requiredQty: number | null = 2,
): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId(parent),
  childPart: PartId(child),
  requiredQty,
  childDescription,
  uom,
});

const TABLE_JSON = JSON.stringify({
  generatedAt: '2026-09-01T00:00:00.000Z',
  rowCount: 4,
  rows: [
    { code: 'PDSC00747U', description: 'Podium seat pad', line: 'UPL-Gluing', key: 'UPH', confidence: 'high', evidence: ['R3 foam 1'] },
    { code: 'CS0900', description: 'Cut Fab Storm', line: 'UPL-CUT', key: 'CUT', confidence: 'high', evidence: [] },
    { code: 'CP-SOFA', description: 'placeholder', line: 'EXCLUDE — 配置器占位件', key: 'EXCLUDE', confidence: 'high', evidence: [] },
    { code: 'HUH', description: 'nobody knows', line: 'UNKNOWN — 需人工判定', key: 'UNKNOWN', confidence: 'none', evidence: [] },
  ],
});

describe('parseProductLines', () => {
  it('reads the file the classifier writes, both column spellings', () => {
    const t = parseProductLines(TABLE_JSON);
    expect(t.errors).toEqual([]);
    expect(t.generatedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(t.byCode.get('PDSC00747U')?.line).toBe('UPL_GLUING');
    expect(t.byCode.get('CS0900')?.line).toBe('UPL_CUT_SEW');
    expect(t.excluded.has('CP-SOFA')).toBe(true);
    // UNKNOWN is not a line; the part falls through to the live rules.
    expect(t.byCode.has('HUH')).toBe(false);
  });

  it('never throws on a bad file — the board still has to load', () => {
    expect(parseProductLines('not json').errors[0]).toMatch(/not valid JSON/);
    expect(parseProductLines('{"rows":"nope"}').errors[0]).toMatch(/no "rows" array/);
    expect(parseProductLines('[]').errors[0]).toMatch(/no usable rows/);
  });

  it('names the rows whose line this board does not run', () => {
    const t = parseProductLines(JSON.stringify({ rows: [
      { code: 'A', line: 'UPL-CUT' },
      { code: 'B', line: 'Laser Cutting' },
    ] }));
    expect(t.byCode.get('A')?.line).toBe('UPL_CUT_SEW');
    expect(t.errors[0]).toMatch(/1 row name(s)? a line this board does not run/);
  });
});

describe('makeLineRouter', () => {
  it('lets ERP name TBP, PMD, Table and General outright', () => {
    const r = makeLineRouter(parseProductLines(TABLE_JSON), []);
    expect(r.place('CS0900', 'TBP', '').line).toBe('TBP');
    expect(r.place('CS0900', 'PMD', '').line).toBe('PMD');
    expect(r.place('CS0900', 'Table', '').line).toBe('TABLE');
    expect(r.place('CS0900', 'FACTORY_GENERAL', '').line).toBe('FACTORY_GENERAL');
    expect(r.place('CS0900', 'TBP', '').source).toBe('erp');
  });

  it('uses the reviewed table when ERP only named a department', () => {
    const r = makeLineRouter(parseProductLines(TABLE_JSON), []);
    const p = r.place('PDSC00747U', 'UPL', '');
    expect(p.line).toBe('UPL_GLUING');
    expect(p.source).toBe('table');
  });

  it('does not re-derive a reviewed part from its BOM', () => {
    // The BOM alone would call this one cutting (all cloth by the metre); the
    // reviewed file says Gluing, and the review wins.
    const links = [link('J1', 'PDSC00747U', 'FB1', 'Think Plus Charcoal', 'm')];
    const r = makeLineRouter(parseProductLines(TABLE_JSON), links);
    expect(r.place('PDSC00747U', 'UPL', '').line).toBe('UPL_GLUING');
    expect(r.place('PDSC00747U', 'UPL', '').source).toBe('table');
  });

  it('classifies a part the table has never seen, from JobMaterialReq', () => {
    const links = [
      link('J9', 'NEW-PAD', 'FM0031', 'Foam: 25mm chip'),
      link('J9', 'NEW-PAD', 'SB0100', 'Screw M6'),
    ];
    const p = makeLineRouter(parseProductLines(TABLE_JSON), links).place('NEW-PAD', 'ASSY', '');
    expect(p.line).toBe('UPL_GLUING');
    expect(p.source).toBe('bom');
    expect(p.evidence.join(' ')).toMatch(/foam line/);
  });

  it('knows a component is a sub-assembly because another order builds it', () => {
    const links = [
      link('J1', 'SHELL', 'PM1042', 'Polypropylene copolymer', 'kg'),
      link('J2', 'CHAIR', 'SHELL', 'Ned Stool shell'),
      link('J2', 'CHAIR', 'SB0100', 'Screw M6'),
    ];
    const r = makeLineRouter(EMPTY_PRODUCT_LINES, links);
    expect(r.place('SHELL', 'ASSY', '').line).toBe('PMD');
    expect(r.place('CHAIR', 'ASSY', '').line).toBe('ASSY');
    expect(r.place('CHAIR', 'ASSY', '').evidence.join(' ')).toMatch(/finished sub-assembly/);
  });

  it('follows the BOM up to the finished product for the SSS rule', () => {
    const links = [
      link('J1', 'PAD', 'FM0031', 'Foam: 25mm chip'),
      link('J2', 'SSOT-600', 'PAD', 'Ottoman pad'),
    ];
    const r = makeLineRouter(EMPTY_PRODUCT_LINES, links);
    expect(r.place('PAD', 'UPL', '').line).toBe('UPL_SOFTIE');
  });

  it('survives a BOM that loops back on itself', () => {
    const links = [link('J1', 'A', 'B'), link('J2', 'B', 'A')];
    expect(() => makeLineRouter(EMPTY_PRODUCT_LINES, links).place('A', 'UPL', '')).not.toThrow();
  });

  it('places nothing when it knows nothing, rather than guessing', () => {
    const p = makeLineRouter(EMPTY_PRODUCT_LINES, []).place('MYSTERY', 'UPL', '');
    expect(p.line).toBeNull();
    expect(p.source).toBe('none');
  });

  it('reports a placeholder as excluded rather than as a line', () => {
    const p = makeLineRouter(parseProductLines(TABLE_JSON), []).place('CP-SOFA', 'ASSY', '');
    expect(p.line).toBeNull();
    expect(p.excluded).toBe(true);
  });

  it('takes the fullest BOM when a part is built by more than one order', () => {
    const links = [
      link('TOPUP', 'PAD', 'SB0100', 'Screw M6'),
      link('FULL', 'PAD', 'FM0031', 'Foam: 25mm chip'),
      link('FULL', 'PAD', 'SB0100', 'Screw M6'),
    ];
    expect(makeLineRouter(EMPTY_PRODUCT_LINES, links).place('PAD', 'UPL', '').line).toBe('UPL_GLUING');
  });
});
