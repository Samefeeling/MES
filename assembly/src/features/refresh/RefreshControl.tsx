/** Re-read the export, and publish this board as the one current plan. */

import { useDataStore } from '@/store/dataStore';
import { Button, Spinner } from '@/ui';

export function RefreshControl({
  source,
  onRefresh,
  onSave,
  dirty,
  saving,
  canSave,
}: {
  /** Which export the board was built from — on the hover, not in the row. */
  source?: string;
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
          // The read time used to sit under this button as its own line. It
          // answered a question nobody had, and the row it was in is now the
          // one that says whether this board has been published.
          `${source ? `Read from ${source}. ` : ''}Re-reads the export and takes the saved plan — ` +
          'anything on this board that has not been saved is dropped.'
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
