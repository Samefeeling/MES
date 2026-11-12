import { describe, it, expect } from 'vitest';
import { otherShiftNames, rosterNames } from '../src/ui/operator';
import type { Operator } from '../src/types';

function op(operatorName: string, shift?: string): Operator {
  return { id: 0, operatorName, active: true, shift };
}

describe('rosterNames (shift-filtered operator/supervisor list)', () => {
  const roster = [
    op('Day Op', 'Day'),
    op('Arvo Op', 'Afternoon'),
    op('Night Op', 'Night'),
    op('Untagged Op', ''), // no shift tag
  ];

  it('narrows to the selected shift, keeping untagged entries', () => {
    const names = rosterNames(roster, 'Day', '');
    expect(names).toContain('Day Op');
    expect(names).toContain('Untagged Op'); // untagged shows on every shift
    expect(names).not.toContain('Arvo Op');
    expect(names).not.toContain('Night Op');
  });

  it('tolerates "Day Shift" / single-letter "D" tags via prefix match', () => {
    const r = [op('Long', 'Day Shift'), op('Short', 'D'), op('Other', 'Night')];
    const names = rosterNames(r, 'Day', '');
    expect(names).toEqual(expect.arrayContaining(['Long', 'Short']));
    expect(names).not.toContain('Other');
  });

  it('always includes the currently-selected name even if off-shift', () => {
    // Viewing Day but the record was signed by a Night operator — must
    // still be selectable so the value is never dropped.
    const names = rosterNames(roster, 'Day', 'Night Op');
    expect(names).toContain('Night Op');
    expect(names[names.length - 1]).toBe('Night Op'); // appended at the end
  });

  it('de-duplicates names', () => {
    const r = [op('Sam', 'Day'), op('Sam', 'Day')];
    expect(rosterNames(r, 'Day', '').filter((n) => n === 'Sam')).toHaveLength(1);
  });
});

describe('otherShiftNames (the people of the other shifts, for overtime)', () => {
  const roster = [op('Day Op', 'Day'), op('Night Op', 'Night'), op('Arvo Op', 'Afternoon'), op('Untagged Op', '')];

  it('lists everybody the shift\'s own list leaves out, A–Z', () => {
    const own = rosterNames(roster, 'Afternoon', '');
    expect(own).toEqual(['Arvo Op', 'Untagged Op']);
    expect(otherShiftNames(roster, own)).toEqual(['Day Op', 'Night Op']);
  });

  it('never repeats a name the shift\'s list already has', () => {
    const own = rosterNames(roster, 'Afternoon', 'Day Op'); // Day Op already picked
    expect(otherShiftNames(roster, own)).toEqual(['Night Op']);
  });
});
