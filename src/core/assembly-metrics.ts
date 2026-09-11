/**
 * What the Assembly production record adds up to, on the same terms as PMD's.
 *
 * PMD rolls machine-shifts up per press; Assembly rolls order-days up per
 * line, because that is the shape `ASSY_Production` is written in — one row
 * per order per day. Everything else is deliberately the same language, so the
 * two KPI pages can be read one after the other without relearning them:
 * output, reject, yield, an efficiency, and a comparison against what was
 * promised.
 *
 * Two things are counted apart from production and never folded into it:
 *
 *   Support work (Factory General) has no output at all — it is measured in
 *   the hours it took — so counting its rows as production would report a line
 *   that made nothing all week.
 *
 *   A row that carries no standard is excluded from **both** sides of
 *   Efficiency rather than counted as zero. An order nobody gave a labour
 *   standard is not an order that was worked badly, and PMD's comparison
 *   metric drops an unjudgeable job-shift for the same reason.
 */

import type { AssemblyResult } from '../types/assembly';

/**
 * Productive hours one person delivers in a day: the 07:00–15:30 shift less
 * morning tea and lunch. The board schedules with exactly this figure
 * (`PRODUCTIVE_HOURS_PER_PERSON` in `assembly/src/domain/assembly.ts`), so
 * measuring against it is measuring against the plan the floor was given.
 * Keep the two in step.
 */
export const PRODUCTIVE_HOURS_PER_PERSON = 7.5;

/**
 * Where each metric turns amber and red. Fixed rather than editable: PMD's
 * thresholds are argued over in the meeting because its presses are compared
 * with one another, and there is no equivalent argument here yet. Documented
 * on the page so nobody has to read this file to know what a colour means.
 */
export const ASSEMBLY_THRESHOLDS = {
  yieldGreen: 98,
  yieldAmber: 95,
  effGreen: 90,
  effAmber: 75,
  planGreen: 95,
  planAmber: 80,
  onTimeGreen: 95,
  onTimeAmber: 85,
} as const;

/** Rows with no line at all — the record says nothing, so neither do we. */
export const NO_LINE = '(no line)';

export interface AssemblyAgg {
  /** Distinct manufactured orders touched in the window. */
  orders: number;
  /** Order-days booked — Assembly's answer to PMD's machine-shifts. */
  bookings: number;
  output: number;
  complete: number;
  reject: number;
  rework: number;
  /** Distinct orders marked finished inside the window. */
  completedOrders: number;
  /** Of those, the ones finished on or before their Due Date. */
  onTimeOrders: number;
  /** …and the ones that had a Due Date to be judged against. */
  datedCompletions: number;
  /** Support orders and the hours they took, kept out of everything above. */
  supportOrders: number;
  supportHours: number;
  /** Crew hours the production rows consumed, at 7.5 h a head a day. */
  crewHours: number;
  /**
   * Hours the shift booked: everything that came off the line, at the order's
   * own standard. `earnedHours` is the same sum over the *good* pieces only,
   * so the gap between the two is what the rejects cost in time.
   */
  bookedHours: number;
  /** Standard hours those rows earned: units finished x the order's standard. */
  earnedHours: number;
  /** Crew hours on rows that carried a standard, so Efficiency has a base. */
  judgedHours: number;
  /**
   * What the crew on those rows was expected to produce: their hours divided
   * by the order's standard. The denominator of Output/Plan, and PMD's
   * schedule expectation said in Assembly's terms.
   */
  plannedOutput: number;
}

export function emptyAssemblyAgg(): AssemblyAgg {
  return {
    orders: 0,
    bookings: 0,
    output: 0,
    complete: 0,
    reject: 0,
    rework: 0,
    completedOrders: 0,
    onTimeOrders: 0,
    datedCompletions: 0,
    supportOrders: 0,
    supportHours: 0,
    crewHours: 0,
    bookedHours: 0,
    earnedHours: 0,
    judgedHours: 0,
    plannedOutput: 0,
  };
}

/** People on the order that day. `Operators` is their names, comma-joined. */
export function crewSize(operators: string | undefined): number {
  return (operators ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean).length;
}

const isSupport = (row: AssemblyResult): boolean => row.workType === 'Support';

/** The day an order was finished — the stamp if there is one, else the row. */
const finishedOn = (row: AssemblyResult): string =>
  (row.completedAt ?? row.day).slice(0, 10);

/**
 * Standard hours one finished unit is worth: the order's whole labour content
 * spread over its whole quantity. Null when the record cannot say — an order
 * with no PlannedHours, or none ordered — which excludes the row from
 * Efficiency rather than scoring it zero.
 */
export function hoursPerUnit(row: AssemblyResult): number | null {
  const planned = row.plannedHours ?? 0;
  const qty = row.orderQty ?? 0;
  return planned > 0 && qty > 0 ? planned / qty : null;
}

/** Fold one row into a running total. */
function addRow(agg: AssemblyAgg, row: AssemblyResult): void {
  if (isSupport(row)) {
    agg.supportHours += row.laborHours ?? 0;
    return;
  }
  agg.bookings++;
  agg.output += row.output;
  agg.complete += row.complete;
  agg.reject += row.reject;
  agg.rework += row.rework;

  const hours = crewSize(row.operators) * PRODUCTIVE_HOURS_PER_PERSON;
  agg.crewHours += hours;
  const perUnit = hoursPerUnit(row);
  if (perUnit !== null) {
    agg.bookedHours += row.output * perUnit;
    agg.earnedHours += row.complete * perUnit;
    agg.judgedHours += hours;
    agg.plannedOutput += hours / perUnit;
  }
}

/**
 * Distinct-order counts, which cannot be added row by row: an order booked on
 * five days is one order, and it is finished once however many of its rows say
 * so.
 */
function countOrders(agg: AssemblyAgg, rows: readonly AssemblyResult[]): void {
  const support = new Set<string>();
  const made = new Set<string>();
  const finished = new Map<string, AssemblyResult>();
  for (const row of rows) {
    if (isSupport(row)) {
      support.add(row.job);
      continue;
    }
    made.add(row.job);
    // The earliest row claiming completion is the one that finished it; a
    // later row of the same order re-stating it must not move the date.
    if (!row.completed) continue;
    const already = finished.get(row.job);
    if (!already || finishedOn(row) < finishedOn(already)) finished.set(row.job, row);
  }
  agg.supportOrders = support.size;
  agg.orders = made.size;
  agg.completedOrders = finished.size;
  for (const row of finished.values()) {
    if (!row.due) continue;
    agg.datedCompletions++;
    if (finishedOn(row) <= row.due.slice(0, 10)) agg.onTimeOrders++;
  }
}

/** The whole window, on one line of figures. */
export function assemblyMetrics(rows: readonly AssemblyResult[]): AssemblyAgg {
  const agg = emptyAssemblyAgg();
  for (const row of rows) addRow(agg, row);
  countOrders(agg, rows);
  return agg;
}

/** One manufactured order, rolled up across the days it was booked on. */
export interface AssemblyOrderRoll {
  job: string;
  description: string;
  line: string;
  days: number;
  due: string | null;
  completed: boolean;
  completedOn: string | null;
  agg: AssemblyAgg;
}

/** One line and the orders that ran on it. */
export interface AssemblyLineRoll {
  line: string;
  agg: AssemblyAgg;
  orders: AssemblyOrderRoll[];
}

/** Older production rows retain ASM; group them with the renamed line. */
const lineLabel = (name: string): string => /^(ASM|Assembly Seats)$/i.test(name.trim()) ? 'Assembly Seats' : name.trim() || NO_LINE;

/**
 * The window split by line, and each line by order.
 *
 * Lines come back in the order given — the board's own left-to-right sequence
 * — with anything the caller does not recognise after them, so the table reads
 * the way the floor is laid out rather than alphabetically.
 */
export function assemblyByLine(
  rows: readonly AssemblyResult[],
  lineOrder: readonly string[] = [],
): AssemblyLineRoll[] {
  const byLine = new Map<string, AssemblyResult[]>();
  for (const row of rows) {
    const key = lineLabel(row.line);
    const held = byLine.get(key);
    if (held) held.push(row);
    else byLine.set(key, [row]);
  }

  const rank = new Map(lineOrder.map((name, i) => [lineLabel(name).toUpperCase(), i]));
  const place = (line: string): number =>
    rank.get(line.toUpperCase()) ?? lineOrder.length;

  return [...byLine.entries()]
    .sort(([a], [b]) => place(a) - place(b) || a.localeCompare(b))
    .map(([line, lineRows]) => ({
      line,
      agg: assemblyMetrics(lineRows),
      orders: rollOrders(lineRows),
    }));
}

function rollOrders(rows: readonly AssemblyResult[]): AssemblyOrderRoll[] {
  const byJob = new Map<string, AssemblyResult[]>();
  for (const row of rows) {
    const held = byJob.get(row.job);
    if (held) held.push(row);
    else byJob.set(row.job, [row]);
  }
  return [...byJob.entries()]
    .map(([job, jobRows]) => {
      const done = jobRows.filter((row) => row.completed);
      const finishedRow = done.length
        ? done.reduce((a, b) => (finishedOn(a) <= finishedOn(b) ? a : b))
        : null;
      return {
        job,
        // The description travels on the support rows; a manufactured order
        // carries it nowhere in this list, so an empty one is honest.
        description: jobRows.find((row) => row.description)?.description ?? '',
        line: lineLabel(jobRows[0].line),
        days: new Set(jobRows.map((row) => row.day)).size,
        due: jobRows.find((row) => row.due)?.due ?? null,
        completed: finishedRow !== null,
        completedOn: finishedRow ? finishedOn(finishedRow) : null,
        agg: assemblyMetrics(jobRows),
      };
    })
    .sort((a, b) => a.job.localeCompare(b.job));
}

/** Good work as a share of what was made. Null with nothing to judge. */
export function yieldPct(agg: AssemblyAgg): number | null {
  const judged = agg.complete + agg.reject;
  return judged > 0 ? +((agg.complete / judged) * 100).toFixed(1) : null;
}

/** Standard hours earned against the crew hours that earned them. */
export function efficiencyPct(agg: AssemblyAgg): number | null {
  return agg.judgedHours > 0
    ? +((agg.earnedHours / agg.judgedHours) * 100).toFixed(1)
    : null;
}

/**
 * What came off the line against what the plan asked of the crew who were on
 * it. PMD's Output cell reads `Good /expected` and takes its colour from that
 * ratio; this is the same reading, with the expectation worked out from the
 * hours the shift had rather than from a schedule Assembly does not keep.
 *
 * Rows with no standard are out of both sides, as they are out of Efficiency:
 * a plan cannot be computed for an order nobody costed.
 */
export function plannedPct(agg: AssemblyAgg): number | null {
  return agg.plannedOutput > 0
    ? +((agg.output / agg.plannedOutput) * 100).toFixed(1)
    : null;
}

/** Finished orders that met their Due Date. */
export function onTimePct(agg: AssemblyAgg): number | null {
  return agg.datedCompletions > 0
    ? +((agg.onTimeOrders / agg.datedCompletions) * 100).toFixed(1)
    : null;
}

/** 🟢 / 🟡 / 🔴 for a percentage, in PMD's own class names. */
export function colourClass(
  value: number | null,
  green: number,
  amber: number,
): string {
  if (value === null) return '';
  return value >= green ? 'green' : value >= amber ? 'amber' : 'red';
}
