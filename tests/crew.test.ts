import { describe, expect, it } from 'vitest';
import {
  crewOf, crewSize, firstName, floorStaffing, namesForSheet, onOvertime, operatorsOf, operatorsRunningByShift,
  rosterOf, sheetPeople, shiftStaffing,
} from '../src/core/crew';
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

  it('keeps the named operator when nobody signed', () => {
    const unsigned = afternoon.map((r) => ({ ...r, qcBy: '' }));
    expect(sheetPeople(unsigned).operators).toEqual(['John Taylor']);
  });

  it('somebody covering a break is an operator of the sheet too, after the named one', () => {
    // John Taylor ran the press and signed most checks; Ben Wood signed two
    // while he was on his break, and Ann Lee one.
    const cover = (slot: number): string => (slot === 4 || slot === 5 ? 'Ben Wood' : slot === 9 ? 'Ann Lee' : 'John Taylor');
    const shared = afternoon.map((r) => ({ ...r, qcBy: r.qcBy ? cover(r.slotIndex) : '' }));
    expect(sheetPeople(shared)).toMatchObject({ operators: ['John Taylor', 'Ben Wood', 'Ann Lee'], leftover: false });
    expect(operatorsOf(shared)).toEqual(['Ann Lee', 'Ben Wood', 'John Taylor']);
    // The sheet's output is still the named operator's.
    expect([...operatorByTuple(shared).values()]).toEqual(['John Taylor']);
  });

  it('counts a person once in a total, on however many presses they signed', () => {
    // Ben Wood runs the hot-stamp press and covers a break on 550T.
    const other = sheet('2026-11-12-Afternoon', 'Ann Lee', 'RRRRRRRRRRRRRRRR').map((r) => ({
      ...r, machineCode: '550T', jobNumber: 'SFM500001',
      operator: r.slotIndex === 0 ? 'Ann Lee' : '',
      qcBy: r.slotIndex === 6 ? 'Ben Wood' : r.qcBy,
    }));
    expect(operatorsOf(other)).toEqual(['Ann Lee', 'Ben Wood']);
    expect(crewOf([...afternoon, ...other]).operators).toEqual(['Ann Lee', 'Ben Wood']);
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

describe('how many people a shift had on, overtime at half', () => {
  // People list: John and Ben run presses on Day and Afternoon; Tin Maung
  // supervises Day, Jean-Michel the Afternoon; Sam is on no shift's list.
  const roster = rosterOf(
    [
      { operatorName: 'John Taylor', shift: 'Day' },
      { operatorName: 'Ben Wood', shift: 'Afternoon' },
      { operatorName: 'Sam Untagged', shift: '' },
    ],
    [
      { operatorName: 'Tin Maung', shift: 'Day' },
      { operatorName: 'Jean-Michel Thomas', shift: 'Afternoon' },
    ],
  );
  const sheet = (shiftId: string, operator: string, supervisor: string, machineCode = 'HStamp'): ReturnType<typeof rec>[] =>
    [0, 1, 2, 3].map((slotIndex) =>
      rec({
        machineCode, shiftId, jobNumber: 'SFM508005', slotIndex, statusCode: 'R',
        operator: slotIndex === 0 ? operator : '', supervisor: slotIndex === 0 ? supervisor : '',
        qcBy: slotIndex === 1 ? '' : operator,
      }));
  const day = sheet('2026-11-12-Day', 'John Taylor', 'Tin Maung');
  // Tin Maung stays on into the Afternoon with its own supervisor.
  const afternoon = [
    ...sheet('2026-11-12-Afternoon', 'Ben Wood', 'Tin Maung'),
    ...sheet('2026-11-12-Afternoon', 'Sam Untagged', 'Jean-Michel Thomas', '550T'),
  ];

  it('tells overtime by the roster: a tag for another shift, and none for this one', () => {
    expect(onOvertime(roster, 'Tin Maung', 'Afternoon')).toBe(true);
    expect(onOvertime(roster, 'tin  maung', 'Day')).toBe(false);
    expect(onOvertime(roster, 'Sam Untagged', 'Night')).toBe(false); // no tag: every shift
    expect(onOvertime(roster, 'Somebody New', 'Night')).toBe(false); // not on the list
    // A supervisor listed for two shifts is at home on both.
    const both = rosterOf([{ operatorName: 'Tin Maung', shift: 'Day' }, { operatorName: 'Tin Maung', shift: 'Afternoon Shift' }]);
    expect(onOvertime(both, 'Tin Maung', 'Afternoon')).toBe(false);
    expect(onOvertime(both, 'Tin Maung', 'Night')).toBe(true);
  });

  it('counts the shift\'s own people as 1 and somebody on overtime as 0.5', () => {
    expect(shiftStaffing(day, roster)).toMatchObject({ people: 2, shifts: 1, overtime: [] });
    // Ben, Sam, Jean-Michel = 3, Tin Maung on overtime = 0.5.
    expect(shiftStaffing(afternoon, roster)).toMatchObject({ people: 3.5, shifts: 1, overtime: ['Tin Maung'] });
    expect(shiftStaffing(afternoon, roster).crew.supervisors).toEqual(['Jean-Michel Thomas', 'Tin Maung']);
  });

  it('adds the shifts up for the floor: 1.5 for the person who did both, named once', () => {
    const shifts = [shiftStaffing(day, roster), shiftStaffing(afternoon, roster)];
    const floor = floorStaffing([...day, ...afternoon], shifts);
    expect(floor.people).toBe(5.5);
    expect(floor.overtime).toEqual(['Tin Maung']);
    expect([...floor.crew.operators, ...floor.crew.supervisors]).toHaveLength(5);
  });

  it('averages a kind of shift over the days it ran', () => {
    // Two Afternoons: 3.5 people, then Ben alone under Jean-Michel = 2.
    const next = sheet('2026-11-13-Afternoon', 'Ben Wood', 'Jean-Michel Thomas');
    expect(shiftStaffing([...afternoon, ...next], roster)).toMatchObject({ people: 2.75, shifts: 2 });
  });

  it('without a roster nobody is on overtime', () => {
    expect(shiftStaffing(afternoon, rosterOf())).toMatchObject({ people: 4, overtime: [] });
    expect(shiftStaffing([], roster)).toMatchObject({ people: 0, shifts: 0 });
  });
});

describe('how many people ran a press in a shift', () => {
  const sheet = (machineCode: string, shiftId: string, operator: string, cover = ''): ReturnType<typeof rec>[] =>
    [0, 2, 3, 4].map((slotIndex) =>
      rec({
        machineCode, shiftId, jobNumber: 'J-' + machineCode, slotIndex, statusCode: 'R',
        operator: slotIndex === 0 ? operator : '', supervisor: slotIndex === 0 ? 'Tin Maung' : '',
        qcBy: slotIndex === 3 && cover ? cover : operator,
      }));

  it('counts the operator of each sheet once: no supervisors, nobody who only covered a break', () => {
    const day = '2026-11-16-Day';
    const records = [
      ...sheet('P1', day, 'John Taylor'),
      ...sheet('P2', day, 'Ben Wood', 'Relief Rita'), // Rita covered Ben's break
      // John's press stopped and he moved to the standby.
      ...sheet('S', day, 'John Taylor'),
      ...sheet('P1', '2026-11-16-Afternoon', 'Ann Lee'),
    ];
    expect(operatorsRunningByShift(records)).toEqual(new Map([[day, 2], ['2026-11-16-Afternoon', 1]]));
  });
});
