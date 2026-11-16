// Operator sheet — what may still be edited: signed off, reopened for
// correction, half-hours already past.
import { isSupervisor } from '../supervisor-auth';
import { canonical, isPastShift, sid, slotRec, occupyingOtherJob, parseRejects } from './sheet';
import { S } from './state';
import { currentSlotIndex, slotClock } from '../../core/shifts';
import { isReadOnlyDevice, needsConfirm } from './data';
import { rejectSlotBlock } from '../../core/rejectslot';

/**
 * True when the currently-viewed (machine, shift, job) is signed off
 * and the operator therefore can't edit it without a supervisor
 * Unlock. Supervisor sign-in transparently lifts the read-only state
 * so the supervisor can re-open the order via the lock banner's Unlock
 * button. Used to gate every input on the page (status picker, reject
 * cells, Count Start / End, Purge, handover textareas).
 */
export function isJobLocked(): boolean {
  return lockInfo() !== null && !isSupervisor();
}

/** The selected order has been signed off and re-opened for correction
 *  (PMD_Production.Reopened = Yes). In this mode the floor may fix the
 *  already-signed slots and the counts; adding status to new (empty) time
 *  periods is governed by reopenedBlocksNewPeriod below. Read off the
 *  canonical slot, so every device that sees the server flag agrees. */
export function reopenedForCorrection(): boolean {
  return canonical()?.reopened === true;
}

/** Whether the selected job already has a machine-status letter on this slot
 *  — i.e. it was part of the signed timeline. Editable slots in reopened mode. */
function slotHasOwnStatus(slot: number): boolean {
  return S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot && !!r.statusCode,
  );
}

/** Does reopened-for-correction mode block giving this (empty) slot a NEW
 *  status? Slots outside the signed timeline are protected from
 *  after-the-fact fabrication — but only on ENDED shifts, and a signed-in
 *  supervisor may still add them there. While the shift is RUNNING the
 *  timeline is genuinely still growing: sign-off no longer demands future
 *  slots (see isPastShift), so an order signed off mid-shift — the normal
 *  post-midnight Night case — legitimately has real production after the
 *  signed range, and an unlock must let the floor record it. Without this
 *  exception those periods could never be added at all. */
export function reopenedBlocksNewPeriod(slot: number): boolean {
  if (!reopenedForCorrection() || slotHasOwnStatus(slot)) return false;
  return isPastShift() && !isSupervisor();
}

/** Has this half-hour already finished? The one running now is NOT past —
 *  it is still in progress, so a reject may be recorded on it before its
 *  Machine Status is set. Every slot of an ended shift is past; on a shift
 *  that has not started yet, none of them are. */
function slotIsPast(slot: number): boolean {
  if (isPastShift()) return true;
  const live = currentSlotIndex(sid(), new Date());
  if (live == null) return false; // future shift — nothing has happened yet
  return slot < live;
}

/** The one predicate that decides whether a D01–D10 reject cell is open.
 *  buildGrid paints from it and the change handler re-runs it, so a
 *  signed-off, unconfirmed or read-only slot can't take a reject even when
 *  the input's `disabled` paint is stale: right after a sign-off the row is locked but
 *  the grid may not have re-rendered yet, and an iPad Edge re-render race, a
 *  hardware keyboard, paste or devtools can each defeat the attribute. The
 *  Machine Status and Quality Check pickers already re-check the lock in
 *  their handlers — this brings the reject row up to parity so a worker
 *  can't type into the wrong (already-signed) place.
 *
 *  The last two rules answer "which half-hour does this reject belong
 *  to?" rather than "may this sheet be edited at all" — see
 *  core/rejectslot.ts for why each one is provably wrong data. `code` is
 *  the reject category (D01–D10): the escape hatch for an already-entered
 *  value is per-cell, so a wrong number can be cleared without opening the
 *  rest of the column. */
export function rejectEntryBlocked(slot: number, code: string): { blocked: boolean; reason: string } {
  // A signed-in supervisor corrects the record: none of the rules below —
  // sign-off lock (already lifted for them), the ✅ Confirm gate, another
  // order's half-hour or an empty past half-hour — stops their defect entry.
  if (isSupervisor()) return { blocked: false, reason: '' };
  if (isReadOnlyDevice())
    return { blocked: true, reason: 'Read only — sign in as supervisor to edit' };
  if (isJobLocked())
    return { blocked: true, reason: 'Signed off — sign in as supervisor and Unlock to edit' };
  if (needsConfirm())
    return { blocked: true, reason: 'Tap ✅ Confirm first — order, press, operator & supervisor' };
  if (reopenedBlocksNewPeriod(slot))
    return { blocked: true, reason: 'Re-opened for correction — this slot wasn\'t part of the signed timeline. Sign in as supervisor to add it' };
  const rec = slotRec(slot);
  return rejectSlotBlock({
    clock: slotClock(sid(), slot),
    hasOwnStatus: !!rec?.statusCode,
    occupiedBy: occupyingOtherJob(slot)?.jobNumber ?? null,
    isPast: slotIsPast(slot),
    existing: parseRejects(rec)[code] ?? 0,
  });
}

export function lockInfo(): { lockedBy: string; lockedAt: string } | null {
  // Lock is scoped to (machine, shift, **job**). A signed-off SFM507017
  // does not lock SFM507018 — the press still has half a shift of run
  // time available and the operator needs to start the next order on
  // the remaining slots. Without the selJob filter the lock banner +
  // every gated edit (Operator/Supervisor fields, status grid via
  // pastLocked) would freeze the whole UI as soon as one job on this
  // shift got signed off.
  if (!S!.selJob) return null;
  for (const r of S!.prod) {
    if (r.jobNumber !== S!.selJob) continue;
    if (r.locked) return { lockedBy: r.lockedBy, lockedAt: r.lockedAt };
  }
  return null;
}
