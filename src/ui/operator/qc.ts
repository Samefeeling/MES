// Operator sheet — signing a half-hour's Quality Check.
import { S, canWriteThisDevice, dalRef } from './state';
import { toast } from '../toast';
import { isJobLocked } from './lock';
import { qcRoleFor, rosterNames, otherShiftNames, initials, OTHER_SHIFTS_LABEL } from './view';
import { slotRec, sid } from './sheet';
import { escapeHtml, openModal, closeModal } from '../modal';
import { SLOTS_PER_SHIFT, slotClock } from '../../core/shifts';
import { upsertSlotNoReload } from './data';

export function openQcPicker(slot: number): void {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
    return;
  }
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  const role = qcRoleFor(slot);
  const current = slotRec(slot)?.qcBy ?? '';
  // QC sign-off names are also narrowed to the shift's roster (current
  // sign-off always kept, even if from another shift).
  const people = role === 'operator' ? S!.operators : S!.supervisors;
  const roster = rosterNames(people, S!.shiftCode, current);
  // Somebody on overtime signs on a shift they are not rostered on.
  const others = otherShiftNames(people, roster);
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const pick = (n: string): string =>
    `<button class="bd-cause${n === current ? ' is-current' : ''}" data-qc-pick="${escapeHtml(n)}">
          <span class="bd-code">${escapeHtml(initials(n))}</span>
          <span class="bd-cause-text">${escapeHtml(n)}</span>
        </button>`;
  const buttons = roster.map(pick).join('')
    + (others.length ? `<p class="bd-sub">${OTHER_SHIFTS_LABEL}</p>${others.map(pick).join('')}` : '');
  const clearBtn = current
    ? `<button class="btn-ghost-big" data-qc-clear>↺ Clear sign-off</button>`
    : '';
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">🔍 Quality Check — slot ${slot + 1}/${SLOTS_PER_SHIFT} (${escapeHtml(
      slotClock(sid(), slot),
    )})</h2>
    <p class="bd-sub">${roleLabel} sign-off · ${escapeHtml(S!.mc)} · ${escapeHtml(S!.selJob)}${
      current ? ` · currently signed by <b>${escapeHtml(current)}</b>` : ''
    }</p>
    <div class="bd-cause-list">${buttons || '<p class="bd-sub">No names available — add them on the People list.</p>'}</div>
    <div class="bd-actions">
      ${clearBtn}
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-qc-clear]')?.addEventListener('click', () => {
    closeModal();
    void applyQc(slot, '');
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-qc-pick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      closeModal();
      void applyQc(slot, btn.dataset.qcPick ?? '');
    }),
  );
}

async function applyQc(slot: number, name: string): Promise<void> {
  await upsertSlotNoReload(slot, (r) => {
    r.qcBy = name;
  });
  // Live snapshot push so the floor view picks up the QC sign-off
  // without waiting for the operator poll tick.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
  // Repaint just the QC row so the grid scroll position + every input
  // currently focused stays untouched.
  repaintQcRow();
}

function repaintQcRow(): void {
  const row = document.querySelector<HTMLElement>('.op-grid tr.row-qc');
  if (!row) return;
  const cells = row.querySelectorAll<HTMLElement>('td');
  for (let i = 0; i < cells.length; i++) {
    const rec = slotRec(i);
    const name = rec?.qcBy ?? '';
    const role = qcRoleFor(i);
    const btn = cells[i].querySelector<HTMLButtonElement>('.qc-btn');
    if (!btn) continue;
    btn.textContent = name ? `✓ ${initials(name)}` : '—';
    cells[i].classList.toggle('is-signed', !!name);
    cells[i].title = name
      ? `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off · ${name} · tap to change`
      : `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off required · tap to confirm`;
  }
}
