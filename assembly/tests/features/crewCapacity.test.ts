import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import { DEFAULT_CREW_POOLS, type LineKey } from '@/domain/assembly';
import { boardHours, capacityDays, shareDay } from '@/features/assembly/crewCapacity';

const demand = (entries: [string, number][]) => new Map(entries as [LineKey, number][]);

describe('crews share the lines the supervisor gave them', () => {
  // Upholstery crew: 4 × 7.5 = 30 h. Assembly crew: 30 h. Table: 22.5 h.
  it('measures each crew against its own lines', () => {
    const day = shareDay(demand([['UPL_CUT_SEW', 15], ['TABLE', 22.5]]), DEFAULT_CREW_POOLS, true);
    expect(day.pools.map((p) => [p.id, p.capacity, p.demand, p.pct])).toEqual([
      ['upholstery', 30, 15, 50],
      ['assembly', 30, 0, 0],
      ['table', 22.5, 22.5, 100],
    ]);
    expect(day.lines.get('UPL_CUT_SEW' as LineKey)).toMatchObject({ pools: ['Upholstery crew'], pct: 50, band: 'green' });
  });

  it('works a shared line with its first crew, and borrows only the room the next one has left', () => {
    // Upholstery crew has 30 - 20 = 10 h spare; the other 14 h of UPL-Gluing
    // go to the assembly crew, which has 30 - 10 = 20 h spare.
    const day = shareDay(
      demand([['UPL_CUT_SEW', 20], ['UPL_GLUING', 24], ['ASSY', 10]]),
      DEFAULT_CREW_POOLS,
      true,
    );
    expect(day.pools.slice(0, 2).map((p) => p.demand)).toEqual([30, 24]);
    expect(day.lines.get('UPL_GLUING' as LineKey)).toMatchObject({
      pools: ['Upholstery crew', 'Assembly crew'], capacity: 60, demand: 54, pct: 90,
    });
    // The cutters' crew is now full, and says so on UPL-CUT's row.
    expect(day.lines.get('UPL_CUT_SEW' as LineKey)?.pct).toBe(100);
  });

  it('leaves what nobody has room for on the first crew, which reads over', () => {
    const day = shareDay(demand([['UPL_GLUING', 70]]), DEFAULT_CREW_POOLS, true);
    expect(day.pools.slice(0, 2).map((p) => p.demand)).toEqual([40, 30]);
    expect(day.lines.get('UPL_GLUING' as LineKey)?.band).toBe('red');
  });

  it('has no capacity at the weekend, and none behind a line no crew lists', () => {
    const weekend = shareDay(demand([['ASSY', 5]]), DEFAULT_CREW_POOLS, false);
    expect(weekend.pools.every((p) => p.capacity === 0)).toBe(true);
    expect(weekend.lines.get('ASSY' as LineKey)?.band).toBe('red');
    const general = shareDay(demand([['FACTORY_GENERAL', 6]]), DEFAULT_CREW_POOLS, true);
    expect(general.unpooled).toBe(6);
    expect(general.lines.get('FACTORY_GENERAL' as LineKey)).toMatchObject({ pools: [], pct: null });
  });
});

describe('the banner is the sum of the lines', () => {
  const day = (key: string) => new Date(`${key}T00:00:00`);
  const row = (id: string, line: string, extra: Partial<OrderRow>): OrderRow =>
    ({
      job: { id, dueDate: null, laborHrs: 15, remainingQty: 10, completedQty: 0 },
      line: { key: line, schedulable: true },
      workers: [],
      crewDays: [],
      booked: [],
      plannedStart: day('2026-09-14'),
      start: day('2026-09-14'),
      completedToday: false,
      ...extra,
    }) as unknown as OrderRow;

  it('adds crewed and waiting hours over every lane, benches on their lane', () => {
    const cut = row('A', 'UPL_CUT_SEW', {
      crewDays: [{ day: '2026-09-14', date: day('2026-09-14'), from: 0, hours: 15, perWorkerHours: 7.5, workerIds: ['1', '2'] }],
    } as Partial<OrderRow>);
    const sew = row('B', 'UPL_GLUING_SEW', {
      crewDays: [{ day: '2026-09-14', date: day('2026-09-14'), from: 0, hours: 7.5, perWorkerHours: 7.5, workerIds: ['3'] }],
    } as Partial<OrderRow>);
    // Nobody on it, due Tuesday: its 15 h belong on Monday.
    const waiting = row('C', 'ASSY', { start: null, uncoveredHours: 15 } as Partial<OrderRow>);
    (waiting.job as { dueDate: Date | null }).dueDate = day('2026-09-15');

    const [monday] = capacityDays([cut, sew, waiting], DEFAULT_CREW_POOLS, () => 3, [day('2026-09-14')], day('2026-09-14'));
    expect(monday).toMatchObject({ crewed: 22.5, waiting: 15, capacity: 82.5, isToday: true });
    expect(Math.round(monday.pct)).toBe(45);
    expect(monday.lines.get('UPL_GLUING' as LineKey)?.load.hours).toBe(7.5);
    expect(monday.lines.get('ASSY' as LineKey)?.load.unstaffedHours).toBe(15);
    const lineTotal = [...monday.lines.values()].reduce((s, l) => s + l.load.hours + l.load.unstaffedHours, 0);
    expect(lineTotal).toBe(monday.crewed + monday.waiting);
  });
});

describe('hours on the board, against the crews', () => {
  const r = (line: string, hours: number, schedulable = true) =>
    ({
      line: { key: line, schedulable },
      job: { laborHrs: hours, remainingQty: 1, completedQty: 0 },
    }) as never;
  const pools = [
    { id: 'u', name: 'Upholstery', lines: ['UPL_CUT_SEW', 'UPL_GLUING'], people: 4 },
    { id: 'a', name: 'Assembly', lines: ['ASSY', 'UPL_GLUING'], people: 2 },
  ] as never;

  it('reads each crew’s hours against its people, splitting a shared line by headcount', () => {
    const got = boardHours(
      [r('UPL_CUT_SEW', 30), r('UPL_GLUING', 30), r('ASSY', 15), r('GENERAL', 5), r('PMD', 99, false)],
      pools,
    );
    expect(got.total).toBe(80);
    const [u, a] = got.pools;
    expect(u.hours).toBeCloseTo(50, 6); // 30 own + 4/6 of 30
    expect(u.perDay).toBe(30);
    expect(u.days).toBeCloseTo(50 / 30, 6);
    expect(a.hours).toBeCloseTo(25, 6); // 15 own + 2/6 of 30
    expect(got.unpooled).toEqual([{ key: 'GENERAL', hours: 5 }]);
    expect(got.perDay).toBe(45);
    expect(got.days).toBeCloseTo(75 / 45, 6);
  });
});
