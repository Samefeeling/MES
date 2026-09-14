/** Re-read the export and show its read time below Refresh. */

import { useDataStore } from '@/store/dataStore';
import { Button, Spinner } from '@/ui';
const UPDATED_TIME = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

export function RefreshControl({
  source,
  onRefresh,
}: {
  /** Which export the board was built from — on the hover, not in the row. */
  source?: string;
  onRefresh: () => void;
}) {
  const status = useDataStore((s) => s.status);
  const fetchedAt = useDataStore((s) => s.dataset?.fetchedAt ?? null);
  const loading = status === 'loading';

  return (
    <div className="refresh-control">
      <Button onClick={onRefresh} disabled={loading}>Refresh</Button>
      {loading && <Spinner />}
      <span
        className="sub"
        title={source ? `Read from ${source}` : undefined}
      >
        {fetchedAt ? `updated ${UPDATED_TIME.format(fetchedAt)}` : 'Update time unavailable'}
      </span>
    </div>
  );
}
