import type { ProductionRecord } from '../types';

// §5.4 — "8 hours can't contain 10 hours of work."
// Two or more orders holding a filled record at the SAME SlotIndex within
// the same (machine, shift) conflict. Empty status ('') does not count.

function isFilled(r: ProductionRecord): boolean {
  return r.statusCode !== '';
}

export interface SlotConflict {
  slotIndex: number;
  jobNumbers: string[];
}

/** All conflicted slots for a set of records belonging to one (machine,shift). */
export function detectConflicts(records: ProductionRecord[]): SlotConflict[] {
  const bySlot = new Map<number, Set<string>>();
  for (const r of records) {
    if (!isFilled(r)) continue;
    if (!bySlot.has(r.slotIndex)) bySlot.set(r.slotIndex, new Set());
    bySlot.get(r.slotIndex)!.add(r.jobNumber);
  }
  const out: SlotConflict[] = [];
  for (const [slotIndex, jobs] of bySlot) {
    if (jobs.size > 1) out.push({ slotIndex, jobNumbers: [...jobs].sort() });
  }
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

export function hasConflicts(records: ProductionRecord[]): boolean {
  return detectConflicts(records).length > 0;
}

/**
 * Real-time guard (§5.4 layer 1): before filling `slotIndex` for `jobNumber`,
 * is some OTHER order already holding that slot in this shift? Returns the
 * blocking record, or null if the slot is free for this job.
 */
export function slotGuard(
  records: ProductionRecord[],
  slotIndex: number,
  jobNumber: string,
): ProductionRecord | null {
  for (const r of records) {
    if (!isFilled(r)) continue;
    if (r.slotIndex !== slotIndex) continue;
    if (r.jobNumber !== jobNumber) return r;
  }
  return null;
}
