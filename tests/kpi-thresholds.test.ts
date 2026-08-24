import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KPI_THRESHOLDS,
  loadKpiThresholds,
  planColourClass,
} from '../src/core/kpi-thresholds';

describe('shared KPI / Live Schedule thresholds', () => {
  it('uses the same green, orange(amber), and red boundaries', () => {
    expect(planColourClass(95, DEFAULT_KPI_THRESHOLDS)).toBe('green');
    expect(planColourClass(94, DEFAULT_KPI_THRESHOLDS)).toBe('amber');
    expect(planColourClass(80, DEFAULT_KPI_THRESHOLDS)).toBe('amber');
    expect(planColourClass(79, DEFAULT_KPI_THRESHOLDS)).toBe('red');
    expect(planColourClass(null, DEFAULT_KPI_THRESHOLDS)).toBe('');
  });

  it('falls back to defaults when browser storage is unavailable', () => {
    expect(loadKpiThresholds()).toEqual(DEFAULT_KPI_THRESHOLDS);
  });
});
