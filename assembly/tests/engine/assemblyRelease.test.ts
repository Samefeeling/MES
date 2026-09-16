import { describe, it, expect } from 'vitest';
import { releaseCheck, startEligibility } from '@/engine/assembly/release';
import type { MaterialStatus } from '@/domain/types';

const ok: MaterialStatus = { level: 'ok', earliestStart: null, shortages: [] };
const covered: MaterialStatus = {
  level: 'covered',
  earliestStart: new Date('2026-07-15'),
  shortages: [],
};
const short: MaterialStatus = {
  level: 'short',
  earliestStart: null,
  shortages: [],
};

describe('release gate', () => {
  it('releases only when stock exists and the kit is picked', () => {
    const r = releaseCheck(ok, 'ready');
    expect(r.level).toBe('ready');
    expect(r.releasable).toBe(true);
    expect(r.needsOverride).toBe(false);
  });

  it('blocks when components are short with no PO', () => {
    const r = releaseCheck(short, 'ready');
    expect(r.level).toBe('blocked');
    expect(r.releasable).toBe(false);
    expect(r.needsOverride).toBe(true);
  });

  it('blocks when the handler flags a shortage even if stock looks fine', () => {
    const r = releaseCheck(ok, 'shortage');
    expect(r.level).toBe('blocked');
    expect(r.releasable).toBe(false);
  });

  it('holds an order whose material only arrives on a future PO', () => {
    const r = releaseCheck(covered, 'ready');
    expect(r.level).toBe('caution');
    expect(r.releasable).toBe(false);
    expect(r.needsOverride).toBe(true);
    expect(r.reason).toMatch(/Waiting on material/);
  });

  it('holds — without override — while the kit is still being picked', () => {
    for (const prep of ['not-prepared', 'preparing'] as const) {
      const r = releaseCheck(ok, prep);
      expect(r.level).toBe('caution');
      expect(r.releasable).toBe(false);
      expect(r.needsOverride).toBe(false);
    }
  });

  it('reports the material problem ahead of the kit problem', () => {
    // Both are wrong; the harder constraint is the one shown.
    const r = releaseCheck(short, 'not-prepared');
    expect(r.level).toBe('blocked');
    expect(r.reason).toMatch(/no PO/);
  });

  it('marks a kit nobody has reported on as unconfirmed, not as a problem', () => {
    const release = releaseCheck(ok, 'unknown');
    expect(release.releasable).toBe(false);
    expect(release.unconfirmed).toBe(true);
    // The card still says the kit is unconfirmed; only the start gate ignores it.
    expect(release.reason).toBe('kit status missing');
  });

  it('starts an order the export says nothing about', () => {
    // JobReleased and MaterialPrep are optional columns. Where the export
    // carries neither, every order reads null/unknown — and a gate that stops
    // every start is a gate the floor overrides without reading.
    const gate = startEligibility(null, releaseCheck(ok, 'unknown'), 2);
    expect(gate.allowed).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it('still holds an order somebody has explicitly held', () => {
    expect(startEligibility(false, releaseCheck(ok, 'ready'), 2).reasons).toEqual([
      'Order is not released',
    ]);
    expect(startEligibility(null, releaseCheck(ok, 'not-prepared'), 2).reasons).toEqual([
      'kit not prepared',
    ]);
    expect(startEligibility(null, releaseCheck(short, 'unknown'), 2).reasons).toEqual([
      'Components short with no PO',
    ]);
  });

  it('does not allow even a supervisor override without a crew', () => {
    const gate = startEligibility(false, releaseCheck(ok, 'ready'), 0);
    expect(gate.allowed).toBe(false);
    expect(gate.canOverride).toBe(false);
  });
});
