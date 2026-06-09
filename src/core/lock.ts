import type { ProductionRecord } from '../types';
import { detectConflicts } from './conflicts';

// §5.5 Shift Lock.

export interface LockCheck {
  ok: boolean;
  reason?: string;
}

/** Gate for the "Confirm & Lock shift" button. */
export function canLock(
  records: ProductionRecord[],
  supervisorSelected: string | null | undefined,
): LockCheck {
  if (!supervisorSelected) {
    return { ok: false, reason: 'Supervisor must be selected before locking' };
  }
  const conflicts = detectConflicts(records);
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `Cannot lock: ${conflicts.length} time slots have overlapping orders. Fix conflicts first.`,
    };
  }
  return { ok: true };
}

export function isShiftLocked(records: ProductionRecord[]): boolean {
  return records.some((r) => r.locked);
}

/**
 * Produce the lock mutation for every record of a (machine, shift). When the
 * shift has no records yet, a placeholder at SlotIndex 0 carries the metadata
 * (§5.5). Returns new objects; callers persist via the DAL.
 */
export function applyLock(
  records: ProductionRecord[],
  machineCode: string,
  shiftId: string,
  supervisor: string,
  operator: string,
  now: Date = new Date(),
): ProductionRecord[] {
  const stamp = now.toISOString();
  const out = records.map((r) => ({
    ...r,
    locked: true,
    lockedBy: supervisor,
    lockedAt: stamp,
    operator: operator || r.operator,
    supervisor,
    updatedAt: stamp,
  }));
  if (out.length === 0) {
    out.push({
      id: 0, // assigned by the DAL on insert
      machineCode,
      shiftId,
      jobNumber: '',
      partNumber: '',
      slotIndex: 0,
      statusCode: '',
      countStart: null,
      countEnd: null,
      rejectCount: 0,
      rejects: '{}',
      purgeKg: null,
      operator,
      supervisor,
      bdIssue: '',
      mangoTicket: '',
      handoverNote: '',
      locked: true,
      lockedBy: supervisor,
      lockedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  return out;
}

export function applyUnlock(
  records: ProductionRecord[],
  now: Date = new Date(),
): ProductionRecord[] {
  const stamp = now.toISOString();
  return records.map((r) => ({
    ...r,
    locked: false,
    lockedBy: '',
    lockedAt: '',
    updatedAt: stamp,
  }));
}
