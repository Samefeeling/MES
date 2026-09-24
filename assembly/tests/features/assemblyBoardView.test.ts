import { describe, expect, it } from 'vitest';
import type { OrderRow } from '@/engine/assembly/board';
import type { PickShortage } from '@/engine/assembly/pickShortage';
import { PartId, WorkerId } from '@/domain/ids';
import { toDayKey } from '@/lib/time';
import {
  PRODUCTIVE_HOURS_PER_PERSON,
  type LineKey,
  type Worker,
} from '@/domain/assembly';

import {
  activeWorkerIdsOnDay,
  countRunningOrders,
  dueWithin,
  isDueSoon,
  runningOrdersByDay,
  isRunningOnDay,
  retainLineRows,
  barTag,
  lineOfWorkerToday,
  missingBarReason,
  shiftTimelineDays,
  sortLineRows,
  teamSummary,
  onLeaveWorkerOrders,
  strandedOrders,
  timelineDayOffset,
  withPredecessors,
  releasedOrderNumbers,
  unstaffedWindow,
  lineDayLoads,
  timelineDays,
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

  it('advances the timeline through a DST weekend', () => {
    const friday = new Date('2027-04-02T00:00:00');
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

  /*
   * The morning the board used to stay quiet about: somebody rings in, and
   * whatever they were half-way through is neither running nor on any list of
   * work waiting for a crew — it still has a full set of names on it.
   */
  describe('the two rolls in the crew column', () => {
    const TODAY = new Date('2026-09-04T00:00:00');
    const KEY = '2026-09-04';
    const person = (id: string, over: Partial<Worker> = {}): Worker => ({
      id: WorkerId(id),
      name: id,
      skills: ['ASSY'],
      onShift: true,
      ...over,
    });
    const onToday = (ids: string[]) => ({
      day: KEY,
      date: new Date(`${KEY}T00:00:00`),
      from: 0,
      used: 1,
      workerIds: ids,
      hours: PRODUCTIVE_HOURS_PER_PERSON * ids.length,
      perWorkerHours: PRODUCTIVE_HOURS_PER_PERSON,
    });

    it('takes somebody marked off out of the ratio and names them', () => {
      const people = [person('Ann'), person('Bob'), person('Cal')];
      const running = row('J1');
      running.workers = [people[0]];
      running.crewDays = [onToday(['Ann'])];

      const team = teamSummary(people, [running], TODAY, { Bob: [KEY] });
      expect(team.onLeave.map((w) => w.name)).toEqual(['Bob']);
      // Bob is not "free": he is not here to be reached for.
      expect(team.free.map((w) => w.name)).toEqual(['Cal']);
      expect(team.label).toBe('1/2 Free 1: Cal');
    });

    it('counts annual leave and the roster\'s own flag as absent too', () => {
      const people = [
        person('Ann', { plannedLeave: [KEY] }),
        person('Bob', { onShift: false }),
        person('Cal'),
      ];
      expect(
        teamSummary(people, [], TODAY, {}).onLeave.map((w) => w.name),
      ).toEqual(['Ann', 'Bob']);
    });

    it('finds the begun orders nobody is left on', () => {
      const away = person('Bob');
      // Begun on the floor, and today has no crew day at all: the one the
      // supervisor has to hand to somebody.
      const stalled = row('J1');
      stalled.workers = [away];
      stalled.crewOnLeaveToday = [away];
      stalled.actualStart = {
        startedAt: '2026-09-03T07:10:00',
        overrideReason: null,
        operatorIds: ['Bob'],
        operatorNames: ['Bob'],
      };
      // Same absence, but a second person is on it, so it is still running.
      const covered = row('J2');
      covered.workers = [away, person('Ann')];
      covered.crewOnLeaveToday = [away];
      covered.actualStart = stalled.actualStart;
      covered.crewDays = [onToday(['Ann'])];
      // Not started yet: it is waiting its turn, not stranded.
      const waiting = row('J3');
      waiting.workers = [away];
      waiting.crewOnLeaveToday = [away];

      expect(
        strandedOrders([stalled, covered, waiting], TODAY).map((r) =>
          String(r.job.id),
        ),
      ).toEqual(['J1']);
    });

    it('lists what each absentee left, the uncovered orders first', () => {
      const away = person('Bob');
      const covered = row('J2');
      covered.workers = [away];
      covered.crewOnLeaveToday = [away];
      covered.crewDays = [onToday(['Ann'])];
      const stalled = row('J1');
      stalled.workers = [away];
      stalled.crewOnLeaveToday = [away];
      stalled.booked = [{ day: '2026-09-03', qty: 4, hours: 8 }] as OrderRow['booked'];

      const left = onLeaveWorkerOrders([covered, stalled], TODAY);
      expect(left.get('Bob')?.map((r) => String(r.job.id))).toEqual([
        'J1',
        'J2',
      ]);
    });
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

/**
 * What has to go out before this board is next looked at.
 *
 * Production asked for it by name: two working days. The two properties that
 * matter are that "two days" counts working days — asked on a Friday it has to
 * reach Monday — and that an order already late is in the list, because one
 * due last Tuesday is not less urgent than one due tomorrow.
 */
describe('due soon', () => {
  const due = (id: string, dueDate: string): OrderRow =>
    ({ ...row(id), job: { ...row(id).job, dueDate: new Date(dueDate) } }) as OrderRow;

  it('counts working days, so a Friday reaches the Monday', () => {
    // Friday 11 Sep 2026 → through the end of Monday 14th.
    expect(dueWithin(new Date('2026-09-11T09:00:00'), 2)).toEqual(
      new Date('2026-09-15T00:00:00'),
    );
    // Thursday → through the end of Friday.
    expect(dueWithin(new Date('2026-09-10T09:00:00'), 2)).toEqual(
      new Date('2026-09-12T00:00:00'),
    );
  });

  it('opens the weekend on the next working day rather than on itself', () => {
    // Saturday: no working day has begun yet, so two of them reach Tuesday.
    expect(dueWithin(new Date('2026-09-12T09:00:00'), 2)).toEqual(
      new Date('2026-09-16T00:00:00'),
    );
  });

  it('takes what is due inside the window, and everything already late', () => {
    const today = new Date('2026-09-10T09:00:00');
    expect(isDueSoon(due('today', '2026-09-10T00:00:00'), today, 2)).toBe(true);
    expect(isDueSoon(due('tomorrow', '2026-09-11T00:00:00'), today, 2)).toBe(true);
    expect(isDueSoon(due('late', '2026-09-01T00:00:00'), today, 2)).toBe(true);
    expect(isDueSoon(due('next-week', '2026-09-15T00:00:00'), today, 2)).toBe(false);
  });

  it('leaves out an order with no due date, and one finished today', () => {
    const today = new Date('2026-09-10T09:00:00');
    expect(isDueSoon(row('undated'), today, 2)).toBe(false);
    const done = { ...due('done', '2026-09-01T00:00:00'), completedToday: true } as OrderRow;
    expect(isDueSoon(done, today, 2)).toBe(false);
  });
});

describe('why an order has no bar', () => {
  const stopped = (over: Partial<OrderRow>): OrderRow =>
    ({ ...row('ASM1'), ...over }) as OrderRow;
  const short = (part: string, shortQty: number): PickShortage => ({
    part: PartId(part),
    description: part,
    requiredQty: shortQty + 10,
    onHand: 10,
    shortQty,
  });

  it('asks for people when people are all that is missing', () => {
    const missing = missingBarReason(stopped({ workers: [] }));
    expect(missing.label).toBe('no crew');
    expect(missing.material).toBe(false);
  });

  it('asks for material instead, when the pick list cannot be covered', () => {
    /*
     * The one this was written for: nobody on the order *and* no foam in the
     * racks. It used to read "no crew", so a crew is what it got — and the
     * order still could not start.
     */
    const missing = missingBarReason(
      stopped({ workers: [], shortPicks: [short('FOAM', 28)] }),
    );
    expect(missing.label).toBe('short material');
    expect(missing.material).toBe(true);
    // Naming one reason must not hide the other.
    expect(missing.title).toContain('FOAM short 28');
    expect(missing.title).toContain('No crew allocated either');
  });

  it('counts the rest of the short lines without listing them', () => {
    const missing = missingBarReason(
      stopped({
        workers: [{ id: WorkerId('W1') } as Worker],
        shortPicks: [short('CLOTH', 100), short('FOAM', 28)],
      }),
    );
    expect(missing.title).toContain('2 lines of the pick list');
    expect(missing.title).toContain('CLOTH short 100');
    expect(missing.title).toContain('and 1 more');
    expect(missing.title).not.toContain('No crew');
  });

  it('names the predecessor ahead of the shortage it is already clearing', () => {
    const missing = missingBarReason(
      stopped({
        workers: [],
        shortPicks: [short('COVER', 30)],
        waitingOn: { onJobId: 'UPL1#20', part: 'COVER' },
      } as unknown as Partial<OrderRow>),
    );
    // The row key is the board's; the supervisor reads the order number.
    expect(missing.label).toBe('waits on UPL1');
    expect(missing.material).toBe(false);
  });

  it('says so when the crew simply runs out before the work does', () => {
    const missing = missingBarReason(
      stopped({ workers: [{ id: WorkerId('W1') } as Worker], shortPicks: [] }),
    );
    expect(missing.label).toBe('not covered');
  });
});

describe('Released Only', () => {
  const order = (id: string, released: boolean | null, over: Partial<OrderRow> = {}): OrderRow => {
    const r = row(id);
    (r.job as { released: boolean | null }).released = released;
    r.predecessors = [];
    return Object.assign(r, over);
  };

  it('plans with released orders, and treats a blank flag as released', () => {
    const keep = releasedOrderNumbers([order('A', true), order('B', false), order('C', null)]);
    expect([...keep].sort()).toEqual(['A', 'C']);
  });

  it('keeps an unreleased order a released one waits for, and one already begun', () => {
    const chair = order('CHAIR', true);
    chair.predecessors = [{ jobId: chair.job.id, onJobId: 'FOAM', part: null }] as OrderRow['predecessors'];
    const foam = order('FOAM', false);
    const started = order('RUN', false, { actualStart: { startedAt: '2026-09-22T07:00:00' } } as Partial<OrderRow>);
    const idle = order('IDLE', false);
    expect([...releasedOrderNumbers([chair, foam, started, idle])].sort()).toEqual(['CHAIR', 'FOAM', 'RUN']);
  });

  it('answers in order numbers, so every operation of a routed order goes together', () => {
    expect([...releasedOrderNumbers([order('SFM1#10', true), order('SFM1#20', true)])]).toEqual(['SFM1']);
  });
});

describe('the box an order with nobody on it is drawn in', () => {
  // 15 h of work: two people (preferredCrewSize), so exactly one shift of it.
  const waiting = (due: string | null, plannedStart = '2026-09-14T07:00:00'): OrderRow => {
    const r = row('W');
    (r.job as { dueDate: Date | null }).dueDate = due ? new Date(due) : null;
    Object.assign(r.job, { laborHrs: 15, remainingQty: 10, completedQty: 0 });
    Object.assign(r, { plannedStart: new Date(plannedStart), line: { key: 'ASSY', schedulable: true } });
    return r;
  };

  it('ends on the Due Date and reaches back to the last day the work can start', () => {
    const w = unstaffedWindow(waiting('2026-09-18T00:00:00'))!;
    expect(w.late).toBe(false);
    expect(w.to).toEqual(new Date('2026-09-18T00:00:00'));
    expect(toDayKey(w.from)).toBe('2026-09-17');
  });

  it('never starts before the order can, and says when it cannot make its Due Date', () => {
    const tight = unstaffedWindow(waiting('2026-09-15T00:00:00', '2026-09-14T12:00:00'))!;
    expect(tight.from).toEqual(new Date('2026-09-14T12:00:00'));
    expect(tight.late).toBe(true);
    const gone = unstaffedWindow(waiting('2026-09-10T00:00:00'))!;
    expect(gone).toEqual({ from: new Date('2026-09-14T07:00:00'), to: new Date('2026-09-14T07:00:00'), late: true });
  });

  it('has nowhere to go without a Due Date', () => {
    expect(unstaffedWindow(waiting(null))).toBeNull();
  });
});

describe('a folded line reads its load day by day', () => {
  const day = (key: string) => new Date(`${key}T00:00:00`);
  const crewed = (id: string, days: Record<string, { hours: number; workerIds: string[] }>): OrderRow => {
    const r = row(id, { start: '2026-09-14T07:00:00', due: '2026-09-30T00:00:00' });
    r.crewDays = Object.entries(days).map(([key, d]) => ({
      day: key, date: day(key), from: 0, hours: d.hours, perWorkerHours: d.hours / d.workerIds.length, workerIds: d.workerIds,
    })) as OrderRow['crewDays'];
    return r;
  };
  const waiting = (id: string, due: string): OrderRow => {
    const r = row(id);
    (r.job as { dueDate: Date | null }).dueDate = new Date(due);
    Object.assign(r.job, { laborHrs: 15, remainingQty: 10, completedQty: 0 });
    Object.assign(r, { plannedStart: new Date('2026-09-14T07:00:00'), uncoveredHours: 15 });
    return r;
  };
  const dates = ['2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'].map(day);
  const day0 = () => day('2026-09-14');

  it('adds up the hours, people and positions its crew is planned on', () => {
    const a = crewed('A', { '2026-09-14': { hours: 14.5, workerIds: ['1', '2'] }, '2026-09-15': { hours: 7.25, workerIds: ['1'] } });
    const b = crewed('B', { '2026-09-14': { hours: 7.25, workerIds: ['3'] } });
    const c = crewed('C', { '2026-09-14': { hours: 7.25, workerIds: ['4'] } });
    const loads = lineDayLoads([a, b, c], 3, dates, day('2026-09-14'));
    expect(loads[1]).toMatchObject({ hours: 29, people: 4, orders: ['A', 'B', 'C'], band: 'orange' });
    expect(loads[2]).toMatchObject({ hours: 7.25, people: 1, orders: ['A'], band: 'green' });
    expect(loads[3]).toMatchObject({ hours: 0, band: 'idle' });
    expect(lineDayLoads([a, b, c], 2, dates, day('2026-09-14'))[1].band).toBe('red');
  });

  it('shows what was booked on a day already gone', () => {
    const a = crewed('A', {});
    a.booked = [{ day: '2026-09-11', qty: 4, hours: 6 }];
    expect(lineDayLoads([a], 3, dates, day('2026-09-14'))[0]).toMatchObject({ past: true, hours: 6, orders: ['A'] });
  });

  it('lays the work nobody is on yet across the days before its Due Date', () => {
    // 15 h at two people is one shift: it has to be worked on the 17th.
    const loads = lineDayLoads([waiting('W', '2026-09-18T00:00:00')], 3, dates, day('2026-09-14'));
    expect(loads.map((d) => d.unstaffedHours)).toEqual([0, 0, 0, 0, 15]);
    expect(loads[4]).toMatchObject({ unstaffedOrders: ['W'], hours: 0 });
  });

  it('lists the orders behind a day, and they add up to its figures', () => {
    const a = crewed('A', { '2026-09-17': { hours: 14.5, workerIds: ['1', '2'] } });
    const [, , , , day] = lineDayLoads([a, waiting('W', '2026-09-18T00:00:00')], 3, dates, day0());
    expect(day.entries.map((e) => [e.order, e.kind, e.hours, e.people])).toEqual([
      ['W', 'waiting', 15, 0],
      ['A', 'crewed', 14.5, 2],
    ]);
    expect(day.entries.reduce((n, e) => n + e.hours, 0)).toBe(day.hours + day.unstaffedHours);
  });
});

describe('the timeline is not held to a fortnight', () => {
  const board = (horizonDays: number, rows: OrderRow[] = []) => ({
    horizonStart: new Date('2026-09-11T00:00:00'),
    today: new Date('2026-09-14T00:00:00'),
    horizonDays,
    groups: [{ rows }],
  });
  const waitingDue = (due: string) => {
    const r = row('W');
    (r.job as { dueDate: Date | null }).dueDate = new Date(due);
    Object.assign(r.job, { laborHrs: 15, remainingQty: 10, completedQty: 0 });
    return r;
  };

  it('shows the weeks asked for past today, and never cuts a planned bar', () => {
    expect(timelineDays(board(17), 4)).toBe(3 + 28);
    expect(timelineDays(board(17), 2)).toBe(17);
    expect(timelineDays(board(300), 2)).toBe(300);
  });

  it('reaches the Due Date of an order waiting for a crew, within reason', () => {
    expect(timelineDays(board(17, [waitingDue('2026-11-30T00:00:00')]), 2)).toBe(81);
    expect(timelineDays(board(17, [waitingDue('2027-12-01T00:00:00')]), 2)).toBe(3 + 182);
  });
});
