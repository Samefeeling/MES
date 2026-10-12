// Drag-to-resize table columns, shared by the Maint tables (Tool's die
// table, Machine's equipment table). What is a comfortable width on the iPad
// is cramped on a PC monitor, so dragging a header's right edge resizes that
// column; the widths persist per device in localStorage under the table's
// own key and are re-applied on every render. Double-tapping an edge resets
// the whole table to automatic layout.
//
// The table carries `<colgroup><col data-ck="…">…</colgroup>` (one key per
// column, so a column added later invalidates nothing) and a
// `<span class="die-rz" data-die-rz>` handle inside each `<th>`.

function savedWidths(storageKey: string): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, number>;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** Re-apply saved widths after a render. Fixed layout only kicks in once the
 *  user has resized something — before that the browser lays the table out. */
function applyWidths(table: HTMLTableElement, storageKey: string): void {
  const saved = savedWidths(storageKey);
  if (!saved) return;
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup col'));
  let total = 0;
  let allSaved = true;
  for (const c of cols) {
    const w = saved[c.dataset.ck ?? ''];
    if (typeof w === 'number' && w > 0) {
      c.style.width = `${Math.round(w)}px`;
      total += Math.round(w);
    } else {
      allSaved = false;
    }
  }
  if (total > 0) {
    table.style.tableLayout = 'fixed';
    table.classList.add('resized');
    // With every column pinned the table's own width must be the sum,
    // otherwise fixed layout re-squeezes to the container.
    if (allSaved) table.style.width = `${total}px`;
  }
}

/** `<span>` handle to put at the end of every resizable `<th>`. */
export const RESIZE_HANDLE =
  '<span class="die-rz" data-die-rz title="Drag to resize · double-tap to reset all columns"></span>';

export interface ColumnResizeOptions {
  /** localStorage key the widths are kept under. */
  storageKey: string;
  /** Re-render after a reset, so the table goes back to automatic layout. */
  onReset: () => void;
  /** Called while a column is being dragged (e.g. to move a pinned column). */
  onResize?: () => void;
}

export function wireColumnResize(table: HTMLTableElement, opts: ColumnResizeOptions): void {
  applyWidths(table, opts.storageKey);
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'));
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup col'));
  table.querySelectorAll<HTMLElement>('[data-die-rz]').forEach((rz) => {
    // The handle lives inside a sortable <th> — swallow clicks so a resize
    // never doubles as a sort.
    rz.addEventListener('click', (e) => e.stopPropagation());
    rz.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      try {
        localStorage.removeItem(opts.storageKey);
      } catch {
        /* blocked storage — nothing was kept to clear */
      }
      opts.onReset();
    });
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = rz.closest('th');
      const idx = th ? ths.indexOf(th as HTMLTableCellElement) : -1;
      if (idx < 0 || !cols[idx]) return;
      // Freeze every column at its current rendered width first — under
      // automatic layout, growing one column would rebalance the rest.
      const widths = ths.map((t) => Math.round(t.getBoundingClientRect().width));
      cols.forEach((c, i) => (c.style.width = `${widths[i]}px`));
      table.style.tableLayout = 'fixed';
      table.classList.add('resized');
      const totalRest = widths.reduce((a, b) => a + b, 0) - widths[idx];
      table.style.width = `${totalRest + widths[idx]}px`;
      const startX = e.clientX;
      const startW = widths[idx];
      rz.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        cols[idx].style.width = `${w}px`;
        table.style.width = `${totalRest + w}px`;
        opts.onResize?.();
      };
      const up = (): void => {
        rz.removeEventListener('pointermove', move);
        const out: Record<string, number> = {};
        cols.forEach((c, i) => {
          out[c.dataset.ck ?? String(i)] = Math.round(parseFloat(c.style.width)) || widths[i];
        });
        try {
          localStorage.setItem(opts.storageKey, JSON.stringify(out));
        } catch {
          /* storage full / private mode — the resize still applies for this page */
        }
      };
      rz.addEventListener('pointermove', move);
      rz.addEventListener('pointerup', up, { once: true });
      rz.addEventListener('pointercancel', up, { once: true });
    });
  });
}

/** The die-style tables pin their first two columns; the second's `left`
 *  must follow the first's rendered width, which resizing and wrapping move. */
export function syncStickyOffset(table: HTMLTableElement): void {
  const first = table.querySelector<HTMLTableCellElement>('thead th:first-child');
  const width = first?.getBoundingClientRect().width ?? 0;
  if (width > 0) table.style.setProperty('--die-sticky-first-width', `${width}px`);
}
