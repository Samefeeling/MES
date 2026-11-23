import { describe, expect, it } from 'vitest';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { Completion } from '@/engine/assembly/completedJobs';
import type { StoredDay } from '@/engine/assembly/completionRecord';
import { boardCrewFor, demoCompletions, groupByLine, itemFor, lineCrewFor, lineForPlanner, lineGroupsFor, type WorkerLines } from '@/features/assembly/completions';
import { useCompletionStore } from '@/store/completionStore';

const workers = [
  { id: '11', name: 'Ana', skills: [], onShift: true },
  { id: '12', name: 'Bo', skills: [], onShift: true },
  { id: '13', name: 'Cy', skills: [], onShift: true },
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
    // The board's layout decides: plain UPL is the Upholstery (Gluing) lane.
    expect(['ASSY', 'TABLE', 'TBP', 'UPL', 'General'].map((p) => lineForPlanner(p))).toEqual(['Assembly', 'Table', 'TBP', 'UPL-Gluing', 'General']);
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

/**
 * The supervisors' ask: offer each order its line's group on the board that
 * day, less anyone on leave, so confirming is a review rather than typing.
 */
describe('the line group as the first offer', () => {
  const roster = [
    { id: '21', name: 'Dee', skills: ['ASSY'], onShift: true },
    { id: '22', name: 'Eli', skills: ['ASSY'], onShift: true, plannedLeave: ['2026-11-17'] },
    { id: '23', name: 'Fay', skills: ['TABLE'], onShift: true },
    // Grouped on Assembly by the supervisor, whatever the roster says.
    { id: '24', name: 'Gus', skills: ['TABLE'], onShift: true },
    // Marked off on the board for the day.
    { id: '25', name: 'Hal', skills: ['ASSY'], onShift: true },
    // Away today only: says nothing about the completion day.
    { id: '26', name: 'Ivy', skills: ['ASSY'], onShift: false },
  ];
  const board = {
    workers: roster,
    rowsByJob: new Map(),
    groups: [],
    today: new Date(2026, 10, 18),
    workerOnLeave: { '25': ['2026-11-17'] },
  } as unknown as AssemblyGanttView;
  const lines: WorkerLines = { '24': 'ASSY' };

  it('is everybody the board groups on the line, less who was on leave that day', () => {
    const crew = lineCrewFor(board, lines, 'Assembly', '2026-11-17');
    expect(crew.people.map((p) => p.name)).toEqual(['Dee', 'Gus', 'Ivy']);
    expect(crew.onLeave.map((p) => p.name)).toEqual(['Eli', 'Hal']);
    expect(lineCrewFor(board, lines, 'Table', '2026-11-17').people.map((p) => p.name)).toEqual(['Fay']);
    expect(lineCrewFor(board, lines, 'Nowhere', '2026-11-17')).toEqual({ people: [], onLeave: [] });
  });

  it('comes before the names on the list, and says who it left out', () => {
    const planning = [stored({ operators: ['Fay'], operatorIds: ['23'] })];
    const item = itemFor(board, done(), planning, [], 10, lines);
    expect(item.line).toBe('Assembly');
    expect(item.people.map((p) => p.name)).toEqual(['Dee', 'Gus', 'Ivy']);
    expect(item.offeredFrom).toBe('line');
    expect(item.onLeave.map((p) => p.name)).toEqual(['Eli', 'Hal']);
  });

  it('gives way to what was confirmed', () => {
    const saved = stored({ recordKey: 'J1|2026-11-17', completedBy: ['Fay'], completedByIds: ['23'], confirmedBy: 'Sup', confirmedAt: '2026-11-18T08:00:00Z' });
    const item = itemFor(board, done(), [], [saved], 10, lines);
    expect(item.people.map((p) => p.name)).toEqual(['Fay']);
    expect(item.offeredFrom).toBe('saved');
  });

  it('gives each line heading its group, on the line\'s latest day', () => {
    const items = [
      itemFor(board, done({ key: 'A1|2026-11-16', jobNum: 'A1', day: '2026-11-16' }), [], [], 10, lines),
      itemFor(board, done({ key: 'A2|2026-11-17', jobNum: 'A2' }), [], [], 10, lines),
    ];
    const groups = lineGroupsFor(board, lines, items);
    expect(Object.keys(groups)).toEqual(['Assembly']);
    expect(groups.Assembly.day).toBe('2026-11-17');
    expect(groups.Assembly.people.map((p) => p.name)).toEqual(['Dee', 'Gus', 'Ivy']);
    expect(groups.Assembly.onLeave.map((p) => p.name)).toEqual(['Eli', 'Hal']);
  });

  it('fills a line from its heading, drops one name on an order, and leaves confirmed orders alone', () => {
    const a1 = itemFor(board, done({ key: 'A1|2026-11-17', jobNum: 'A1' }), [], [], 10, lines);
    const a2 = { ...itemFor(board, done({ key: 'A2|2026-11-17', jobNum: 'A2' }), [], [], 10, lines), confirmed: true, people: [{ id: '23', name: 'Fay' }] };
    const t1 = itemFor(board, done({ key: 'T1|2026-11-17', jobNum: 'T1', planner: 'TABLE' }), [], [], 10, lines);
    useCompletionStore.setState({ items: [a1, a2, t1], lineGroups: lineGroupsFor(board, lines, [a1, a2, t1]) });
    const st = useCompletionStore.getState();
    st.setLineGroup('Assembly', [{ id: '21', name: 'Dee' }, { id: '25', name: 'Hal' }]);
    st.fillLine('Assembly');
    const names = (key: string) => useCompletionStore.getState().items.find((i) => i.completion.key === key)!.people.map((p) => p.name);
    expect(names('A1|2026-11-17')).toEqual(['Dee', 'Hal']);
    expect(names('A2|2026-11-17')).toEqual(['Fay']);
    expect(names('T1|2026-11-17')).toEqual(['Fay']);
    st.addPerson('T1|2026-11-17', { id: '24', name: 'Gus' });
    st.addPerson('T1|2026-11-17', { id: '24', name: 'Gus' });
    expect(names('T1|2026-11-17')).toEqual(['Fay', 'Gus']);
    expect(useCompletionStore.getState().items.every((i) => i.confirmed || i.edited)).toBe(true);
  });

  it('groups the dialog by line in the board order, orders by number within', () => {
    const items = [
      itemFor(board, done({ key: 'T2|2026-11-17', jobNum: 'T2', planner: 'TABLE' }), [], [], 10, lines),
      itemFor(board, done({ key: 'A9|2026-11-17', jobNum: 'A9' }), [], [], 10, lines),
      itemFor(board, done({ key: 'X1|2026-11-17', jobNum: 'X1', planner: 'ODD' }), [], [], 10, lines),
      itemFor(board, done({ key: 'A1|2026-11-17', jobNum: 'A1' }), [], [], 10, lines),
    ];
    const groups = groupByLine(board, items);
    expect(groups.map((g) => [g.line, g.items.map((i) => i.completion.jobNum)])).toEqual([
      ['Assembly', ['A1', 'A9']],
      ['Table', ['T2']],
      ['ODD', ['X1']],
    ]);
    // The supervisor's own arrangement of the lines wins.
    expect(groupByLine(board, items, ['TABLE']).map((g) => g.line)).toEqual(['Table', 'Assembly', 'ODD']);
  });
});
