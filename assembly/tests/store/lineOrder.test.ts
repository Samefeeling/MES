/**
 * Arranging the lines.
 *
 * `LINES` is the order the plant lists its benches in, which is not the order
 * any particular floor runs them. The sequence is the supervisor's and it lives
 * in the shared plan, so two people reading the board read the same one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { LINES, arrangeLines, type LineKey } from '@/domain/assembly';
import { usePlanStore } from '@/store/planStore';

const BUILT_IN = LINES.map((line) => line.key);

const reset = () =>
  usePlanStore.setState({ lineOrder: [], virtualLines: [], containers: {} });

beforeEach(reset);

const order = () => usePlanStore.getState().lineOrder;
const arranged = () =>
  arrangeLines(LINES, usePlanStore.getState().lineOrder).map((l) => l.key);

describe('putting one line where another is', () => {
  it('opens in the order the plant lists them', () => {
    expect(arranged()).toEqual(BUILT_IN);
  });

  /*
   * The user's own example: cutting feeds gluing on one shift and the other way
   * round on the next, and reading the board against the bench order is most of
   * what makes it quick to read.
   */
  it('drops UPL-CUT under UPL-Gluing when it lands on it', () => {
    usePlanStore.getState().moveLine('UPL_CUT_SEW', 'UPL_GLUING');
    expect(arranged().slice(0, 4)).toEqual([
      'TBP',
      'PMD',
      'UPL_GLUING',
      'UPL_CUT_SEW',
    ]);
  });

  it('and above it when it lands going the other way', () => {
    usePlanStore.getState().moveLine('UPL_GLUING', 'UPL_CUT_SEW');
    expect(arranged().slice(0, 4)).toEqual([
      'TBP',
      'PMD',
      'UPL_GLUING',
      'UPL_CUT_SEW',
    ]);
  });

  it('moves one line and leaves the rest where they were', () => {
    usePlanStore.getState().moveLine('TABLE', 'TBP');
    expect(arranged()).toEqual([
      'TABLE',
      'TBP',
      'PMD',
      'UPL_CUT_SEW',
      'UPL_GLUING',
      'UPL_SOFTIE',
      'ASSY',
      'FACTORY_GENERAL',
    ]);
  });

  it('writes the whole sequence out, not just the line that moved', () => {
    usePlanStore.getState().moveLine('ASSY', 'TBP');
    expect(order()).toHaveLength(BUILT_IN.length);
    expect([...order()].sort()).toEqual([...BUILT_IN].sort());
  });

  it('does nothing at all when a line is dropped on itself', () => {
    usePlanStore.getState().moveLine('ASSY', 'ASSY');
    expect(order()).toEqual([]);
  });

  it('or on a line this plan does not have', () => {
    usePlanStore.getState().moveLine('ASSY', 'VL_NOT_A_BENCH' as LineKey);
    expect(order()).toEqual([]);
  });
});

describe('a stored arrangement that no longer fits the board', () => {
  /*
   * The load-bearing case. `arrangeLines` is asked to place a saved list
   * against the lines that actually exist, and neither side is ever guaranteed
   * to be the whole of the other: a plan saved last month predates a bench
   * opened this morning, and a closed bench outlives the plan that named it.
   */
  it('keeps every line it has, whatever the arrangement names', () => {
    expect(
      arrangeLines(LINES, ['ASSY', 'VL_CLOSED_LAST_WEEK', 'TABLE']).map((l) => l.key),
    ).toEqual([
      'ASSY',
      'TABLE',
      'TBP',
      'PMD',
      'UPL_CUT_SEW',
      'UPL_GLUING',
      'UPL_SOFTIE',
      'FACTORY_GENERAL',
    ]);
  });

  it('and a plan with no arrangement at all is the built-in order', () => {
    expect(arrangeLines(LINES, []).map((l) => l.key)).toEqual(BUILT_IN);
  });

  it('never draws a line twice, however the arrangement repeats itself', () => {
    const keys = arrangeLines(LINES, ['ASSY', 'ASSY', 'TABLE']).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(LINES.length);
  });
});

describe('an added line, and a closed one', () => {
  it('opens at the end of the arrangement rather than in the middle of it', () => {
    usePlanStore.getState().moveLine('TABLE', 'TBP');
    usePlanStore.getState().addVirtualLine('Table 2');
    expect(usePlanStore.getState().lineOrder).not.toContain('VL_TABLE_2');
    const all = [
      ...LINES,
      { key: 'VL_TABLE_2' as LineKey },
    ];
    expect(arrangeLines(all, usePlanStore.getState().lineOrder).at(-1)?.key)
      .toBe('VL_TABLE_2');
  });

  it('takes its place in the sequence once it has been moved', () => {
    usePlanStore.getState().addVirtualLine('Table 2');
    usePlanStore.getState().moveLine('VL_TABLE_2' as LineKey, 'TBP');
    expect(usePlanStore.getState().lineOrder[0]).toBe('VL_TABLE_2');
  });

  // A key left behind in the arrangement is a gap for the next reader to trip
  // over, and `arrangeLines` would have to keep stepping over it for good.
  it('and leaves no trace of itself when the bench closes', () => {
    usePlanStore.getState().addVirtualLine('Table 2');
    usePlanStore.getState().moveLine('VL_TABLE_2' as LineKey, 'TBP');
    usePlanStore.getState().removeVirtualLine('VL_TABLE_2');
    expect(usePlanStore.getState().lineOrder).not.toContain('VL_TABLE_2');
    expect(arranged()).toEqual(BUILT_IN);
  });
});

describe('reading and writing it with the plan', () => {
  it('comes back as it was stored', () => {
    usePlanStore.getState().setAssemblyPlan({ lineOrder: ['TABLE', 'ASSY'] });
    expect(usePlanStore.getState().lineOrder).toEqual(['TABLE', 'ASSY']);
  });

  // Every other field in `setAssemblyPlan` keeps what is in the store when the
  // stored plan says nothing, and an arrangement is no different: a plan saved
  // before the lines could be arranged must not read as "put them back".
  it('and a plan saved before there was one changes nothing', () => {
    usePlanStore.getState().moveLine('TABLE', 'TBP');
    const before = usePlanStore.getState().lineOrder;
    usePlanStore.getState().setAssemblyPlan({ manualOrders: {} });
    expect(usePlanStore.getState().lineOrder).toEqual(before);
  });
});
