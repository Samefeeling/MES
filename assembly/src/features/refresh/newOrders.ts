/** Persistent first-seen tracking for incremental daily order updates. */

const STORAGE_KEY = 'resero-planning-known-orders-v1';

export interface KnownOrders {
  known: Record<string, string | null>;
}

export function updateKnownOrders(
  previous: KnownOrders | null,
  currentIds: Iterable<string>,
  today: string,
): { state: KnownOrders; newToday: string[] } {
  const current = [...new Set(currentIds)];
  if (!previous) {
    return {
      state: { known: Object.fromEntries(current.map((id) => [id, null])) },
      newToday: [],
    };
  }
  const known = { ...previous.known };
  for (const id of current) if (!(id in known)) known[id] = today;
  return {
    state: { known },
    newToday: current.filter((id) => known[id] === today),
  };
}

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function trackNewOrders(
  ids: Iterable<string>,
  now = new Date(),
  sourceName = 'default',
): string[] {
  if (typeof localStorage === 'undefined') return [];
  const storageKey = `${STORAGE_KEY}:${sourceName}`;
  let previous: KnownOrders | null = null;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) previous = JSON.parse(saved) as KnownOrders;
  } catch {
    // A corrupt local baseline is replaced by a safe first setup below.
  }
  const result = updateKnownOrders(previous, ids, localDay(now));
  try {
    localStorage.setItem(storageKey, JSON.stringify(result.state));
  } catch {
    // Tracking is informative; storage failure must never block the schedule.
  }
  return result.newToday;
}
