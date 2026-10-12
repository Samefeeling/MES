import { describe, it, expect } from 'vitest';
import {
  DIE_CHANGE_STD_HRS,
  COLOR_CHANGE_STD_HRS,
  INSERT_CHANGE_STD_HRS,
  setupJudgement,
  setupStandardHours,
} from '../src/core/standards';

describe('setupStandardHours (die 4h, colour/insert 30min per occurrence)', () => {
  it('multiplies occurrence counts by the standards', () => {
    expect(setupStandardHours({ dieChanges: 2, colorChanges: 1, insertChanges: 3 })).toEqual({
      dieStdHrs: 2 * DIE_CHANGE_STD_HRS,
      colorStdHrs: 1 * COLOR_CHANGE_STD_HRS,
      insertStdHrs: 3 * INSERT_CHANGE_STD_HRS,
    });
  });
});

describe('setupJudgement (红黄蓝 vs the standard allowance)', () => {
  it('blue at/under standard, amber one block over, red beyond', () => {
    expect(setupJudgement(4, 4)).toBe('blue'); // exactly 8 D blocks
    expect(setupJudgement(3.5, 4)).toBe('blue'); // faster than standard
    expect(setupJudgement(4.5, 4)).toBe('amber'); // 1 extra block
    expect(setupJudgement(5, 4)).toBe('red'); // 2+ extra blocks
    expect(setupJudgement(1, 0.5)).toBe('amber');
    expect(setupJudgement(1.5, 0.5)).toBe('red');
  });

  it("'' when nothing to judge (no changeover, or standards not computed)", () => {
    expect(setupJudgement(0, 0)).toBe('');
    expect(setupJudgement(3, null)).toBe('');
  });
});
