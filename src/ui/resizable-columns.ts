/**
 * Column widths a person can drag: a grip on the right edge of each header
 * cell. The first drag fixes every column at the width it has, so moving one
 * edge moves only that column; the widths are kept in this browser
 * (`localStorage`, per table) and put back the next time the table is drawn.
 * Double-clicking a grip puts every column back to its natural width.
 */

const MIN_WIDTH = 44;

function readWidths(key: string): number[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(raw) && raw.every((n) => typeof n === 'number' && n > 0) ? raw : null;
  } catch {
    return null;
  }
}

function saveWidths(key: string, widths: number[] | null): void {
  try {
    if (widths) localStorage.setItem(key, JSON.stringify(widths));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: the widths last until the page is drawn again */
  }
}

/** Fix the table's columns at `widths`: the table is then exactly as wide as they add up to. */
function applyWidths(table: HTMLTableElement, cols: HTMLTableColElement[], widths: number[]): void {
  cols.forEach((col, i) => {
    col.style.width = `${widths[i]}px`;
  });
  table.style.tableLayout = 'fixed';
  table.style.minWidth = '0';
  table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
}

/**
 * Make a table's columns draggable. The table needs a `<colgroup>` with one
 * `<col>` per header cell of its first header row.
 */
export function resizableColumns(table: HTMLTableElement | null, storageKey: string): void {
  if (!table) return;
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col'));
  const heads = Array.from(table.querySelectorAll<HTMLTableCellElement>(':scope > thead > tr:first-child > th'));
  if (!cols.length || cols.length !== heads.length) return;
  const stored = readWidths(storageKey);
  if (stored && stored.length === cols.length) applyWidths(table, cols, stored);

  heads.forEach((th, i) => {
    const grip = document.createElement('span');
    grip.className = 'col-grip';
    grip.title = 'Drag to resize · double-click to reset every column';
    grip.setAttribute('aria-hidden', 'true');
    th.classList.add('col-resizable');
    th.appendChild(grip);
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      saveWidths(storageKey, null);
      cols.forEach((col) => col.style.removeProperty('width'));
      table.style.removeProperty('table-layout');
      table.style.removeProperty('min-width');
      table.style.removeProperty('width');
    });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const widths = heads.map((h) => Math.round(h.getBoundingClientRect().width));
      applyWidths(table, cols, widths);
      const startX = e.clientX;
      const start = widths[i];
      grip.setPointerCapture(e.pointerId);
      table.classList.add('col-resizing');
      const move = (ev: PointerEvent): void => {
        widths[i] = Math.max(MIN_WIDTH, Math.round(start + ev.clientX - startX));
        applyWidths(table, cols, widths);
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        table.classList.remove('col-resizing');
        saveWidths(storageKey, widths);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  });
}
