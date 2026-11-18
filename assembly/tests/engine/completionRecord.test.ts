import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  COMPLETION_COLUMNS as C,
  completionFields,
  newCompletionRow,
  readStoredDay,
  rowForCompletion,
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
import { storedDaysFor, writeCompletion } from '@/data/sharepoint/completion.list';

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
  id: '1', day: '2026-11-17', op: '', wip: false, line: 'Table',
  operators: [], operatorIds: [], completedBy: [], completedByIds: [],
  confirmedBy: '', confirmedAt: '', epicorQty: null, ...over,
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

  it('is the day’s receiving operation, the last of them; none when the order has no row that day', () => {
    const rows = [
      row({ id: '1', op: '10', wip: true }),
      row({ id: '2', op: '20' }),
      row({ id: '3', op: '30' }),
      row({ id: '4', day: '2026-11-18' }),
    ];
    expect(rowForCompletion(rows, '2026-11-17')?.id).toBe('3');
    expect(rowForCompletion([row({ id: '1', op: '10', wip: true })], '2026-11-17')?.id).toBe('1');
    expect(rowForCompletion(rows, '2026-11-16')).toBeNull();
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

  it('writes Epicor’s figures and the names into columns of their own, never the board’s', () => {
    const fields = completionFields(done, [{ id: '11', name: 'Ana' }, { id: '12', name: 'Bo' }], 'Jeff Penn', new Date('2026-11-18T07:00:00Z'));
    expect(fields).toMatchObject({
      [C.epicorQty]: 150, [C.epicorHours]: 18.75, [C.epicorPartNum]: 'PODSE00010',
      [C.completedBy]: 'Ana, Bo', [C.completedByIds]: '11,12', [C.confirmedBy]: 'Jeff Penn',
      [C.confirmedAt]: '2026-11-18T07:00:00.000Z',
    });
    for (const owned of ['Operators', 'OperatorIds', 'Complete', 'ShiftOutput', 'JobCompleted', 'CompletedAt']) {
      expect(fields).not.toHaveProperty(owned);
    }
    expect(newCompletionRow(done, 'Table', fields)).toMatchObject({
      Title: '018474-10-1', Date: '2026-11-17', RecordKey: '018474-10-1|2026-11-17', Line: 'Table',
    });
  });
});

describe('writing a confirmation', () => {
  const cfg = { siteUrl: 'https://x.sharepoint.com/sites/PMD', filePath: '', token: '', authMode: 'session' as const };
  beforeEach(() => vi.resetAllMocks());

  it('updates the day’s row in place', async () => {
    vi.mocked(lists.updateListItem).mockResolvedValue({ ok: true, value: undefined } as never);
    const res = await writeCompletion(cfg, 'ASSY_Production', done, row({ id: '9' }), 'Table', { [C.completedBy]: 'Ana' });
    expect(res.ok).toBe(true);
    expect(lists.updateListItem).toHaveBeenCalledWith(cfg, 'ASSY_Production', '9', { [C.completedBy]: 'Ana' });
    expect(lists.createListItem).not.toHaveBeenCalled();
  });

  it('opens a row when the order has none that day, and joins one that appeared meanwhile', async () => {
    vi.mocked(lists.createListItem).mockResolvedValueOnce({ ok: true, value: '21' });
    const opened = await writeCompletion(cfg, 'L', done, null, 'Table', {});
    expect(opened.ok && opened.value.id).toBe('21');

    vi.mocked(lists.createListItem).mockResolvedValueOnce({ ok: false, error: { status: 400, message: 'duplicate key' } });
    vi.mocked(lists.fetchRowsWhere).mockResolvedValueOnce({ ok: true, value: [{ id: '30', fields: { Title: done.jobNum, Date: '2026-11-17' } }] });
    vi.mocked(lists.updateListItem).mockResolvedValue({ ok: true, value: undefined } as never);
    const joined = await writeCompletion(cfg, 'L', done, null, 'Table', { x: 1 });
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
