// Operator sheet — Sign off & Save, and the supervisor's Unlock.
import { isFutureShift, slotGapsForSignoff, canonical, selectedOrder, sid } from './sheet';
import { toast } from '../toast';
import { S, dalRef } from './state';
import {
  refreshPressState,
  cavities,
  shiftOutputWarning,
  isReadOnlyDevice,
  needsConfirm,
  reload,
} from './data';
import { isSupervisor, clearSupervisor } from '../supervisor-auth';
import { reopenedForCorrection, isJobLocked, lockInfo } from './lock';
import { dieChangeLoggedForSignoff } from './die-change';
import { jobTotals } from './index';
import { openModal, escapeHtml, closeModal } from '../modal';
import { multiFillApply } from './status-picker';
import type { StatusCode } from '../../types';
import { flushPhotoQueue } from './photos';

// Guard against a double Sign Off. On a laggy iPad the supervisor used
// to tap the confirm button repeatedly (no feedback while lockShift's
// slow network round-trip ran) — each tap fired a fresh lockShift, and
// because editCache is cleared only at the END of lockShift the MERGE
// lookup couldn't see the in-flight POSTed row yet, so every tap POSTed
// a NEW PMD_Production row (SFM507208 landed 11× identical). The confirm
// button is also disabled on click; this flag is the belt-and-braces.
let signoffInFlight = false;

/**
 * Sign-off + Save in one modal (§5). Replaces the separate checkbox.
 * Pre-flight = same gates as the .bas btnSaveAndClear_Click:
 *   - Supervisor selected
 *   - Machine Status has at least one filled slot (a shift with no
 *     status timeline records nothing useful and writes an empty
 *     header that later reads back as a blank, confusing record)
 *   - Count Start AND Count End are both entered — explicitly. Zero
 *     is valid data ("counter reset / no parts"); a blank field is
 *     not, because we can't tell "no parts" from "forgot to fill in".
 *   - countEnd >= countStart
 *   - Total Good must not exceed 130% of Shift Target; a likely counter
 *     typo must be corrected before the shift can be locked. A signed-in
 *     SUPERVISOR may sign off anyway (same bypass rule as the slot-gaps
 *     gate below): genuine over-target output happens — a better cycle
 *     than the standard, an extra cavity — and the supervisor vouching
 *     for the figures is exactly what sign-off means. The modal repeats
 *     the warning so the override is a conscious decision.
 * Confirming locks the shift records and clears the in-form selection.
 */
export async function openSaveSignoffModal(): Promise<void> {
  // A shift that hasn't started can't have real production — block sign-off
  // outright (supervisor included) so this morning's Night work never gets
  // locked onto tonight's not-yet-started shift. The banner above offers the
  // one-tap jump to the running shift.
  if (isFutureShift()) {
    toast(
      "This shift hasn't started yet — switch to the running shift before signing off",
      'err',
    );
    return;
  }
  if (!S!.selSupervisor) {
    toast('Pick a Supervisor before signing off', 'err');
    return;
  }
  // Local gates are done; everything below reads the press's shared
  // timeline, so re-read it from the server first.
  await refreshPressState();
  const hasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (!hasStatus) {
    toast('Machine Status is empty — fill in at least one time slot before signing off', 'err');
    return;
  }
  // No-gaps gate: every Machine-Status slot up to now (live) / all 16
  // (past) must be filled before sign-off, so a half-recorded shift
  // can't be locked in (the reported "worker skips slots, Job Left
  // data is wrong" problem). Slots held by another job on this press
  // are that job's responsibility and don't count as gaps here.
  // A signed-in supervisor bypasses the gate — they can sign off an
  // exceptional / partially-recorded shift when correcting data.
  // A reopened-for-correction order is also exempt: its timeline was
  // already accepted by the original sign-off, and re-signing later
  // (e.g. after the shift ended) must not demand MORE slots than that
  // acceptance did — slots the correction mode may not even allow adding.
  const gaps = isSupervisor() || reopenedForCorrection() ? [] : slotGapsForSignoff();
  if (gaps.length) {
    const list = gaps.map((i) => i + 1).join(', ');
    toast(
      `Fill every time slot up to now before signing off — missing slot ${list}`,
      'err',
    );
    return;
  }
  // A shift with a die change owes its Die Change Log (one per press per
  // shift). Exempt as the gaps gate is: a supervisor correcting data, or a
  // reopened order whose timeline was already accepted.
  if (!isSupervisor() && !reopenedForCorrection() && !(await dieChangeLoggedForSignoff())) return;
  const c = canonical();
  if (c?.countStart == null || c?.countEnd == null) {
    toast('Count Start and Count End are required — enter 0 if no parts were counted', 'err');
    return;
  }
  const cs = Number(c.countStart);
  const ce = Number(c.countEnd);
  if (ce < cs) {
    toast('Count End must be ≥ Count Start', 'err');
    return;
  }
  const cav = cavities();
  const totalRej = jobTotals();
  const good = Math.max(0, (ce - cs) * cav - totalRej);
  const outputWarning = shiftOutputWarning(good);
  // Over-130% output hard-blocks the OPERATOR (almost always a Count
  // Start / Count End typo). A signed-in supervisor proceeds to the
  // modal instead, which repeats the warning — approving it is theirs
  // to do, the same way they can bypass the slot-gaps gate above.
  if (outputWarning && !isSupervisor()) {
    toast(
      `${outputWarning.message} Or ask a supervisor to sign in and approve this output.`,
      'err',
    );
    const countEnd = document.querySelector<HTMLInputElement>(
      '.op-side input[data-meta="cend"]',
    );
    countEnd?.focus();
    countEnd?.select();
    return;
  }
  const o = selectedOrder();

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">✅ Sign off &amp; Save</h2>
    <p class="bd-sub">${escapeHtml(sid())} · ${escapeHtml(S!.mc)} · job ${escapeHtml(S!.selJob || '—')}</p>
    <div class="signoff-summary">
      <div><span>Operator</span><b>${escapeHtml(S!.selOperator || '—')}</b></div>
      <div><span>Supervisor</span><b>${escapeHtml(S!.selSupervisor)}</b></div>
      <div><span>Part</span><b>${escapeHtml(o?.partNumber ?? '—')}</b></div>
      <div><span>Order Qty</span><b>${o && !o.isDieChange ? o.orderQty : '—'}</b></div>
      <div><span>Count Start → End</span><b>${cs} → ${ce}${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</b></div>
      <div><span>Good (this shift)</span><b class="g">${good}</b></div>
      <div><span>Total Reject</span><b class="r">${totalRej}</b></div>
    </div>
    ${
      outputWarning
        ? `<div class="count-warning" role="alert">${escapeHtml(
            outputWarning.message,
          )} Signing off as supervisor approves this output as genuine.</div>`
        : ''
    }
    <p class="bd-sub">By signing off you confirm the above figures are correct and lock the shift records.</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
      <button class="btn-primary-big" data-confirm-save>Sign off as ${escapeHtml(S!.selSupervisor)}</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  const confirmBtn = mc.querySelector<HTMLButtonElement>('[data-confirm-save]');
  confirmBtn?.addEventListener('click', () => {
    // Disable immediately so a second tap on a laggy iPad can't fire a
    // second lockShift (the duplicate-row cause). doSignoffSave keeps the
    // modal open until the network round-trip resolves; on failure it
    // re-enables so the supervisor can retry.
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    void doSignoffSave(confirmBtn);
  });
}

/**
 * "🏁 End order / shift" shortcut from the Set Status popup. Fills every empty
 * slot up to the current half-hour with R (Running) for the selected job —
 * exactly the gaps the sign-off gate would block on — then opens Sign off. Use
 * when the order or shift is finished and the operator just wants to close it
 * out without painting each remaining cell by hand.
 */
export async function endOrderAndSignoff(): Promise<void> {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  if (isReadOnlyDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  if (isJobLocked()) {
    toast('Order signed off — Unlock as supervisor to edit', 'warn');
    return;
  }
  if (needsConfirm()) {
    toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
    return;
  }
  // This paints R onto the gaps, so the gaps had better be real: re-read
  // the press first or a half-hour another order already recorded gets a
  // second, contradicting R written over it.
  await refreshPressState();
  // In reopened-for-correction mode the order already ran and was signed —
  // don't paint R onto empty slots (that would add new production). Just route
  // to sign-off so the corrected counts/slots can be re-locked.
  const gaps = reopenedForCorrection() ? [] : slotGapsForSignoff();
  if (gaps.length) await multiFillApply(gaps, 'R' as StatusCode, '', '');
  await openSaveSignoffModal();
}

async function doSignoffSave(confirmBtn?: HTMLButtonElement): Promise<void> {
  if (isReadOnlyDevice()) {
    toast('Read only — sign in as supervisor to sign off here', 'warn');
    return;
  }
  // Reentrancy guard — a second concurrent sign-off would POST a
  // duplicate PMD_Production row (see signoffInFlight comment).
  if (signoffInFlight) return;
  signoffInFlight = true;
  try {
    // Scope sign-off to the order being reviewed: another job already
    // running on this press's remaining timeline slots (operator
    // started the next order mid-shift) must stay live and editable.
    // The JobLeft column is recomputed inside lockShift from signed
    // rows; the canonical row's value (legacy frozen data, if any) rides
    // along only as a deep fallback for when that read fails.
    await dalRef.lockShift(
      S!.mc,
      sid(),
      S!.selSupervisor,
      S!.selOperator,
      S!.selJob || undefined,
      canonical()?.jobLeft ?? null,
    );
    closeModal();
    toast(`Signed off · ${S!.selJob || 'shift'} saved to Master`, 'ok');
    // What the list would not take. The shift is signed without it, and
    // nobody would know from the toast above.
    const notSaved = dalRef.takeWriteWarnings?.() ?? [];
    // Keep selJob: the next shift on the same job continues seamlessly
    // (operator keeps clicking ▶ to advance). Matches how Machine sticks
    // across shift navigation.
    // Supervisor sign-in is intentionally per-action: once a shift is
    // signed off and saved, the supervisor's elevated permission ends
    // automatically. They need to sign in again from the top nav for
    // the next unlock.
    if (isSupervisor()) clearSupervisor();
    await reload();
    // The PMD_Production row exists now — ship any photos the operator
    // queued during the shift onto it as attachments.
    void flushPhotoQueue();
    if (notSaved.length) showNotSavedNotice(notSaved);
  } catch (e) {
    // Surface the actual SP/Graph failure so we don't blindly blame "network".
    // The full stack is in console; toast shows the first line for triage.
    console.error('[signoff] lockShift failed:', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Save failed: ${msg.slice(0, 140)}`, 'err');
    // Re-enable the confirm button so the supervisor can retry after a
    // transient failure (the modal is still open on this path).
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Sign off as ${S!.selSupervisor}`;
    }
  } finally {
    signoffInFlight = false;
  }
}

/**
 * The shift is signed, and SharePoint refused part of it. A toast is gone in
 * three seconds; this stays until it is acknowledged, because the record is
 * missing something only the people at the press can still supply.
 */
function showNotSavedNotice(lines: string[]): void {
  const mc = openModal(`<div class="bd-modal">
    <h3 class="bd-title">⚠ Signed off — but not everything was saved</h3>
    <p class="bd-sub">The shift is signed and its counts are saved. SharePoint would not take the values below, so the record is missing them. Tell your supervisor before the sheet is cleared:</p>
    <ul class="not-saved-list">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <div class="bd-actions">
      <button type="button" class="btn-primary-big" data-ack>OK</button>
    </div>
  </div>`);
  mc.querySelector('[data-ack]')?.addEventListener('click', closeModal);
}

export function openUnlockModal(): void {
  const info = lockInfo();
  if (!info) return;
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  openModal(`<div class="bd-modal">
    <h3 class="bd-title">🔓 Unlock this shift?</h3>
    <p class="bd-sub">
      Signed off by <b>${escapeHtml(info.lockedBy || '—')}</b>${when ? ' at ' + escapeHtml(when) : ''}.
      Unlocking lets operators edit the shift again. Someone must sign it off
      a second time once the changes are done — otherwise the master roll-up
      won't include the new numbers.
    </p>
    <div class="bd-actions">
      <button type="button" class="btn-ghost-big" data-mod="cancel">Cancel</button>
      <button type="button" class="btn-primary-big" data-mod="confirm">🔓 Unlock</button>
    </div>
  </div>`);
  document.querySelector('[data-mod="cancel"]')?.addEventListener('click', () => closeModal());
  document.querySelector('[data-mod="confirm"]')?.addEventListener('click', () => void doUnlock());
}

async function doUnlock(): Promise<void> {
  try {
    // Scope the unlock to the currently-viewed job so other signed-off
    // orders on the same shift stay locked — supervisor is unlocking
    // the order they're looking at, not the whole press.
    await dalRef.unlockShift(S!.mc, sid(), S!.selJob || undefined);
    closeModal();
    toast(
      S!.selJob
        ? `Unlocked ${S!.selJob}. Make your fixes, then sign off again.`
        : 'Shift unlocked. Make your fixes, then sign off again.',
      'ok',
    );
    await reload();
  } catch (e) {
    console.error('[unlock] failed', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Unlock failed: ${msg.slice(0, 140)}`, 'err');
  }
}
