import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import { WorkerId } from '@/domain/ids';
import { toDayKey } from '@/lib/time';
import {
  PRODUCTIVE_HOURS_PER_PERSON,
  type LineKey,
  type Worker,
} from '@/domain/assembly';

import {
  activeWorkerIdsOnDay,
  countRunningOrders,
  runningOrdersByDay,
  isRunningOnDay,
  retainLineRows,
  barTag,
  lineOfWorkerToday,
  isInNextWorkingDays,
  nextWorkingDaysWindow,
  shiftTimelineDays,
  sortLineRows,
  teamSummary,
  timelineDayOffset,
  withPredecessors,
} from '@/features/assembly/boardView';

const row = (
  id: string,
  dates: { start?: string; due?: string } = {},
): OrderRow =>
  ({
    job: {
      id,
      startDate: dates.start ? new Date(dates.start) : null,
      dueDate: dates.due ? new Date(dates.due) : null,
    },
    line: { schedulable: true },
    workers: [],
    crewDays: [],
    booked: [],
    plannedStart: dates.start ? new Date(dates.start) : new Date('2026-09-30'),
    start: dates.start ? new Date(dates.start) : null,
    expectDate: dates.due ? new Date(dates.due) : null,
    completedToday: false,
  }) as unknown as OrderRow;

describe('assembly board view controls', () => {
  it('holds row positions through start and crew changes until explicitly re-sorted', () => {
    const sort = { key: 'start', direction: 'asc' } as const;
    const a = row('A', { start: '2026-09-08T00:00:00' });
    const b = row('B', { start: '2026-09-04T00:00:00' });
    const ids = retainLineRows([a, b], sort).map((r) => String(r.job.id));
    expect(ids).toEqual(['B', 'A']);
    const changed = { ...a, start: new Date('2026-09-03T00:00:00') };
    const held = retainLineRows([changed, b], sort, ids);
    expect(held.map((r) => r.job.id)).toEqual(['B', 'A']);
    expect(held[1]).toBe(changed);
    expect(retainLineRows([changed, b], sort).map((r) => r.job.id)).toEqual(['A', 'B']);
    // Filtering does not replace the full identity snapshot; new imports
    // append and deleted orders disappear without re-sorting surviving rows.
    const newcomer = row('C', { start: '2026-09-01T00:00:00' });
    expect(retainLineRows([newcomer, changed, b], sort, ids).map((r) => r.job.id))
      .toEqual(['B', 'A', 'C']);
    expect(retainLineRows([changed, newcomer], sort, ids).map((r) => r.job.id))
      .toEqual(['A', 'C']);
  });

  it('filters exact worked days, excludes gaps, and counts an order only once', () => {
    const active = row('A', { start: '2026-09-04T00:00:00', due: '2026-09-10T00:00:00' });
    active.crewDays = ['2026-09-04', '2026-09-08'].map((day) => ({
      day, date: new Date(`${day}T00:00:00`), from: 0, used: 0.5,
      workerIds: ['W1', 'W2'], hours: 7.5, perWorkerHours: 3.75,
    }));
    expect(isRunningOnDay(active, new Date('2026-09-04T15:00:00'))).toBe(true);
    expect(isRunningOnDay(active, new Date('2026-09-07T00:00:00'))).toBe(false);
    expect(isRunningOnDay(active, new Date('2026-09-05T00:00:00'))).toBe(false);
    expect(countRunningOrders([active, active, { ...active, crewDays: [], job: { ...active.job, id: 'B' as typeof active.job.id } }],
      new Date('2026-09-04T00:00:00'))).toBe(1);
    const completed = { ...active, completedToday: true, crewDays: [], booked: [{ day: '2026-09-04', qty: 1, hours: 2 }] };
    expect(isRunningOnDay(completed, new Date('2026-09-04T00:00:00'))).toBe(true);
    expect(isRunningOnDay(completed, new Date('2026-09-08T00:00:00'))).toBe(false);
  });

  it('handles midnight, overtime and local DST boundaries in source bars', () => {
    const active = row('A', { start: '2027-04-02T00:00:00', due: '2027-04-05T00:00:00' });
    // A line this board schedules is read off its day plan, and an empty plan
    // means the order runs on no day — whatever its bar happens to span.
    expect(isRunningOnDay(active, new Date('2027-04-05T00:00:00'))).toBe(false);
    expect(isRunningOnDay(active, new Date('2027-04-04T00:00:00'))).toBe(false);
    // Approved for the weekend means a day planned on the Sunday, which is
    // what says it runs — not the fact that the bar reaches across it.
    const weekend = {
      ...active,
      overtime: true,
      crewDays: [
        {
          day: '2027-04-04',
          date: new Date('2027-04-04T00:00:00'),
          from: 0,
          used: 1,
          workerIds: ['W1'],
          hours: PRODUCTIVE_HOURS_PER_PERSON,
          perWorkerHours: PRODUCTIVE_HOURS_PER_PERSON,
        },
      ],
    } as unknown as OrderRow;
    expect(isRunningOnDay(weekend, new Date('2027-04-04T23:30:00'))).toBe(true);
    // PMD keeps its source bar: its crew is managed off this board, so there
    // is no day plan to read in its place.
    const pmd = { ...active, line: { ...active.line, schedulable: false } };
    expect(isRunningOnDay(pmd, new Date('2027-04-04T00:00:00'))).toBe(true);
    expect(isRunningOnDay(row('no-crew'), new Date('2026-09-30T00:00:00'))).toBe(false);
  });

  it('sorts within a line, toggles direction, and leaves missing dates last', () => {
    const rows = [
      row('B', { due: '2026-09-05' }),
      row('missing'),
      row('A', { due: '2026-09-03' }),
    ];
    expect(sortLineRows(rows, { key: 'due', direction: 'asc' }).map((r) => r.job.id))
      .toEqual(['A', 'B', 'missing']);
    expect(sortLineRows(rows, { key: 'due', direction: 'desc' }).map((r) => r.job.id))
      .toEqual(['B', 'A', 'missing']);
  });

  it('uses five working days and keeps bars that overlap the window', () => {
    const window = nextWorkingDaysWindow(new Date('2026-09-03T00:00:00'));
    expect(window.from).toEqual(new Date('2026-09-03T00:00:00'));
    expect(window.toExclusive).toEqual(new Date('2026-09-10T00:00:00'));

    const active = row('active', { start: '2026-09-01', due: '2026-09-04' });
    const later = row('later', { start: '2026-09-10', due: '2026-09-11' });
    expect(isInNextWorkingDays(active, new Date('2026-09-03'))).toBe(true);
    expect(isInNextWorkingDays(later, new Date('2026-09-03'))).toBe(false);
  });

  it('sorts by when work starts, not the must-start deadline, after a crew change', () => {
    const a = row('A', { start: '2026-09-08', due: '2026-09-09' });
    const b = row('B', { start: '2026-09-04', due: '2026-09-20' });
    a.mustStartBy = new Date('2026-09-01');
    b.mustStartBy = new Date('2026-09-15');
    const sort = { key: 'start', direction: 'asc' } as const;
    const rows = [a, b];
    expect(sortLineRows(rows, sort).map((r) => r.job.id)).toEqual(['B', 'A']);
    // The scheduler returns an earlier bar when the crew has changed.
    const changed = { ...a, start: new Date('2026-09-03') };
    expect(sortLineRows([changed, b], sort).map((r) => r.job.id)).toEqual(['A', 'B']);
    expect(rows.map((r) => r.job.id)).toEqual(['A', 'B']);
    b.actualStart = { startedAt: '2026-09-02T07:00:00', operatorIds: [], operatorNames: [], overrideReason: null };
    expect(sortLineRows([changed, b], sort).map((r) => r.job.id)).toEqual(['B', 'A']);
  });

  it('keeps what the shown orders are waiting for, all the way up the chain', () => {
    // The press job for the shell ran last week, so no date filter would pick
    // it — and the arrow from it to the chair is drawn only where both bars
    // are on screen. Narrowing the board used to cut the chain silently.
    const chair = row('chair', { start: '2026-09-10' });
    const cover = row('cover', { start: '2026-08-20' });
    const shell = row('shell', { start: '2026-08-14' });
    const unrelated = row('unrelated', { start: '2026-08-01' });
    const waits = (from: OrderRow, onJobId: string) => {
      from.predecessors = [
        { jobId: from.job.id, onJobId, part: null },
      ] as OrderRow['predecessors'];
    };
    waits(chair, 'cover');
    waits(cover, 'shell');
    shell.predecessors = [];
    unrelated.predecessors = [];

    const rows = [chair, cover, shell, unrelated];
    const keep = withPredecessors(rows, (r) => String(r.job.id) === 'chair');
    expect([...keep].sort()).toEqual(['chair', 'cover', 'shell']);

    // A circular link is a warning, not a removal, so the walk has to survive
    // one rather than spin on it.
    waits(shell, 'chair');
    expect(withPredecessors(rows, () => false).size).toBe(0);
    expect(withPredecessors(rows, (r) => String(r.job.id) === 'chair').size)
      .toBe(3);
  });

  it('excludes yesterday-only work and the sixth working day', () => {
    const today = new Date('2026-09-04T00:00:00');
    const ended = row('ended', { start: '2026-09-03T00:00:00', due: '2026-09-04T00:00:00' });
    const fifth = row('fifth', { start: '2026-09-10T00:00:00' });
    const sixth = row('sixth', { start: '2026-09-11T00:00:00' });
    expect(isInNextWorkingDays(ended, today)).toBe(false);
    expect(isInNextWorkingDays(fifth, today)).toBe(true);
    expect(isInNextWorkingDays(sixth, today)).toBe(false);
  });

  it('advances the five-day window and timeline through a DST weekend', () => {
    const friday = new Date('2027-04-02T00:00:00');
    expect(nextWorkingDaysWindow(friday).toExclusive).toEqual(new Date('2027-04-09T00:00:00'));
    expect(shiftTimelineDays(friday, 1, false)).toEqual(new Date('2027-04-05T00:00:00'));
    expect(timelineDayOffset(new Date('2027-04-05T00:00:00'), friday, false)).toBe(1);
  });

  it('summarises unique staff working today, excluding absence, leave and future work', () => {
    const today = new Date('2026-09-04T00:00:00');
    const people: Worker[] = Array.from({ length: 15 }, (_, i) => ({
      id: WorkerId(`W${i}`), name: i === 13 ? 'Tom' : `Person ${i}`,
      skills: ['ASSY'], onShift: i < 14,
    }));
    const onToday = (ids: string[]) => ({
      day: '2026-09-04',
      date: new Date('2026-09-04T00:00:00'),
      from: 0,
      used: 1,
      workerIds: ids,
      hours: PRODUCTIVE_HOURS_PER_PERSON * ids.length,
      perWorkerHours: PRODUCTIVE_HOURS_PER_PERSON,
    });
    const active = row('active');
    active.workers = people.slice(0, 13);
    active.crewDays = [onToday(active.workers.map((w) => String(w.id)))];
    const later = row('future');
    later.crewDays = [{ day: '2026-09-07', date: new Date('2026-09-07'), from: 0, used: 1, workerIds: ['W13'], hours: 7.5, perWorkerHours: 7.5 }];
    expect(teamSummary(people, [active, active, later], today).label).toBe('13/14 Free 1: Tom');
    active.workers = people;
    active.crewDays = [onToday(people.map((w) => String(w.id)))];
    expect(teamSummary(people, [active], today).label).toBe('14/14 All allocated');
    people[13].plannedLeave = ['2026-09-04'];
    expect(teamSummary(people, [active], today).label).toBe('13/13 All allocated');
    expect(teamSummary([], [active], today).label).toBe('0/0 No staff on site');
  });

  it('removes weekend width and drags by visible working-day columns', () => {
    const friday = new Date('2026-09-04T00:00:00');
    const monday = new Date('2026-09-07T00:00:00');
    expect(timelineDayOffset(monday, friday, false)).toBe(1);
    expect(timelineDayOffset(monday, friday, true)).toBe(3);
    expect(shiftTimelineDays(friday, 1, false)).toEqual(monday);
    expect(shiftTimelineDays(monday, -1, false)).toEqual(friday);
  });

  it('counts only the crew active today, not a later assignment', () => {
    const planned = row('SFM507569', { start: '2026-09-02T00:00:00' });
    planned.crewDays = [
      {
        day: '2026-09-02',
        date: new Date('2026-09-02T00:00:00'),
        from: 0,
        used: 1,
        workerIds: ['Bill'],
        hours: PRODUCTIVE_HOURS_PER_PERSON,
        perWorkerHours: PRODUCTIVE_HOURS_PER_PERSON,
      },
      {
        day: '2026-09-04',
        date: new Date('2026-09-04T00:00:00'),
        from: 0,
        used: 1,
        workerIds: ['Jones'],
        hours: PRODUCTIVE_HOURS_PER_PERSON,
        perWorkerHours: PRODUCTIVE_HOURS_PER_PERSON,
      },
    ];
    expect([...activeWorkerIdsOnDay([planned], new Date('2026-09-02T00:00:00'))]).toEqual([
      'Bill',
    ]);
  });
});

/**
 * Where an order's label goes. A couple of hours of work is a few pixels of
 * bar, and a label crammed into those came out as one clipped character.
 */
describe('barTag', () => {
  const bar = (over: Partial<Parameters<typeof barTag>[0]> = {}) =>
    barTag({
      jobId: 'ASM80013',
      hours: 12,
      spanDays: 2,
      width: 184,
      left: 0,
      gridWidth: 1400,
      overtime: false,
      ...over,
    });

  it('keeps the label inside a bar with room for it', () => {
    const tag = bar();
    expect(tag.text).toBe('ASM80013');
    expect(tag.outside).toBe(false);
    expect(tag.stub).toBe(false);
  });

  it('puts it outside when the bar is narrower than the name', () => {
    // Eight characters need about 69px with the padding; 63 is not enough.
    expect(bar({ width: 63 }).outside).toBe(true);
    expect(bar({ width: 80 }).outside).toBe(false);
  });

  it('says how long a few hours of work is', () => {
    // The block has bottomed out at its minimum width, so its length is not
    // telling anyone anything — the hours have to.
    const tag = bar({ spanDays: 0.11, width: 20, hours: 0.8 });
    expect(tag.stub).toBe(true);
    expect(tag.text).toBe('ASM80013 · 0.8 h');
    expect(tag.outside).toBe(true);
  });

  it('leaves the hours off an order with none left to run', () => {
    expect(bar({ spanDays: 0.1, width: 20, hours: 0 }).text).toBe('ASM80013');
  });

  it('flips to the left where the grid runs out to the right', () => {
    expect(bar({ width: 20, left: 100 }).flip).toBe(false);
    expect(bar({ width: 20, left: 1340 }).flip).toBe(true);
  });

  it('makes room for the overtime marker', () => {
    // Wide enough for the name alone, not once a marker sits beside it.
    expect(bar({ width: 76 }).outside).toBe(false);
    expect(bar({ width: 76, overtime: true }).outside).toBe(true);
  });
});

/**
 * One person, one line. Somebody trained on two is qualified for both, but at
 * any one moment they are standing at one of them.
 */
describe('lineOfWorkerToday', () => {
  const TODAY = new Date(2026, 8, 10);
  const person = (id: string, skills: LineKey[]): Worker => ({
    id: WorkerId(id),
    name: id,
    skills,
    onShift: true,
  });
  const onLine = (
    jobId: string,
    line: LineKey,
    day: Date,
    workerIds: string[],
  ): OrderRow =>
    ({
      job: { id: jobId },
      line: { key: line, schedulable: true },
      completedToday: false,
      workers: workerIds.map((id) => ({ id })),
      crewDays: [
        { day: toDayKey(day), date: day, from: 0, used: 1, workerIds },
      ],
    }) as unknown as OrderRow;

  it('puts them on the line their work today is on', () => {
    const bill = person('W1', ['UPL_GLUING', 'ASSY']);
    const at = lineOfWorkerToday(
      [bill],
      [onLine('J1', 'ASSY', TODAY, ['W1'])],
      TODAY,
    );
    expect(at.get('W1')).toBe('ASSY');
  });

  it('falls back to the line they normally work', () => {
    const bill = person('W1', ['UPL_GLUING', 'ASSY']);
    // Work, but not today — so today they are at their usual bench.
    const at = lineOfWorkerToday(
      [bill],
      [onLine('J1', 'ASSY', new Date(2026, 8, 14), ['W1'])],
      TODAY,
    );
    expect(at.get('W1')).toBe('UPL_GLUING');
  });

  it('uses the supervisor drag placement ahead of legacy skills and work', () => {
    const bill = person('Bill', ['UPL_GLUING', 'ASSY']);
    const rows = [onLine('OLD', 'UPL_GLUING', TODAY, ['Bill'])];
    expect(
      lineOfWorkerToday([bill], rows, TODAY, { Bill: 'TABLE' }).get('Bill'),
    ).toBe('TABLE');
  });

  it('never lands anyone on two lines at once', () => {
    const mary = person('W3', ['UPL_GLUING', 'ASSY', 'TABLE']);
    const at = lineOfWorkerToday(
      [mary],
      [
        onLine('J1', 'UPL_GLUING', TODAY, ['W3']),
        onLine('J2', 'TABLE', TODAY, ['W3']),
      ],
      TODAY,
    );
    // An approved double-booking is still one row on the board; the chips on
    // the orders themselves are what say they are on both.
    expect([...at.values()]).toHaveLength(1);
    expect(at.get('W3')).toBe('UPL_GLUING');
  });

  it('ignores a line the board does not schedule', () => {
    const ken = person('W9', ['TABLE']);
    const pmd = onLine('SFM1', 'PMD', TODAY, ['W9']);
    (pmd.line as { schedulable: boolean }).schedulable = false;
    expect(lineOfWorkerToday([ken], [pmd], TODAY).get('W9')).toBe('TABLE');
  });
});

/**
 * The header counts orders per column. Asking column by column walked every
 * row on the board once per column on screen; counting outwards from the rows
 * is the same answer for a fraction of the work, so the two must agree
 * exactly — including on the moulding lane, which has no day plan to walk and
 * is still read off its source bar.
 */
describe('counting the orders running on each day', () => {
  const days = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'].map(
    (d) => new Date(`${d}T00:00:00`),
  );
  const planned = (day: string, ids: string[], hours = PRODUCTIVE_HOURS_PER_PERSON) => ({
    day,
    date: new Date(`${day}T00:00:00`),
    from: 0,
    used: 1,
    workerIds: ids,
    hours,
    perWorkerHours: hours,
  });

  it('agrees with asking one column at a time', () => {
    const a = row('A', { start: '2026-09-02T00:00:00', due: '2026-09-05T00:00:00' });
    a.crewDays = [planned('2026-09-02', ['W1']), planned('2026-09-04', ['W1'])];
    const b = row('B', { start: '2026-09-02T00:00:00', due: '2026-09-05T00:00:00' });
    b.crewDays = [planned('2026-09-04', ['W2'])];
    // Nobody on it: it runs on no day, however far its bar reaches.
    const idle = row('C', { start: '2026-09-02T00:00:00', due: '2026-09-08T00:00:00' });
    // Booked output counts even once the plan has moved past it.
    const booked = row('D', { start: '2026-09-07T00:00:00', due: '2026-09-09T00:00:00' });
    booked.booked = [{ day: '2026-09-03', qty: 2, hours: 4 }];
    // The moulding lane keeps its source bar.
    const press = {
      ...row('E', { start: '2026-09-02T00:00:00', due: '2026-09-04T00:00:00' }),
      line: { schedulable: false },
    } as unknown as OrderRow;

    const rows = [a, b, idle, booked, press];
    const oneAtATime = new Map(
      days.map((day) => [toDayKey(day), countRunningOrders(rows, day)]),
    );
    expect(runningOrdersByDay(rows, days)).toEqual(oneAtATime);
    // Assembly counts A on the 2nd, D's output on the 3rd, and A/B on the 4th.
    // The PMD source bar is never included in those counts.
    expect([...oneAtATime.values()]).toEqual([1, 1, 2, 0]);
  });

  it('counts an order once however many days it names', () => {
    const a = row('A', { start: '2026-09-02T00:00:00', due: '2026-09-05T00:00:00' });
    a.crewDays = [planned('2026-09-02', ['W1'])];
    a.booked = [{ day: '2026-09-02', qty: 1, hours: 1 }];
    expect(runningOrdersByDay([a, a], days).get('2026-09-02')).toBe(1);
  });

  it('gives every column asked for a number, even an empty one', () => {
    expect([...runningOrdersByDay([], days).keys()]).toEqual(
      days.map(toDayKey),
    );
    expect([...runningOrdersByDay([], days).values()]).toEqual([0, 0, 0, 0]);
  });
});

describe('PMD remains outside Assembly date controls', () => {
  it('keeps PMD source order when date sorting is requested', () => {
    const a = row('P1', { start: '2026-09-10' });
    const b = row('P2', { start: '2026-09-08' });
    a.line.schedulable = false; b.line.schedulable = false;
    expect(sortLineRows([a,b], { key: 'start', direction:'asc' }).map(r=>r.job.id)).toEqual(['P1','P2']);
  });
  it('excludes PMD source bars and bookings from daily counts', () => {
    const a = row('A1', { start: '2026-09-08', due: '2026-09-10' });
    a.booked = [{ day:'2026-09-08', qty:2, hours:1 }];
    const pmd = { ...a, job:{...a.job,id:'P1' as typeof a.job.id},line:{...a.line,schedulable:false} };
    const day = new Date('2026-09-08T12:00:00');
    expect(countRunningOrders([a,pmd],day)).toBe(1);
    expect(runningOrdersByDay([a,pmd],[day]).get('2026-09-08')).toBe(1);
  });
});
