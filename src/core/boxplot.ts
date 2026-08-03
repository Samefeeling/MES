/**
 * Five-number summary for a box plot, Tukey's convention.
 *
 * Quartiles interpolate linearly between order statistics (the method
 * Excel's PERCENTILE.INC and R's default type 7 use), so a supervisor
 * checking the chart against a spreadsheet gets the same numbers.
 *
 * Whiskers stop at the most extreme value still within 1.5×IQR of the
 * box; anything past that is drawn as an outlier rather than swallowed
 * by a long whisker. On this data the outliers ARE the finding — the one
 * die change that took nine hours is what the meeting is about.
 */
export interface BoxStats {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Ends of the drawn whiskers (real data points, never the fences). */
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number[];
  mean: number;
}

/** Guards the fence comparison against interpolation rounding, so a
 *  point sitting exactly on the fence stays inside it. */
const EPS = 1e-9;

export function boxStats(values: number[]): BoxStats | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const q1 = quantile(0.25);
  const median = quantile(0.5);
  const q3 = quantile(0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr - EPS;
  const hiFence = q3 + 1.5 * iqr + EPS;
  const inside = v.filter((x) => x >= loFence && x <= hiFence);
  return {
    n: v.length,
    min: v[0],
    max: v[v.length - 1],
    q1,
    median,
    q3,
    // inside is only empty if every point is an outlier, which Tukey's
    // fences cannot produce (q1 and q3 are always within them).
    lowerWhisker: inside.length ? inside[0] : v[0],
    upperWhisker: inside.length ? inside[inside.length - 1] : v[v.length - 1],
    outliers: v.filter((x) => x < loFence || x > hiFence),
    mean: v.reduce((a, x) => a + x, 0) / v.length,
  };
}
