import { describe, expect, it } from 'vitest';
import { crewOf, crewSize, firstName, operatorsOf } from '../src/core/crew';
import { rec as base } from './helpers';
import type { ProductionRecord } from '../src/types';

const rec = (over: Partial<ProductionRecord>): ProductionRecord =>
  base({ jobNumber: 'A', slotIndex: 0, statusCode: 'R', ...over });

describe('who was on shift', () => {
  it('shows a first name', () => {
    expect(firstName('  Maria  De Souza ')).toBe('Maria');
    expect(firstName('Tom')).toBe('Tom');
    expect(firstName('')).toBe('');
  });

  it('names each operator once, however their name is spaced or cased', () => {
    const records = [
      rec({ operator: 'Maria De Souza' }),
      rec({ operator: 'maria  de souza', slotIndex: 1 }),
      rec({ operator: 'Tom Lee', jobNumber: 'B' }),
      rec({ operator: '', slotIndex: 2 }),
    ];
    expect(operatorsOf(records)).toEqual(['Maria De Souza', 'Tom Lee']);
  });

  it('counts the supervisors who signed with the shift, once each', () => {
    const records = [
      rec({ operator: 'Maria De Souza', supervisor: 'Sam Ward', lockedBy: 'Sam Ward' }),
      rec({ operator: 'Tom Lee', supervisor: '', lockedBy: 'Pat Hill', jobNumber: 'B' }),
    ];
    const crew = crewOf(records);
    expect(crew.operators).toEqual(['Maria De Souza', 'Tom Lee']);
    expect(crew.supervisors).toEqual(['Pat Hill', 'Sam Ward']);
    expect(crewSize(crew)).toBe(4);
  });

  it('a supervisor who also ran a press is one person', () => {
    const crew = crewOf([
      rec({ operator: 'Sam Ward', lockedBy: 'Sam Ward' }),
      rec({ operator: 'Tom Lee', lockedBy: 'Sam Ward', jobNumber: 'B' }),
    ]);
    expect(crew.operators).toEqual(['Sam Ward', 'Tom Lee']);
    expect(crew.supervisors).toEqual([]);
    expect(crewSize(crew)).toBe(2);
  });
});
