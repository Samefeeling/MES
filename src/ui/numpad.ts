// In-app numeric keypad for the operator sheet.
//
// Why this exists: iPadOS never shows a phone-style 9-grid keypad for
// inputmode="numeric" — the full-width iPad keyboard is always QWERTY
// (with a number row), and the 9-grid only appears in Apple's floating
// keyboard mode, which operators find fiddly and can't reposition
// reliably. So numeric fields suppress the system keyboard entirely
// (inputmode="none") and this pad renders instead: big touch targets,
// draggable by its grip bar, and it commits through the same `change`
// event the existing handlers already listen for.

let pad: HTMLDivElement | null = null;
let target: HTMLInputElement | null = null;
/** Where the operator last dragged the pad (viewport px). Once they've
 *  placed it, keep it there for the rest of the session instead of
 *  snapping back next to each focused input. */
let userPos: { left: number; top: number } | null = null;

const KEYS: Array<{ k: string; label: string; cls?: string }> = [
  { k: '1', label: '1' }, { k: '2', label: '2' }, { k: '3', label: '3' },
  { k: '4', label: '4' }, { k: '5', label: '5' }, { k: '6', label: '6' },
  { k: '7', label: '7' }, { k: '8', label: '8' }, { k: '9', label: '9' },
  { k: 'C', label: 'C', cls: 'np-clear' },
  { k: '0', label: '0' },
  { k: '⌫', label: '⌫', cls: 'np-back' },
];

function buildPad(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'numpad';
  el.innerHTML =
    `<div class="np-grip" title="Drag to move">⠿ <span class="np-grip-label">123</span> ⠿</div>` +
    `<div class="np-keys">` +
    KEYS.map(
      (key) =>
        `<button type="button" class="np-key ${key.cls ?? ''}" data-np="${key.k}">${key.label}</button>`,
    ).join('') +
    `</div>` +
    `<button type="button" class="np-done" data-np-done>✓ Done</button>`;
  document.body.appendChild(el);

  // Key taps: pointerdown + preventDefault so the tap never steals
  // focus from the target input (focus loss would fire change too
  // early and hide the pad mid-entry).
  el.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-np]');
    const done = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-np-done]');
    if (btn || done) e.preventDefault();
    if (!target) return;
    if (btn) {
      const k = btn.dataset.np!;
      if (k === 'C') target.value = '';
      else if (k === '⌫') target.value = target.value.slice(0, -1);
      else target.value += k;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (done) {
      commitAndHide();
    }
  });

  // Drag via the grip bar.
  const grip = el.querySelector<HTMLElement>('.np-grip')!;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const offX = e.clientX - r.left;
    const offY = e.clientY - r.top;
    const move = (ev: PointerEvent): void => {
      const left = clamp(ev.clientX - offX, 4, window.innerWidth - r.width - 4);
      const top = clamp(ev.clientY - offY, 4, window.innerHeight - r.height - 4);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      userPos = { left, top };
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return el;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function commitAndHide(): void {
  if (target) {
    // Same event path a keyboard entry takes: change on commit. The
    // reject-cell / Count / Purge handlers all listen on `change`.
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.blur();
  }
  target = null;
  if (pad) pad.style.display = 'none';
}

function showFor(input: HTMLInputElement): void {
  if (!pad) pad = buildPad();
  if (target && target !== input) {
    // Switching fields commits the previous one first.
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  target = input;
  pad.style.display = 'block';
  if (userPos) {
    pad.style.left = `${userPos.left}px`;
    pad.style.top = `${userPos.top}px`;
    return;
  }
  // Default placement: beside the input, below if there's room,
  // flipped above otherwise; clamped to the viewport.
  const r = input.getBoundingClientRect();
  const pw = pad.offsetWidth || 232;
  const ph = pad.offsetHeight || 320;
  const left = clamp(r.left, 4, window.innerWidth - pw - 4);
  const below = r.bottom + ph + 8 <= window.innerHeight;
  const top = below ? r.bottom + 8 : Math.max(4, r.top - ph - 8);
  pad.style.left = `${left}px`;
  pad.style.top = `${top}px`;
}

/**
 * Wire the numpad to every `input[data-numpad]` under `root` via focus
 * delegation. Call once per render — listeners live on document and
 * are installed only the first time.
 */
let installed = false;
export function attachNumpad(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('focusin', (e) => {
    const inp = e.target as HTMLElement;
    if (inp instanceof HTMLInputElement && inp.dataset.numpad != null && !inp.disabled) {
      showFor(inp);
    }
  });
  // Tap anywhere that's neither the pad nor a numpad input → commit + hide.
  document.addEventListener('pointerdown', (e) => {
    if (!pad || pad.style.display === 'none') return;
    const t = e.target as HTMLElement;
    if (pad.contains(t)) return;
    if (t instanceof HTMLInputElement && t.dataset.numpad != null) return;
    commitAndHide();
  });
}
