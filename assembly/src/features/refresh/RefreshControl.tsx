/**
 * Re-read the export and show its read time below Refresh.
 *
 * Only the time. Which export it came from used to be on the hover here, and
 * it answered a question nobody has: the source is fixed when the board is
 * built and cannot change while anyone is looking at it, so "planning-csv"
 * was a word waiting under the pointer of the one button on the row that
 * everybody presses.
 */

import { useDataStore } from '@/store/dataStore';
import { Button, Spinner } from '@/ui';
const UPDATED_TIME = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

export function RefreshControl({ onRefresh }: { onRefresh: () => void }) {
  const status = useDataStore((s) => s.status);
  const fetchedAt = useDataStore((s) => s.dataset?.fetchedAt ?? null);
  const loading = status === 'loading';

  return (
    <div className="refresh-control">
      <Button onClick={onRefresh} disabled={loading}>Refresh</Button>
      {loading && <Spinner />}
      <span className="sub">
        {fetchedAt ? `updated ${UPDATED_TIME.format(fetchedAt)}` : 'Update time unavailable'}
      </span>
    </div>
  );
}
