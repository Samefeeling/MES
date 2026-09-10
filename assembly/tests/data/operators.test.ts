/**
 * The `ASSY_Operator` roster adapter.
 *
 * The rows below are shaped the way Graph returns list items: a `fields` object
 * keyed by internal column name, where a multi-choice column is an array and a
 * text column is one delimited string.
 */

import { describe, it, expect } from 'vitest';
import { parseOperators } from '@/data/sharepoint/operator.parser';

const roster = [
  { id: '1', Operator: 'Aroha T.', Position: 'Sewer', Skills: 'Cutting/Sewing', Supervisor: 'Mei' },
  { id: '2', Operator: 'Ben K.', Position: 'Upholsterer', Skills: ['Upholstery', 'Final Assembly'], Supervisor: 'Mei' },
  { id: '3', Operator: 'Chen W.', Position: 'Assembler', Skills: 'ASSY; TABLE', Supervisor: 'Raj' },
];

describe('parseOperators', () => {
  const { values, errors } = parseOperators(roster);

  it('reads one worker per row', () => {
    expect(values.map((w) => w.name)).toEqual(['Aroha T.', 'Ben K.', 'Chen W.']);
    expect(errors).toEqual([]);
  });

  it('keys people by list item id so a rename keeps their allocations', () => {
    expect(values.map((w) => String(w.id))).toEqual(['1', '2', '3']);
  });

  it('maps written-out skills onto lines', () => {
    // "Cutting/Sewing" is its own line now that UPL is three benches, so a
    // sewer is rostered onto UPL-CUT rather than onto all of upholstery.
    expect(values[0].skills).toEqual(['UPL_CUT_SEW']);
    expect(values[1].skills).toEqual(['UPL_GLUING', 'ASSY']);
  });

  it('splits a delimited skills string', () => {
    expect(values[2].skills).toEqual(['ASSY', 'TABLE']);
  });

  it('carries position and supervisor through', () => {
    expect(values[0].position).toBe('Sewer');
    expect(values[0].supervisor).toBe('Mei');
  });

  it('puts everyone on shift — attendance is not in the list', () => {
    expect(values.every((w) => w.onShift)).toBe(true);
  });

  it('honours an OnShift column if the list grows one', () => {
    const { values: v } = parseOperators([
      { id: '9', Operator: 'Away D.', Skills: 'ASSY', OnShift: 'No' },
    ]);
    expect(v[0].onShift).toBe(false);
  });

  it('reads planned annual leave for future load-rate capacity', () => {
    const { values: v } = parseOperators([
      {
        id: '10',
        Operator: 'Leave P.',
        Skills: 'ASSY',
        PlannedAnnualLeave: '2026-09-14; 2026-09-15',
      },
    ]);
    expect(v[0].plannedLeave).toEqual(['2026-09-14', '2026-09-15']);
  });

  it('matches columns however they are cased or spaced', () => {
    const { values: v } = parseOperators([
      { id: '4', Title: 'Legacy Row', skills: 'upl', 'Team Leader': 'Mei' },
    ]);
    expect(v[0].name).toBe('Legacy Row');
    expect(v[0].skills).toEqual(['UPL_GLUING']);
    expect(v[0].supervisor).toBe('Mei');
  });

  it('flags anyone whose skills nobody recognises', () => {
    const { values: v, errors: e } = parseOperators([
      { id: '5', Operator: 'Unskilled P.', Skills: 'Forklift' },
    ]);
    expect(v[0].skills).toEqual([]);
    expect(e[0]).toContain('Unskilled P.');
  });

  it('ignores blank rows', () => {
    expect(parseOperators([{ id: '6', Operator: '' }]).values).toHaveLength(0);
  });
});

it('keeps former line labels on their intended benches', () => {
  const labels = ['UPL - Cut/Sewing', 'UPL - Gluing', 'UPL - Softie (SSS)', 'ASSY - Stool', 'ASSY - Seats', 'Table', 'Factory General'];
  const { values, errors } = parseOperators(labels.map((Skills, index) => ({ id: String(index), PreferName: 'Worker ' + index, Skills })));
  expect(errors).toEqual([]);
  expect(values.map(worker => worker.skills)).toEqual([['UPL_CUT_SEW'], ['UPL_GLUING'], ['UPL_SOFTIE'], ['ASSY'], ['ASSY'], ['TABLE'], ['FACTORY_GENERAL']]);
});
