import { describe, expect, it } from 'vitest';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { Completion } from '@/engine/assembly/completedJobs';
import type { StoredDay } from '@/engine/assembly/completionRecord';
import { boardCrewFor, demoCompletions, itemFor, lineForPlanner } from '@/features/assembly/completions';

const workers = [
  { id: '11', name: 'Ana' },
  { id: '12', name: 'Bo' },
  { id: '13', name: 'Cy' },
];

const boardWith = (rows: unknown[]): AssemblyGanttView =>
  ({ workers, rowsByJob: new Map(rows.map((r, i) => [String(i), r])), groups: [] }) as unknown as AssemblyGanttView;

const onBoard = (jobNum: string, crew: Record<string, string[]>, op?: { jobNum: string; last: boolean }) => ({
  job: { id: op ? `${jobNum}#${op.last ? 30 : 10}` : jobNum, operation: op, remainingQty: 30, completedQty: 10, dueDate: new Date('2026-11-20T05:30:00Z') },
  line: { name: 'Assembly' },
  workers: [workers[2]],
  crewDays: Object.entries(crew).map(([day, workerIds]) => ({ day, workerIds })),
});

const done = (over: Partial<Completion> = {}): Completion => ({
  key: 'J1|2026-11-17', jobNum: 'J1', day: '2026-11-17', qty: 10, hours: 2.5, planner: 'ASSY',
  partNum: 'P1', description: 'Chair', lastAt: '2026-11-17T14:00', entries: 1, ...over,
});

const stored = (over: Partial<StoredDay> = {}): StoredDay => ({
  id: '1', recordKey: '', day: '2026-11-17', op: '', wip: false, line: 'Assembly', operators: [], operatorIds: [],
  dueDate: null, orderQty: null, plannedHours: null,
  completedBy: [], completedByIds: [], confirmedBy: '', confirmedAt: '', epicorQty: null, ...over,
});

describe('who the dialog offers', () => {
  it('takes the board’s crew that day first, from the operation that receives', () => {
    const board = boardWith([
      onBoard('J1', { '2026-11-17': ['13'] }, { jobNum: 'J1', last: false }),
      onBoard('J1', { '2026-11-17': ['11', '12'] }, { jobNum: 'J1', last: true }),
    ]);
    expect(boardCrewFor(board, 'J1', '2026-11-17').map((p) => p.name)).toEqual(['Ana', 'Bo']);
    expect(boardCrewFor(boardWith([]), 'J1', '2026-11-18')).toEqual([]);
    // No crew recorded that day: whoever the order has now.
    expect(boardCrewFor(board, 'J1', '2026-11-18').map((p) => p.name)).toEqual(['Cy']);
    const item = itemFor(board, done(), [stored({ operators: ['Cy'], operatorIds: ['13'] })], [], 10);
    expect(item.people.map((p) => p.name)).toEqual(['Ana', 'Bo']);
    expect(item.confirmed).toBe(false);
    // The order as the board holds it: its whole quantity and Due Date.
    expect(item.order).toEqual({ line: 'Assembly', dueDate: '2026-11-20T05:30:00.000Z', orderQty: 40 });
  });

  it('falls back to the names on the list when the board no longer has the order', () => {
    const planning = [stored({ day: '2026-11-14', operators: ['cy'], operatorIds: [''], line: '', orderQty: 25, dueDate: '2026-11-19T00:00:00Z' })];
    const item = itemFor(boardWith([]), done({ planner: 'TABLE' }), planning, [], 25);
    expect(item.people).toEqual([{ id: '13', name: 'Cy' }]);
    expect(item.row).toBeNull();
    expect(item.line).toBe('Table');
    expect(item.order).toMatchObject({ orderQty: 25, dueDate: '2026-11-19T00:00:00Z' });
    expect(item.doneToDate).toBe(25);
  });

  it('shows what was confirmed rather than offering again', () => {
    const item = itemFor(
      boardWith([onBoard('J1', { '2026-11-17': ['11'] })]),
      done(),
      [],
      [stored({ recordKey: 'J1|2026-11-17', completedBy: ['Bo', 'Cy'], completedByIds: ['12', '13'], confirmedBy: 'Jeff Penn', confirmedAt: '2026-11-18T07:00:00Z' })],
      10,
    );
    expect(item).toMatchObject({ confirmed: true, confirmedBy: 'Jeff Penn' });
    expect(item.people.map((p) => p.name)).toEqual(['Bo', 'Cy']);
  });

  it('names the board’s lines for the ERP planners', () => {
    expect(['ASSY', 'TABLE', 'TBP', 'UPL', 'General'].map(lineForPlanner)).toEqual(['Assembly', 'Table', 'TBP', 'UPL', 'General']);
  });

  it('fills the demo from the board’s own crewed orders, spread over the window', () => {
    const row = (id: string) => ({
      job: { id, partNum: 'P', description: 'D', remainingQty: 20, completedQty: 0, laborHrs: 5 },
      line: { name: 'Assembly', schedulable: true },
      workers: [workers[0]],
    });
    const board = { rowsByJob: new Map(['A', 'B', 'C'].map((id) => [id, row(id)])) } as unknown as AssemblyGanttView;
    const demo = demoCompletions(board, { from: '2026-11-13', to: '2026-11-15' });
    expect(demo.map((c) => c.day)).toEqual(['2026-11-13', '2026-11-14']);
    expect(demo[0]).toMatchObject({ jobNum: 'A', qty: 10, hours: 2.5 });
  });
});
