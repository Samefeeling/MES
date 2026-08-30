// Tiny cross-view hand-off used when the operator sheet deep-links into the
// Tool board's die drilldown (tap the Die# pill). The operator page stashes
// the current shift context here just before navigating to
// `#/tool/die/<dieNumber>`; the drilldown's "Add note" dialog reads it back to
// prefill Date / Shift / Machine / Operator so the SOC note is stamped with
// where it was raised. Kept as its own dependency-free module so both UI
// views can import it without a cycle.

export interface DieNoteContext {
  /** YYYY-MM-DD of the shift the note is being raised from. */
  date: string;
  /** Shift code (Day / Afternoon / Night). */
  shift: string;
  /** Machine code the operator sheet was on. */
  machine: string;
  /** Selected operator's name. */
  operator: string;
}

let pending: DieNoteContext | null = null;

/** Remember the operator context for the next die drilldown. Overwrites any
 *  previous value; the context is a prefill hint, not authoritative state. */
export function setDieNoteContext(ctx: DieNoteContext): void {
  pending = ctx;
}

/** The last stashed context, or null when the drilldown was reached directly
 *  from the Tool board (no operator context to inherit). Left in place rather
 *  than consumed so re-opening the Add-note dialog keeps the same prefill. */
export function peekDieNoteContext(): DieNoteContext | null {
  return pending;
}
