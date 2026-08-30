import { describe, it, expect } from 'vitest';
import {
  BD_CATEGORIES,
  BD_TAXONOMY,
  bdAsBdCodes,
  bdCategoryOf,
  bdCausesFor,
  breakdownDetailFor,
  bdLabelFor,
  decodeBreakdownCauseMap,
  encodeBreakdownCauseMap,
} from '../src/core/breakdown';
import { rec } from './helpers';

describe('breakdown taxonomy (breakdown_classification_taxonomy.md)', () => {
  it('exposes exactly 11 categories', () => {
    expect(BD_CATEGORIES).toHaveLength(11);
    expect(BD_CATEGORIES.map((c) => c.prefix)).toEqual([
      'ELE',
      'MEC',
      'HYD',
      'HEA',
      'CTL',
      'TOOL',
      'SAF',
      'AUX',
      'UTL',
      'MAT',
      'OTH',
    ]);
  });

  it('each cause belongs to a known category', () => {
    for (const c of BD_TAXONOMY) {
      const cat = bdCategoryOf(c.code);
      expect(cat, `no category for ${c.code}`).toBeTruthy();
    }
  });

  it('category sizes match the MD (9/11/10/8/8/10/9/9/7/6/4 = 91)', () => {
    const sizes = BD_CATEGORIES.map((c) => bdCausesFor(c.prefix).length);
    expect(sizes).toEqual([9, 11, 10, 8, 8, 10, 9, 9, 7, 6, 4]);
    expect(BD_TAXONOMY).toHaveLength(91);
  });

  it('keeps the OTH-99 free-text escape hatch', () => {
    expect(BD_TAXONOMY.some((c) => c.code === 'OTH-99')).toBe(true);
  });

  it('bdLabelFor resolves a known code', () => {
    expect(bdLabelFor('HYD-04')).toMatch(/pressure/i);
    expect(bdLabelFor('NOPE-99')).toBe('NOPE-99'); // unknown → echo
  });

  it('bdAsBdCodes carries subCategory + owner for Power BI Pareto', () => {
    const all = bdAsBdCodes();
    const ele = all.find((b) => b.code === 'ELE-02')!;
    expect(ele.subCategory).toBe('Electrical');
    expect(ele.owner).toBe('Maintenance');
  });

  it('uses PMD_BreakdownMaster Cause as the authoritative display text', () => {
    const master = new Map([
      [
        'MEC-11',
        {
          code: 'MEC-11',
          label: 'Cause supplied by SharePoint master',
          subCategory: 'Mechanical master',
          sequence: 1,
          owner: 'Maintenance master',
        },
      ],
    ]);
    expect(breakdownDetailFor(' mec-11 ', master)).toEqual({
      code: 'MEC-11',
      cause: 'Cause supplied by SharePoint master',
      category: 'Mechanical master',
      owner: 'Maintenance master',
    });
  });

  it('round-trips different causes by half-hour slot', () => {
    const encoded = encodeBreakdownCauseMap([
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'B', bdIssue: 'MEC-11', bdCause: 'Master cause' }),
      rec({ jobNumber: 'J1', slotIndex: 7, statusCode: 'B', bdIssue: 'OTH-99', bdCause: 'I model leaking' }),
    ]);
    expect(JSON.parse(encoded)).toEqual({
      3: 'MEC-11 — Master cause',
      7: 'OTH-99 — I model leaking',
    });
    expect(decodeBreakdownCauseMap(encoded)).toEqual([
      { slotIndex: 3, code: 'MEC-11', cause: 'Master cause' },
      { slotIndex: 7, code: 'OTH-99', cause: 'I model leaking' },
    ]);
  });

  it('applies a legacy plain BDCause to every B in the timeline', () => {
    expect(decodeBreakdownCauseMap('Hydraulic leak', 'HYD-01', 'RBBR')).toEqual([
      { slotIndex: 1, code: 'HYD-01', cause: 'Hydraulic leak' },
      { slotIndex: 2, code: 'HYD-01', cause: 'Hydraulic leak' },
    ]);
  });
});
