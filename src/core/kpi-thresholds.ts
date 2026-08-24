/** Shared traffic-light thresholds for KPI Output/vs Plan and the Live
 * Schedule bars. Kept outside the KPI UI so both views read and persist
 * exactly the same supervisor-tuned values. */
export interface KpiThresholds {
  effGreen: number;
  effAmber: number;
  yieldGreen: number;
  yieldAmber: number;
  planBlue: number;
  planAmber: number;
}

export const DEFAULT_KPI_THRESHOLDS: KpiThresholds = {
  effGreen: 85,
  effAmber: 70,
  yieldGreen: 98,
  yieldAmber: 95,
  planBlue: 95,
  planAmber: 80,
};

export const KPI_THRESHOLDS_KEY = 'pmd.kpiThresholds';

export function loadKpiThresholds(): KpiThresholds {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_KPI_THRESHOLDS };
    const raw = localStorage.getItem(KPI_THRESHOLDS_KEY);
    if (!raw) return { ...DEFAULT_KPI_THRESHOLDS };
    const parsed = JSON.parse(raw) as Partial<KpiThresholds>;
    return { ...DEFAULT_KPI_THRESHOLDS, ...parsed };
  } catch {
    return { ...DEFAULT_KPI_THRESHOLDS };
  }
}

export function saveKpiThresholds(thresholds: KpiThresholds): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KPI_THRESHOLDS_KEY, JSON.stringify(thresholds));
  } catch {
    // Private mode / blocked storage: the caller keeps its in-memory copy.
  }
}

export function planColourClass(
  pct: number | null,
  thresholds: Pick<KpiThresholds, 'planBlue' | 'planAmber'>,
): '' | 'green' | 'amber' | 'red' {
  if (pct == null) return '';
  if (pct >= thresholds.planBlue) return 'green';
  if (pct >= thresholds.planAmber) return 'amber';
  return 'red';
}
