/**
 * The blocks an order's bar is drawn as.
 *
 * A bar is dated in calendar time and worked in shifts, and the two part
 * company wherever the factory is shut. One run of work is one block — two
 * days running are one run — but a run that carries on after a weekend, a
 * public holiday or an RDO is not worked on the days between, and a block
 * drawn straight across them reads as an order planned on days the factory
 * is shut. So a run is cut at its closed days and they show through.
 */

import { endOfCrewDay, startOfCrewDay, type CrewDayPlan } from '@/engine/assembly/crewSchedule';
import { openDaysBetween, workingSpans } from '@/engine/assembly/dates';
import { MS_PER_DAY } from '@/lib/time';

/** Fractions of a shift are divided out, so flush ends agree to about here. */
const SEAM = 1e-6;

export interface BarBlock {
  from: Date;
  to: Date;
  /**
   * Which run of work this block belongs to. Two blocks of one run are parted
   * by closed days only; two runs are parted by time the crew was elsewhere.
   */
  run: number;
  /** Days of work this block carries, and how many came before it. */
  worked: number;
  workedBefore: number;
}

/**
 * `continuous`: the order runs straight through closed days (weekend overtime
 * approved), so nothing is cut. `x` is where a moment sits on the grid, in
 * pixels: blocks of one run that meet there — either side of a weekend the
 * axis is not drawing — are one block.
 */
export function barBlocks(
  crewDays: readonly CrewDayPlan[],
  continuous: boolean,
  x: (at: Date) => number,
): BarBlock[] {
  const plannedSpans = crewDays.map((day) => ({
    from: startOfCrewDay(day),
    to: endOfCrewDay(day),
  }));
  /*
   * One run of work is one block, and two days running are one run.
   *
   * On the clock a day ends at 15:15 and the next opens at 07:00, so spans
   * that used to meet at a shared midnight no longer meet at all — compared on
   * the instant alone, every multi-day bar would come apart into a block per
   * day. They are the same run when nothing open lies between them and neither
   * end stops short inside its own shift, which is also exactly the test that
   * still parts a bar around a day its crew lost to another order.
   */
  const runs = crewDays.reduce<{ from: Date; to: Date }[]>((out, day, i) => {
    const previous = crewDays[i - 1];
    const span = plannedSpans[i];
    const joined =
      previous !== undefined &&
      previous.from + previous.used >= 1 - SEAM &&
      day.from <= SEAM &&
      openDaysBetween(previous.date, day.date, continuous).length === 0;
    if (joined) out.at(-1)!.to = span.to;
    else out.push({ ...span });
    return out;
  }, []);

  const blocks: { from: Date; to: Date; run: number }[] = [];
  runs.forEach((span, run) => {
    const open = continuous ? [] : workingSpans(span.from, span.to);
    // A run with no open day in it is drawn as it stands rather than lost.
    for (const stretch of open.length > 0 ? open : [span]) {
      const previous = blocks.at(-1);
      if (previous && previous.run === run && x(stretch.from) - x(previous.to) <= 1) previous.to = stretch.to;
      else blocks.push({ from: stretch.from, to: stretch.to, run });
    }
  });

  let workedBefore = 0;
  return blocks.map((block) => {
    const worked = (block.to.getTime() - block.from.getTime()) / MS_PER_DAY;
    const out = { ...block, worked, workedBefore };
    workedBefore += worked;
    return out;
  });
}
