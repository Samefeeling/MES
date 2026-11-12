import { describe, expect, it } from 'vitest';
import { crewOf, crewSize, firstName, namesForSheet, operatorsOf, sheetPeople } from '../src/core/crew';
import { operatorByTuple } from '../src/core/operator-perf';
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

describe('a sheet confirmed under the names of the shift before', () => {
  // Hot-stamp press, 12 Nov 2026. The Day sheet names John Taylor and Tin
  // Maung. The Afternoon sheet was confirmed without re-picking, so it names
  // them too — and every Quality Check on it is signed by Ben Wood.
  const sheet = (shiftId: string, signer: string, timeline: string): ReturnType<typeof rec>[] =>
    [...timeline].map((statusCode, slotIndex) =>
      rec({
        machineCode: 'HStamp', shiftId, jobNumber: 'SFM508005', slotIndex,
        statusCode: statusCode as 'R' | 'M',
        operator: slotIndex === 0 ? 'John Taylor' : '',
        supervisor: slotIndex === 0 ? 'Tin Maung' : '',
        qcBy: statusCode === 'R' ? signer : '',
        locked: true, lockedBy: 'Jean-Michel Thomas',
      }));
  const day = sheet('2026-11-12-Day', 'John Taylor', 'MMMMMMMMMMMRRRMR');
  const afternoon = sheet('2026-11-12-Afternoon', 'Ben Wood', 'RRRRRRMRRRRRRMRR');

  it('goes by who signed the operator checks when the named operator signed none', () => {
    expect(sheetPeople(afternoon)).toMatchObject({ operators: ['Ben Wood'], leftover: true });
    expect(operatorsOf(afternoon)).toEqual(['Ben Wood']);
    expect([...operatorByTuple(afternoon).values()]).toEqual(['Ben Wood']);
  });

  it('keeps the named crew where the operator signed his own checks', () => {
    expect(sheetPeople(day)).toMatchObject({ operators: ['John Taylor'], leftover: false });
  });

  it('leaves the supervisors alone: somebody on overtime is rightly in both shifts', () => {
    // Tin Maung stayed on into the Afternoon. Nothing on the sheet says
    // otherwise, so he is counted there with whoever signed it off.
    expect(crewOf(afternoon)).toEqual({
      operators: ['Ben Wood'],
      supervisors: ['Jean-Michel Thomas', 'Tin Maung'],
    });
    expect(crewOf(day).supervisors).toEqual(['Jean-Michel Thomas', 'Tin Maung']);
  });

  it('keeps the named operator when nobody signed, or when he signed some of them', () => {
    const unsigned = afternoon.map((r) => ({ ...r, qcBy: '' }));
    expect(sheetPeople(unsigned).operators).toEqual(['John Taylor']);
    const shared = afternoon.map((r) => ({ ...r, qcBy: r.slotIndex === 2 ? 'John Taylor' : r.qcBy }));
    expect(sheetPeople(shared)).toMatchObject({ operators: ['John Taylor'], leftover: false });
  });

  it('the supervisor\'s own check slots say nothing about the operator', () => {
    // Only half-hours 1, 7 and 13 signed, by the supervisor: no contradiction.
    const supOnly = afternoon.map((r) => ({ ...r, qcBy: [1, 7].includes(r.slotIndex) ? 'Jean-Michel Thomas' : '' }));
    expect(sheetPeople(supOnly)).toMatchObject({ operators: ['John Taylor'], leftover: false });
  });
});

describe('the names a sheet opens with', () => {
  const picked = { operator: 'John Taylor', supervisor: 'Tin Maung' };

  it('a new shift starts with nobody named', () => {
    expect(namesForSheet({
      here: 'HStamp|2026-11-12-Afternoon', pickedFor: 'HStamp|2026-11-12-Day', unconfirmed: true, picked,
    })).toEqual({ operator: '', supervisor: '' });
  });

  it('another press starts with nobody named', () => {
    expect(namesForSheet({
      here: '1600T|2026-11-12-Day', pickedFor: 'HStamp|2026-11-12-Day', unconfirmed: true, picked,
    })).toEqual({ operator: '', supervisor: '' });
  });

  it('the next order on the same press in the same shift keeps the crew', () => {
    expect(namesForSheet({
      here: 'HStamp|2026-11-12-Day', pickedFor: 'HStamp|2026-11-12-Day', unconfirmed: true, picked,
    })).toEqual(picked);
  });

  it('a sheet with names recorded shows those', () => {
    expect(namesForSheet({
      here: 'HStamp|2026-11-12-Day', pickedFor: 'HStamp|2026-11-12-Day', unconfirmed: false, picked,
      recorded: { operator: 'Ben Wood', supervisor: 'Jean-Michel Thomas' },
    })).toEqual({ operator: 'Ben Wood', supervisor: 'Jean-Michel Thomas' });
  });
});

