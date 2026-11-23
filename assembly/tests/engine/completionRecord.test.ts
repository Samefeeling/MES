import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  COMPLETION_COLUMNS as C,
  completionRow,
  orderFromRows,
  readStoredDay,
  recordFor,
  suggestedCrew,
  type StoredDay,
} from '@/engine/assembly/completionRecord';
import type { Completion } from '@/engine/assembly/completedJobs';

vi.mock('@/data/sharepoint/lists.write', () => ({
  createListItem: vi.fn(),
  updateListItem: vi.fn(),
  fetchRowsWhere: vi.fn(),
  fetchListItemsWithIds: vi.fn(),
}));
import * as lists from '@/data/sharepoint/lists.write';
import { fieldsFor, storedDaysFor, writeCompletion } from '@/data/sharepoint/completion.list';

const done: Completion = {
  key: '018474-10-1|2026-11-17',
  jobNum: '018474-10-1',
  day: '2026-11-17',
  qty: 150,
  hours: 18.75,
  planner: 'TABLE',
  partNum: 'PODSE00010',
  description: 'C-Leg Table',
  lastAt: '2026-11-17T15:03',
  entries: 2,
};

const row = (over: Partial<StoredDay> = {}): StoredDay => ({
  id: '1', recordKey: '', day: '2026-11-17', op: '', wip: false, line: 'Table',
  operators: [], operatorIds: [], dueDate: null, orderQty: null, plannedHours: null,
  completedBy: [], completedByIds: [], confirmedBy: '', confirmedAt: '', epicorQty: null, ...over,
});

describe('the row a completion is written into', () => {
  it('reads a list row the way the board wrote it', () => {
    expect(readStoredDay({
      id: '7',
      fields: {
        Date: '2026-11-17T00:00:00Z', WorkDescription: 'Op 30 stapling', WorkType: 'WIP', Line: 'UPL-SSS',
        Operators: 'Ana, Bo', OperatorIds: '11,12', CompletedBy: 'Ana', CompletionConfirmedAt: '2026-11-18T07:10:00Z', EpicorQty: 40,
      },
    })).toMatchObject({ id: '7', op: '30', wip: true, operators: ['Ana', 'Bo'], operatorIds: ['11', '12'], completedBy: ['Ana'], epicorQty: 40, confirmedAt: '2026-11-18T07:10:00Z' });
  });

  it('is the row holding the completion’s key, else the order’s newest row that day', () => {
    const rows = [
      row({ id: '4', day: '2026-11-16', recordKey: done.key }),
      row({ id: '2' }),
      row({ id: '3' }),
    ];
    // The key wins over the Date, which a site's timezone can shift a day.
    expect(recordFor(rows, done)?.id).toBe('4');
    expect(recordFor(rows.slice(1), done)?.id).toBe('3');
    expect(recordFor([row({ day: '2026-11-18' })], done)).toBeNull();
  });

  it('offers the people named that day, else the latest day before it that names anyone', () => {
    const rows = [
      row({ id: '1', day: '2026-11-13', operators: ['Ana'], operatorIds: ['11'] }),
      row({ id: '2', day: '2026-11-16', operators: ['Bo', 'Cy'], operatorIds: ['12', '13'] }),
      row({ id: '3', day: '2026-11-18', operators: ['Di'], operatorIds: ['14'] }),
    ];
    expect(suggestedCrew(rows, '2026-11-17')).toEqual({ ids: ['12', '13'], names: ['Bo', 'Cy'] });
    expect(suggestedCrew(rows, '2026-11-13').names).toEqual(['Ana']);
    expect(suggestedCrew(rows, '2026-11-01')).toEqual({ ids: [], names: [] });
  });

  it('writes a whole record: the day’s quantity, the names, and a standard that gives back Epicor’s hours', () => {
    const people = [{ id: '11', name: 'Ana' }, { id: '12', name: 'Bo' }];
    const order = { line: 'Table', dueDate: '2026-11-20T00:00:00Z', orderQty: 300 };
    const fields = completionRow(done, people, 'Jeff Penn', new Date('2026-11-18T07:00:00Z'), order, 150);
    expect(fields).toMatchObject({
      Title: '018474-10-1', Date: '2026-11-17', RecordKey: '018474-10-1|2026-11-17', Line: 'Table',
      Operators: 'Ana, Bo', OperatorIds: '11,12', Complete: 150, ShiftOutput: 150, Reject: 0,
      OrderQty: 300, PlannedHours: 37.5, RemainingQty: 150, DueDate: '2026-11-20T00:00:00Z',
      JobCompleted: false, CompletedAt: null,
      [C.epicorQty]: 150, [C.epicorHours]: 18.75, [C.epicorDescription]: 'C-Leg Table', [C.completedBy]: 'Ana, Bo', [C.confirmedBy]: 'Jeff Penn',
      [C.confirmedAt]: '2026-11-18T07:00:00.000Z',
    });
    // Complete × PlannedHours ÷ OrderQty is Epicor's hours.
    expect((150 * 37.5) / 300).toBe(18.75);
    // The day the running total reaches the order's quantity finishes it.
    const last = completionRow(done, people, 'J', new Date(), order, 300);
    expect(last).toMatchObject({ JobCompleted: true, RemainingQty: 0 });
    expect(last.CompletedAt).toBe(new Date(2026, 10, 17, 15, 3).toISOString());
    // With no order quantity known, the day's own quantity carries the rate.
    expect(completionRow(done, people, 'J', new Date(), { line: 'Table', dueDate: null, orderQty: null }, 150))
      .toMatchObject({ OrderQty: 150, PlannedHours: 18.75, JobCompleted: false });
  });

  it('takes the order’s line, Due Date and quantity from the planning rows, receiving rows first', () => {
    expect(orderFromRows([
      row({ wip: true, line: 'UPL-Gluing', orderQty: 40 }),
      row({ line: 'UPL-SSS', dueDate: '2026-11-21T00:00:00Z', orderQty: 40 }),
    ])).toEqual({ line: 'UPL-SSS', dueDate: '2026-11-21T00:00:00Z', orderQty: 40 });
  });

  it('writes only the columns the list has, but always its key', () => {
    const schema = ['Title', 'Date', 'Line'].map((n) => ({ InternalName: n, Title: n }));
    expect(fieldsFor({ Title: 'J', Date: 'd', RecordKey: 'k', Line: 'L', RemainingQty: 1 }, schema))
      .toEqual({ Title: 'J', Date: 'd', RecordKey: 'k', Line: 'L' });
    expect(fieldsFor({ RemainingQty: 1 }, null)).toEqual({ RemainingQty: 1 });
  });
});

describe('writing a confirmation', () => {
  const cfg = { siteUrl: 'https://x.sharepoint.com/sites/PMD', filePath: '', token: '', authMode: 'session' as const };
  beforeEach(() => vi.resetAllMocks());

  it('writes over the row already holding the completion', async () => {
    vi.mocked(lists.updateListItem).mockResolvedValue({ ok: true, value: undefined } as never);
    const res = await writeCompletion(cfg, 'ASSY_CompletedJobs', done, row({ id: '9' }), { [C.completedBy]: 'Ana' });
    expect(res.ok).toBe(true);
    expect(lists.updateListItem).toHaveBeenCalledWith(cfg, 'ASSY_CompletedJobs', '9', { [C.completedBy]: 'Ana' });
    expect(lists.createListItem).not.toHaveBeenCalled();
  });

  it('opens a row for a new completion, and writes over one that appeared meanwhile', async () => {
    vi.mocked(lists.createListItem).mockResolvedValueOnce({ ok: true, value: '21' });
    const opened = await writeCompletion(cfg, 'L', done, null, {});
    expect(opened.ok && opened.value.id).toBe('21');

    vi.mocked(lists.createListItem).mockResolvedValueOnce({ ok: false, error: { status: 400, message: 'duplicate key' } });
    vi.mocked(lists.fetchRowsWhere).mockResolvedValueOnce({ ok: true, value: [{ id: '30', fields: { Title: done.jobNum, Date: '2026-11-16T13:00:00Z', RecordKey: done.key } }] });
    vi.mocked(lists.updateListItem).mockResolvedValue({ ok: true, value: undefined } as never);
    const joined = await writeCompletion(cfg, 'L', done, null, { x: 1 });
    expect(joined.ok && joined.value.id).toBe('30');
    expect(lists.updateListItem).toHaveBeenCalledWith(cfg, 'L', '30', { x: 1 });
  });

  it('reads each order’s rows by its number, or the whole list where it cannot ask', async () => {
    vi.mocked(lists.fetchRowsWhere).mockImplementation(async (_c, _l, _col, job) => ({
      ok: true, value: [{ id: job === 'A' ? '1' : '2', fields: { Title: job, Date: '2026-11-17' } }],
    }));
    const asked = await storedDaysFor(cfg, 'L', ['A', 'B']);
    expect(asked.ok && [...asked.value.keys()]).toEqual(['A', 'B']);

    vi.mocked(lists.fetchRowsWhere).mockResolvedValue(null);
    vi.mocked(lists.fetchListItemsWithIds).mockResolvedValue({ ok: true, value: [
      { id: '1', fields: { Title: 'A', Date: '2026-11-17' } },
      { id: '5', fields: { Title: 'Z', Date: '2026-11-17' } },
    ] });
    const all = await storedDaysFor(cfg, 'L', ['A']);
    expect(all.ok && [...all.value.keys()]).toEqual(['A']);
  });
});
