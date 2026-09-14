import { describe, expect, it } from 'vitest';
import {
  expectedScheduledOutputForShift,
  expectedScheduledPiecesForOrder,
  plannedOrdersForShift,
  plannedRuntimeForShift,
  scheduleSegmentsForShift,
} from '../src/core/schedule';
import { order } from './helpers';

describe('Planning.csv schedule core', () => {
  it('filters by normalised machine and exact Start–Due overlap', () => {
    const orders = [
      order({
        jobNumber: 'A',
        machineCode: ' 1300t ',
        plannedStart: '2026-07-01T06:00:00',
        plannedEnd: '2026-07-01T08:00:00',
      }),
      order({
        jobNumber: 'EDGE',
        machineCode: '1300T',
        plannedStart: '2026-07-01T15:00:00',
        plannedEnd: '2026-07-01T16:00:00',
      }),
      order({ jobNumber: 'OTHER', machineCode: '125T' }),
    ];
    expect(plannedOrdersForShift(orders, '1300T', '2026-07-01-Day').map((o) => o.jobNumber)).toEqual([
      'A',
    ]);
  });

  it('maps Planning.csv HS only to the Operator Hstamp machine', () => {
    const hs = order({ jobNumber: 'HOT', machineCode: 'HS' });
    expect(plannedOrdersForShift([hs], 'Hstamp', '2026-05-15-Day')).toHaveLength(1);
    expect(plannedOrdersForShift([hs], 'HS', '2026-05-15-Day')).toHaveLength(0);
    expect(plannedOrdersForShift([hs], '125T', '2026-05-15-Day')).toHaveLength(0);
  });

  it('uses all completed-shift overlap and truncates the current shift at now', () => {
    const orders = [
      order({
        jobNumber: 'A',
        machineCode: '1300T',
        plannedStart: '2026-07-01T07:00:00',
        plannedEnd: '2026-07-01T15:00:00',
        qtyPerHr: 1 / 50,
      }),
    ];
    expect(
      expectedScheduledOutputForShift(
        '2026-07-01-Day',
        orders,
        '1300T',
        new Date('2026-07-02T00:00:00'),
      ).pieces,
    ).toBe(400);
    expect(
      expectedScheduledOutputForShift(
        '2026-07-01-Day',
        orders,
        '1300T',
        new Date('2026-07-01T11:00:00'),
      ).pieces,
    ).toBe(200);
    expect(
      expectedScheduledPiecesForOrder(
        '2026-07-01-Day',
        orders[0],
        '1300T',
        new Date('2026-07-01T11:00:00'),
      ),
    ).toBe(200);
  });

  it('aligns a 23:00–07:00 plan with the Night shift that owns its start date', () => {
    const plan = order({
      jobNumber: 'NIGHT',
      machineCode: '1300T',
      plannedStart: '2026-08-24T23:00:00',
      plannedEnd: '2026-08-25T07:00:00',
      qtyPerHr: 1 / 50,
    });
    const expected = expectedScheduledOutputForShift(
      '2026-08-24-Night',
      [plan],
      '1300T',
      new Date('2026-08-25T08:00:00'),
    );
    expect(expected.pieces).toBe(400);
    expect(expected.scheduledHours).toBe(8);
  });

  it('returns no comparison for future time or a historical plan that is absent', () => {
    expect(
      expectedScheduledOutputForShift('2026-07-01-Day', [], '1300T', new Date('2026-07-02'))
        .pieces,
    ).toBeNull();
    expect(
      expectedScheduledOutputForShift(
        '2026-07-01-Day',
        [order({ jobNumber: 'A', machineCode: '1300T' })],
        '1300T',
        new Date('2026-07-01T06:59:59'),
      ).pieces,
    ).toBeNull();
  });

  it('never asks one press for more hours than the shift holds', () => {
    // Epicor's Start–Due windows overlap each other freely — the Gantt draws
    // them in lanes for exactly that reason. Summing each order's overlap
    // asked a single press for 24 hours of a 8-hour shift, which is where
    // single-digit adherence on shifts that ran their plan came from.
    const spanning = (jobNumber: string) =>
      order({
        jobNumber,
        machineCode: '1300T',
        plannedStart: '2026-07-01T07:00:00',
        plannedEnd: '2026-07-01T15:00:00',
        qtyPerHr: 1 / 50,
      });
    const asOf = new Date('2026-07-02T00:00:00');
    const three = plannedRuntimeForShift(
      '2026-07-01-Day',
      [spanning('A'), spanning('B'), spanning('C')],
      '1300T',
      asOf,
    );
    expect(three.demandHours).toBe(24);
    expect(three.runtimeHours).toBe(8);
    expect(three.runs.map((r) => r.hours)).toEqual([8 / 3, 8 / 3, 8 / 3]);
    // 8 press-hours at 50/h, however the plan divides them up.
    expect(three.runs.reduce((sum, r) => sum + r.pieces, 0)).toBe(399); // floored thrice
  });

  it('leaves a plan that sequences its orders exactly as it found it', () => {
    // The ordinary case: two orders, one after the other, filling six of the
    // eight hours. Nothing is shared out and nothing is scaled up — a plan
    // that asks for six hours expects six hours of output.
    const runtime = plannedRuntimeForShift(
      '2026-07-01-Day',
      [
        order({
          jobNumber: 'A', machineCode: '1300T', qtyPerHr: 1 / 50,
          plannedStart: '2026-07-01T07:00:00', plannedEnd: '2026-07-01T11:00:00',
        }),
        order({
          jobNumber: 'B', machineCode: '1300T', qtyPerHr: 1 / 50,
          plannedStart: '2026-07-01T11:00:00', plannedEnd: '2026-07-01T13:00:00',
        }),
      ],
      '1300T',
      new Date('2026-07-02T00:00:00'),
    );
    expect(runtime.demandHours).toBe(6);
    expect(runtime.runs.map((r) => [r.order.jobNumber, r.hours, r.pieces])).toEqual([
      ['A', 4, 200],
      ['B', 2, 100],
    ]);
  });

  it('takes the shift’s unavailable hours off the runtime before the rate', () => {
    // The floor's own example: a Day shift carrying a planned four-hour die
    // change is asked for four hours of output, not eight.
    const spanning = order({
      jobNumber: 'A',
      machineCode: '1300T',
      plannedStart: '2026-07-01T07:00:00',
      plannedEnd: '2026-07-01T15:00:00',
      qtyPerHr: 1 / 50,
    });
    const asOf = new Date('2026-07-02T00:00:00');
    const whole = plannedRuntimeForShift('2026-07-01-Day', [spanning], '1300T', asOf);
    expect(whole.runs[0].pieces).toBe(400);
    const changedOver = plannedRuntimeForShift('2026-07-01-Day', [spanning], '1300T', asOf, 4);
    expect(changedOver.runtimeHours).toBe(4);
    expect(changedOver.runs[0].pieces).toBe(200);
    // A shift that was nothing but changeover is asked for nothing, rather
    // than going negative.
    expect(
      plannedRuntimeForShift('2026-07-01-Day', [spanning], '1300T', asOf, 99).runs[0].pieces,
    ).toBe(0);
  });

  it('stacks overlapping jobs into separate lanes', () => {
    const orders = [
      order({ jobNumber: 'A', machineCode: '1300T', plannedEnd: '2026-05-15T12:00:00' }),
      order({
        jobNumber: 'B',
        machineCode: '1300T',
        plannedStart: '2026-05-15T10:00:00',
        plannedEnd: '2026-05-15T13:00:00',
      }),
    ];
    const result = scheduleSegmentsForShift(orders, '1300T', '2026-05-15-Day');
    expect(result.laneCount).toBe(2);
    expect(result.segments.map((s) => s.lane)).toEqual([0, 1]);
  });
});
