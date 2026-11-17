/**
 * A bar is one block per stretch of days the factory is open.
 *
 * A run of work that carries on after a weekend, a public holiday or an RDO
 * is not worked on the days between; drawn as one block straight across them
 * it read as an order planned on days the factory is shut.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CrewDayPlan } from '@/engine/assembly/crewSchedule';
import { setFactoryCalendar } from '@/engine/assembly/dates';
import { barBlocks } from '@/features/assembly/barBlocks';
import { timelineDayOffset } from '@/features/assembly/boardView';
import { toDayKey } from '@/lib/time';

const day = (key: string, from = 0, used = 1): CrewDayPlan => ({
  day: key,
  date: new Date(`${key}T00:00:00`),
  from,
  used,
  workerIds: ['1'],
  hours: 7.25 * used,
  perWorkerHours: 7.25 * used,
});

/** Where a moment sits on a grid of 40 px days starting Monday 14 December 2026. */
const grid = (showWeekends: boolean) => (at: Date) =>
  timelineDayOffset(at, new Date('2026-12-14T00:00:00'), showWeekends) * 40;

/** Each block as the days it lies on, and the run it belongs to. */
const lie = (blocks: ReturnType<typeof barBlocks>): string[] =>
  blocks.map((b) => `${toDayKey(b.from)}..${toDayKey(new Date(b.to.getTime() - 1))} run ${b.run}`);

// Christmas 2026: shut from Thursday 24 December to Friday 1 January.
const SHUT = ['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01'];
const shutdown = (): void => setFactoryCalendar({ listed: SHUT.map((d) => ({ day: d })), holidays: false });

afterEach(() => setFactoryCalendar({ listed: [], holidays: true }));

describe('the blocks of a bar', () => {
  it('draws two days running as one block', () => {
    expect(lie(barBlocks([day('2026-12-15'), day('2026-12-16')], false, grid(false)))).toEqual([
      '2026-12-15..2026-12-16 run 0',
    ]);
  });

  it('leaves a shutdown showing through: no block on a public holiday or an RDO', () => {
    shutdown();
    // Wednesday before the shutdown, and Monday and Tuesday after it.
    const blocks = barBlocks([day('2026-12-23'), day('2027-01-04'), day('2027-01-05')], false, grid(false));
    expect(lie(blocks)).toEqual(['2026-12-23..2026-12-23 run 0', '2027-01-04..2027-01-05 run 0']);
    // The first ends where the Wednesday's column ends, the second starts
    // where Monday's begins: seven closed days lie between, undrawn on.
    const x = grid(false);
    expect(x(blocks[1].from) - x(blocks[0].to)).toBe(7 * 40);
  });

  it('is one run either side of the shutdown: closed days, not a pause', () => {
    shutdown();
    const blocks = barBlocks([day('2026-12-23'), day('2027-01-04')], false, grid(false));
    expect(blocks.map((b) => b.run)).toEqual([0, 0]);
  });

  it('meets across a weekend the axis is not drawing, and parts round one it is', () => {
    const friday = [day('2026-12-18'), day('2026-12-21')];
    expect(lie(barBlocks(friday, false, grid(false)))).toEqual(['2026-12-18..2026-12-21 run 0']);
    expect(lie(barBlocks(friday, false, grid(true)))).toEqual([
      '2026-12-18..2026-12-18 run 0',
      '2026-12-21..2026-12-21 run 0',
    ]);
  });

  it('runs straight through with weekend overtime approved', () => {
    const days = [day('2026-12-18'), day('2026-12-19'), day('2026-12-20'), day('2026-12-21')];
    expect(lie(barBlocks(days, true, grid(true)))).toEqual(['2026-12-18..2026-12-21 run 0']);
  });

  it('keeps a day the crew spent elsewhere as a pause between two runs', () => {
    // Tuesday, then Thursday: Wednesday was open and not worked.
    expect(lie(barBlocks([day('2026-12-15'), day('2026-12-17')], false, grid(false)))).toEqual([
      '2026-12-15..2026-12-15 run 0',
      '2026-12-17..2026-12-17 run 1',
    ]);
  });

  it('counts the work of each block and what came before it', () => {
    shutdown();
    const blocks = barBlocks([day('2026-12-23'), day('2027-01-04')], false, grid(false));
    expect(blocks[0].workedBefore).toBe(0);
    expect(blocks[1].workedBefore).toBeCloseTo(blocks[0].worked, 9);
    // Nothing is counted for the days in between.
    expect(blocks[0].worked + blocks[1].worked).toBeLessThan(2);
  });
});
