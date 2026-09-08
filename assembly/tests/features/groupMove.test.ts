import { describe, expect, it } from 'vitest';
import {
  markedSet,
  planGroupMove,
  type MarkedMove,
  type MovableRow,
} from '@/features/assembly/groupMove';

/** Mon 1 Sept 2025 is the Monday every case below counts from. */
const day = (date: string): string => new Date(`${date}T00:00:00`).toISOString();
/**
 * The local day each order landed on. Read with the local getters that built
 * it: `day` below makes local midnight, which east of Greenwich is the
 * previous date in UTC, so reading these back as ISO answered a day early.
 */
const landed = (
  moves: { jobId: string; startISO: string }[],
): Record<string, string> =>
  Object.fromEntries(
    moves.map((move) => {
      const at = new Date(move.startISO);
      return [
        move.jobId,
        `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
          at.getDate(),
        ).padStart(2, '0')}`,
      ];
    }),
  );

const order = (
  jobId: string,
  start: string,
  floor: string | null = null,
): MarkedMove => ({ jobId, startISO: day(start), floorISO: floor && day(floor) });

describe('moving a marked set', () => {
  it('shifts every order by the same number of columns', () => {
    const moves = planGroupMove(
      [order('A', '2025-09-01'), order('B', '2025-09-03'), order('C', '2025-09-08')],
      2,
      false,
    );
    expect(landed(moves)).toEqual({
      A: '2025-09-03',
      B: '2025-09-05',
      C: '2025-09-10',
    });
  });

  it('counts columns rather than days when weekends are hidden', () => {
    // Thursday plus two working columns is the following Monday, not Saturday.
    expect(landed(planGroupMove([order('A', '2025-09-04')], 2, false))).toEqual({
      A: '2025-09-08',
    });
  });

  it('steps off a weekend a visible-weekend axis would have landed on', () => {
    // The column arithmetic includes Saturday when weekend columns are showing,
    // but nobody is in on Saturday and a bulk move is not where overtime gets
    // decided, so the bar opens on the Monday.
    expect(landed(planGroupMove([order('A', '2025-09-04')], 2, true))).toEqual({
      A: '2025-09-08',
    });
  });

  it('gives an empty set nothing to do', () => {
    expect(planGroupMove([], 3, false)).toEqual([]);
  });
});

describe('the earliest days the set may take', () => {
  it('butts the whole run up against today, keeping its spacing', () => {
    // Dragged a fortnight into the past. Moved one at a time the first two
    // would pile up on today and the run would come out shorter than it went in.
    const moves = planGroupMove(
      [
        order('A', '2025-09-15', '2025-09-08'),
        order('B', '2025-09-17', '2025-09-08'),
        order('C', '2025-09-19', '2025-09-08'),
      ],
      -10,
      false,
    );
    expect(landed(moves)).toEqual({
      A: '2025-09-08',
      B: '2025-09-10',
      C: '2025-09-12',
    });
  });

  it('moves the set only as far as its most constrained order can go', () => {
    // B waits on a press job outside the set that finishes on the 12th. The
    // drag asks for five columns earlier; B can only give three, so all of
    // them give three and the run holds its shape.
    const moves = planGroupMove(
      [order('A', '2025-09-15', '2025-09-01'), order('B', '2025-09-17', '2025-09-12')],
      -5,
      false,
    );
    expect(landed(moves)).toEqual({ A: '2025-09-10', B: '2025-09-12' });
  });

  it('refuses to move a set already hard against its wall', () => {
    // A is drawn on the day its predecessor finishes. Nothing in the set can
    // go earlier, so nothing does — rather than moving the others and leaving
    // the run in a shape nobody chose. Nothing is written either: pinning an
    // order that is not moving would still change how it runs.
    const moves = planGroupMove(
      [order('A', '2025-09-15', '2025-09-15'), order('B', '2025-09-18')],
      -3,
      false,
    );
    expect(moves).toEqual([]);
  });

  it('still gives ground where the wall is only part of the way over', () => {
    // B is held on the 17th, so the run can give one column of the two asked
    // for. Both take that one column and the gap between them is unchanged.
    const moves = planGroupMove(
      [order('A', '2025-09-16'), order('B', '2025-09-18', '2025-09-17')],
      -2,
      false,
    );
    expect(landed(moves)).toEqual({ A: '2025-09-15', B: '2025-09-17' });
  });

  it('lets a set held back from moving earlier still move later', () => {
    const moves = planGroupMove(
      [order('A', '2025-09-15', '2025-09-15'), order('B', '2025-09-18')],
      3,
      false,
    );
    expect(landed(moves)).toEqual({ A: '2025-09-18', B: '2025-09-23' });
  });

  it('leaves a set alone when every day it asks for is already legal', () => {
    const moves = planGroupMove(
      [order('A', '2025-09-15', '2025-09-01'), order('B', '2025-09-17', '2025-09-01')],
      1,
      false,
    );
    expect(landed(moves)).toEqual({ A: '2025-09-16', B: '2025-09-18' });
  });

  it('never lands anything on a Saturday or a Sunday', () => {
    for (let shift = -6; shift <= 6; shift++) {
      const moves = planGroupMove(
        [
          order('A', '2025-09-11', '2025-09-08'),
          order('B', '2025-09-12'),
          order('C', '2025-09-16'),
        ],
        shift,
        true,
      );
      for (const move of moves) {
        expect(new Date(move.startISO).getDay()).not.toBe(0);
        expect(new Date(move.startISO).getDay()).not.toBe(6);
      }
    }
  });
});

describe('which orders a drag carries', () => {
  const row = (
    id: string,
    start: string | null,
    extra: Partial<MovableRow> = {},
  ): MovableRow => ({
    job: { id },
    start: start === null ? null : new Date(day(start)),
    material: {},
    predecessors: [],
    ...extra,
  });
  const ids = (set: MarkedMove[]): string[] => set.map((m) => m.jobId).sort();
  const today = new Date(day('2025-09-01'));

  it('carries a marked order the window is not showing', () => {
    // The day filter or the five-day window can hide a bar without unmarking
    // it. Dropping it here would move the rest of the run without it, which is
    // the broken shape the whole feature exists to avoid.
    const board = [
      row('A', '2025-09-08'),
      row('HIDDEN', '2025-09-12'),
      row('C', '2025-09-16'),
    ];
    expect(ids(markedSet(board, new Set(['A', 'HIDDEN', 'C']), today))).toEqual([
      'A',
      'C',
      'HIDDEN',
    ]);
  });

  it('leaves out orders that cannot move', () => {
    const board = [
      row('MARKED', '2025-09-08'),
      row('UNMARKED', '2025-09-09'),
      row('STARTED', '2025-09-10', { actualStart: { at: day('2025-09-10') } }),
      row('UNSCHEDULED', null),
    ];
    const marks = new Set(['MARKED', 'STARTED', 'UNSCHEDULED']);
    expect(ids(markedSet(board, marks, today))).toEqual(['MARKED']);
  });

  it('floors an order on today when nothing else holds it', () => {
    const set = markedSet([row('A', '2025-09-08')], new Set(['A']), today);
    expect(set[0].floorISO).toBe(day('2025-09-01'));
  });

  it('takes the latest of today, material and an outside predecessor', () => {
    const board = [
      row('A', '2025-09-16', {
        material: { earliestStart: new Date(day('2025-09-05')) },
        predecessors: [{ onJobId: 'PRESS' }],
      }),
      row('PRESS', '2025-09-02', { expectDate: new Date(day('2025-09-10')) }),
    ];
    const set = markedSet(board, new Set(['A']), today);
    expect(set[0].floorISO).toBe(day('2025-09-10'));
  });

  it('ignores a predecessor that is moving with the set', () => {
    // B follows A, but A is about to shift by the same number of columns, so
    // the gap between them survives the drag without A holding B back.
    const board = [
      row('A', '2025-09-08', { expectDate: new Date(day('2025-09-12')) }),
      row('B', '2025-09-15', { predecessors: [{ onJobId: 'A' }] }),
    ];
    const set = markedSet(board, new Set(['A', 'B']), today);
    expect(set.find((m) => m.jobId === 'B')!.floorISO).toBe(day('2025-09-01'));
  });

  it('still honours that predecessor when it is not marked', () => {
    const board = [
      row('A', '2025-09-08', { expectDate: new Date(day('2025-09-12')) }),
      row('B', '2025-09-15', { predecessors: [{ onJobId: 'A' }] }),
    ];
    const set = markedSet(board, new Set(['B']), today);
    expect(set[0].floorISO).toBe(day('2025-09-12'));
  });

  it('reports where each bar is drawn, not where it was pinned', () => {
    const set = markedSet([row('A', '2025-09-08')], new Set(['A']), today);
    expect(set[0].startISO).toBe(day('2025-09-08'));
  });
});
