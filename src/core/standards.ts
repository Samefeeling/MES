/**
 * Changeover standards (floor-stated):
 *
 * - A die change is allowed 4 hours — 8 consecutive D slots.
 * - A colour change or an insert change is allowed 30 min — 1 slot.
 *
 * Standard, not actual, so a die change that dragged past 4h shows up as
 * a red changeover instead of silently lowering the bar. What a shift
 * should produce is core/kpi-attainment.ts.
 */
export const DIE_CHANGE_STD_HRS = 4;
export const COLOR_CHANGE_STD_HRS = 0.5;
export const INSERT_CHANGE_STD_HRS = 0.5;

export interface SetupStd {
  dieStdHrs: number;
  colorStdHrs: number;
  insertStdHrs: number;
}

/** Standard changeover allowance for a slice: each D/C/I *changeover*
 *  (one per order, as counted by countSetupEvents) earns its standard
 *  duration. Per order, not per run of slots — a die change the sheet
 *  recorded in two pieces is one changeover with one 4 h allowance, not
 *  two with eight. */
export function setupStandardHours(counts: {
  dieChanges: number;
  colorChanges: number;
  insertChanges: number;
}): SetupStd {
  return {
    dieStdHrs: counts.dieChanges * DIE_CHANGE_STD_HRS,
    colorStdHrs: counts.colorChanges * COLOR_CHANGE_STD_HRS,
    insertStdHrs: counts.insertChanges * INSERT_CHANGE_STD_HRS,
  };
}

/** Judge actual changeover hours against the standard allowance:
 *  blue = met (within standard), amber = one slot (0.5 h) over, red =
 *  worse. '' when the slice had no changeover at all (nothing to judge)
 *  or the standard wasn't computed for it (null). */
export function setupJudgement(
  actualHrs: number,
  stdHrs: number | null,
): 'blue' | 'amber' | 'red' | '' {
  if (stdHrs == null) return '';
  if (actualHrs <= 0 && stdHrs <= 0) return '';
  const over = +(actualHrs - stdHrs).toFixed(2);
  if (over <= 0) return 'blue';
  if (over <= 0.5) return 'amber';
  return 'red';
}
