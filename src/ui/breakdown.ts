import { BD_CATEGORIES, bdCausesFor } from '../core/breakdown';
import { closeModal, escapeHtml, openModal } from './modal';

export interface BdPick {
  code: string;
  note: string;
}

/**
 * Two-tier breakdown picker (taxonomy MD, §"Two-tier mapping"):
 *   1. 11 category tiles → 2. causes for the chosen category.
 *   OTH-99 opens a free-text step before saving.
 */
export function openBreakdownCascade(
  slotLabel: string,
  initialCode: string,
  onPick: (pick: BdPick) => void,
): void {
  type Phase = 'cat' | 'causes' | 'free';
  let phase: Phase = 'cat';
  let selCat = '';
  let note = '';

  if (initialCode) {
    const m = /^([A-Z]+)-/.exec(initialCode);
    if (m) {
      selCat = m[1];
      phase = 'causes';
    }
  }

  function renderCats(): string {
    const tiles = BD_CATEGORIES.map(
      (c) =>
        `<button class="bd-cat" data-cat="${c.prefix}">
          <span class="bd-emoji">${c.emoji}</span>
          <span class="bd-prefix">${c.prefix}</span>
          <span class="bd-cat-label">${escapeHtml(c.label)}</span>
        </button>`,
    ).join('');
    return `
      <h2 class="bd-title">⛔ Report breakdown</h2>
      <p class="bd-sub">${escapeHtml(slotLabel)} · <b>Step 1 of 2</b> — pick the category</p>
      <div class="bd-cat-grid">${tiles}</div>
      <div class="bd-actions">
        <button class="btn-ghost-big" data-cancel>Cancel</button>
      </div>`;
  }

  function renderCauses(): string {
    const cat = BD_CATEGORIES.find((c) => c.prefix === selCat);
    if (!cat) return renderCats();
    const causes = bdCausesFor(selCat);
    const rows = causes
      .map(
        (c) =>
          `<button class="bd-cause" data-code="${escapeHtml(c.code)}">
            <span class="bd-code">${escapeHtml(c.code)}</span>
            <span class="bd-cause-text">${escapeHtml(c.cause)}</span>
            <span class="bd-owner">${escapeHtml(c.owner)}</span>
          </button>`,
      )
      .join('');
    return `
      <h2 class="bd-title">${cat.emoji} ${escapeHtml(cat.label)}</h2>
      <p class="bd-sub">${escapeHtml(slotLabel)} · <b>Step 2 of 2</b> — pick the cause</p>
      <div class="bd-cause-list">${rows}</div>
      <div class="bd-actions">
        <button class="btn-ghost-big" data-back>← Back</button>
        <button class="btn-ghost-big" data-cancel>Cancel</button>
      </div>`;
  }

  function renderFree(): string {
    return `
      <h2 class="bd-title">❓ OTH-99 — free text</h2>
      <p class="bd-sub">${escapeHtml(slotLabel)} · describe what happened</p>
      <textarea class="bd-note" placeholder="e.g. unusual smell from cooling unit, no clear alarm">${escapeHtml(note)}</textarea>
      <div class="bd-actions">
        <button class="btn-ghost-big" data-back>← Back</button>
        <button class="btn-primary-big" data-confirm>Save OTH-99</button>
      </div>`;
  }

  function paint(): void {
    const html =
      phase === 'cat' ? renderCats() : phase === 'causes' ? renderCauses() : renderFree();
    const mc = openModal(`<div class="bd-modal">${html}</div>`);
    wire(mc);
  }

  function wire(mc: HTMLElement): void {
    mc.querySelectorAll<HTMLButtonElement>('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => {
        selCat = b.dataset.cat!;
        phase = 'causes';
        paint();
      }),
    );
    mc.querySelectorAll<HTMLButtonElement>('[data-code]').forEach((b) =>
      b.addEventListener('click', () => {
        const code = b.dataset.code!;
        if (code === 'OTH-99') {
          phase = 'free';
          paint();
          return;
        }
        closeModal();
        onPick({ code, note: '' });
      }),
    );
    mc.querySelector('[data-back]')?.addEventListener('click', () => {
      phase = phase === 'free' ? 'causes' : 'cat';
      paint();
    });
    mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
    mc.querySelector('[data-confirm]')?.addEventListener('click', () => {
      const ta = mc.querySelector<HTMLTextAreaElement>('.bd-note');
      const n = (ta?.value ?? '').trim();
      if (!n) return;
      closeModal();
      onPick({ code: 'OTH-99', note: n });
    });
    mc.querySelector<HTMLTextAreaElement>('.bd-note')?.addEventListener('input', (e) => {
      note = (e.target as HTMLTextAreaElement).value;
    });
  }

  paint();
}
