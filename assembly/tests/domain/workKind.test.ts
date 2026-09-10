/**
 * Benches within upholstery. Cutting and sewing, building the softies, and
 * upholstering the frame are different trades and the people are not
 * interchangeable between them.
 *
 * The bench used to be guessed from the part description, because `UPL` was
 * one lane holding all three. The BOM rules split that lane into UPL-CUT,
 * UPL-Gluing and UPL-SSS, so the line already names the bench and there is
 * nothing left to guess — which is the point of these first tests.
 */

import { describe, it, expect } from 'vitest';
import { canWorkKind, workKind, type Worker } from '@/domain/assembly';
import { WorkerId } from '@/domain/ids';

const person = (trades?: Worker['trades']): Worker => ({
  id: WorkerId('W'),
  name: 'W',
  skills: ['UPL_GLUING', 'ASSY'],
  onShift: true,
  ...(trades ? { trades } : {}),
});

describe('workKind', () => {
  it('takes the bench from the line, which is what the BOM decided', () => {
    expect(workKind('UPL_CUT_SEW')).toBe('cut-sew');
    expect(workKind('UPL_SOFTIE')).toBe('smart-softie');
    expect(workKind('UPL_GLUING')).toBe('upholstery');
  });

  it('leaves every other line qualified by the line itself', () => {
    for (const line of ['TBP', 'PMD', 'ASSY', 'TABLE', 'FACTORY_GENERAL'] as const) {
      expect(workKind(line)).toBe('general');
    }
  });

  it('no longer reads the description, however suggestive it is', () => {
    // "Cut Fabric for Smart Softie" on an ASM order used to be dragged onto
    // cutting by its wording. The part's BOM says where it goes; a phrase in
    // the description that happens to contain "cut" does not get a vote.
    expect(workKind('ASSY')).toBe('general');
    expect(workKind('TABLE')).toBe('general');
  });
});

describe('canWorkKind', () => {
  it('keeps restricted work for the people named for it', () => {
    expect(canWorkKind(person(['smart-softie']), 'smart-softie')).toBe(true);
    expect(canWorkKind(person(), 'smart-softie')).toBe(false);
    expect(canWorkKind(person(['cut-sew']), 'smart-softie')).toBe(false);
  });

  it('holds a listed trade to that trade and nothing else', () => {
    const cutter = person(['cut-sew']);
    expect(canWorkKind(cutter, 'cut-sew')).toBe(true);
    expect(canWorkKind(cutter, 'upholstery')).toBe(false);
  });

  it('opens everything unrestricted to someone with no trade listed', () => {
    const anyone = person();
    expect(canWorkKind(anyone, 'cut-sew')).toBe(true);
    expect(canWorkKind(anyone, 'upholstery')).toBe(true);
  });

  it('leaves the other lines alone', () => {
    // A cutter is still a whole ASM hand — the trade says which bench on the
    // line that has benches, not which lines they may work at all.
    expect(canWorkKind(person(['cut-sew']), 'general')).toBe(true);
    expect(canWorkKind(person(['smart-softie']), 'general')).toBe(true);
  });
});
