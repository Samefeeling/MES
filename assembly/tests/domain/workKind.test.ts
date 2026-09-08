/**
 * Benches within a line. UPL is not one workstation: cutting and sewing,
 * building the softies, and upholstering the frame are different trades and
 * the people are not interchangeable between them.
 */

import { describe, it, expect } from 'vitest';
import { canWorkKind, workKind, type Worker } from '@/domain/assembly';
import { WorkerId } from '@/domain/ids';

const person = (trades?: Worker['trades']): Worker => ({
  id: WorkerId('W'),
  name: 'W',
  skills: ['UPL', 'ASSY'],
  onShift: true,
  ...(trades ? { trades } : {}),
});

describe('workKind', () => {
  it('reads the bench off the description', () => {
    expect(workKind('Podium Chair - Cut & Sew Charcoal', 'UPL')).toBe('cut-sew');
    expect(workKind('Lounge Sofa 3-Seat Smart Softies Storm', 'UPL')).toBe(
      'smart-softie',
    );
    expect(workKind('Ottoman 600 Smart Softies - Charcoal', 'UPL')).toBe(
      'smart-softie',
    );
    expect(workKind('Viva Sidechair Upholstery - Black', 'UPL')).toBe(
      'upholstery',
    );
  });

  it('gives cutting priority over Softie descriptions', () => {
    // Cutting precedes Softie assembly.
    expect(workKind('Smart Softie Cut & Sew - Ottoman', 'UPL')).toBe(
      'cut-sew',
    );
  });

  it('calls anything it cannot place upholstery, which UPL mostly is', () => {
    expect(workKind('Integra Chair - UV', 'UPL')).toBe('upholstery');
  });

  it('recognises Cut regardless of the supplied line', () => {
    // Description takes priority over the exported line.
    expect(workKind('Classroom Table 1200 Cut', 'TABLE')).toBe('cut-sew');
    expect(workKind('Podium Chair Final Assy & Pack', 'ASSY')).toBe('general');
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
    // A cutter is still a whole ASSY hand — the trade says which bench on the
    // line that has benches, not which lines they may work at all.
    expect(canWorkKind(person(['cut-sew']), 'general')).toBe(true);
    expect(canWorkKind(person(['smart-softie']), 'general')).toBe(true);
  });
});
