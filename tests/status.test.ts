import { describe, it, expect } from 'vitest';
import {
  STATUSES,
  STATUS_MAP,
  ABNORMAL_CODES,
  DIE_CHANGE_CODES,
  statusKind,
  resolveAmbiguousStatus,
} from '../src/core/status';

describe('status codes (§2.2)', () => {
  it('defines all 9 codes', () => {
    expect(STATUSES.map((s) => s.code).sort()).toEqual(
      ['B', 'C', 'D', 'I', 'M', 'O', 'P', 'R', 'S'].sort(),
    );
  });

  it('classifies kinds per spec', () => {
    expect(statusKind('R')).toBe('production');
    expect(statusKind('B')).toBe('downtime');
    expect(statusKind('M')).toBe('downtime');
    expect(statusKind('C')).toBe('setup');
    expect(statusKind('D')).toBe('setup');
    expect(statusKind('I')).toBe('setup');
    expect(statusKind('P')).toBe('setup');
    expect(statusKind('S')).toBe('setup');
    expect(statusKind('O')).toBe('idle');
    expect(statusKind('')).toBeNull();
  });

  it('regular slot modal offers 8 abnormal codes, no R (§8.2)', () => {
    expect(ABNORMAL_CODES).toHaveLength(8);
    expect(ABNORMAL_CODES).not.toContain('R');
  });

  it('die-change modal offers only B C D I M (§5.3/§8.2)', () => {
    expect([...DIE_CHANGE_CODES].sort()).toEqual(['B', 'C', 'D', 'I', 'M']);
  });

  it('exposes the R color from the spec', () => {
    expect(STATUS_MAP['R'].color).toBe('#86efac');
  });
});

describe('ambiguous-status decision table (§16)', () => {
  it('R always beats other codes if good parts are coming off', () => {
    expect(resolveAmbiguousStatus(['R', 'B', 'M'])).toBe('R');
  });
  it('B always beats M', () => {
    expect(resolveAmbiguousStatus(['M', 'B'])).toBe('B');
  });
  it('falls through priority order', () => {
    expect(resolveAmbiguousStatus(['O', 'S', 'D'])).toBe('D');
    expect(resolveAmbiguousStatus([])).toBeNull();
  });
});
