/**
 * A bench's share of an order.
 *
 * UPL-SSS and UPL-Gluing are each three benches, and the export knows nothing
 * about that: it gives one order with one set of hours. So the hours are split
 * across the benches here, and where the floor has no order number for a step,
 * one is derived — `ASM8001#SEW` beside the real `ASM8001`.
 *
 * A derived order is a real order in every way the board cares about: it takes
 * people, it has a bar, the shift books against it. What it is not is a second
 * receipt. Its output posts **hours and no quantity** — the units exist once,
 * they are received once, on the order that carries the job number — which is
 * why `derived` is on the record rather than inferred from the id.
 */

import { JobId } from './ids';
import type { ProductionStep } from './assembly';

/** How a derived id is spelled: the order, then the bench. */
export const STEP_ID_MARK = '#';

const SUFFIX: Record<ProductionStep, string> = {
  foaming: 'FOAM',
  sewing: 'SEW',
  stapling: 'STAPLE',
};

export interface StepOrder {
  /** The order this work belongs to — the one with the job number. */
  sourceJobId: JobId;
  /** Which bench works it. */
  step: ProductionStep;
  /**
   * True when the board made this row up because the floor has no order
   * number for the step. Its bookings carry hours and never quantity.
   */
  derived: boolean;
}

/** The id a derived step row takes. Stable, and readable in a saved plan. */
export const stepJobId = (source: string, step: ProductionStep): JobId =>
  JobId(`${source}${STEP_ID_MARK}${SUFFIX[step]}`);

/** The order a row belongs to — itself, unless it is a derived step. */
export const sourceJobIdOf = (id: string): string =>
  id.includes(STEP_ID_MARK) ? id.slice(0, id.indexOf(STEP_ID_MARK)) : id;
