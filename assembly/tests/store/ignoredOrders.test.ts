import { describe, expect, it } from 'vitest';
import { useIgnoredOrders, withoutIgnoredOrders } from '@/store/ignoredOrders';
import type { AssemblyGanttView } from '@/engine/assembly/board';

describe('reversible order exclusions', () => {
  it('deduplicates ignores and restores the original order', () => {
    useIgnoredOrders.setState({ ids: [] });
    useIgnoredOrders.getState().ignore('A');
    useIgnoredOrders.getState().ignore('A');
    expect(useIgnoredOrders.getState().ids).toEqual(['A']);
    useIgnoredOrders.getState().restore('A');
    expect(useIgnoredOrders.getState().ids).toEqual([]);
  });
  it('excludes crew candidates without deleting dependency indexes or mutating the board', () => {
    const index = new Map();
    const board = { groups: [{ rows: [{ job: { id: 'A' } }, { job: { id: 'B' } }] }], rowsByJob: index } as unknown as AssemblyGanttView;
    const filtered = withoutIgnoredOrders(board, ['A']);
    expect(filtered.groups[0].rows.map((row) => row.job.id)).toEqual(['B']);
    expect(filtered.rowsByJob).toBe(index);
    expect(board.groups[0].rows).toHaveLength(2);
  });
});
