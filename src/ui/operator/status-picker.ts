// Operator sheet — setting Machine Status: one half-hour or a run of them,
// comments, and filling the gaps.
import { occupyingOtherJob, slotRec, sid, coRunSiblings } from './sheet';
import { isSupervisor } from '../supervisor-auth';
import { S, dalRef } from './state';
import { reopenedBlocksNewPeriod, isJobLocked } from './lock';
import { toast } from '../toast';
import { isReadOnlyDevice, confirmBlocksEdit, upsertSlotNoReload, upsertSlotForJob } from './data';
import type { ProductionRecord, StatusCode } from '../../types';
import { escapeHtml, openModal, closeModal } from '../modal';
import { STATUS_MAP } from '../../core/status';
import { SLOTS_PER_SHIFT, slotClock } from '../../core/shifts';
import { endOrderAndSignoff } from './signoff';
import { openBreakdownCascade } from '../breakdown';
import { parseHandover } from './events';
import { breakdownDetailFor } from '../../core/breakdown';
import { render } from './render';
import { dieChangeEventsTouching, maybeOpenDieChangeLog } from './die-change';

// ---------- Unified status picker (tap or hold-and-drag) ----------

export function wireStatusPicker(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;

  // iPad Safari does not always report e.pressure > 0 during a finger
  // drag — guarding pointermove on pressure caused multi-select to fail
  // silently on the very devices we ship to. Use an explicit isDown flag
  // (set on pointerdown, cleared on pointerup / cancel / lostcapture)
  // and rely on the browser's pointer-capture to keep the events arriving
  // even when the finger drifts outside the original cell.
  let anchor: number | null = null;
  let isDown = false;
  let dragged = false;

  const slotAt = (clientX: number, clientY: number): number | null => {
    const el = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-slot][data-row="status"]');
    if (!el) return null;
    const slot = Number(el.dataset.slot);
    // Slots already held by another job on this (machine, shift) are
    // not selectable — neither single-tap nor drag-range can pick them
    // up. Prevents the duplicate-15:00 case where two orders both
    // claim the same half-hour as Run time. A signed-in supervisor may
    // take one anyway, to correct a timeline (warned when they do).
    if (occupyingOtherJob(slot) && !isSupervisor()) return null;
    return slot;
  };

  const setRange = (a: number, b: number): void => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    S!.selSet = new Set<number>();
    // Skip slots already held by another job — drag-range across a
    // signed-off run mustn't sweep its slots into the selection. In
    // reopened-for-correction mode also skip slots the mode blocks
    // (empty slots of an ended shift without a supervisor).
    for (let i = lo; i <= hi; i++) {
      if (occupyingOtherJob(i) && !isSupervisor()) continue;
      if (reopenedBlocksNewPeriod(i)) continue;
      S!.selSet.add(i);
    }
    paintSelection();
  };

  const release = (e?: PointerEvent): void => {
    if (e) {
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        /* not captured by this target — fine */
      }
    }
    isDown = false;
  };

  wrap.addEventListener('pointerdown', (e) => {
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null) return;
    // Signed-off shifts: no slot picker, no drag-range, nothing —
    // operator gets a one-shot toast explaining how to re-open it.
    if (isJobLocked()) {
      toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
      return;
    }
    if (isReadOnlyDevice()) {
      toast('Read only — sign in as supervisor to edit', 'warn');
      return;
    }
    if (confirmBlocksEdit()) {
      toast('Tap ✅ Confirm first — confirm the order, press, operator & supervisor to start logging', 'warn');
      return;
    }
    // Reopened-for-correction: on an ENDED shift, empty slots need a
    // supervisor — the running shift's timeline is still growing and
    // stays editable (an early sign-off mustn't strand real production).
    if (reopenedBlocksNewPeriod(slot)) {
      toast('Reopened for correction — fix the signed slots & counts. Adding new time periods to an ended shift needs a supervisor signed in.', 'warn');
      return;
    }
    anchor = slot;
    isDown = true;
    dragged = false;
    S!.selSet = new Set<number>([slot]);
    paintSelection();
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture optional */
    }
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!isDown || anchor == null) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null || slot === anchor) return;
    dragged = true;
    setRange(anchor, slot);
  });

  const finish = (e: PointerEvent): void => {
    if (anchor == null) {
      release(e);
      return;
    }
    release(e);
    anchor = null;
    // Open picker for both single-tap (selSet.size==1) and drag-range cases —
    // single tap is the most common path so it shouldn't need an extra click.
    if (S!.selSet.size > 0) openStatusPicker(dragged);
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', (e) => {
    release(e);
    anchor = null;
    S!.selSet.clear();
    paintSelection();
  });
  wrap.addEventListener('lostpointercapture', () => {
    isDown = false;
  });

  paintSelection();
}

function paintSelection(): void {
  document.querySelectorAll<HTMLElement>('[data-slot][data-row="status"]').forEach((el) => {
    const slot = Number(el.dataset.slot);
    const td = el.closest<HTMLElement>('.status-cell');
    if (!td) return;
    if (S!.selSet.has(slot)) td.classList.add('multisel');
    else td.classList.remove('multisel');
  });
}

/** Find the most recent filled slot with index < min(selSet). */
function previousFilled(beforeSlot: number): ProductionRecord | undefined {
  for (let i = beforeSlot - 1; i >= 0; i--) {
    const r = slotRec(i);
    if (r && r.statusCode) return r;
  }
  return undefined;
}

function openStatusPicker(isRange: boolean): void {
  if (S!.selSet.size === 0) return;
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    S!.selSet.clear();
    paintSelection();
    return;
  }
  const slots = [...S!.selSet].sort((a, b) => a - b);
  const prev = previousFilled(slots[0]);
  const sameAsPrev = prev
    ? `<button class="bd-cause" data-pick-same>
        <span class="bd-code">↪ ${escapeHtml(prev.statusCode)}</span>
        <span class="bd-cause-text">Same as previous (${escapeHtml(prev.statusCode)} ${escapeHtml(STATUS_MAP[prev.statusCode as StatusCode]?.label ?? '')})</span>
      </button>`
    : '';
  const codes: StatusCode[] = ['R', 'B', 'C', 'D', 'I', 'M', 'O', 'P', 'S'];
  const pills = codes
    .map((c) => {
      const d = STATUS_MAP[c];
      return `<button class="ab-pill" style="background:${d.color};border-color:${d.border};color:${d.text}" data-pick="${c}">
        <span class="ab-cd">${c}</span><span class="ab-lb">${escapeHtml(d.label)}</span>
      </button>`;
    })
    .join('');
  const title = isRange || slots.length > 1
    ? `🖌 Set status — ${slots.length} slots`
    : `Set status — slot ${slots[0] + 1}/${SLOTS_PER_SHIFT} (${slotClock(sid(), slots[0])})`;
  const slotsLine = slots.length > 1
    ? `<p class="bd-sub">Slots: ${slots.map((s) => `${s + 1}`).join(', ')}</p>`
    : '';

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">${title}</h2>
    ${slotsLine}
    ${sameAsPrev ? `<div class="bd-cause-list">${sameAsPrev}</div>` : ''}
    <div class="ab-grid">${pills}</div>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-end-order title="Order or shift finished: fill any empty slots up to now with R (Running), then go straight to Sign off.">🏁 End order / shift</button>
      <button class="btn-ghost-big" data-comments>💬 Comments</button>
      <button class="btn-ghost-big" data-clear>↺ Clear (back to blank)</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const cancel = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', cancel);
  mc.querySelector('[data-clear]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, '' as StatusCode, '', '');
  });
  mc.querySelector('[data-comments]')?.addEventListener('click', () => {
    // Use cancel(), not closeModal(), so the slot selection clears —
    // the comments path doesn't apply a status, and a leftover
    // selection would confuse the next tap.
    closeModal();
    if (isJobLocked()) {
      toast('Order signed off — Unlock as supervisor to add comments', 'warn');
      S!.selSet.clear();
      paintSelection();
      return;
    }
    openCommentsModal();
  });
  // 🏁 End order / shift: fill any empty slots up to now with R, then route
  // straight to Sign off. The selected slots in the picker are irrelevant to
  // this action (it works off the whole timeline), so clear them first.
  mc.querySelector('[data-end-order]')?.addEventListener('click', () => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
    void endOrderAndSignoff();
  });
  mc.querySelector('[data-pick-same]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, prev!.statusCode as StatusCode, prev!.bdIssue, prev!.mangoTicket);
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.dataset.pick as StatusCode;
      if (code === 'B') {
        openBreakdownCascade(`${slots.length} slot${slots.length === 1 ? '' : 's'}`, '', (pick) => {
          void multiFillApply(slots, 'B', pick.code, pick.note);
        });
        return;
      }
      closeModal();
      void multiFillApply(slots, code, '', '');
    }),
  );
}

/**
 * Free-text comment popped from the Machine Status modal. The line is
 * appended to the canonical slot's Handover Material field with a
 * `[HH:MM]` wall-clock prefix so it shows up alongside the existing
 * material-side handover notes the next shift reads.
 *
 * Material was the field the production line asked for explicitly —
 * the comment-during-status flow is most often a quick "saw a streak
 * in mix #4", which is material-side observation. If they want to
 * route to a different 4M slot later it's a one-line change here.
 *
 * The on-screen Handover Material textarea is patched directly so the
 * operator sees the line land without a full re-render (which would
 * destroy any in-flight focus in the side panel).
 */
function openCommentsModal(): void {
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">💬 Add comment</h2>
    <p class="bd-sub">Appended to Handover · 📦 Material with the current time.</p>
    <textarea class="comments-input" rows="4" placeholder="Type your note…" style="width:100%;font-family:inherit;font-size:15px;padding:8px;border:2px solid var(--bd);border-radius:8px;background:#fef9c3;resize:vertical"></textarea>
    <div class="bd-actions">
      <button class="btn-primary-big" data-save>Save</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const ta = mc.querySelector<HTMLTextAreaElement>('.comments-input');
  ta?.focus();
  const close = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', close);
  mc.querySelector('[data-save]')?.addEventListener('click', () => {
    const txt = (ta?.value ?? '').trim();
    if (!txt) {
      close();
      return;
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const line = `[${hh}:${mm}] ${txt}`;
    let nextMaterial = '';
    void upsertSlotNoReload(0, (r) => {
      const obj = parseHandover(r);
      obj.material = obj.material ? `${obj.material}\n${line}` : line;
      nextMaterial = obj.material;
      r.handoverNote = JSON.stringify(obj);
    });
    // Patch the visible textarea so the operator sees the line land.
    const live = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-meta="hand-material"]',
    );
    if (live) live.value = nextMaterial;
    toast('Comment added to Handover · Material', 'ok');
    close();
  });
}

export async function multiFillApply(
  slots: number[],
  code: StatusCode,
  bdIssue: string,
  mangoNote: string,
): Promise<void> {
  const bdCause =
    code === 'B'
      ? mangoNote.trim() || breakdownDetailFor(bdIssue, S!.bdCodes).cause
      : '';
  const apply = (r: ProductionRecord): void => {
    r.statusCode = code;
    r.bdIssue = code === 'B' ? bdIssue : '';
    r.bdCause = code === 'B' ? bdCause : '';
    if (code === 'B') r.mangoTicket = mangoNote;
    else r.mangoTicket = '';
  };
  // Mirror the machine status across every co-running order on this die
  // (they share the press, so they share the timeline). Counts / rejects
  // / sign-off stay per-order — only the status row is mirrored.
  const siblings = coRunSiblings(S!.selJob);
  // A supervisor may write over another order's half-hour; say which, so the
  // other order's copy gets cleared rather than left as a double booking.
  const clashes = slots
    .map((slot) => ({ slot, occ: occupyingOtherJob(slot) }))
    .filter((c): c is { slot: number; occ: ProductionRecord } => c.occ !== null);
  // Sequential upserts — keep simple; could batch later if needed.
  for (const slot of slots) {
    await upsertSlotNoReload(slot, apply);
    for (const sib of siblings) await upsertSlotForJob(sib, slot, apply);
  }
  S!.selSet.clear();
  const mirroredNote = siblings.length ? ` (+${siblings.length} co-run)` : '';
  toast(
    `Filled ${slots.length} slot${slots.length === 1 ? '' : 's'} with ${code}${mirroredNote}`,
    'ok',
  );
  if (clashes.length) {
    toast(
      `Also recorded on ${[...new Set(clashes.map((c) => c.occ.jobNumber))].join(', ')} at ` +
        clashes.map((c) => slotClock(sid(), c.slot).split('–')[0]).join(', ') +
        ' — clear it there so the press is not in two orders at once',
      'warn',
    );
  }
  // Skip reload() here. upsertSlotNoReload already mutated S!.prod in
  // memory, and a status edit cannot change anything reload() would
  // re-fetch — Job Left / Total Good are driven by Count Start/End and
  // Rejects, not by status; maybeCarryCountStart is a no-op once it's
  // already been carried; refreshJobTotal sums canonical countEnd
  // across shifts which a status edit doesn't touch. Skipping the SP
  // round-trip turns the iPad lag on "fill a status cell" from
  // 600-800 ms (REST + render) down to a single render.
  render();
  // Kick a live snapshot push so other iPads see the new status pattern
  // without waiting up to 60 s for the next poll tick. Fire-and-forget.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
  // One report per CONTINUOUS D/I block. Extending an existing block finds
  // the same start slot and edits the same EventKey; a later, separate block
  // gets its own row.
  if (code === 'D' || code === 'I') {
    const events = dieChangeEventsTouching(slots);
    if (events.length) maybeOpenDieChangeLog(code, events);
  }
}
