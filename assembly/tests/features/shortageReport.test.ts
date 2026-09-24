import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import type { PickShortage } from '@/engine/assembly/pickShortage';
import { PartId } from '@/domain/ids';
import { shortageReport } from '@/features/assembly/shortageReport';
import { filteredOrderIds, rowsInView } from '@/features/assembly/boardView';

const d = (iso: string) => new Date(`${iso}T00:00:00`);

const short = (
  part: string,
  shortQty: number,
  po: { qty: number; at: string | null; covers: boolean } | null,
): PickShortage => ({
  part: PartId(part),
  description: `${part} desc`,
  requiredQty: shortQty,
  onHand: 0,
  heldEarlier: 0,
  shortQty,
  incoming: po && {
    qty: po.qty,
    heldEarlier: 0,
    availableDate: po.at ? d(po.at) : null,
    coversShort: po.covers,
    releases: [],
  },
});

const row = (id: string, due: string | null, shortPicks: PickShortage[], line = 'ASSY'): OrderRow =>
  ({
    job: { id, dueDate: due ? d(due) : null },
    line: { key: line, name: line, schedulable: true },
    shortPicks,
    predecessors: [],
    crewDays: [],
    completedToday: false,
  }) as unknown as OrderRow;

describe('what the orders in view are short of', () => {
  it('turns order shortages round into parts, with the orders short of each', () => {
    const report = shortageReport([
      row('J1', '2026-10-10', [short('FRAME', 20, { qty: 50, at: '2026-10-01', covers: true })]),
      row('J2', '2026-10-05', [
        short('FRAME', 30, { qty: 50, at: '2026-10-08', covers: true }),
        short('FOAM', 5, null),
      ]),
      row('J3', '2026-10-20', []),
    ]);
    expect(report.orders).toBe(2);
    expect(report.uncoveredOrders).toBe(1);
    // J2: FOAM nothing on order, FRAME after its Due Date.
    expect(report.lateOrders).toBe(1);
    // A part nothing covers first.
    expect(report.parts.map((p) => p.part)).toEqual(['FOAM', 'FRAME']);
    const frame = report.parts[1];
    expect(frame).toMatchObject({ shortQty: 50, onOrder: 50, uncovered: 0 });
    expect(frame.lastArrival).toEqual(d('2026-10-08'));
    // Earliest Due Date first.
    expect(frame.orders.map((o) => [o.orderNum, o.shortQty, o.late])).toEqual([
      ['J2', 30, true],
      ['J1', 20, false],
    ]);
    expect(report.parts[0]).toMatchObject({ onOrder: 0, uncovered: 1, lastArrival: null });
  });

  it('counts a routed order once, whichever of its operations are on screen', () => {
    const picks = [short('FRAME', 20, null)];
    const report = shortageReport([row('J1#10', null, picks), row('J1#20', null, picks)]);
    expect(report.orders).toBe(1);
    expect(report.parts[0].orders).toHaveLength(1);
    expect(report.parts[0].orders[0]).toMatchObject({ orderNum: 'J1', rowId: 'J1#10' });
  });

  it('reads nothing when nothing in view is short', () => {
    expect(shortageReport([row('J1', null, [])])).toEqual({
      parts: [],
      orders: 0,
      uncoveredOrders: 0,
      lateOrders: 0,
    });
  });
});

describe('the orders in the current view', () => {
  const a = row('A', '2026-09-25', [], 'ASSY');
  const b = row('B', '2026-12-01', [], 'ASSY');
  const c = row('C', '2026-09-25', [], 'TABLE');
  const groups = [
    { line: { key: 'ASSY', schedulable: true }, rows: [a, b] },
    { line: { key: 'TABLE', schedulable: true }, rows: [c] },
  ] as never;

  it('leaves out lines taken off the board', () => {
    const shown = rowsInView(groups, { hiddenLines: ['TABLE'] as never, ids: null, orderDay: null });
    expect(shown.map((r) => r.job.id)).toEqual(['A', 'B']);
  });

  it('follows the Due-soon filter', () => {
    const ids = filteredOrderIds([a, b, c], {
      orderDay: null,
      dueSoon: true,
      dueSoonDays: 2,
      today: d('2026-09-24'),
    });
    const shown = rowsInView(groups, { hiddenLines: [], ids, orderDay: null });
    expect(shown.map((r) => r.job.id)).toEqual(['A', 'C']);
    expect(filteredOrderIds([a], { orderDay: null, dueSoon: false, dueSoonDays: 2, today: d('2026-09-24') })).toBeNull();
  });
});
