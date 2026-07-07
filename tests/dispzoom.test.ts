import { describe, it, expect } from 'vitest';
import { clampDispZoom } from '../src/ui/operator';

describe('clampDispZoom (operator page display zoom)', () => {
  it('passes through in-range values, snapped to 0.1 steps', () => {
    expect(clampDispZoom(1)).toBe(1);
    expect(clampDispZoom(0.8)).toBe(0.8);
    expect(clampDispZoom(1.2500001)).toBe(1.3);
    // float drift from repeated ±0.1 stepping snaps back onto the grid
    expect(clampDispZoom(0.7999999999999999)).toBe(0.8);
  });

  it('clamps to the 0.6–1.5 range', () => {
    expect(clampDispZoom(0.3)).toBe(0.6);
    expect(clampDispZoom(0)).toBe(0.6);
    expect(clampDispZoom(2.4)).toBe(1.5);
  });

  it('falls back to 100% on garbage (corrupt localStorage)', () => {
    expect(clampDispZoom(NaN)).toBe(1);
    expect(clampDispZoom(Infinity)).toBe(1);
    expect(clampDispZoom(-Infinity)).toBe(1);
  });
});
