import { describe, expect, it } from 'vitest';
import type { CrewPool, LineKey } from '@/domain/assembly';
import type { OrderRow } from '@/engine/assembly/board';
import { pinsOf, planLevelLoad } from '@/features/assembly/levelLoad';

// Monday. Nine working days of 30 h — four people, 7.5 h each — from here.
const TODAY = new Date('2026-09-14T07:00:00');
const POOLS: CrewPool[] = [{ id: 'assy', name: 'Assembly crew', lines: ['ASSY'], people: 4 }];
const at = (key: string, time = '00:00:00') => new Date(`${key}T${time}`);

interface Opts {
  due: string;
  hours?: number;
  lane?: string;
  /** Pinned start day: the order is then drawn from it. */
  pinned?: string;
  materialAt?: string;
  crewed?: Record<string, number>;
  short?: boolean;
  predecessors?: OrderRow[];
  expect?: string;
}

/**
 * One board row with just what the plan reads. 15 h is one whole day at the
 * two people Crew orders would put on it; 45 h is three.
 */
function row(id: string, o: Opts): OrderRow {
  const hours = o.hours ?? 15;
  const crewDays = Object.entries(o.crewed ?? {}).map(([day, h]) => ({
    day, date: at(day), from: 0, used: 1, hours: h, workerIds: ['w1'], perWorkerHours: h,
  }));
  const days = Object.keys(o.crewed ?? {}).sort();
  return {
    job: {
      id, description: `Chair ${id}`, dueDate: at(o.due),
      laborHrs: hours, remainingQty: 10, completedQty: 0,
    },
    line: { key: (o.lane ?? 'ASSY') as LineKey, name: o.lane ?? 'ASSY', schedulable: true },
    workers: [], crewDays, booked: [], overtime: false, actualStart: null, completedToday: false,
    start: crewDays.length ? at(days[0], '07:00:00') : null,
    expectDate: crewDays.length ? new Date(at(days[days.length - 1]).getTime() + 86_400_000) : null,
    planThrough: null,
    plannedStart: o.pinned ? at(o.pinned, '07:00:00') : TODAY,
    startPinned: Boolean(o.pinned),
    uncoveredHours: crewDays.length ? 0 : hours,
    material: { level: 'ok', earliestStart: null, shortages: [] },
    materialReadyAt: o.materialAt ? at(o.materialAt) : null,
    shortPicks: o.short ? [{ incoming: null }] : [],
    predecessors: (o.predecessors ?? []).map((p) => ({
      jobId: id, onJobId: String(p.job.id), part: null, coveredFraction: 0,
    })),
  } as unknown as OrderRow;
}

const level = (rows: OrderRow[], days: string[], extra: Partial<Parameters<typeof planLevelLoad>[0]> = {}) =>
  planLevelLoad({
    rows, pools: POOLS, today: TODAY,
    picks: new Map([['ASSY' as LineKey, new Set(days)]]),
    ...extra,
  });
const moved = (plan: ReturnType<typeof level>) =>
  Object.fromEntries(plan.moves.map((m) => [m.jobId, m.toDay]));

describe('level loading', () => {
  // Three 15 h orders due Friday, none staffed: each is drawn on Thursday, which
  // is 45 h against the 30 h the crew can work.
  const three = () => [row('A', { due: '2026-09-18' }), row('B', { due: '2026-09-18' }), row('C', { due: '2026-09-18' })];

  it('moves what does not fit to the nearest day that has room, and only that', () => {
    const plan = level(three(), ['2026-09-17']);
    expect(plan.before.hours).toBeCloseTo(15);
    expect(plan.after.hours).toBe(0);
    // Two keep Thursday; the third goes to Wednesday — the day before, not after.
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ toDay: '2026-09-16', kind: 'level', fromDay: '2026-09-17' });
    expect(pinsOf(plan)[plan.moves[0].jobId]).toBe(new Date('2026-09-16T07:00:00').toISOString());
  });

  it('never fills a day past the ceiling it was given', () => {
    // At 80% a day holds 24 h: one 15 h order each.
    const plan = level(three(), ['2026-09-17'], { ceiling: 0.8 });
    expect(new Set(plan.moves.map((m) => m.toDay)).size).toBe(2);
    expect(plan.after.hours).toBe(0);
  });

  it('leaves the plan alone when nothing is over', () => {
    const plan = level(three().slice(0, 2), ['2026-09-17']);
    expect(plan.moves).toEqual([]);
    expect(plan.before.hours).toBe(0);
  });

  it('moves the order with the most slack, not the one due soonest', () => {
    // Monday: 10 h staffed and two orders pinned there, 40 h against 30. Both can
    // go to Tuesday; the one due next week is the one that yields.
    const rows = [
      row('CREW', { due: '2026-09-18', crewed: { '2026-09-14': 10 } }),
      row('SOON', { due: '2026-09-16', pinned: '2026-09-14' }),
      row('LATER', { due: '2026-09-25', pinned: '2026-09-14' }),
    ];
    const plan = level(rows, ['2026-09-14']);
    expect(moved(plan)).toEqual({ LATER: '2026-09-15' });
    expect(plan.after.hours).toBe(0);
  });

  it('will not pull an order before its material lands', () => {
    const rows = three();
    rows[2] = row('C', { due: '2026-09-18', materialAt: '2026-09-17' });
    const plan = level(rows, ['2026-09-17']);
    // C has nowhere earlier to go, so it keeps Thursday and one of the others yields.
    expect(moved(plan).C).toBeUndefined();
    expect(plan.moves).toHaveLength(1);
    expect(plan.after.hours).toBe(0);
  });

  it('says so when nothing before the Due Date has room', () => {
    const rows = [row('A', { due: '2026-09-15' }), row('B', { due: '2026-09-15' }), row('C', { due: '2026-09-15' })];
    // Tuesday's deadline leaves only today and Monday's… which is today. Two days,
    // three orders: the third has to go somewhere, and Monday has the room.
    const plan = level(rows, ['2026-09-14']);
    expect(plan.after.hours).toBeLessThanOrEqual(plan.before.hours);
    const tight = level([...rows, row('D', { due: '2026-09-15' }), row('E', { due: '2026-09-15' })], ['2026-09-14']);
    expect(tight.left.some((l) => l.kind === 'window')).toBe(true);
    expect(tight.stillOver.length).toBeGreaterThan(0);
  });

  it('holds an order short of material with no dated PO where it is', () => {
    const rows = three();
    rows[0] = row('A', { due: '2026-09-18', short: true });
    const plan = level(rows, ['2026-09-17']);
    expect(moved(plan).A).toBeUndefined();
    expect(plan.left.find((l) => l.jobId === 'A')).toMatchObject({ kind: 'held' });
  });

  it('counts a staffed order against the day but never moves it', () => {
    const rows = [
      row('CREW', { due: '2026-09-18', crewed: { '2026-09-17': 20 } }),
      row('A', { due: '2026-09-18' }),
    ];
    // 20 h staffed + 15 h waiting = 35 h on Thursday.
    const plan = level(rows, ['2026-09-17']);
    expect(plan.before.hours).toBeCloseTo(5);
    expect(moved(plan)).toEqual({ A: '2026-09-16' });
    expect(plan.left.find((l) => l.jobId === 'CREW')).toMatchObject({ kind: 'fixed' });
  });

  it('never puts work on a weekend', () => {
    // Monday's orders are due the Monday after: the pile is on Friday 18th.
    const rows = ['A', 'B', 'C'].map((id) => row(id, { due: '2026-09-21' }));
    const plan = level(rows, ['2026-09-18']);
    for (const m of plan.moves) expect([0, 6]).not.toContain(new Date(`${m.toDay}T00:00:00`).getDay());
  });

  it('has nothing to level against on a line no crew lists', () => {
    const rows = [row('A', { due: '2026-09-18', lane: 'TABLE' })];
    const plan = planLevelLoad({
      rows, pools: POOLS, today: TODAY,
      picks: new Map([['TABLE' as LineKey, new Set(['2026-09-17'])]]),
    });
    expect(plan.noCrew).toEqual(['TABLE']);
    expect(plan.moves).toEqual([]);
  });

  it('does not touch days behind today', () => {
    expect(level(three(), ['2026-09-11']).moves).toEqual([]);
  });

  describe('benches', () => {
    const upl: CrewPool[] = [{ id: 'upl', name: 'Upholstery crew', lines: ['UPL_SOFTIE'], people: 4 }];
    const onBench = (id: string, bench: string) => {
      const r = row(id, { due: '2026-09-18' });
      Object.assign(r, { line: { key: bench, name: bench, schedulable: true } });
      return r;
    };
    const rows = () => [onBench('A', 'UPL_SOFTIE_FOAM'), onBench('B', 'UPL_SOFTIE_FOAM'), onBench('C', 'UPL_SOFTIE_SEW')];
    const run = (line: string) =>
      planLevelLoad({ rows: rows(), pools: upl, today: TODAY, picks: new Map([[line as LineKey, new Set(['2026-09-17'])]]) });

    it('a bench’s block is its own orders, counted against the lane’s crew', () => {
      const plan = run('UPL_SOFTIE_FOAM');
      expect(plan.inScope).toBe(2);
      expect(plan.before.hours).toBeCloseTo(15);
      expect(plan.moves).toHaveLength(1);
      expect(['A', 'B']).toContain(plan.moves[0].jobId);
    });

    it('a lane’s block reaches every bench it is made of', () => {
      expect(run('UPL_SOFTIE').inScope).toBe(3);
    });
  });

  describe('linked orders', () => {
    it('pushes whatever waits for an order that is put later to start after it', () => {
      // Monday is full and A cannot come before Monday 21st (its material), so
      // it goes to Tuesday. B waits for A and was standing on that Tuesday.
      const a = row('A', { due: '2026-09-25', materialAt: '2026-09-21' });
      const rows = [
        row('FULL', { due: '2026-09-22', crewed: { '2026-09-21': 30 } }),
        row('A', { due: '2026-09-25', materialAt: '2026-09-21', pinned: '2026-09-21' }),
        row('B', { due: '2026-09-28', pinned: '2026-09-22', predecessors: [a] }),
      ];
      const plan = level(rows, ['2026-09-21']);
      expect(moved(plan)).toEqual({ A: '2026-09-22', B: '2026-09-23' });
      expect(plan.moves.find((m) => m.jobId === 'B')).toMatchObject({
        kind: 'linked', because: { order: 'A', effect: 'follows' },
      });
    });

    it('does not push it past the day it must start to make its own Due Date', () => {
      // B is due Wednesday: it cannot start later than Tuesday, so A has to finish
      // by Monday and cannot be the one to leave it.
      const a = row('A', { due: '2026-09-25' });
      const rows = [
        row('FULL', { due: '2026-09-22', crewed: { '2026-09-21': 30 } }),
        row('A', { due: '2026-09-25', materialAt: '2026-09-21', pinned: '2026-09-21' }),
        row('B', { due: '2026-09-23', predecessors: [a] }),
      ];
      const plan = level(rows, ['2026-09-21']);
      expect(moved(plan).A).toBeUndefined();
      expect(moved(plan).B).toBeUndefined();
      // And it says why A stayed over capacity.
      expect(plan.left.find((l) => l.jobId === 'A')?.why).toMatch(/B waits for it/);
      expect(plan.stillOver).toHaveLength(1);
    });

    it('brings a supplier in ahead of an order that is pulled forward', () => {
      // Thursday and Wednesday are full, so A can only go to Tuesday — which it
      // cannot do while P, the component it is made from, still runs on Tuesday.
      const p = row('P', { due: '2026-09-16' });
      const rows = [
        row('F1', { due: '2026-09-18', crewed: { '2026-09-16': 30, '2026-09-17': 30 } }),
        p,
        row('A', { due: '2026-09-18', predecessors: [p] }),
      ];
      const plan = level(rows, ['2026-09-17']);
      expect(moved(plan)).toEqual({ A: '2026-09-15', P: '2026-09-14' });
      expect(plan.moves.find((m) => m.jobId === 'P')).toMatchObject({
        kind: 'linked', because: { order: 'A', effect: 'ahead of' },
      });
    });

    it('keeps an order behind a press job that is still running', () => {
      const press = { ...row('PRESS', { due: '2026-09-16' }), line: { key: 'PMD', name: 'PMD', schedulable: false } } as unknown as OrderRow;
      Object.assign(press, { start: at('2026-09-14', '07:00:00'), expectDate: at('2026-09-16', '15:00:00') });
      const rows = [
        press,
        row('A', { due: '2026-09-18', predecessors: [press] }),
        row('B', { due: '2026-09-18' }),
        row('C', { due: '2026-09-18' }),
      ];
      const plan = level(rows, ['2026-09-17']);
      // Nobody may start A before the press job finishes on Wednesday.
      const a = plan.moves.find((m) => m.jobId === 'A');
      if (a) expect(a.toDay >= '2026-09-17').toBe(true);
      expect(plan.after.hours).toBe(0);
    });
  });
});
