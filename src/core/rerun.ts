// A second run of an order on the hot-stamping press — the other side of
// a two-sided foil, or a rework — once the first run is signed off.
//
// Production is keyed by (machine, shift, Job#), and a signed-off key is
// locked; Job Left counts every signed piece of the Job#. A second run
// under the same Job# would therefore land on a locked sheet (same shift)
// or start at Job Left 0 / Shift Target 0 and trip the 130% sign-off gate
// (any later shift). So the second run is recorded under its own Job#,
// the order's number plus "-R2" (then -R3 …): its own sheet, counts, Job
// Left and sign-off, and nothing else in the data model changes. It is
// created as a supervisor manual order (PMD_ManualOrders) and is offered
// on the Hstamp only.

/** The press where an order may be run again. */
export const RERUN_MACHINE = 'HSTAMP';

const RERUN_RE = /^(.+)-R(\d+)$/i;

/** Whether the press on screen is the one that may run an order again. */
export function isRerunMachine(machineCode: string): boolean {
  return (machineCode ?? '').trim().toUpperCase() === RERUN_MACHINE;
}

/** The run number of a re-run Job# (2 for "SFM507147-R2"), or null. */
export function rerunNumber(job: string): number | null {
  const m = RERUN_RE.exec(job.trim());
  return m ? Number(m[2]) : null;
}

/** The order a Job# belongs to: "SFM507147-R2" → "SFM507147". */
export function rerunBase(job: string): string {
  const m = RERUN_RE.exec(job.trim());
  return m ? m[1] : job.trim();
}

/** The Job# of run `n` of an order. */
export function rerunJobNumber(base: string, n: number): string {
  return `${rerunBase(base)}-R${n}`;
}

/** The next free run of an order, given every Job# already known (planning,
 *  manual orders, production). The first run is the order itself, so the
 *  answer is never below 2. */
export function nextRerunJob(base: string, known: Iterable<string>): string {
  const root = rerunBase(base).toUpperCase();
  let max = 1;
  for (const j of known) {
    const n = rerunNumber(j);
    if (n != null && rerunBase(j).toUpperCase() === root) max = Math.max(max, n);
  }
  return rerunJobNumber(base, max + 1);
}
