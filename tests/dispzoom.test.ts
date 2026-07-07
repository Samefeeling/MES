import { describe, it, expect } from 'vitest';
import { clampDispZoom, fitDispZoom } from '../src/ui/operator';

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

describe('fitDispZoom (auto-fit the whole sheet on screen)', () => {
  it('shrinks a too-tall sheet to exactly fill the available height', () => {
    // iPad 9 landscape: ~750px available, sheet naturally ~1200px tall
    expect(fitDispZoom(750, 1200)).toBeCloseTo(0.625);
  });

  it('is NOT snapped to 0.1 steps — snapping up would overflow', () => {
    const z = fitDispZoom(750, 1200);
    expect(1200 * z).toBeLessThanOrEqual(750);
  });

  it('never enlarges past 100% when the sheet already fits', () => {
    expect(fitDispZoom(900, 700)).toBe(1);
    expect(fitDispZoom(700, 700)).toBe(1);
  });

  it('floors at 60% — below that the grid scrolls instead', () => {
    expect(fitDispZoom(400, 1600)).toBe(0.6);
  });

  it('degrades to 100% on degenerate measurements', () => {
    expect(fitDispZoom(0, 1200)).toBe(1);
    expect(fitDispZoom(750, 0)).toBe(1);
    expect(fitDispZoom(NaN, 1200)).toBe(1);
    expect(fitDispZoom(750, NaN)).toBe(1);
  });
});
