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

describe('renderJobTraceCards — day grouping', () => {
  it('renders detailed per-shift cards for ≤3 shifts', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([shift('2026-07-01-Day'), shift('2026-07-01-Afternoon'), shift('2026-07-01-Night')]),
      'J1',
    );
    expect(html).not.toContain('trace-day-card');
    // One card head per shift (per-shift cards, not day-grouped).
    expect((html.match(/trace-card-head/g) ?? []).length).toBe(3);
  });

  it('heads every per-shift card with its date, identity left to the title', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day', { jobRequired: 1000, partNumber: 'POPL01035' }),
        shift('2026-07-01-Night', { jobRequired: 1000, partNumber: 'POPL01035' }),
      ]),
      'J1',
    );
    const heads = Array.from(html.matchAll(/trace-card-head">\s*<b>([^<]*)<\/b>/g)).map((m) => m[1]);
    // Both cards, not just the first — map() would otherwise pass the
    // array index in as the hide flag.
    expect(heads).toEqual(['2026-07-01', '2026-07-01']);
    expect(html).not.toContain('POPL01035');
    expect(html).toContain('>Day</span>');
    expect(html).toContain('>Night</span>');
  });

  it('groups into one day card per date once a job spans >3 shifts', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day'),
        shift('2026-07-01-Afternoon'),
        shift('2026-07-02-Day'),
        shift('2026-07-02-Afternoon'),
      ]),
      'J1',
    );
    // Two dates → two day cards, oldest first.
    const dayCards = html.match(/trace-day-card/g) ?? [];
    expect(dayCards.length).toBe(2);
    expect(html.indexOf('2026-07-01')).toBeLessThan(html.indexOf('2026-07-02'));
    // Each day card holds its date's shift blocks (4 shifts total).
    expect((html.match(/trace-day-shift"/g) ?? []).length).toBe(4);
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
});

describe('renderJobTraceCards — chronological order', () => {
  /** Shift codes must be ranked by the clock, not alphabetically:
   *  "Afternoon" < "Day" < "Night" as text would put 15:00 first. */
  it('orders the per-shift cards Day → Afternoon → Night', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([shift('2026-07-01-Night'), shift('2026-07-01-Afternoon'), shift('2026-07-01-Day')]),
      'J1',
    );
    expect(html.indexOf('Day')).toBeLessThan(html.indexOf('Afternoon'));
    expect(html.indexOf('Afternoon')).toBeLessThan(html.indexOf('Night'));
  });

  it('keeps Day → Afternoon → Night inside each day card', async () => {
    const { html } = await renderJobTraceCards(
      stubDal([
        shift('2026-07-02-Night'),
        shift('2026-07-01-Afternoon'),
        shift('2026-07-02-Day'),
        shift('2026-07-01-Day'),
      ]),
      'J1',
    );
    const order = Array.from(html.matchAll(/trace-day-shift-hd">\s*<b>(\w+)<\/b>/g)).map(
      (m) => m[1],
    );
    expect(order).toEqual(['Day', 'Afternoon', 'Day', 'Night']);
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
