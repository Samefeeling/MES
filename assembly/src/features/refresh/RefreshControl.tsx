import { useDataStore } from '@/store/dataStore';
import { Button, Spinner } from '@/ui';
import { formatTime } from '@/lib/time';

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
  const newOrderIds = useDataStore((s) => s.newOrderIds);

  return (
    <div className="zoom">
      {loading && <Spinner />}
      <span
        className="sub"
        title={source ? `Read from ${source}` : undefined}
      >
        {fetchedAt ? `updated ${formatTime(fetchedAt)}` : 'Update time unavailable'}
      </span>
      {newOrderIds.length > 0 && (
        <span
          className="new-order-count"
          title={`First seen today: ${newOrderIds.join(', ')}`}
        >
          {newOrderIds.length} new today
        </span>
      )}
      <Button onClick={onRefresh} disabled={loading}>
        Refresh
      </Button>
    </div>
  );
}
