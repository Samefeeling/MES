/**
 * One order per bench, out of the one order the export gives.
 *
 * UPL-SSS and UPL-Gluing are each three benches — foam, sew, staple — and the
 * board drew them as one lane, so four people allocated to "UPL-SSS" said
 * nothing about which bench any of them was standing at. The two lines are
 * organised differently on the floor, and this is the whole of the difference:
 *
 *   UPL-SSS has order numbers for two of the three. A job consuming foam *is*
 *   the foaming order; every other job on the line is a stapling order. Sewing
 *   has no order of its own, so one is derived from the stapling order at half
 *   an hour a unit — and those hours come *out* of the stapling order rather
 *   than being added to the line, because they were always inside its figure.
 *
 *   UPL-Gluing has one order for all three. It is split three ways, evenly,
 *   and the first two benches work side by side: foaming and sewing wait for
 *   nobody, and stapling waits for both.
 *
 * On both lines the order number stays on the stapling row — the last bench,
 * where the units are finished and received — and the derived rows book hours
 * only. That is the one rule that keeps the quantity from being counted twice.
 *
 * Pure. No React, no store.
 */

import { JobId } from '@/domain/ids';
import type { Job, JobMaterialLink } from '@/domain/types';
import {
  readLineKey,
  stepLine,
  type LineKey,
  type ProductionStep,
} from '@/domain/assembly';
import { classifyMaterial } from '@/domain/lineRules';
import { stepJobId } from '@/domain/stepOrder';

/**
 * Sewing, per unit, on UPL-SSS.
 *
 * The floor's own figure. It is a rate rather than a share because sewing a
 * cover takes the same half hour whatever else the order carries, which is
 * exactly why it could not be read off the order's total.
 */
export const SEWING_HOURS_PER_UNIT = 0.5;

/** Lines that are really three benches. */
export type BenchedLine = 'UPL_SOFTIE' | 'UPL_GLUING';
const BENCHED: BenchedLine[] = ['UPL_SOFTIE', 'UPL_GLUING'];

/** Is this line one of the two the export under-describes? */
export const isBenchedLine = (key: LineKey | null): key is BenchedLine =>
  key !== null && (BENCHED as LineKey[]).includes(key);

/** Does this order consume foam? That is what makes it the foaming order. */
export function consumesFoam(
  jobId: string,
  links: readonly JobMaterialLink[],
): boolean {
  return links.some(
    (link) =>
      String(link.jobNum) === jobId &&
      classifyMaterial(
        String(link.childPart),
        link.childDescription,
        link.uom,
      ) === 'FOAM',
  );
}

/** The order's whole quantity, done and still to do. */
const wholeQty = (job: Job): number =>
  Math.max(0, job.completedQty) + Math.max(0, job.remainingQty);

/**
 * One bench's row.
 *
 * The quantities are the order's own on every row, derived or not: a bench
 * works the whole order, and a row saying otherwise would give the bar the
 * wrong length and the shift the wrong daily target. What separates the rows
 * is the hours, and what separates a derived row from the real one is that its
 * output is hours only — see `domain/stepOrder`.
 */
function benchRow(
  job: Job,
  step: ProductionStep,
  hours: number,
  line: LineKey,
  derived: boolean,
  predecessors: JobId[] = [],
): Job {
  const lineDef = stepLine(line, step);
  return {
    ...job,
    id: derived ? stepJobId(String(job.id), step) : job.id,
    laborHrs: Math.max(0, hours),
    line: lineDef?.id ?? job.line,
    predecessors: [...job.predecessors, ...predecessors],
    step: { sourceJobId: job.id, step, derived },
  };
}

/**
 * Split the orders on the two benched lines, and leave everything else alone.
 *
 * Runs over the whole export each time it loads, so the derived ids are the
 * same from one refresh to the next and a plan that allocated somebody to
 * `ASM8001#SEW` yesterday still finds it today.
 */
export function expandStepOrders(
  jobs: readonly Job[],
  links: readonly JobMaterialLink[],
): Job[] {
  const out: Job[] = [];
  for (const job of jobs) {
    const line = job.department === 'assembly'
      ? readLineKey(String(job.line ?? ''))
      : null;
    if (!isBenchedLine(line)) {
      out.push(job);
      continue;
    }

    if (line === 'UPL_SOFTIE') {
      // The foaming orders are the ones with foam in them, and they are whole
      // orders: nothing is carved out of them and nothing is derived from them.
      if (consumesFoam(String(job.id), links)) {
        out.push(benchRow(job, 'foaming', job.laborHrs, line, false));
        continue;
      }
      /*
       * Everything else is a stapling order with the sewing still inside its
       * figure. Half an hour a unit comes out of it and becomes the sewing
       * row, so the line's total is what it always was — 26.3 becomes
       * 21.8 + 4.5, not 26.3 + 4.5.
       */
      const sewing = SEWING_HOURS_PER_UNIT * wholeQty(job);
      const sewRow = benchRow(job, 'sewing', sewing, line, true);
      out.push(sewRow);
      out.push(
        benchRow(job, 'stapling', job.laborHrs - sewing, line, false, [
          sewRow.id,
        ]),
      );
      continue;
    }

    // UPL-Gluing: one order, three benches, an even third each. Foaming and
    // sewing are worked side by side, so neither waits for the other; the
    // staplers wait for both.
    const third = job.laborHrs / 3;
    const foamRow = benchRow(job, 'foaming', third, line, true);
    const sewRow = benchRow(job, 'sewing', third, line, true);
    out.push(foamRow, sewRow);
    out.push(
      benchRow(job, 'stapling', third, line, false, [foamRow.id, sewRow.id]),
    );
  }
  return out;
}

/**
 * The same split applied to a whole dataset.
 *
 * Done once where the data lands rather than inside the board, so the plan
 * store, the pool, the crew picker and the SharePoint mirror all see the same
 * orders the board does. Nothing downstream needs to know a row was derived
 * except the two places that must: what is written back, and what is counted.
 */
export function withStepOrders<T extends { jobs: Job[]; jobLinks?: JobMaterialLink[] }>(
  dataset: T,
): T {
  return { ...dataset, jobs: expandStepOrders(dataset.jobs, dataset.jobLinks ?? []) };
}
