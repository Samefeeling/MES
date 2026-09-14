import { describe, expect, it, vi, afterEach } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';
import { parseHandover } from '../src/core/handover';
import { buildImpwDraft, detectImpwFindings, EMPTY_IMPW_SITE } from '../src/core/impw';
import { resetMangoToken, submitImpwToMango } from '../src/ui/mango-api';

const finding = detectImpwFindings([{
  machineCode: '1600T', machineName: 'Press', shiftId: '2026-09-07-Day',
  output: 100, reject: 10, yieldPct: 90, breakdownHrs: 0, breakdowns: [],
  jobs: [{ jobNumber: 'J1', partNumber: 'P1', partDescription: 'Part one' }],
  raisedTicket: '',
}], { yieldTarget: 95, rejectPerShiftMax: 5 })[0];

afterEach(() => { vi.unstubAllGlobals(); resetMangoToken(); });

it('defaults to Paul without inventing a tenant ID', () => {
  expect(buildImpwDraft(finding, { name: 'CK' }, EMPTY_IMPW_SITE).coordinator)
    .toEqual({ id: '', name: 'Paul Fiddling (AU)' });
});

describe('Mango confirmation', () => {
  it.each([
    [{ id: 'opaque' }, false, ''],
    [{ id: 'opaque', abbreviation: 'IMPW', number: '0123' }, true, 'IMPW 0123'],
  ])('requires a returned ticket number: %j', async (created, ok, ticket) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 })));
    const result = await submitImpwToMango(buildImpwDraft(finding, { name: 'CK' }, EMPTY_IMPW_SITE),
      { baseUrl: 'https://example.com', username: 'testuser', password: 'testpass' });
    expect(result.ok).toBe(ok);
    expect(result.ticketRef).toBe(ticket);
  });
});

describe('Handover writeback', () => {
  const setup = () => {
    const dal = new SharePointDataLayer('https://example.sharepoint.com/sites/test');
    const internal = dal as unknown as {
      fetchHeaders: ReturnType<typeof vi.fn>; getJson: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>;
    };
    let note = JSON.stringify({ machine: 'Existing machine note', mold: '', material: '', method: 'Original method' });
    internal.fetchHeaders = vi.fn().mockResolvedValue([
      { id: 42, machineCode: '1600T', date: '2026-09-07', shift: 'Day' },
      { id: 43, machineCode: '1600T', date: '2026-09-06', shift: 'Day' },
    ]);
    internal.getJson = vi.fn().mockImplementation(async () => ({ d: { Handover: note, __metadata: { etag: '"7"', type: 'SP.Data.PMD_ProductionListItem' } } }));
    internal.post = vi.fn().mockImplementation(async (_url, body) => { note = body.Handover; return new Response(null, { status: 204 }); });
    return { dal, internal, note: () => note };
  };

  it('updates only Handover, preserves notes, uses ETag, and deduplicates retries', async () => {
    const { dal, internal, note } = setup();
    await dal.appendImpwHandover('1600T', '2026-09-07-Day', 'IMPW 0123');
    await dal.appendImpwHandover('1600T', '2026-09-07-Day', 'IMPW 0123');
    expect(internal.post).toHaveBeenCalledTimes(1);
    expect(Object.keys(internal.post.mock.calls[0][1]).sort()).toEqual(['Handover', '__metadata']);
    expect(internal.post.mock.calls[0][2]).toBe('"7"');
    expect(parseHandover(note())).toMatchObject({ machine: 'Existing machine note', method: 'Original method\nIMPW: IMPW 0123' });
  });

  it('reports write failure and missing production rows instead of claiming success', async () => {
    const { dal, internal } = setup();
    internal.post.mockRejectedValue(new Error('403 Forbidden'));
    await expect(dal.appendImpwHandover('1600T', '2026-09-07-Day', 'IMPW 0123')).rejects.toThrow('403');
    internal.fetchHeaders.mockResolvedValue([]);
    await expect(dal.appendImpwHandover('1600T', '2026-09-07-Day', 'IMPW 0123')).rejects.toThrow('No PMD_Production');
  });
});
