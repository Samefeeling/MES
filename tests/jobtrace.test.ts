import { describe, expect, it } from 'vitest';

import { renderJobTraceCards } from '../src/ui/trace';
import type { PmdDataLayer } from '../src/dal';
import { rec } from './helpers';

/** Minimal DAL stub: the KPI job-Trace popup only reads signed-off
 *  production for one job plus (empty) planning. */
function stubDal(records: ReturnType<typeof rec>[]): PmdDataLayer {
  return {
    listSignedOffProduction: async () => records,
    listPlanning: async () => [],
    listRejectCategories: async () => [
      { code: 'D07', label: 'ShortShot', sequence: 1 },
      { code: 'D09', label: 'Flash', sequence: 2 },
    ],
  } as unknown as PmdDataLayer;
}

const shift = (shiftId: string, over: Partial<ReturnType<typeof rec>> = {}) =>
  rec({
    jobNumber: 'J1',
    slotIndex: 0,
    statusCode: 'R',
    machineCode: '125T',
    shiftId,
    locked: true,
    countStart: 0,
    countEnd: 40,
    ...over,
  });

const BLOCK =
  /<div class="trace-day-shift( is-empty)?"[^>]*>\s*<div class="trace-day-shift-hd">\s*<b>(\w+)<\/b>/g;

/** Shift codes in document order, with the ones that have no production
 *  marked — `Night*` means "rendered, but empty". */
const blockStates = (html: string): string[] =>
  Array.from(html.matchAll(BLOCK)).map((m) => `${m[2]}${m[1] ? '*' : ''}`);

/** The same, grouped by day card. */
const blocksPerCard = (html: string): string[][] =>
  html
    .split('<div class="trace-card trace-day-card">')
    .slice(1)
    .map((card) => Array.from(card.matchAll(BLOCK)).map((m) => m[2]));

describe('renderJobTraceCards — every day is a fixed Day | Afternoon | Night row', () => {
  it('lays out all three shifts even when the order ran only one', async () => {
    const { html } = await renderJobTraceCards(stubDal([shift('2026-07-01-Night')]), 'J1');
    expect(blockStates(html)).toEqual(['Day*', 'Afternoon*', 'Night']);
    // The one shift that ran must not be widened to fill the row: the
    // three columns come from the grid, so all three boxes exist.
    expect(blockStates(html)).toHaveLength(3);
  });

  it('leaves a Day column standing when the order ran only Afternoon and Night', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([shift('2026-07-01-Afternoon'), shift('2026-07-01-Night')]),
      'J1',
    );
    expect(blockStates(html)).toEqual(['Day*', 'Afternoon', 'Night']);
  });

  it('uses the same day grid however many shifts the order ran', async () => {
    for (const ids of [
      ['2026-07-01-Day'],
      ['2026-07-01-Day', '2026-07-01-Night'],
      ['2026-07-01-Day', '2026-07-01-Afternoon', '2026-07-01-Night'],
    ]) {
      const { html } = await renderJobTraceCards(stubDal(ids.map((i) => shift(i))), 'J1');
      expect(html).toContain('trace-day-card');
      expect(blockStates(html).map((s) => s.replace('*', ''))).toEqual([
        'Day',
        'Afternoon',
        'Night',
      ]);
    }
  });

  it('marks the empty blocks so the eye skips them, and says why', async () => {
    const { html } = await renderJobTraceCards(stubDal([shift('2026-07-01-Day')]), 'J1');
    expect((html.match(/trace-day-none">Not run</g) ?? []).length).toBe(2);
    expect(html).toContain('recorded no production in the Afternoon shift on 2026-07-01');
  });

  it('reports an empty state when the job has no signed-off records', async () => {
    const { html } = await renderJobTraceCards(stubDal([]), 'NOPE');
    expect(html).toContain('No signed-off production records');
  });

  it('renders signed QC cells as bare initials, without the operator-sheet ✓', async () => {
    const r = shift('2026-07-01-Day');
    r.qcBy = 'John Taylor';
    const { html } = await renderJobTraceCards(stubDal([r]), 'J1');
    expect(html).toContain('>JT</div>');
    expect(html).not.toContain('✓');
  });

  it('keeps names out of the header line, where they broke the alignment', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Afternoon', { operator: 'Trong (Danny) Nguyen', supervisor: 'Jeff Penn' }),
        shift('2026-07-01-Night', { operator: 'Van Minh Ma', supervisor: 'Jeff Penn' }),
      ]),
      'J1',
    );
    const headers = Array.from(html.matchAll(/trace-day-shift-hd">([\s\S]*?)<\/div>/g)).map((m) =>
      m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    // Operator names are the one unbounded-length item: inline, the long
    // one wraps its header to two lines and the short one doesn't, which
    // pushes one block's grids out of line with its neighbour's.
    expect(headers.every((h) => !/Nguyen|Van Minh/.test(h))).toBe(true);
    expect(headers[1]).toMatch(/^Afternoon G \d+ R \d+ Target \S+ Left \S+$/);
    // Still reachable, just not on the line that has to stay one line.
    expect(html).toContain('Operator Trong (Danny) Nguyen · Supervisor Jeff Penn');
  });

  it('shows only the reject count in the slot, with the detail on hover', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day'),
        shift('2026-07-01-Day', {
          slotIndex: 4,
          rejectCount: 4,
          rejects: JSON.stringify({ D07: 1, D09: 3 }),
        }),
      ]),
      'J1',
    );
    const cells = Array.from(
      html.matchAll(/<div class="trace-rej-slot has-rej" title="([^"]*)">([^<]*)<\/div>/g),
    ).map((m) => ({ tip: m[1], text: m[2] }));
    expect(cells).toHaveLength(1);
    // The cell is the total and nothing else — no codes, no ×, no <br>.
    expect(cells[0].text).toBe('4');
    // Time, then each code with its description and quantity.
    expect(cells[0].tip).toContain('4 rejects');
    expect(cells[0].tip).toContain('D09 Flash × 3');
    expect(cells[0].tip).toContain('D07 ShortShot × 1');
    expect(cells[0].tip.split('&#10;')[0]).toMatch(/^\d{2}:\d{2}/);
    // Biggest contributor first — that's the one worth acting on.
    expect(cells[0].tip.indexOf('D09')).toBeLessThan(cells[0].tip.indexOf('D07'));
  });

  it('spells the same detail onto the status slot the rejects happened in', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day'),
        shift('2026-07-01-Day', { slotIndex: 4, rejects: JSON.stringify({ D07: 2 }) }),
      ]),
      'J1',
    );
    const slot = html.match(/<div class="trace-slot" title="([^"]*)"[^>]*>R<\/div>/g) ?? [];
    expect(slot.join()).toContain('D07 ShortShot × 2');
  });

  it('falls back to the bare code when the tenant has no description for it', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day'),
        shift('2026-07-01-Day', { slotIndex: 4, rejects: JSON.stringify({ ZZ9: 2 }) }),
      ]),
      'J1',
    );
    expect(html).toContain('ZZ9 × 2');
  });

  it('carries the shift target and any breakdown detail into the block', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day', { jobRequired: 1000, cycleTime: 0.01 }),
        shift('2026-07-01-Day', {
          slotIndex: 4,
          statusCode: 'B',
          bdIssue: 'B01',
          mangoTicket: 'MG-77',
        }),
      ]),
      'J1',
    );
    expect(html).toContain('Target ');
    expect(html).toContain('Breakdowns');
    expect(html).toContain('B01');
    expect(html).toContain('MG-77');
  });
});

describe('renderJobTraceCards — chronological order', () => {
  it('runs the day cards oldest → newest', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-02-Day'),
        shift('2026-07-01-Afternoon'),
        shift('2026-07-03-Night'),
      ]),
      'J1',
    );
    const dates = Array.from(html.matchAll(/trace-card-head">\s*<b>([^<]*)<\/b>/g)).map((m) => m[1]);
    expect(dates).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  /** Shift codes must be ranked by the clock, not alphabetically:
   *  "Afternoon" < "Day" < "Night" as text would put 15:00 first. */
  it('keeps Day → Afternoon → Night inside every day card', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-02-Night'),
        shift('2026-07-01-Afternoon'),
        shift('2026-07-02-Day'),
        shift('2026-07-01-Day'),
      ]),
      'J1',
    );
    expect(blocksPerCard(html)).toEqual([
      ['Day', 'Afternoon', 'Night'],
      ['Day', 'Afternoon', 'Night'],
    ]);
    // …and the empties land where the order genuinely didn't run.
    expect(blockStates(html)).toEqual([
      'Day',
      'Afternoon',
      'Night*',
      'Day',
      'Afternoon*',
      'Night',
    ]);
  });
});

describe('renderJobTraceCards — heading', () => {
  // jobRequired makes the row self-describing (syntheticOrderFromRecord),
  // which is where a past shift's part identity comes from when planning
  // no longer carries the order.
  const spread = (over: Partial<ReturnType<typeof rec>> = {}) => [
    shift('2026-07-01-Day', { jobRequired: 1000, ...over }),
    shift('2026-07-01-Afternoon', { jobRequired: 1000, ...over }),
    shift('2026-07-02-Day', { jobRequired: 1000, ...over }),
    shift('2026-07-02-Afternoon', { jobRequired: 1000, ...over }),
  ];

  it('names order, machine, part and description', async () => {
    const { heading } = await renderJobTraceCards(
      stubDal(spread({ partNumber: 'POPL01035', partDescription: 'Postura Max Chair - Slate' })),
      'J1',
    );
    expect(heading).toContain('>J1<');
    expect(heading).toContain('125T · POPL01035');
    expect(heading).toContain('— Postura Max Chair - Slate');
  });

  it('moves that identity off the day cards, leaving them headed by the date', async () => {
    const { html } = await renderJobTraceCards(
      stubDal(spread({ partNumber: 'POPL01035', partDescription: 'Postura Max Chair - Slate' })),
      'J1',
    );
    const heads = Array.from(html.matchAll(/trace-card-head">\s*<b>([^<]*)<\/b>/g)).map((m) => m[1]);
    expect(heads).toEqual(['2026-07-01', '2026-07-02']);
    expect(html).not.toContain('POPL01035');
  });

  it('keeps the press on each card when the order moved between machines', async () => {
    const rows = spread();
    rows[2].machineCode = '550T';
    rows[3].machineCode = '550T';
    const { heading, html } = await renderJobTraceCards(stubDal(rows), 'J1');
    expect(heading).toContain('125T / 550T');
    expect(html).toContain('>125T<');
    expect(html).toContain('>550T<');
  });

  it('still titles the popup when the job has no records', async () => {
    const { heading } = await renderJobTraceCards(stubDal([]), 'NOPE');
    expect(heading).toContain('NOPE');
  });
});
