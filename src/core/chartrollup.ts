import type { ShiftCode } from '../types';

/**
 * Month rollup for the KPI trend charts.
 *
 * Both bottom charts plot one bar per DAY. That reads well over a week and
 * falls apart over a quarter: a 90-day range renders 90 bars into a card a
 * few hundred pixels wide, so every bar is a sliver and the date labels
 * collapse into a smear. The months are what a quarter-long range is
 * actually asking about, and the days only matter at the recent end.
 *
 * So when the range crosses a month boundary the charts roll every month
 * up into one bar and leave the NEWEST month in the range on daily bars —
 * the fine detail sits where you are reading from. A rolled-up month can
 * be opened to its own days by clicking it, and closed again the same way.
 *
 * Everything here sums. That matters for the two derived lines the charts
 * draw on top: Efficiency is recomputed as Σrun ÷ Σ(run+down+setup) and
 * vs-Plan as Σgood ÷ Σexpected, so a month's figure is the ratio of the
 * sums — the month's real efficiency — and not the average of thirty daily
 * ratios, which would let one quiet Sunday count as much as a full
 * Wednesday.
 */

export interface ChartShiftCell {
  good: number;
  reject: number;
  runHrs: number;
  downHrs: number;
  setupHrs: number;
  oee: number | null;
  exp: number | null;
}

export interface ChartBucket {
  /** Full date key, YYYY-MM-DD. The grouping key — `label` is display only. */
  key: string;
  label: string;
  byShift: Record<ShiftCode, ChartShiftCell>;
}

/** One bar as drawn: either a single day, or a whole month summed. */
export interface DisplayBucket extends ChartBucket {
  /** Calendar month this bar belongs to, YYYY-MM. */
  month: string;
  /** True when this bar is a whole month rather than one day. */
  isMonth: boolean;
  /** Days of production behind the bar (1 for a day bar). Shown in the
   *  tooltip so nobody reads a short month as a bad month. */
  days: number;
}

export const monthOf = (dateKey: string): string => dateKey.slice(0, 7);

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Display label for a month bar. Keeps the year off when every month in
 * view shares one — "May" beats "May 26" on an axis this tight — but puts
 * it back the moment a range straddles New Year, where a bare "Jan" next
 * to a bare "Dec" is genuinely ambiguous.
 */
export function monthLabel(month: string, withYear: boolean): string {
  const [y, m] = month.split('-');
  const name = MONTH_NAMES[Number(m) - 1] ?? month;
  return withYear ? `${name} ${y.slice(2)}` : name;
}

/** Distinct months present, oldest first. */
export function monthsIn(buckets: readonly ChartBucket[]): string[] {
  const seen = new Set<string>();
  for (const b of buckets) seen.add(monthOf(b.key));
  return [...seen].sort();
}

/** Does this range cross a calendar month boundary? Nothing below fires
 *  until it does — a within-one-month range keeps its daily bars. */
export function spansMonths(buckets: readonly ChartBucket[]): boolean {
  return monthsIn(buckets).length > 1;
}

const addInto = (into: ChartShiftCell, from: ChartShiftCell): void => {
  into.good += from.good;
  into.reject += from.reject;
  into.runHrs += from.runHrs;
  into.downHrs += from.downHrs;
  into.setupHrs += from.setupHrs;
  // exp stays null until at least one day had a planning expectation, so a
  // month with no plan at all shows "no expectation" rather than 0.
  if (from.exp != null) into.exp = (into.exp ?? 0) + from.exp;
};

const emptyCell = (): ChartShiftCell => ({
  good: 0, reject: 0, runHrs: 0, downHrs: 0, setupHrs: 0, oee: null, exp: null,
});

/**
 * Collapse `buckets` (one per day, any order) to the bars to draw.
 *
 * The newest month is always left on daily bars. Every other month is one
 * bar unless its YYYY-MM is in `expanded`. Returns oldest → newest; a day
 * bar keeps its original `key` so the caller can still identify it.
 */
export function rollUpByMonth(
  buckets: readonly ChartBucket[],
  expanded: ReadonlySet<string> = new Set(),
): DisplayBucket[] {
  const months = monthsIn(buckets);
  if (months.length <= 1) {
    return [...buckets]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((b) => ({ ...b, month: monthOf(b.key), isMonth: false, days: 1 }));
  }
  const newest = months[months.length - 1];
  const withYear = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const byMonth = new Map<string, ChartBucket[]>();
  for (const b of buckets) {
    const m = monthOf(b.key);
    const arr = byMonth.get(m) ?? [];
    arr.push(b);
    byMonth.set(m, arr);
  }

  const out: DisplayBucket[] = [];
  for (const m of months) {
    const days = (byMonth.get(m) ?? []).sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    if (m === newest || expanded.has(m)) {
      for (const d of days) out.push({ ...d, month: m, isMonth: false, days: 1 });
      continue;
    }
    const byShift: Record<ShiftCode, ChartShiftCell> = {
      Day: emptyCell(), Afternoon: emptyCell(), Night: emptyCell(),
    };
    for (const d of days) {
      for (const code of ['Day', 'Afternoon', 'Night'] as ShiftCode[]) {
        addInto(byShift[code], d.byShift[code]);
      }
    }
    out.push({
      // A month bar's key is its first day, so it still sorts with the
      // day bars and can be used as a stable DOM id.
      key: days[0].key,
      label: monthLabel(m, withYear),
      byShift,
      month: m,
      isMonth: true,
      days: days.length,
    });
  }
  return out;
}
