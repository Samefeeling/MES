// Operator sheet — the banners over the sheet, and drawing the whole of it.
import { reopenedForCorrection, lockInfo } from './lock';
import {
  isPastShift,
  selectedOrder,
  isFutureShift,
  shiftWindowLabel,
  sid,
  inSignoffReminderWindow,
  currentJobNeedsSignoff,
  orderForJob,
} from './sheet';
import { isSupervisor } from '../supervisor-auth';
import { escapeHtml } from '../modal';
import { needsConfirm, cavityBlockNotes } from './data';
import { S } from './state';
import { currentShift, currentSlotIndex, shiftBounds } from '../../core/shifts';
import {
  applyShiftTheme,
  buildGrid,
  buildSide,
  buildLegend,
  buildActionBar,
  buildMeta,
} from './view';
import { buildSummary } from './summary';
import { applyDispZoom, dispZoom } from './zoom';
import { wire } from './events';

/** Notice shown while a signed order is re-opened for correction. The text
 *  states the rule that applies RIGHT NOW on this device: a running shift
 *  (or a signed-in supervisor) may also add missed time periods; an ended
 *  shift without a supervisor is limited to the signed slots and counts. */
function buildReopenedBanner(): string {
  if (!reopenedForCorrection()) return '';
  const canAddPeriods = !isPastShift() || isSupervisor();
  const scope = canAddPeriods
    ? 'Fix the signed slots and the counts — you can also add time periods that were missed — then sign off again.'
    : 'Fix the already-signed slots and the counts, then sign off again. Adding new time periods to an ended shift needs a supervisor signed in.';
  return `<div class="reopened-banner">
    <b>🔓 Re-opened for correction</b>
    <span>${scope}</span>
  </div>`;
}

function buildLockBanner(): string {
  const info = lockInfo();
  if (!info) return '';
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  // The Unlock button only shows in supervisor mode — operators see an
  // explanatory note instead so they know who can re-open the shift and
  // why nothing happens when they tap.
  const action = isSupervisor()
    ? `<button type="button" class="lock-unlock-btn" data-unlock>🔓 Unlock</button>`
    : `<span class="lock-no-perm" title="Sign in via 🔓 Supervisor in the top nav to enable Unlock">Supervisor sign-in required</span>`;
  return `<div class="lock-banner">
    <div class="lock-text">
      <b>🔒 Signed off</b>
      <span>by ${escapeHtml(info.lockedBy || '—')}${when ? ' · ' + escapeHtml(when) : ''}</span>
    </div>
    ${action}
  </div>`;
}

/**
 * Loud warning when the selected shift hasn't started yet — almost always a
 * night supervisor who left the date on "today" after midnight. Names the
 * running shift and offers a one-tap jump to it, so this morning's work lands
 * on yesterday's Night (the shift that actually ran) instead of tonight's.
 */
/**
 * The ✅ Confirm banner — shown while the live selection is unconfirmed.
 * Names what's being vouched for (order + press + shift + people) and
 * carries the single Confirm button; it disappears once confirmed. The
 * button stays disabled until BOTH Operator and Supervisor are picked in
 * the meta row above, so a confirmation always records who ran the line.
 */
function buildConfirmBar(): string {
  if (!needsConfirm()) return '';
  const o = selectedOrder();
  const ready = !!S!.selOperator && !!S!.selSupervisor;
  const people = `${S!.selOperator ? escapeHtml(S!.selOperator) : '<i>pick operator</i>'} · ${
    S!.selSupervisor ? escapeHtml(S!.selSupervisor) : '<i>pick supervisor</i>'
  }`;
  return `<div class="confirm-bar">
    <div class="confirm-text">
      <b>Confirm to start logging</b>
      <span><b>${escapeHtml(S!.selJob)}</b>${
        o?.partDescription ? ' — ' + escapeHtml(o.partDescription) : ''
      } on <b>${escapeHtml(S!.mc)}</b> · ${escapeHtml(S!.shiftCode)} · ${people}</span>
    </div>
    <button type="button" class="confirm-btn" data-confirm-tuple${
      ready
        ? ''
        : ' disabled title="Pick Operator and Supervisor in the row above first"'
    }>✅ Confirm &amp; start</button>
  </div>`;
}

function buildFutureShiftBanner(): string {
  if (!isFutureShift()) return '';
  const running = currentShift(new Date());
  return `<div class="future-banner">
    <div class="future-text">
      <b>⚠ This shift hasn't started yet</b>
      <span>${escapeHtml(S!.shiftCode)} · ${escapeHtml(shiftWindowLabel(sid()))} is in the future. The shift running now is <b>${escapeHtml(running.code)} · ${escapeHtml(shiftWindowLabel(running.shiftId))}</b> — log this work there.</span>
    </div>
    <button type="button" class="future-fix-btn" data-jump-live>Switch to the running shift →</button>
  </div>`;
}

/**
 * Soft sign-off reminder shown only in the last few minutes of the live
 * shift, when the selected order still has unsigned in-progress data. Replaces
 * the old block-on-every-navigation prompt — the floor wanted a nudge near
 * handover, not a gate each time they switch job / machine / shift.
 */
function buildSignoffReminderBanner(): string {
  if (!inSignoffReminderWindow() || !currentJobNeedsSignoff()) return '';
  return `<div class="signoff-reminder">
    <div class="signoff-reminder-text">
      <b>⏰ Shift ends soon</b>
      <span>Sign off <b>${escapeHtml(S!.selJob)}</b> before the shift ends so its Job Left is recorded.</span>
    </div>
    <button type="button" class="signoff-now-btn" data-signoff-now>✅ Sign off now</button>
  </div>`;
}

/**
 * 🔒 Block-the-cavity reminder. A co-running pair with uneven quantities is
 * run together until the smaller order is made; that part's cavity is then
 * blocked and the die carries on with the other. The sheet says so from the
 * moment the smaller order has less than a shift of output left, so the block
 * is planned for instead of found out from a pile of surplus parts.
 */
function cavityBlockBannerInner(): string {
  const notes = cavityBlockNotes();
  if (!notes.length) return '';
  const n = (v: number): string => v.toLocaleString('en-AU');
  // A part by its description, then the order(s) it is on.
  const name = (p: { partNumber: string; jobNumbers: string[] }): string => {
    const desc = p.jobNumbers
      .map((j) => orderForJob(j)?.partDescription ?? '')
      .find((d) => d && d !== '(historical)');
    return `<b>${escapeHtml(desc || p.partNumber || p.jobNumbers[0])}</b> (${escapeHtml(
      p.jobNumbers.join(', '),
    )})`;
  };
  const lines = notes
    .map((r) => {
      const others = r.continuing.map((c) => `${name(c)} — ${n(c.left)} left`).join('; ');
      const carryOn = `Still to run: ${others}.`;
      if (r.done) {
        return `<span>${name(r)} is complete — block its cavity now. ${carryOn}</span>`;
      }
      const perShift = r.shiftCapacity != null ? ` (a shift makes about ${n(r.shiftCapacity)})` : '';
      return `<span>${name(r)} has <b>${n(r.left)}</b> left — less than one shift${perShift}. Block its cavity as soon as it is made. ${carryOn}</span>`;
    })
    .join('');
  return `<div class="cavity-block-text"><b>🔒 Block a cavity</b>${lines}</div>`;
}

function buildCavityBlockBanner(): string {
  const inner = cavityBlockBannerInner();
  return `<div class="cavity-block-banner" data-cavity-block role="status"${inner ? '' : ' hidden'}>${inner}</div>`;
}

/** Repaint the reminder in place — a Count End typed on the sheet moves Job
 *  Left without a re-render. */
export function paintCavityBlockBanner(): void {
  const el = document.querySelector<HTMLElement>('[data-cavity-block]');
  if (!el) return;
  const inner = cavityBlockBannerInner();
  el.innerHTML = inner;
  el.hidden = !inner;
}

export function render(): void {
  applyShiftTheme();
  // Preserve the scroll position across a re-render — without this,
  // filling slot 12 via the status picker snapped the view back to the
  // top-left, forcing the operator to scroll again every time on the
  // 10" iPad. The grid pans with the PAGE now (overflow:visible for
  // page-scrollport sticky), so it's the window scroll that matters.
  const prevScrollX = window.scrollX;
  const prevScrollY = window.scrollY;

  const app = document.getElementById('app')!;
  const detail =
    S!.viewLevel === 1
      ? `<div class="op-grid-row">${buildGrid()}${buildSide()}</div>${buildLegend()}`
      : buildSummary();
  app.innerHTML = `<div class="op-sheet">
    ${buildActionBar()}
    ${buildFutureShiftBanner()}
    ${buildSignoffReminderBanner()}
    ${buildReopenedBanner()}
    ${buildLockBanner()}
    ${buildMeta()}
    ${buildCavityBlockBanner()}
    ${buildConfirmBar()}
    ${detail}
  </div>`;
  // After the sheet exists in the DOM: auto-fit needs to measure the real
  // banners / rows of THIS render (a lock banner appearing changes the fit).
  applyDispZoom();
  wire();
  window.scrollTo(prevScrollX, prevScrollY);
  if (S!.viewLevel === 1) {
    renderNowLine();
  }
}

export function renderNowLine(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;
  const old = wrap.querySelector('.now-line');
  if (old) old.remove();
  const cs = currentShift(new Date());
  if (cs.shiftId !== sid()) return;
  const idx = currentSlotIndex(sid(), new Date());
  if (idx == null) return;
  const b = shiftBounds(sid())!;
  const frac = (Date.now() - b.start.getTime()) / (b.end.getTime() - b.start.getTime());
  const headFirst = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:first-of-type');
  const headLast = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:last-of-type');
  if (!headFirst || !headLast) return;
  const wRect = wrap.getBoundingClientRect();
  const startX = headFirst.getBoundingClientRect().left - wRect.left;
  const endX = headLast.getBoundingClientRect().right - wRect.left;
  const x = startX + Math.max(0, Math.min(1, frac)) * (endX - startX);
  const line = document.createElement('div');
  line.className = 'now-line';
  // getBoundingClientRect returns VISUAL (post-zoom) pixels, but style.left
  // on a child of the zoomed .op-sheet subtree is re-multiplied by the zoom
  // factor at paint time — divide it back out or the line drifts right as
  // the operator zooms in.
  line.style.left = `${x / dispZoom}px`;
  line.title = `Now: ${new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
  wrap.appendChild(line);
}
