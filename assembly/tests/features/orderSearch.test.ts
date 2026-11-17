import { describe, expect, it } from 'vitest';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { findEntries, matchEntries, normalOrder, pickedEntry } from '@/features/assembly/orderSearch';

/** Only what the finder reads off a board: its lines, their rows, the pool. */
function boardOf(
  groups: { key: string; name: string; parent?: string; rows: { id: string; description: string; step?: string }[] }[],
  pool: { id: string; description: string }[] = [],
): AssemblyGanttView {
  return {
    groups: groups.map((group) => ({
      line: { key: group.key, name: group.name, parent: group.parent },
      rows: group.rows.map((row) => ({
        job: {
          id: row.id,
          description: row.description,
          operation: row.step ? { step: row.step } : undefined,
        },
      })),
    })),
    pool,
  } as unknown as AssemblyGanttView;
}

const shown = boardOf(
  [
    { key: 'UPL_GLUING', name: 'Upholstery', rows: [] },
    {
      key: 'UPL_GLUING_FOAM',
      name: 'Foaming',
      parent: 'UPL_GLUING',
      rows: [{ id: 'ASM80412#10', description: 'Lounge Sofa 2-Seat Upholstery', step: 'foaming' }],
    },
    {
      key: 'UPL_GLUING_SEW',
      name: 'Sewing',
      parent: 'UPL_GLUING',
      rows: [{ id: 'ASM80412#20', description: 'Lounge Sofa 2-Seat Upholstery', step: 'sewing' }],
    },
    {
      key: 'ASSY',
      name: 'Assembly',
      rows: [
        { id: 'ASM70001', description: 'Podium Chair 8041 frame' },
        { id: 'ASM80410', description: 'Viva Sidechair' },
      ],
    },
    // A press's changeovers ride on its orders' bars: the press holds orders only.
    { key: 'PRESS_M1', name: 'M1', parent: 'PMD', rows: [{ id: 'SFM507001', description: 'Podium shell' }] },
  ],
  [{ id: 'ASM90001', description: 'Table top' }],
);

describe('order finder', () => {
  it('lists each order once, saying where it is — a routed order at both its benches', () => {
    const entries = findEntries(shown);
    expect(entries.map((e) => e.order)).toEqual(['ASM70001', 'ASM80410', 'ASM80412', 'ASM90001', 'SFM507001']);
    const routed = entries.find((e) => e.order === 'ASM80412')!;
    expect(routed.where).toBe('Upholstery › Foaming, Sewing');
    expect(routed.rowIds).toEqual(['ASM80412#10', 'ASM80412#20']);
    expect(routed.lines).toEqual(['UPL_GLUING', 'UPL_GLUING_FOAM', 'UPL_GLUING_SEW']);
    expect(routed.status).toBe('board');
    // A press order is found where it runs.
    expect(entries.find((e) => e.order === 'SFM507001')?.where).toBe('PMD › M1');
  });

  it('lists an order on no line as unassigned, with no rows to scroll to', () => {
    const pool = findEntries(shown).find((e) => e.order === 'ASM90001')!;
    expect(pool).toMatchObject({ status: 'pool', where: 'Unassigned', rowIds: [], lines: [] });
  });

  it('lists what Released Only keeps off the screen as not released, not as missing', () => {
    const plan = boardOf([
      ...shown.groups.map((g) => ({
        key: g.line.key,
        name: g.line.name,
        parent: g.line.parent,
        rows: g.rows.map((r) => ({ id: String(r.job.id), description: r.job.description, step: r.job.operation?.step })),
      })),
      { key: 'TABLE', name: 'Table', rows: [{ id: 'SUNF0042', description: 'Meeting table' }] },
    ]);
    const entries = findEntries(shown, plan);
    expect(entries.find((e) => e.order === 'SUNF0042')).toMatchObject({ status: 'unreleased', where: 'Table', lines: ['TABLE'] });
    // What is on screen keeps its own status.
    expect(entries.find((e) => e.order === 'ASM80412')!.status).toBe('board');
  });

  it('ranks by the number first — exact, starting with, holding — then the description', () => {
    const entries = findEntries(shown);
    expect(matchEntries(entries, '8041').map((e) => e.order)).toEqual(['ASM80410', 'ASM80412', 'ASM70001']);
    expect(matchEntries(entries, 'asm80412').map((e) => e.order)).toEqual(['ASM80412']);
    expect(matchEntries(entries, 'sidechair').map((e) => e.order)).toEqual(['ASM80410']);
    expect(matchEntries(entries, '').length).toBe(entries.length);
    expect(matchEntries(entries, 'nothing like it')).toEqual([]);
  });

  it('Enter means the order typed in full, or the only match — never a guess between several', () => {
    const entries = findEntries(shown);
    expect(pickedEntry(entries, ' asm 80410 ')?.order).toBe('ASM80410');
    expect(pickedEntry(entries, '80412')?.order).toBe('ASM80412');
    expect(pickedEntry(entries, '8041')).toBeNull();
    expect(pickedEntry(entries, '')).toBeNull();
    expect(normalOrder(' asm 80410\t')).toBe('ASM80410');
  });
});
