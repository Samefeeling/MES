import { describe, expect, it } from 'vitest';
import { lineLayout } from '@/domain/lineLayout';

// The floor in production today: Gluing renamed "Upholstery", SSS renamed
// "Smart Soft Seating", upholstery run by process.
const floor = lineLayout({
  lineNames: { UPL_GLUING: 'Upholstery', UPL_SOFTIE: 'Smart Soft Seating' },
  uplByProcess: true,
  virtualLines: [{ key: 'VL_RUSH', name: 'Rush bay' }],
  lineOrder: ['UPL_CUT_SEW', 'UPL_GLUING', 'ASSY', 'TABLE'],
});

describe('lineLayout', () => {
  it('lists the lines as the board draws them: renamed, SSS stood down by process, benches under their lane', () => {
    expect(floor.lines.map((l) => l.name)).toEqual([
      'UPL-CUT', 'Upholstery + Smart Soft Seating', 'Assembly', 'Table', 'TBP', 'PMD', 'General', 'Rush bay',
    ]);
    expect(floor.lines[1].benches.map((b) => b.name)).toEqual(['Foaming', 'Sewing', 'Stapling']);
  });

  it('reads every name a record may carry as the line it is under now', () => {
    const now = (raw: string) => floor.nameOf(raw);
    // Older names, the SSS lane, a bench, the ERP planner, a key: all one lane now.
    for (const raw of ['UPL-Gluing', 'UPL-SSS', 'Smart Soft Seating', 'Upholstery', 'Sewing', 'UPL', 'UPL_SOFTIE_SEW', 'Upholstery + Smart Soft Seating']) {
      expect(now(raw)).toBe('Upholstery + Smart Soft Seating');
    }
    expect(['ASSY', 'ASM', 'Assembly', 'TABLE', 'GENERAL', 'Factory General', 'UPL-CUT', 'Cut/Sewing', 'VL_RUSH', 'Rush bay'].map(now)).toEqual([
      'Assembly', 'Assembly', 'Assembly', 'Table', 'General', 'General', 'UPL-CUT', 'UPL-CUT', 'Rush bay', 'Rush bay',
    ]);
    expect(floor.lineOf('Office')).toBeNull();
    expect(now('Office')).toBe('Office');
  });

  it('by product, Smart Soft Seating is a line of its own again', () => {
    const product = lineLayout({ lineNames: { UPL_SOFTIE: 'Smart Soft Seating' } });
    expect(product.nameOf('UPL-SSS')).toBe('Smart Soft Seating');
    expect(product.nameOf('UPL-Gluing')).toBe('UPL-Gluing');
    expect(product.lines.map((l) => l.key)).toContain('UPL_SOFTIE');
  });
});
