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

const shift = (shiftId: string) =>
  rec({
    jobNumber: 'J1',
    slotIndex: 0,
    statusCode: 'R',
    machineCode: '125T',
    shiftId,
    locked: true,
    countStart: 0,
    countEnd: 40,
  });

describe('renderJobTraceCards — day grouping', () => {
  it('renders detailed per-shift cards for ≤3 shifts', async () => {
    const html = await renderJobTraceCards(
      stubDal([shift('2026-07-01-Day'), shift('2026-07-01-Afternoon'), shift('2026-07-01-Night')]),
      'J1',
    );
    expect(html).not.toContain('trace-day-card');
    // One card head per shift (per-shift cards, not day-grouped).
    expect((html.match(/trace-card-head/g) ?? []).length).toBe(3);
  });

  it('groups into one day card per date once a job spans >3 shifts', async () => {
    const html = await renderJobTraceCards(
      stubDal([
        shift('2026-07-01-Day'),
        shift('2026-07-01-Afternoon'),
        shift('2026-07-02-Day'),
        shift('2026-07-02-Afternoon'),
      ]),
      'J1',
    );
    // Two dates → two day cards, newest first.
    const dayCards = html.match(/trace-day-card/g) ?? [];
    expect(dayCards.length).toBe(2);
    expect(html.indexOf('2026-07-02')).toBeLessThan(html.indexOf('2026-07-01'));
    // Each day card holds its date's shift blocks (4 shifts total).
    expect((html.match(/trace-day-shift"/g) ?? []).length).toBe(4);
  });

  it('reports an empty state when the job has no signed-off records', async () => {
    const html = await renderJobTraceCards(stubDal([]), 'NOPE');
    expect(html).toContain('No signed-off production records');
  });
});
