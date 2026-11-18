/**
 * PMD and its presses fold to a load strip like any line, read against the
 * hours the presses can run — and none of it reaches the assembly board's
 * own figures.
 */
import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import { DEFAULT_CREW_POOLS } from '@/domain/assembly';
import { pressDayLoads, pressShifts } from '@/features/assembly/pressLoad';
import { boardHours, capacityDays } from '@/features/assembly/crewCapacity';
import { boardDayLoads, loadBand, pressLoadBand } from '@/engine/assembly/workload';

const at = (s: string) => new Date(`2026-11-${s}`);
const day = (k: string) => new Date(`2026-11-${k}T00:00:00`);
const MON = day('16');
const week = ['16', '17', '18', '19', '20', '21', '22'].map(day);

/** A press order as the board draws it: start, end, remaining hours. */
const run = (
  id: string,
  press: string,
  start: string,
  end: string,
  hours: number,
  shifts: string | null = 'MAN',
  extra: Partial<OrderRow> = {},
): OrderRow =>
  ({
    job: {
      id,
      description: `${id} part`,
      laborHrs: hours,
      remainingQty: 10,
      completedQty: 0,
      dueDate: null,
      press: { machine: press, shifts },
    },
    line: { key: `PRESS_${press}`, name: press, parent: 'PMD', schedulable: false },
    start: at(start),
    expectDate: at(end),
    planThrough: at(end),
    workers: [],
    crewDays: [],
    booked: [],
    ...extra,
  }) as unknown as OrderRow;

describe('a press, day by day', () => {
  it('lays an order over the days its run spans, by the time it runs on each', () => {
    // 10 h of work run Monday 19:00 to Tuesday 03:00: 5 of the 8 hours are Monday's.
    const loads = pressDayLoads([run('A', '850T', '16T19:00', '17T03:00', 10)], week, MON);
    expect(loads[0].hours).toBeCloseTo(6.25, 9);
    expect(loads[1].hours).toBeCloseTo(3.75, 9);
    expect(loads[0].orders).toEqual(['A']);
  });

  it('reads it against eight hours a shift, for the shifts its orders are manned for', () => {
    const three = pressDayLoads([run('A', '850T', '16T07:00', '16T19:00', 12, 'MAN')], week, MON);
    expect(three[0]).toMatchObject({ capacity: 24, presses: 1 });
    const one = pressDayLoads([run('A', '850T', '16T07:00', '16T19:00', 12, '1')], week, MON);
    expect(one[0].capacity).toBe(8);
    // Nobody said: all three.
    expect(pressShifts([run('A', '850T', '16T07:00', '16T19:00', 12, null)])).toBe(3);
    // The most any of its orders says.
    expect(pressShifts([run('A', '850T', '16T07:00', '16T19:00', 1, 'M'), run('B', '850T', '17T07:00', '17T19:00', 1, 'MA')])).toBe(2);
  });

  it('counts a changeover as load of its own, on the order before it', () => {
    const before = run('A', '850T', '16T07:00', '16T15:00', 8, 'MAN', {
      changeAfter: {
        change: { kind: 'die', hours: 4, fromJob: 'A', toJob: 'B', fromDie: '174', toDie: '296', fromColor: null, toColor: null },
        start: at('16T15:00'),
        end: at('16T19:00'),
      },
    } as Partial<OrderRow>);
    const [monday] = pressDayLoads([before, run('B', '850T', '16T19:00', '17T03:00', 8)], week, MON);
    expect(monday.changeHours).toBe(4);
    expect(monday.hours).toBeCloseTo(8 + 5, 9);
    expect(monday.entries.find((e) => e.kind === 'change')).toMatchObject({ order: 'A', hours: 4, description: 'DC Die 174 → Die 296 — then B' });
  });

  it('shows nothing behind today, and puts an order overdue on its plan onto today', () => {
    const loads = pressDayLoads([run('A', '850T', '13T07:00', '14T07:00', 6)], [day('15'), ...week], MON);
    expect(loads[0]).toMatchObject({ past: true, hours: 0, capacity: 0 });
    expect(loads[1].hours).toBe(6);
  });

  it('gives a press no time on a day the factory is shut unless its plan runs it then', () => {
    const loads = pressDayLoads([run('A', '850T', '21T07:00', '21T15:00', 8)], week, MON);
    // Saturday the 21st: planned, so it runs. Sunday: shut and idle.
    expect(loads[5]).toMatchObject({ hours: 8, capacity: 24 });
    expect(loads[6]).toMatchObject({ hours: 0, capacity: 0 });
  });
});

describe('PMD adds up its presses', () => {
  it('holds every press’s hours against every press’s time', () => {
    const rows = [
      run('A', '850T', '16T07:00', '16T19:00', 12, 'MAN'),
      run('B', '550T', '16T07:00', '16T15:00', 8, 'M'),
      run('C', '550T', '17T07:00', '17T15:00', 8, 'M'),
    ];
    const [monday, tuesday] = pressDayLoads(rows, week, MON);
    expect(monday).toMatchObject({ hours: 20, capacity: 24 + 8, presses: 2 });
    // A press idle on an open day is still time PMD could run.
    expect(tuesday).toMatchObject({ hours: 8, capacity: 32 });
  });
});

describe('PMD stays out of the assembly board’s figures', () => {
  const assembly = {
    job: { id: 'ASM1', dueDate: null, laborHrs: 15, remainingQty: 10, completedQty: 0 },
    line: { key: 'ASSY', schedulable: true },
    workers: [],
    crewDays: [{ day: '2026-11-16', date: MON, from: 0, hours: 15, perWorkerHours: 7.5, workerIds: ['1', '2'] }],
    booked: [],
    plannedStart: MON,
    start: MON,
    completedToday: false,
  } as unknown as OrderRow;
  const presses = [run('A', '850T', '16T07:00', '16T19:00', 12), run('B', '550T', '16T07:00', '17T07:00', 40)];

  it('adds nothing to Hours on board', () => {
    expect(boardHours([assembly, ...presses], DEFAULT_CREW_POOLS)).toEqual(boardHours([assembly], DEFAULT_CREW_POOLS));
  });

  it('adds nothing to the crews’ day, nor to the day heading', () => {
    const crews = (rows: OrderRow[]) => capacityDays(rows, DEFAULT_CREW_POOLS, () => 3, [MON], MON);
    expect(crews([assembly, ...presses])).toEqual(crews([assembly]));
    const heading = (rows: OrderRow[]) => boardDayLoads(rows, [], MON, 1, MON);
    expect(heading([assembly, ...presses])).toEqual(heading([assembly]));
  });
});

describe('a press day, coloured', () => {
  it('is green while the press is planned within its shifts — three shifts filling 24 h included', () => {
    expect(pressLoadBand((24 / 24) * 100)).toBe('green');
    expect(pressLoadBand(100.4)).toBe('green'); // reads 100%
    expect(pressLoadBand(85)).toBe('green');
    expect(pressLoadBand(101)).toBe('red');
    // An assembly line full to its crew is still a warning there.
    expect(loadBand(100)).toBe('red');
  });
});
