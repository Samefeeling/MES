// Operator sheet — what each control on the drawn sheet does.
import type { ShiftCode, ProductionRecord } from '../../types';
import { S, saveView, dalRef } from './state';
import {
  discardIfUnconfirmed,
  reload,
  upsertSlotNoReload,
  refreshJobTotalAndPaintSide,
  needsConfirm,
  confirmCurrentTuple,
  upsertSlot,
} from './data';
import { sid, parseRejects, slotRec, shiftOrders, isPastShift } from './sheet';
import { dropSummaryCache } from './summary';
import { openAddOrderModal } from './add-order';
import { setDieNoteContext } from '../nav-context';
import { dateKey, currentShift, parseShiftId } from '../../core/shifts';
import { rejectEntryBlocked } from './lock';
import { toast } from '../toast';
import { openQcPicker } from './qc';
import { fitDispZoomToScreen, stepDispZoom } from './zoom';
import { renderNowLine, render } from './render';
import { toggleDictation } from './dictation';
import { queuePhoto, renderPhotoStrip, lastPhotoFlushAt, flushPhotoQueue } from './photos';
import { openSaveSignoffModal, openUnlockModal } from './signoff';
import { wireStatusPicker } from './status-picker';
import { type Handover, parseHandover as sharedParseHandover } from '../../core/handover';

export function wire(): void {
  const app = document.getElementById('app')!;

  // Shift tabs — keep selJob across shift moves: operators commonly
  // carry the same job from Day → Afternoon → Night and shouldn't have to
  // re-pick it. If the new shift has no rows for that job, the grid will
  // just show empty cells. (Day arrows are gone — the date input shows
  // today by default; past days are still reachable via the picker for
  // supervisors reviewing history.)
  app.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = b.dataset.shift as ShiftCode;
      if (next === S!.shiftCode) return;
      // Switching shift is free — the floor asked NOT to be blocked on every
      // navigation. Sign-off discipline is now a soft reminder in the last
      // 5 min of the shift (see buildSignoffReminderBanner) rather than a
      // gate on leaving. Unconfirmed browses are dropped on the way out.
      discardIfUnconfirmed();
      S!.shiftCode = next;
      void reload();
    }),
  );

  // Drill from a summary row back into single-shift detail.
  app.querySelectorAll<HTMLElement>('[data-jump-shift]').forEach((row) =>
    row.addEventListener('click', () => {
      const sid = row.dataset.jumpShift!;
      const m = /^(\d{4})-(\d{2})-(\d{2})-(Day|Afternoon|Night)$/.exec(sid);
      if (!m) return;
      discardIfUnconfirmed();
      S!.viewDate = new Date(+m[1], +m[2] - 1, +m[3]);
      S!.shiftCode = m[4] as ShiftCode;
      S!.viewLevel = 1;
      dropSummaryCache();
      void reload();
    }),
  );

  // Meta fields
  app.querySelectorAll<HTMLElement>('[data-meta]').forEach((el) => {
    el.addEventListener('change', () => onMetaChange(el));
  });
  // ＋ next to Job# (supervisor only) — manual order entry for jobs the
  // Epicor extract is missing.
  app
    .querySelector<HTMLButtonElement>('[data-add-order]')
    ?.addEventListener('click', () => openAddOrderModal());
  // ⛓ Co-Run chips — one-tap hop to a co-running order. Switching between
  // co-runners is exempt from the sign-off-before-leaving gate, so this skips
  // straight to the reload that swaps the per-job view.
  app.querySelectorAll<HTMLButtonElement>('[data-corun-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const j = btn.dataset.corunJump;
      if (!j || j === S!.selJob) return;
      discardIfUnconfirmed();
      S!.selJob = j;
      saveView();
      void reload();
    });
  });
  // Die# pill — deep-link into the Tool board's drilldown for this die.
  // Stash the current shift context first so the drilldown's Add-note dialog
  // can stamp Date / Shift / Machine / Operator without re-deriving them.
  app.querySelector<HTMLButtonElement>('[data-die-jump]')?.addEventListener('click', (e) => {
    const die = (e.currentTarget as HTMLButtonElement).dataset.dieJump;
    if (!die) return;
    setDieNoteContext({
      date: dateKey(S!.viewDate),
      shift: S!.shiftCode,
      machine: S!.mc,
      operator: S!.selOperator,
    });
    window.location.hash = `#/tool/die/${encodeURIComponent(die)}`;
  });
  app
    .querySelector<HTMLTextAreaElement>('textarea[data-meta="comments"]')
    ?.addEventListener('blur', (e) => onMetaChange(e.target as HTMLElement));

  // Status cells are picked via the unified hold-and-drag picker — see
  // wireStatusPicker() at the bottom of wire().

  // Named reject inputs — use the no-reload upsert so tabbing from one
  // cell to the next doesn't trigger a full reload() → render() cycle
  // that destroys the input the operator just moved focus into. The
  // refreshJobTotalAndPaintSide call keeps the side-panel totals fresh
  // without rebuilding the grid.
  app.querySelectorAll<HTMLInputElement>('input[data-row="named"]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const slot = Number(inp.dataset.slot);
      const code = inp.dataset.code!;
      // Live lock guard — same as the Machine Status / Quality Check
      // pickers. A signed-off (or unconfirmed / read-only) slot rejects
      // the edit and reverts the cell, even if its `disabled` attribute is
      // stale, so a worker can't slip a reject into the wrong place.
      const guard = rejectEntryBlocked(slot, code);
      if (guard.blocked) {
        const cur = parseRejects(slotRec(slot))[code] ?? 0;
        inp.value = cur ? String(cur) : '';
        toast(guard.reason, 'warn');
        return;
      }
      const qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      void upsertSlotNoReload(slot, (r) => {
        const obj = parseRejects(r);
        if (qty > 0) obj[code] = qty;
        else delete obj[code];
        r.rejects = JSON.stringify(obj);
      }).then(() => void refreshJobTotalAndPaintSide());
    }),
  );

  // A disabled input fires no events, so a blocked reject cell would just
  // swallow the tap and leave the worker guessing — which is how the wrong
  // -column entries went unnoticed in the first place. The input carries
  // pointer-events:none, so the tap lands on the <td> and we can say why.
  app.querySelectorAll<HTMLElement>('td.num-cell.is-blocked').forEach((td) =>
    td.addEventListener('click', () => {
      const inp = td.querySelector<HTMLInputElement>('input.rej-input');
      if (!inp) return;
      const guard = rejectEntryBlocked(Number(inp.dataset.slot), inp.dataset.code!);
      if (guard.blocked) toast(guard.reason, 'warn');
    }),
  );

  // Digits-only sanitiser for every numeric input on the page (D01-D10
  // reject cells, Count Start / End, Purge). `inputmode="numeric"`
  // only hints the on-screen keyboard — an iPad with an attached
  // hardware keyboard, paste, or autofill can still inject '.' / ','
  // / letters, which would land in upsertSlot as NaN. Strip on the
  // `input` event so the value the operator sees and the value we
  // persist always match. Caret position is restored so editing in
  // the middle of a multi-digit count doesn't jump to the end.
  app
    .querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')
    .forEach((inp) =>
      inp.addEventListener('input', () => {
        const cleaned = inp.value.replace(/[^0-9]/g, '');
        if (cleaned === inp.value) return;
        const caret = (inp.selectionStart ?? cleaned.length) - (inp.value.length - cleaned.length);
        inp.value = cleaned;
        try {
          inp.setSelectionRange(caret, caret);
        } catch {
          /* type=number / browser rejection — caret restore is best-effort */
        }
      }),
    );

  // Quality Check picker: alternating operator / supervisor cadence —
  // even slot pops the operators list, odd slot the supervisors list.
  // Tap-then-pick lands the chosen name on the slot record's qcBy field
  // (no full reload — refreshes just the QC cell so a supervisor walking
  // the floor and signing one cell after another doesn't lose focus or
  // their place in the grid).
  app.querySelectorAll<HTMLButtonElement>('[data-qc-slot]').forEach((b) =>
    b.addEventListener('click', () => {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        return;
      }
      const slot = Number(b.dataset.qcSlot);
      if (Number.isFinite(slot)) openQcPicker(slot);
    }),
  );

  // Buttons
  // ⚠ Future-shift fix — jump straight to the shift running now (the night
  // that's actually in progress). No sign-off gate: the whole point is to get
  // out of the mis-dated shift, where nothing legitimate should be entered.
  app
    .querySelector<HTMLButtonElement>('[data-confirm-tuple]')
    ?.addEventListener('click', () => void confirmCurrentTuple());
  app.querySelector('[data-jump-live]')?.addEventListener('click', () => {
    const cs = currentShift(new Date());
    const p = parseShiftId(cs.shiftId);
    if (!p) return;
    discardIfUnconfirmed();
    S!.viewDate = new Date(p.year, p.month - 1, p.day);
    S!.shiftCode = p.code;
    dropSummaryCache();
    void reload();
  });
  // Display-size − / + steppers + tap-the-% for auto-fit. No full
  // re-render: just re-apply the CSS var (which syncs the % label) and
  // reposition the NOW line (its pixel maths divides by the zoom factor
  // — see renderNowLine).
  app.querySelectorAll<HTMLButtonElement>('[data-dispzoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.dispzoom;
      if (mode === 'fit') {
        fitDispZoomToScreen();
      } else {
        stepDispZoom(mode === '+' ? 1 : -1);
      }
      renderNowLine();
    }),
  );
  // 🎤 dictation toggles on the handover boxes.
  app.querySelectorAll<HTMLButtonElement>('[data-mic]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      toggleDictation(b.dataset.mic!, b);
    }),
  );
  // 📷 defect photos → PMD_Production attachments.
  const photoInput = app.querySelector<HTMLInputElement>('[data-photo-file]');
  app.querySelector<HTMLButtonElement>('[data-photo-take]')?.addEventListener('click', () => {
    if (!S!.selJob) {
      toast('Pick a Job# first — photos attach to the job being run', 'warn');
      return;
    }
    photoInput?.click();
  });
  photoInput?.addEventListener('change', () => {
    const f = photoInput.files?.[0];
    photoInput.value = ''; // same photo re-takeable
    if (!f) return;
    void queuePhoto(f).catch((e) => {
      console.error('[photo] processing failed:', e);
      toast('Could not process that photo — try again', 'err');
    });
  });
  renderPhotoStrip();
  // Retry stranded queued photos (e.g. the tuple was signed off on
  // another device, or the last upload died mid-flight) — throttled so
  // per-keystroke re-renders don't hammer SP with row lookups.
  if (Date.now() - lastPhotoFlushAt > 60_000) void flushPhotoQueue();
  app.querySelector('[data-signoff-now]')?.addEventListener('click', () => void openSaveSignoffModal());
  app.querySelector('[data-refresh]')?.addEventListener('click', () => void refreshAll());
  app.querySelector('[data-saveclear]')?.addEventListener('click', () => void openSaveSignoffModal());
  app.querySelector('[data-unlock]')?.addEventListener('click', () => openUnlockModal());
  wireStatusPicker();
}

export function onMetaChange(el: HTMLElement): void {
  const key = el.dataset.meta;
  const isCheckbox =
    el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox';
  const target = el as HTMLInputElement; // also works for select/textarea (.value)
  const val = isCheckbox ? String(target.checked) : target.value;
  switch (key) {
    case 'date': {
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        discardIfUnconfirmed();
        d.setHours(0, 0, 0, 0);
        S!.viewDate = d;
        void reload();
      }
      break;
    }
    case 'machine':
      // Free to switch presses — no sign-off gate on navigation (the floor
      // found it too aggressive). The shift-end reminder covers discipline.
      // An unconfirmed selection is discarded on the way out: that browse
      // never happened as far as the data is concerned.
      discardIfUnconfirmed();
      S!.mc = val;
      // Machine change does clear selJob: a different press generally runs
      // a different order, and carrying the previous job number across
      // machines tends to mask the empty grid rather than help.
      S!.selJob = '';
      dropSummaryCache(); // cache is per-machine
      // Keep the URL hash truthful WITHOUT a router remount (replaceState
      // fires no hashchange). The dropdown used to leave the old
      // #/op/<press> in the URL, so any reload — notably the auto-updater
      // applying a new build — re-entered the route on the press the tab
      // first OPENED with, not the one on screen: exactly how iPads
      // snapped back to 1600T after a deploy and workers logged the
      // wrong machine.
      try {
        history.replaceState(null, '', `#/op/${encodeURIComponent(val)}`);
      } catch {
        /* about:blank / sandboxed host — state is still saved by saveView */
      }
      void reload();
      break;
    case 'job':
      // Switching orders is free — the floor asked not to be blocked when
      // moving between jobs. Job Left discipline is handled by the shift-end
      // sign-off reminder instead of a gate here.
      discardIfUnconfirmed();
      S!.selJob = val;
      saveView();
      // Full reload, not just render(): Job Left / Total Good and the
      // Count Start auto-carry are per-job, so switching orders with a
      // bare re-render showed the PREVIOUS job's cross-shift total and
      // skipped the carry for the new one.
      void reload();
      break;
    case 'operator':
      S!.selOperator = val;
      S!.namesFor = `${S!.mc}|${sid()}`;
      saveView();
      // Pre-confirm the name is only STAGED — the confirm tap writes it.
      // Writing here would recreate the junk the confirm flow prevents.
      if (needsConfirm()) {
        render();
        break;
      }
      void upsertSlot(0, (r) => {
        r.operator = val;
      });
      break;
    case 'supervisor':
      S!.selSupervisor = val;
      S!.namesFor = `${S!.mc}|${sid()}`;
      saveView();
      if (needsConfirm()) {
        render();
        break;
      }
      void upsertSlot(0, (r) => {
        r.supervisor = val;
      });
      break;
    case 'purge':
    case 'cstart':
    case 'cend': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        render();
        break;
      }
      // Same race-protection as the handover textareas — a full reload
      // after each blur destroys the focused input the operator is
      // typing into next, e.g. tabbing from Count Start straight into
      // Count End would lose the second number when the first reload
      // re-rendered. upsertSlotNoReload keeps S!.prod in sync without
      // triggering render().
      const field = key as 'purge' | 'cstart' | 'cend';
      void upsertSlotNoReload(0, (r) => {
        // Force integer storage to match the digits-only keyboard /
        // sanitiser — Purge had been accepting decimals; the rest were
        // already conceptually whole counts.
        const v = val === '' ? null : Math.max(0, Math.floor(Number(val) || 0));
        if (field === 'purge') r.purgeKg = v;
        else if (field === 'cstart') r.countStart = v;
        else r.countEnd = v;
      });
      // Job Left / Total Good in the side panel depend on these numbers
      // but won't refresh without a render. Recompute the job total and
      // touch the visible cells directly so the operator still sees a
      // live total without losing focus.
      void refreshJobTotalAndPaintSide();
      break;
    }
    case 'cavities': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        render();
        break;
      }
      const n = Math.floor(Number(val));
      if (!Number.isFinite(n) || n < 1) break;
      // Full upsert with a reload: Total Good, Job Left and the Count
      // Start → End line all multiply by this, and a select has no typing
      // in progress for a re-render to lose.
      void upsertSlot(0, (r) => {
        r.cavities = n;
      });
      break;
    }
    case 'hand-machine':
    case 'hand-mold':
    case 'hand-material':
    case 'hand-method': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        break;
      }
      const field = key.slice('hand-'.length) as 'machine' | 'mold' | 'material' | 'method';
      // Skip reload: a full re-render would destroy the textarea the operator
      // just tabbed into, losing whatever they're typing there.
      void upsertSlotNoReload(0, (r) => {
        const obj = parseHandover(r);
        obj[field] = val;
        r.handoverNote = JSON.stringify(obj);
      });
      break;
    }
  }
}

export function parseHandover(r: ProductionRecord | undefined): Handover {
  return sharedParseHandover(r?.handoverNote);
}

/**
 * Refresh (§7): re-read PMD_Planning from SharePoint and recompute the
 * cross-shift Good total. The Excel→Planning sync itself is handled by
 * a Power Automate flow on the server (see docs/DEPLOYMENT.md § C) —
 * the in-browser Graph path can't reliably read PMD_Schedule_master
 * (10MB+ workbook with VLOOKUPs/macros times out at 504), so we don't
 * even try.
 */
async function refreshAll(): Promise<void> {
  const planning = await dalRef.listPlanning({});
  S!.planning = planning;
  S!.showAllPlanningOrders = true;
  dropSummaryCache();
  await reload();
  const visible = shiftOrders().length;
  toast(
    isPastShift()
      ? `Refreshed · ${visible} recorded job(s) for this past shift`
      : `Refreshed · showing all ${visible} planning job(s)`,
    'ok',
  );
}
