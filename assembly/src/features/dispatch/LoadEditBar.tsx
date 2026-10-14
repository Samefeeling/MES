/**
 * Edit loads, and the Save and Cancel that close it.
 *
 * Load edits show on the plan as they are made, but reach nobody else — not
 * the Waybill list, not this browser's saved copy — until **Save**. **Cancel**
 * drops every change made since Edit loads, pins and holds made meanwhile
 * included. Leaving the page keeps the edits open; closing or reloading it
 * drops them, after the browser asks.
 */

import { useMemo } from 'react';
import { changedOrders, decisionsByOrder } from '@/engine/dispatch/waybillList';
import { useDispatchStore } from '@/store/dispatchStore';

/** How many orders the open load edits change. */
export function useEditedOrders(): number | null {
  const editing = useDispatchStore((s) => s.editing);
  const decisions = useDispatchStore((s) => s.decisions);
  const shipments = useDispatchStore((s) => s.shipments);
  return useMemo(
    () =>
      editing
        ? changedOrders(decisionsByOrder(editing.decisions, editing.shipments), decisionsByOrder(decisions, shipments)).size
        : null,
    [editing, decisions, shipments],
  );
}

export function LoadEditBar({ canBegin }: { canBegin: boolean }) {
  const beginEdit = useDispatchStore((s) => s.beginEdit);
  const saveEdit = useDispatchStore((s) => s.saveEdit);
  const cancelEdit = useDispatchStore((s) => s.cancelEdit);
  const changed = useEditedOrders();

  if (changed === null) {
    return canBegin ? (
      <button
        type="button"
        className="kpi-btn"
        onClick={beginEdit}
        title="Move orders between loads, pick sizes and days by hand — saved when you press Save"
      >
        Edit loads
      </button>
    ) : null;
  }
  return (
    <span className="load-edit-bar" role="group" aria-label="Load edits">
      <span className={changed > 0 ? 'edit-count' : 'muted'}>
        {changed === 0 ? 'No changes yet' : `${changed} order${changed === 1 ? '' : 's'} changed · not saved`}
      </span>
      <button
        type="button"
        className="kpi-btn"
        onClick={() => {
          if (changed === 0 || window.confirm(`Drop the changes to ${changed} order${changed === 1 ? '' : 's'}?`)) {
            cancelEdit();
          }
        }}
        title="Drop every change made since Edit loads"
      >
        Cancel
      </button>
      <button
        type="button"
        className="kpi-btn primary"
        onClick={saveEdit}
        title="Keep the changes: every screen plans with them from now on"
      >
        Save
      </button>
    </span>
  );
}
