/**
 * Re-read the export, and publish this board as the one current plan.
 *
 * Two buttons and nothing else. The read time used to sit under Refresh, and
 * the source it came from on its hover; both answered questions nobody has —
 * the source is fixed when the board is built and cannot change while anyone
 * is looking at it, and the export's clock is not the question a planner has
 * about this row. The one they do have is whether what is on the board has
 * been published, and that is what Save answers.
 */

import { useDataStore } from '@/store/dataStore';
import { Button, Spinner } from '@/ui';

export function RefreshControl({
  onRefresh,
  onSave,
  dirty,
  saving,
  canSave,
}: {
  onRefresh: () => void;
  onSave: () => void;
  /** Planning edits are being held in this browser and published nowhere. */
  dirty: boolean;
  saving: boolean;
  /** False while the stored plan has not been read — nothing may be written
   *  over a plan this browser has not seen. */
  canSave: boolean;
}) {
  const status = useDataStore((s) => s.status);
  const loading = status === 'loading';

  return (
    <div className="refresh-control">
      <Button
        onClick={onRefresh}
        disabled={loading}
        title={
          'Re-reads the export and takes the saved plan — anything on this ' +
          'board that has not been saved is dropped.'
        }
      >
        Refresh
      </Button>
      {loading && <Spinner />}
      {/*
        Save is the only way planning leaves this browser. Pressing it makes
        this board the one current plan; every other screen picks it up on its
        next refresh, and whatever they were holding unsaved goes. So the
        button has to say which of the two states it is in — a board with
        nothing to publish must not look like a board with work at risk.
      */}
      <Button
        variant={dirty ? 'primary' : 'default'}
        onClick={onSave}
        disabled={!canSave || saving || !dirty}
        title={
          !canSave
            ? 'The saved plan has not been read yet — nothing can be written over it'
            : dirty
              ? 'Make this board the current plan. Unsaved changes on other screens are dropped when they refresh.'
              : 'This board is the current plan — nothing to save'
        }
      >
        {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
      </Button>
    </div>
  );
}
