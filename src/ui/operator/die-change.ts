// Operator sheet — the die-change condition report, and whether one is owed.
import { slotRec, sid, orderForJob } from './sheet';
import { SLOTS_PER_SHIFT } from '../../core/shifts';
import {
  dieChangeEventKey,
  type DieComponent,
  DIE_COMPONENTS,
  DIE_CONDITION_META,
  dieSignOffStatus,
  DIE_CONDITION_OF_RANK,
} from '../../core/die';
import { S, dalRef } from './state';
import type { StatusCode, DieChangeLog, DieComponentCondition } from '../../types';
import { toast } from '../toast';
import { escapeHtml, openModal, closeModal } from '../modal';

// ---------------------------------------------------------------------
// Die Change Log (PMD_DieChangeLog) — one row per continuous D/I block.
// Date / shift / setter / machine / job / die-out / die-in are
// prefilled; the setter's real work is the condition
// check (1 Good · 2 Worn · 3 Damaged) that builds the die's health
// history for the toolroom. EventKey includes the block's first slot, so a
// later independent change on the same job does not overwrite this one.
// The checks are PMD_DieChangeLog's 1 / 2 / 3 Choice columns. A press owes
// one log with "Die" ticked per shift: the first D asks for it without a
// Skip, later D's do not ask, and sign-off asks if it is still missing.

interface DieChangeEventRef {
  start: number;
  end: number;
  eventKey: string;
}

export function dieChangeEventsTouching(slots: number[]): DieChangeEventRef[] {
  const isChange = (slot: number): boolean => {
    const c = slotRec(slot)?.statusCode;
    return c === 'D' || c === 'I';
  };
  const day = sid().slice(0, 10);
  const byStart = new Map<number, DieChangeEventRef>();
  for (const slot of slots) {
    if (!isChange(slot)) continue;
    let start = slot;
    let end = slot;
    while (start > 0 && isChange(start - 1)) start--;
    while (end + 1 < SLOTS_PER_SHIFT && isChange(end + 1)) end++;
    byStart.set(start, {
      start,
      end,
      eventKey: dieChangeEventKey(S!.mc, day, S!.shiftCode, S!.selJob, start),
    });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/**
 * Whether this press has a die change logged this shift — a saved Die Change
 * Log with "Die" ticked, whichever order it was filed under. One is what a
 * shift owes: the first D asks for it and will not take Skip, and once it is
 * saved no later D asks again. Throws when the log cannot be read.
 */
async function shiftDieChangeLogged(): Promise<boolean> {
  if (!dalRef.listDieChangeLog) return true;
  const day = sid().slice(0, 10);
  const norm = (v: string): string => v.trim().toUpperCase();
  return (await dalRef.listDieChangeLog()).some(
    (r) =>
      norm(r.machineCode) === norm(S!.mc) &&
      r.date === day &&
      norm(r.shift) === norm(S!.shiftCode) &&
      r.changeOver.includes('Die'),
  );
}

export function maybeOpenDieChangeLog(code: StatusCode, events: DieChangeEventRef[]): void {
  if (!dalRef.createDieChangeLog || !S!.selJob) return;
  void (async () => {
    if (code === 'D') {
      // One die change log per press per shift, and it is not optional.
      let logged: boolean;
      try {
        logged = await shiftDieChangeLogged();
      } catch (e) {
        console.warn('[pmd] die change log read failed:', e);
        toast('Could not read the Die Change Log — it will be asked for at sign-off', 'warn');
        return;
      }
      if (!logged) await openDieChangeLogModal(code, events[0], { required: true });
      return;
    }
    // A dragged range can skip slots occupied by another job, producing two
    // disjoint D/I blocks. Prompt for each block in sequence so every
    // continuous event gets its own row; opening them all at once would make
    // the shared modal host overwrite all but the last.
    for (const event of events) await openDieChangeLogModal(code, event);
  })().catch((e) => {
      console.error('[pmd] die change log open failed:', e);
    });
}

/**
 * Sign-off's check that the shift's die change was logged: the selected
 * order has D on the timeline and the press has no Die Change Log this shift
 * (the popup was closed by a reload, or its save failed). Opens the required
 * log for the order's first D block; true when sign-off may go on.
 */
export async function dieChangeLoggedForSignoff(): Promise<boolean> {
  if (!dalRef.createDieChangeLog || !S!.selJob) return true;
  const dSlots = S!.prod
    .filter((r) => r.jobNumber === S!.selJob && r.statusCode === 'D')
    .map((r) => r.slotIndex);
  if (!dSlots.length) return true;
  try {
    if (await shiftDieChangeLogged()) return true;
  } catch (e) {
    toast(`Could not read the Die Change Log — try sign-off again (${e instanceof Error ? e.message : e})`, 'err');
    return false;
  }
  const [event] = dieChangeEventsTouching(dSlots);
  if (!event) return true;
  toast('This shift has a die change (D): fill in the Die Change Log before signing off', 'warn');
  await openDieChangeLogModal('D', event, { required: true });
  try {
    return await shiftDieChangeLogged();
  } catch {
    return false;
  }
}

async function eventDieChangeLog(event: DieChangeEventRef): Promise<DieChangeLog | undefined> {
  if (!dalRef.listDieChangeLog) return undefined;
  try {
    return (await dalRef.listDieChangeLog()).find((r) => r.eventKey === event.eventKey);
  } catch (e) {
    toast(`Could not read Die Change Log: ${e instanceof Error ? e.message : e}`, 'err');
    throw e;
  }
}

async function openDieChangeLogModal(
  trigger: StatusCode,
  event: DieChangeEventRef,
  opts: { required?: boolean } = {},
): Promise<void> {
  const required = !!opts.required;
  const saved = await eventDieChangeLog(event);
  const existing = saved != null;
  // The checks are PMD_DieChangeLog's own condition columns, so one the
  // toolroom adds there is asked here too.
  const checks: DieComponent[] = dalRef.listDieChangeComponents
    ? await dalRef.listDieChangeComponents().catch(() => DIE_COMPONENTS)
    : DIE_COMPONENTS;
  const dieByPart = (part?: string): { dieNumber: string; die: string } | undefined =>
    part ? S!.dieColors.get(part.trim().toUpperCase()) : undefined;
  const partIn =
    orderForJob(S!.selJob)?.partNumber ??
    S!.prod.find((r) => r.jobNumber === S!.selJob && r.partNumber)?.partNumber ??
    '';
  const dieIn = dieByPart(partIn);
  // Die OUT (best effort): the die of the job that occupied earlier
  // slots on this press this shift — the setter can correct it.
  let dieOut: { dieNumber: string; die: string } | undefined;
  const others = [...S!.prod]
    .filter((r) => r.jobNumber && r.jobNumber !== S!.selJob && r.statusCode)
    .sort((a, b) => b.slotIndex - a.slotIndex);
  for (const r of others) {
    const d = dieByPart(r.partNumber);
    if (d?.dieNumber && d.dieNumber !== dieIn?.dieNumber) {
      dieOut = d;
      break;
    }
  }
  const dies = Array.from(
    new Map(
      Array.from(S!.dieColors.values())
        .filter((d) => d.dieNumber)
        .map((d) => [d.dieNumber, d]),
    ).values(),
  ).sort((a, b) => a.dieNumber.localeCompare(b.dieNumber, undefined, { numeric: true }));
  const dieOpts = (sel?: string): string =>
    `<option value="">—</option>` +
    dies
      .map(
        (d) =>
          `<option value="${escapeHtml(d.dieNumber)}"${d.dieNumber === sel ? ' selected' : ''}>${escapeHtml(
            d.dieNumber,
          )}${d.die ? ` — ${escapeHtml(d.die)}` : ''}</option>`,
      )
      .join('');
  // Edit mode: everything prefills from the saved rows so the setter can
  // correct a rating or add detail; the save MERGEs the same records.
  const selSetter = saved?.dieSetter || S!.selOperator;
  const setterNames = Array.from(
    new Set(
      [selSetter, S!.selOperator, ...S!.operators.map((o) => o.operatorName)].filter(Boolean),
    ),
  );
  const setterOpts = setterNames
    .map((n) => `<option${n === selSetter ? ' selected' : ''}>${escapeHtml(n)}</option>`)
    .join('');
  const coChecked = (label: string, fallback: boolean): boolean =>
    saved ? saved.changeOver.includes(label) : fallback;
  const co = (label: string, checked: boolean): string =>
    `<label class="dcl-co"><input type="checkbox" value="${escapeHtml(label)}"${checked ? ' checked' : ''}>${escapeHtml(label)}</label>`;
  // One condition grid for a side (out / in), prefilled from its row.
  const compGrid = (
    side: 'out' | 'in',
    comps: Record<string, DieComponentCondition> | undefined,
  ): string =>
    `<div class="dcl-comps" data-dcl-side="${side}">${checks.map((c) => {
      const sel: DieComponentCondition = comps?.[c.key] || 'good';
      return `<div class="dcl-comp" data-dcl-comp="${c.key}">
        <span class="dcl-comp-name">${escapeHtml(c.label)}</span>
        <span class="dcl-seg">${(['good', 'worn', 'damaged'] as const)
          .map(
            (k) =>
              `<button type="button" class="dcl-opt ${DIE_CONDITION_META[k].cls}${
                k === sel ? ' a' : ''
              }" data-cond="${k}" title="${escapeHtml(DIE_CONDITION_META[k].label)}">${DIE_CONDITION_META[k].short}</button>`,
          )
          .join('')}</span>
      </div>`;
    }).join('')}</div>`;
  const day = sid().slice(0, 10);
  // A saved die number may be typed differently to PMD_ProductDieColor's
  // ("280" vs "280 ") — normalise the select match.
  const dieSel = (saved: string | undefined, fallback?: string): string | undefined => {
    if (!saved) return fallback;
    const norm = saved.trim().toUpperCase();
    return dies.find((d) => d.dieNumber.trim().toUpperCase() === norm)?.dieNumber ?? fallback;
  };
  const mc = openModal(`<div class="bd-modal dcl-modal">
    <h2 class="bd-title dcl-title">🔁 Die Change Log${existing ? ' — edit' : ''}</h2>
    <p class="bd-sub dcl-editnote"><i>Timeline slots ${event.start + 1}–${event.end + 1} · one SharePoint row for this continuous event${existing ? ' · editing the saved row' : ''}.</i></p>
    ${required ? '<p class="dcl-required"><b>Required:</b> one Die Change Log per press per shift. Once it is saved, no other D this shift asks for it.</p>' : ''}
    <div class="dcl-row">
      <label>Die setter<select data-dcl="setter">${setterOpts}</select></label>
      <span class="dcl-cos">Change over ${required ? co('Die', true).replace('<input ', '<input disabled ') : co('Die', coChecked('Die', trigger === 'D'))}${co('Insert', coChecked('Insert', trigger === 'I'))}${co('Space In', coChecked('Space In', false))}${co('SpaceOut', coChecked('SpaceOut', false))}</span>
    </div>
    <div class="dcl-row">
      <label>Die OUT<select data-dcl="out">${dieOpts(dieSel(saved?.dieNumberOut, dieOut?.dieNumber))}</select></label>
      <label>Die IN<select data-dcl="in">${dieOpts(dieSel(saved?.dieNumberIn, dieIn?.dieNumber))}</select></label>
    </div>
    <p class="dcl-legend"><b>Condition Check:</b> 1. Good work order; 2. Operational but worn; 3. Damaged/Can't be used.</p>
    <div class="dcl-section">
      <div class="dcl-sec-h out">🔻 Die OUT — condition when removed <em>problems usually show here</em></div>
      ${compGrid('out', saved?.components)}
      <label class="dcl-prob">Die OUT problem (needed when anything is 2 or 3)
        <textarea data-dcl="probOut" rows="2" placeholder="What's worn / damaged on the die coming out, which cavity…">${escapeHtml(saved?.problemDescription ?? '')}</textarea></label>
    </div>
    <div class="dcl-section">
      <div class="dcl-sec-h in">🔺 Die IN — condition when fitted</div>
      ${compGrid('in', saved?.componentsIn)}
      <label class="dcl-prob">Die IN problem (needed when anything is 2 or 3)
        <textarea data-dcl="probIn" rows="2" placeholder="Any issue with the die going in…">${escapeHtml(saved?.problemDescriptionIn ?? '')}</textarea></label>
    </div>
    <div class="dcl-signoff" data-dcl-signoff aria-live="polite"></div>
    <div class="bd-actions">
      <button class="btn-primary-big" data-dcl-save>${existing ? 'Update' : 'Save'} Die Change Log</button>
      ${required ? '<button class="btn-ghost-big" data-dcl-skip hidden>Close — asked again at sign-off</button>' : '<button class="btn-ghost-big" data-dcl-skip>Skip</button>'}
    </div>
  </div>`);
  let resolveModal!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveModal = resolve;
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveModal();
  };
  // Backdrop dismissal is equivalent to Skip for queue progression. A
  // required log has no Skip, so the backdrop does nothing.
  const backdrop = document.getElementById('modal');
  if (backdrop) {
    backdrop.onclick = (e) => {
      if (e.target !== backdrop || required) return;
      closeModal();
      finish();
    };
  }
  /*
   * The single number this inspection is signed off on — the worst rating
   * anywhere on it, which is what goes into PMD_DieChangeLog.SignOffStatus.
   *
   * Shown, and kept current as the setter taps, because "the state the worker
   * confirmed" has to be something the worker actually saw. It is derived
   * rather than picked: the setter has already answered the question 26
   * times, and a 14th control that can disagree with the 26 is a column that
   * can lie about the row it sits on.
   */
  const readSide = (side: 'out' | 'in'): Record<string, DieComponentCondition> => {
    const comps: Record<string, DieComponentCondition> = {};
    mc.querySelectorAll<HTMLElement>(`[data-dcl-side="${side}"] [data-dcl-comp]`).forEach((row) => {
      comps[row.dataset.dclComp!] = (row.querySelector<HTMLElement>('.dcl-opt.a')?.dataset.cond ??
        '') as DieComponentCondition;
    });
    return comps;
  };
  const paintSignOff = (): void => {
    const box = mc.querySelector<HTMLElement>('[data-dcl-signoff]');
    if (!box) return;
    const status = dieSignOffStatus(readSide('out'), readSide('in'));
    const cond = DIE_CONDITION_OF_RANK[status];
    box.className = `dcl-signoff${cond ? ` ${DIE_CONDITION_META[cond].cls}` : ''}`;
    box.innerHTML = cond
      ? `<span>Signing off as</span><b>${escapeHtml(DIE_CONDITION_META[cond].label)}</b>`
      : '<span>Nothing rated yet — the die condition will be left blank</span>';
  };
  mc.querySelectorAll<HTMLButtonElement>('.dcl-opt').forEach((b) =>
    b.addEventListener('click', () => {
      b.parentElement!.querySelectorAll('.dcl-opt').forEach((x) => x.classList.remove('a'));
      b.classList.add('a');
      paintSignOff();
    }),
  );
  paintSignOff();
  mc.querySelector('[data-dcl-skip]')?.addEventListener('click', () => {
    closeModal();
    finish();
  });
  mc.querySelector<HTMLButtonElement>('[data-dcl-save]')?.addEventListener('click', () => {
    void (async () => {
      const val = (k: string): string =>
        (mc.querySelector<HTMLSelectElement | HTMLTextAreaElement>(`[data-dcl="${k}"]`)?.value ?? '').trim();
      // Collect the ratings for one side, counting worn/damaged flags.
      const collect = (side: 'out' | 'in'): { comps: Record<string, DieComponentCondition>; flagged: number } => {
        const comps = readSide(side);
        const flagged = Object.values(comps).filter(
          (cond) => cond === 'worn' || cond === 'damaged',
        ).length;
        return { comps, flagged };
      };
      const out = collect('out');
      const inc = collect('in');
      const probOut = val('probOut');
      const probIn = val('probIn');
      if (out.flagged > 0 && !probOut) {
        toast('Describe the worn / damaged component(s) on the die OUT first', 'warn');
        return;
      }
      if (inc.flagged > 0 && !probIn) {
        toast('Describe the worn / damaged component(s) on the die IN first', 'warn');
        return;
      }
      const changeOver = Array.from(
        mc.querySelectorAll<HTMLInputElement>('.dcl-co input:checked'),
      ).map((c) => c.value);
      // What makes a required log count for the shift (shiftDieChangeLogged).
      if (required && !changeOver.includes('Die')) changeOver.unshift('Die');
      const outDie = dies.find((d) => d.dieNumber === val('out'));
      const inDie = dies.find((d) => d.dieNumber === val('in'));
      const btn = mc.querySelector<HTMLButtonElement>('[data-dcl-save]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving…';
      }
      const setter = val('setter');
      try {
        // Exactly one row: event metadata + OUT and IN inspections.
        await dalRef.createDieChangeLog!({
          eventKey: event.eventKey,
          eventStartSlot: event.start,
          eventEndSlot: event.end,
          date: day,
          shift: S!.shiftCode,
          dieSetter: setter,
          machineCode: S!.mc,
          changeOver,
          jobNumber: S!.selJob,
          dieNumberOut: outDie?.dieNumber ?? '',
          dieDescriptionOut: outDie?.die ?? '',
          dieNumberIn: inDie?.dieNumber ?? '',
          dieDescriptionIn: inDie?.die ?? '',
          components: out.comps,
          componentsIn: inc.comps,
          problemDescription: probOut,
          problemDescriptionIn: probIn,
        });
        closeModal();
        finish();
        const total = out.flagged + inc.flagged;
        toast(
          total > 0
            ? `Die Change Log ${existing ? 'updated' : 'saved'} — ${total} component${total === 1 ? '' : 's'} flagged (OUT ${out.flagged} · IN ${inc.flagged})`
            : `Die Change Log ${existing ? 'updated' : 'saved'} — all components good`,
          'ok',
        );
      } catch (e) {
        console.error('[pmd] die change log save failed:', e);
        toast(`Could not save: ${e instanceof Error ? e.message : e}`, 'err');
        if (btn) {
          btn.disabled = false;
          btn.textContent = `${existing ? 'Update' : 'Save'} Die Change Log`;
        }
        // A required log that cannot be saved must not trap the press: it
        // may be closed now, and sign-off asks for it again.
        mc.querySelector<HTMLButtonElement>('[data-dcl-skip]')?.removeAttribute('hidden');
      }
    })();
  });
  return completed;
}
