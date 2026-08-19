import { describe, expect, it } from 'vitest';

import { cavityNote, dieKey, resolveCavities } from '../src/core/cavities';

const register = new Map<string, number | null>([
  ['DIE-3597', 2],
  ['DIE-4001', 4],
  ['DIE-BLANK', null],
  ['DIE-ZERO', 0],
  ['DIE-HALF', 2.7],
  ['DIE-ONE', 1],
]);

describe('resolveCavities — the die decides, not the operator', () => {
  it('takes the count straight off PMD_DieMaster', () => {
    expect(resolveCavities('DIE-4001', register)).toEqual({
      count: 4,
      dieNumber: 'DIE-4001',
      reason: 'die',
      known: true,
    });
  });

  it('matches a die whatever case and padding the other list used', () => {
    // PMD_ProductDieColor and PMD_DieMaster are maintained by different
    // people; a trailing space must not read as a missing tool.
    for (const written of [' die-3597 ', 'Die-3597', 'DIE-3597  ']) {
      expect(resolveCavities(written, register).count).toBe(2);
    }
  });

  it('reports the die it read, trimmed, so the tooltip can name it', () => {
    expect(resolveCavities('  DIE-3597 ', register).dieNumber).toBe('DIE-3597');
  });

  it('falls back to 1 when the part has no Die # at all', () => {
    expect(resolveCavities('', register)).toMatchObject({ count: 1, reason: 'no-die', known: false });
    expect(resolveCavities('   ', register).reason).toBe('no-die');
  });

  it('separates "not in the register" from "in it but blank"', () => {
    // Both count 1, and the difference is the whole reason `reason`
    // exists: one is a missing tool, the other a cell to go and fill in.
    expect(resolveCavities('DIE-NEW', register)).toMatchObject({
      count: 1,
      reason: 'no-die-row',
      known: false,
    });
    expect(resolveCavities('DIE-BLANK', register)).toMatchObject({
      count: 1,
      reason: 'die-blank',
      known: false,
    });
  });

  it('treats 0 or a negative as "nobody told us", never as zero output', () => {
    // count is multiplied into every piece figure downstream, so a 0 here
    // would silently wipe out a shift.
    expect(resolveCavities('DIE-ZERO', register)).toMatchObject({ count: 1, reason: 'die-blank' });
    expect(resolveCavities('DIE-NEG', new Map([['DIE-NEG', -2]])).count).toBe(1);
  });

  it('never inflates a count from a fractional cell', () => {
    expect(resolveCavities('DIE-HALF', register).count).toBe(2);
  });

  it('marks a real 1-cavity die as KNOWN, unlike the 1 fallback', () => {
    // This is what lets the sheet overwrite a stale hand-entered 4 with a
    // genuine 1, while leaving it alone when the register is just silent.
    expect(resolveCavities('DIE-ONE', register)).toMatchObject({ count: 1, known: true });
    expect(resolveCavities('DIE-NEW', register).known).toBe(false);
  });

  it('reads an empty register as "no answer", not as an error', () => {
    expect(resolveCavities('DIE-3597', new Map())).toMatchObject({
      count: 1,
      reason: 'no-die-row',
      known: false,
    });
  });
});

describe('dieKey', () => {
  it('normalises case and padding', () => {
    expect(dieKey('  die-1 ')).toBe('DIE-1');
    expect(dieKey('')).toBe('');
  });
});

describe('cavityNote — the operator can no longer fix it, so say why', () => {
  it('names the die and spells out the arithmetic', () => {
    const note = cavityNote(resolveCavities('DIE-4001', register));
    expect(note).toContain('DIE-4001');
    expect(note).toContain('4 pieces per press cycle');
    expect(note).toContain('× 4 − Reject');
  });

  it('says one piece, singular, for a single-cavity tool', () => {
    expect(cavityNote(resolveCavities('DIE-ONE', register))).toContain('1 piece per press cycle');
  });

  it('points a blank cell at the toolroom', () => {
    const note = cavityNote(resolveCavities('DIE-BLANK', register));
    expect(note).toContain('DIE-BLANK');
    expect(note).toMatch(/toolroom/i);
  });

  it('distinguishes an unregistered die from a part with no die', () => {
    expect(cavityNote(resolveCavities('DIE-NEW', register))).toContain('not in the PMD_DieMaster');
    expect(cavityNote(resolveCavities('', register))).toContain('PMD_ProductDieColor');
  });

  it('always says what it fell back to', () => {
    for (const die of ['', 'DIE-NEW', 'DIE-BLANK']) {
      expect(cavityNote(resolveCavities(die, register))).toContain('counting 1 piece per cycle');
    }
  });
});
