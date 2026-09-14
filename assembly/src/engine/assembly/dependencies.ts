/**
 * Which order has to wait for which.
 *
 * `JobMaterialReq.csv` says what each order builds and consumes, one component
 * per row. A component becomes a constraint only when another material row
 * names it as that order's parent part, which is the edge this module produces:
 *
 *   ASM80010 consumes PDSC00747U → ASM8002 builds PDSC00747U → ASM80010 waits
 *
 * The chain runs across departments, so a chair on ASSY can be held up by a
 * cover on UPL and a shell on a moulding press. Anything named directly in the
 * order export's `Predecessor` column is merged in on top.
 *
 * Pure. No React, no store.
 */

import type { JobId, PartId } from '@/domain/ids';
import type { Job, JobMaterialLink } from '@/domain/types';

/** One order waiting on another, and why. */
export interface Dependency {
  /** The order that has to wait. */
  jobId: JobId;
  /** The order it waits for. */
  onJobId: JobId;
  /** Component the wait is for; null when the export named the order itself. */
  part: PartId | null;
}

export interface DependencyGraph {
  /** Consuming job id → everything it waits on. */
  byJob: Map<string, Dependency[]>;
  /** Links that had to be dropped, in words the planner can act on. */
  warnings: string[];
}

/**
 * When an order is scheduled to run, for picking between batches of the same
 * part. Orders with no date at all sort last rather than first — an undated
 * order is not evidence that it will be ready sooner.
 */
const scheduledAt = (job: Job): number =>
  (job.startDate ?? job.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY;

/** Epicor part numbers are case-insensitive; preserve the source for display. */
const partKey = (part: PartId): string => String(part).trim().toUpperCase();

/**
 * Which open order supplies a part.
 *
 * Two sources, and both are needed.
 *
 * `Planning1.JobHead_PartNum` is the order header — the part the job exists to
 * make. `JobMaterialReq.JobHead_PartNum` is that same field repeated onto each
 * material line; it is indexed too, because a job whose material rows name a
 * different parent than its header is still building that parent.
 *
 * Reading only the material export loses any supplier that consumes nothing
 * the export lists: a press job moulding a shell straight from bulk resin, or
 * any job whose material lines the BAQ filtered out. Such a job never appears
 * as a `JobMtl_JobNum`, so nothing names it as a producer, and every order
 * waiting on it quietly comes free. That failure is invisible on the board — a
 * missing constraint looks exactly like an order that never had one.
 *
 * Several open batches of one part all stay in the list; picking one here cut
 * off the deeper branches of a nested BOM. Earliest scheduled first, ties
 * broken on job number, so the same export always yields the same schedule.
 */
function suppliersByPart(
  jobsById: ReadonlyMap<string, Job>,
  links: readonly JobMaterialLink[],
): Map<string, Job[]> {
  const out = new Map<string, Job[]>();
  const seen = new Set<string>();

  const index = (job: Job | undefined, key: string): void => {
    // A missing or finished order cannot constrain the live plan — its parts
    // already exist — and a blank part cannot be the producing end of a link.
    if (!job || job.remainingQty <= 0 || !key) return;
    const pair = `${key}\u0000${String(job.id)}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    const held = out.get(key) ?? [];
    held.push(job);
    held.sort(
      (a, b) =>
        scheduledAt(a) - scheduledAt(b) ||
        String(a.id).localeCompare(String(b.id)),
    );
    out.set(key, held);
  };

  // The order header first: what each open job exists to build.
  for (const job of jobsById.values()) index(job, partKey(job.partNum));
  // Then the material export, for a job building something other than the part
  // its header names.
  for (const link of links) {
    index(jobsById.get(String(link.jobNum)), partKey(link.parentPart));
  }
  return out;
}

/**
 * Drop the links that would make an order wait, however indirectly, on itself.
 *
 * A cycle is bad data — two orders each listing the other's part — and left in
 * place it would quietly cost one of them its constraint anyway. Breaking it
 * here does the same thing deliberately, in a fixed order, and says so.
 */
function breakCycles(byJob: Map<string, Dependency[]>, warnings: string[]): void {
  type Mark = 'open' | 'done';
  const mark = new Map<string, Mark>();

  const visit = (id: string, path: string[]): void => {
    if (mark.get(id) === 'done') return;
    mark.set(id, 'open');

    const deps = byJob.get(id) ?? [];
    const kept: Dependency[] = [];
    for (const dep of deps) {
      const on = String(dep.onJobId);
      if (mark.get(on) === 'open') {
        warnings.push(
          `Circular material link ignored: ${[...path, id, on].join(' → ')}`,
        );
        continue;
      }
      visit(on, [...path, id]);
      kept.push(dep);
    }
    if (kept.length !== deps.length) byJob.set(id, kept);
    mark.set(id, 'done');
  };

  // Sorted, so a file with a cycle in it breaks the same way every load.
  for (const id of [...byJob.keys()].sort()) visit(id, []);
}

/**
 * Build the wait-for graph over `jobs` from the material links.
 *
 * `jobs` should be every open order across both departments — the supplier of
 * a moulded component sits on a press, not on an assembly line.
 */
export function buildDependencies(
  jobs: Job[],
  links: readonly JobMaterialLink[],
): DependencyGraph {
  const byId = new Map(jobs.map((j) => [String(j.id), j]));
  const supplier = suppliersByPart(byId, links);
  const byJob = new Map<string, Dependency[]>();
  const warnings: string[] = [];
  const seen = new Set<string>();

  const add = (jobId: JobId, onJobId: JobId, part: PartId | null): void => {
    const key = `${String(jobId)} ${String(onJobId)}`;
    const list = byJob.get(String(jobId));
    if (seen.has(key)) {
      // Both exports describe this pair. One edge is right, but take the part
      // from whichever source knows it: "waits on ASM8001 for PDSC00747" tells
      // the supervisor more than "waits on ASM8001".
      const held = list?.find((d) => String(d.onJobId) === String(onJobId));
      if (held && !held.part && part) held.part = part;
      return;
    }
    seen.add(key);
    if (list) list.push({ jobId, onJobId, part });
    else byJob.set(String(jobId), [{ jobId, onJobId, part }]);
  };

  // The order export's own column first, so an explicitly named predecessor
  // survives even when the material file says nothing about the pair.
  for (const job of jobs) {
    for (const pred of job.predecessors) {
      if (String(pred) !== String(job.id) && byId.has(String(pred))) {
        add(job.id, pred, null);
      }
    }
  }

  const mismatched = new Set<string>();
  const missingJobs = new Set<string>();
  for (const link of links) {
    const consumer = byId.get(String(link.jobNum));
    // First join: JobMtl_JobNum must be a current Planning1 JobHead_JobNum.
    if (!consumer) {
      missingJobs.add(String(link.jobNum));
      continue;
    }
    if (
      String(link.parentPart) &&
      partKey(link.parentPart) !== partKey(consumer.partNum)
    ) {
      mismatched.add(String(link.jobNum));
    }

    // Second join, entirely inside JobMaterialReq: this row's child part must
    // equal another material row's parent part. That row's JobMtl_JobNum is the
    // producing order the consumer waits for.
    const made = supplier.get(partKey(link.childPart)) ?? [];
    // Preserve every JobMtl_JobNum found for the child part. Choosing only one
    // batch here silently cut deep BOM chains whenever the export contained
    // several open jobs for the same part.
    for (const producingJob of made) {
      if (String(producingJob.id) === String(consumer.id)) continue;
      add(consumer.id, producingJob.id, link.childPart);
    }
  }

  if (mismatched.size > 0) {
    const shown = [...mismatched].sort().slice(0, 3).join(', ');
    warnings.push(
      `JobMaterialReq.csv names a different part than Planning1.csv for ` +
        `${mismatched.size} order${mismatched.size === 1 ? '' : 's'} ` +
        `(${shown}${mismatched.size > 3 ? ', …' : ''}) — the links were still used.`,
    );
  }

  if (missingJobs.size > 0) {
    const shown = [...missingJobs].sort().slice(0, 3).join(', ');
    warnings.push(
      `JobMaterialReq.csv contains ${missingJobs.size} job${missingJobs.size === 1 ? '' : 's'} ` +
        `not present in Planning1.csv (${shown}${missingJobs.size > 3 ? ', …' : ''}) — ` +
        `their material links were ignored.`,
    );
  }

  breakCycles(byJob, warnings);
  return { byJob, warnings };
}
