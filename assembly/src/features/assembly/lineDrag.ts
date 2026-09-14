/**
 * Arranging the lines themselves.
 *
 * A line's row is already a drop target — it takes orders and it takes people —
 * so the row cannot also be the *draggable* under the same id: dnd-kit keys
 * both by id, and one element answering to the same name twice is how a line
 * ends up dropped on itself. The draggable is prefixed, and the type is what
 * tells the drop handler which of the three things landed.
 *
 * It lives in its own module rather than in the board, which is already a
 * thousand lines, and rather than in the drag hook, which would then be
 * imported by the component it is wiring.
 */

export const DRAG_TYPE_LINE = 'line-order';

/** The draggable id for a line's own row. */
export const lineDragId = (key: string): string => `line:${key}`;
