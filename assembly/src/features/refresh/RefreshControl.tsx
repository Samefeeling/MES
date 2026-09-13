/**
 * Re-read the export, and say when it was last read.
 *
 * Two lines and no more. A third used to sit under them — "3 new today" — and
 * it was in the worst place on the header for it: a figure about the plan,
 * stacked under the button everybody reaches for, in the smallest type on the
 * screen. It is a figure like the other four, so it is a figure like the other
 * four now; see `New jobs today` in `BoardTools`.
 */

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
