/**
 * Timed + on-demand refresh of the source data.
 *
 * Every five minutes by default, so a re-exported `Planning1.csv` reaches the
 * board without anyone pressing anything. A refresh does not disturb the plan:
 * `planStore.reconcile` keeps every placement and crew allocation and only
 * files genuinely new orders. The returned function refreshes immediately.
 */

/** Minutes between automatic refreshes when the env does not say. */
const DEFAULT_INTERVAL_MINUTES = 5;

import { useCallback, useEffect } from 'react';
import { useDataStore } from '@/store/dataStore';
import { useUiStore } from '@/store/uiStore';

export function useScheduledRefresh(intervalMinutes?: number): () => Promise<void> {
  const load = useDataStore((s) => s.load);
  const setLastRefresh = useUiStore((s) => s.setLastRefresh);

  const configured = Number(import.meta.env.VITE_REFRESH_INTERVAL_MINUTES);
  const minutes =
    intervalMinutes ??
    (Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_INTERVAL_MINUTES);

  const refresh = useCallback(async () => {
    await load();
    setLastRefresh(new Date());
  }, [load, setLastRefresh]);

  useEffect(() => {
    const ms = Math.max(1, minutes) * 60_000;
    const id = window.setInterval(refresh, ms);
    return () => window.clearInterval(id);
  }, [refresh, minutes]);

  return refresh;
}
