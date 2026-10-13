/**
 * The order finder in the Order heading: type an order number, or pick it off
 * the list, and the board opens to its row — see `orderFinder`.
 *
 * The list is drawn over the board rather than inside the heading cell, which
 * clips whatever overflows it, and is closed by leaving the box.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/store/uiStore';
import { matchEntries, pickedEntry, type FindEntry } from './orderFinder';

/** Rows drawn in the list at once; typing narrows the rest. */
const LIST_LIMIT = 80;

const STATUS_NOTE: Record<FindEntry['status'], string | null> = {
  board: null,
  pool: 'unassigned',
  unreleased: 'not released',
};

/**
 * Scroll the board so these rows — one order's — sit in the middle of what is
 * visible under the heading, with the start of their bar clear of the frozen
 * columns by `lead` pixels, and flash them once so the eye lands on them.
 */
export function revealRows(pane: HTMLElement, rows: HTMLElement[], frozen: number, lead: number): void {
  const view = pane.getBoundingClientRect();
  const heading = pane.querySelector<HTMLElement>('.assy-sticky')?.offsetHeight ?? 0;
  const first = rows[0].getBoundingClientRect();
  const last = rows[rows.length - 1].getBoundingClientRect();
  const y = first.top - view.top + pane.scrollTop;
  const room = pane.clientHeight - heading;
  const top = Math.max(0, y - heading - Math.max(0, (room - (last.bottom - first.top)) / 2));
  const bars = rows.flatMap((row) => {
    const bar = row.querySelector<HTMLElement>('.bar');
    return bar ? [bar.getBoundingClientRect().left - view.left + pane.scrollLeft] : [];
  });
  // An order with no bar (nobody on it, no date) keeps the timeline where it is.
  const left = bars.length ? Math.max(0, Math.min(...bars) - frozen - lead) : pane.scrollLeft;
  pane.scrollTo({ top, left, behavior: 'smooth' });
  for (const row of rows) {
    const cell = row.querySelector<HTMLElement>('.acell.order');
    cell?.animate?.(
      [{ backgroundColor: '#fcd34d' }, { backgroundColor: getComputedStyle(cell).backgroundColor }],
      { duration: 1600, easing: 'ease-out' },
    );
  }
}

export function OrderFinder({
  entries,
  onFind,
}: {
  entries: FindEntry[];
  /** Take the board to the order; what it had to change to get there, in words. */
  onFind: (entry: FindEntry) => string[];
}) {
  const foundOrder = useUiStore((s) => s.foundOrder);
  const clearFound = useUiStore((s) => s.clearFound);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const matches = useMemo(() => matchEntries(entries, text), [entries, text]);
  const shown = matches.slice(0, LIST_LIMIT);

  // Cleared from elsewhere (Escape on the board): the box lets go of it too.
  useEffect(() => {
    if (foundOrder === null) setNote(null);
  }, [foundOrder]);

  // A note says what the board did to show the order; it is read, then goes.
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(timer);
  }, [note]);

  useLayoutEffect(() => {
    if (!open && !note) return;
    const at = () => {
      const r = box.current?.getBoundingClientRect();
      if (r) setPlace({ left: r.left, top: r.bottom + 3, width: Math.max(r.width, 300) });
    };
    at();
    window.addEventListener('resize', at);
    window.addEventListener('scroll', at, true);
    return () => {
      window.removeEventListener('resize', at);
      window.removeEventListener('scroll', at, true);
    };
  }, [open, note]);

  // Keep the active option in view while the arrows walk the list.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const go = (entry: FindEntry) => {
    setText(entry.order);
    setOpen(false);
    const notes = onFind(entry);
    setNote(notes.length ? `${entry.order}: ${notes.join('; ')}` : null);
    // Off the box, so the keyboard on a tablet folds away and the row it was
    // asked for is what is left on the screen.
    input.current?.blur();
  };

  const submit = () => {
    const entry = open && shown[active] ? shown[active] : pickedEntry(entries, text);
    if (entry) go(entry);
    else if (text.trim()) {
      setOpen(true);
      setNote(matches.length ? `${matches.length} orders match "${text.trim()}" — pick one` : `No order "${text.trim()}" on the board or in the export`);
    }
  };

  const clear = () => {
    setText('');
    setOpen(false);
    setNote(null);
    clearFound();
  };

  return (
    <div className="order-finder" ref={box}>
      <input
        ref={input}
        type="text"
        enterKeyHint="search"
        role="combobox"
        aria-label="Find an order by number"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        placeholder="Find order…"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setNote(null);
          setOpen(e.target.value.trim() !== '');
        }}
        onFocus={(e) => e.target.select()}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((i) => Math.min(i + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            // One Escape, one thing: the list, then the pick.
            e.preventDefault();
            if (open) setOpen(false);
            else clear();
          }
        }}
      />
      {(text || foundOrder) && (
        <button
          type="button"
          className="order-finder-clear"
          aria-label="Clear the order finder"
          title="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className="order-finder-list"
        aria-label="List every order"
        title="List every order"
        tabIndex={-1}
        // Keeps the box focused, so the list it opens is not closed by its blur.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          // The full list, from the top: what is typed narrows it again.
          setText('');
          setActive(0);
          setNote(null);
          setOpen(true);
          input.current?.focus();
        }}
      >
        ▾
      </button>
      {place &&
        (open || note) &&
        createPortal(
          <div className="order-finder-pop" style={{ left: place.left, top: place.top, width: place.width }}>
            {note && (
              <div className="order-finder-note" role="status">
                {note}
              </div>
            )}
            {open && (
              <ul id={listId} ref={list} role="listbox" className="order-finder-options" aria-label="Orders">
                {shown.length === 0 && <li className="order-finder-none">No order matches</li>}
                {shown.map((entry, i) => (
                  <li
                    key={entry.order}
                    id={`${listId}-${i}`}
                    role="option"
                    data-index={i}
                    aria-selected={i === active}
                    className={i === active ? 'active' : ''}
                    // Chosen on the press, not the click: on a tablet the box
                    // can lose focus between the two, and the list with it.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(entry);
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className="of-order">{entry.order}</span>
                    <span className="of-desc">{entry.description}</span>
                    <span className={`of-where ${entry.status}`}>
                      {STATUS_NOTE[entry.status] ? `${entry.where} · ${STATUS_NOTE[entry.status]}` : entry.where}
                    </span>
                  </li>
                ))}
                {matches.length > shown.length && (
                  <li className="order-finder-none">
                    +{matches.length - shown.length} more — type to narrow
                  </li>
                )}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
