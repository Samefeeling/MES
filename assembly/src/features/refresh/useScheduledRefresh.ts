/**
 * Timed + on-demand refresh of the source data.
 *
 * Every five minutes by default, so a re-exported `Planning1.csv` reaches the
 * board without anyone pressing anything. A refresh does not disturb the
 * shift's own records: `planStore.reconcile` keeps the bookings and the
 * progress and only files genuinely new orders.
 *
 * It does disturb unsaved planning, and deliberately — `after` is where the
 * board takes the saved plan back (see `usePlanPersistence.pull`). The timer
 * and the Refresh button run the same two steps in the same order, so the
 * board never behaves one way when a person presses it and another way when
 * the clock does.
 */

/** Minutes between automatic refreshes when the env does not say. */
const DEFAULT_INTERVAL_MINUTES = 5;

import { useCallback, useEffect, useRef } from 'react';
import { useDataStore } from '@/store/dataStore';
import { useUiStore } from '@/store/uiStore';

export function useScheduledRefresh(
  /** Run once the new export has landed — both on the timer and on demand. */
  after?: () => void | Promise<void>,
  intervalMinutes?: number,
): () => Promise<void> {
  const load = useDataStore((s) => s.load);
  const setLastRefresh = useUiStore((s) => s.setLastRefresh);

  const configured = Number(import.meta.env.VITE_REFRESH_INTERVAL_MINUTES);
  const minutes =
    intervalMinutes ??
    (Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_INTERVAL_MINUTES);

  // Held in a ref so a new `after` — it is rebuilt whenever the board is —
  // does not restart the interval and push the next automatic read out.
  const onDone = useRef(after);
  onDone.current = after;

  const refresh = useCallback(async () => {
    await load();
    setLastRefresh(new Date());
    await onDone.current?.();
  }, [load, setLastRefresh]);

  useEffect(() => {
    const ms = Math.max(1, minutes) * 60_000;
    const id = window.setInterval(refresh, ms);
    return () => window.clearInterval(id);
  }, [refresh, minutes]);

  return refresh;
}
