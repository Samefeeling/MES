/**
 * One figure on the banner, and what is behind it.
 *
 * The four figures used to be two kinds of thing wearing one face: **Due within
 * 2 days** and **Review orders** opened onto the orders they counted, and the
 * other two were text with a tooltip. From a metre away — which is where this
 * board is read from — there is no telling which is which, so half of them
 * silently did nothing when pressed.
 *
 * Now every figure on the row is the same shape: a label, a number, and a panel
 * underneath naming what the number is made of. Pressing one closes whichever
 * was open, so two panels can never overlap each other on the row they hang
 * from — the caller owns that single piece of state and passes it down.
 *
 * A figure with no `detail` is still drawn, just not pressable: better a
 * consistent row with one quiet member than a control that answers a press with
 * nothing.
 */

import type { ReactNode } from 'react';

export function Metric({
  name,
  className,
  label,
  value,
  title,
  open,
  onOpen,
  detail,
}: {
  /** Identifies this figure in the caller's "which one is open" state. */
  name: string;
  className: string;
  label: ReactNode;
  value: ReactNode;
  title?: string;
  open?: string | null;
  onOpen?: (name: string | null) => void;
  /** Built on the press rather than on every render — the board re-derives
   *  often, and nothing in here is worth walking every time. */
  detail?: () => ReactNode;
}) {
  if (!detail || !onOpen) {
    return (
      <span className={`metric ${className}`} title={title}>
        <span className="metric-label">{label}</span>
        <b className="metric-value">{value}</b>
      </span>
    );
  }
  const isOpen = open === name;
  return (
    <div className="metric-slot">
      <button
        className={`metric ${className}${isOpen ? ' active' : ''}`}
        aria-expanded={isOpen}
        onClick={() => onOpen(isOpen ? null : name)}
        title={title}
      >
        <span className="metric-label">{label}</span>
        <b className="metric-value">
          {value}
          {isOpen && <i> ×</i>}
        </b>
      </button>
      {isOpen && <div className="metric-panel">{detail()}</div>}
    </div>
  );
}

/** A panel's heading line — what the figure is, in a sentence. */
export function MetricNote({ children }: { children: ReactNode }) {
  return <p className="metric-note">{children}</p>;
}
