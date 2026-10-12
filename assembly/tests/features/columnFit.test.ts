import { describe, expect, it } from 'vitest';
import { fitFrozenWidths } from '@/features/assembly/AssemblyGantt';
import { DEFAULT_COLUMN_WIDTHS } from '@/store/uiStore';

const cols = { qty: true, hours: true, team: true };
const dates = { start: true, due: true, expect: true };
const frozen = (w: typeof DEFAULT_COLUMN_WIDTHS) => w.order + w.qty + w.hours + w.start + w.due + w.expect + w.team;

describe('frozen columns on a narrow screen', () => {
  it('leaves a desktop as the reader set it', () => {
    expect(fitFrozenWidths(DEFAULT_COLUMN_WIDTHS, cols, dates, 1440)).toBe(DEFAULT_COLUMN_WIDTHS);
  });

  it('narrows Order first on an iPad held sideways, and keeps Team', () => {
    const w = fitFrozenWidths(DEFAULT_COLUMN_WIDTHS, cols, dates, 1180);
    expect(frozen(w)).toBe(Math.floor(1180 * 0.6));
    expect(w.team).toBe(DEFAULT_COLUMN_WIDTHS.team);
    expect(w.qty).toBe(DEFAULT_COLUMN_WIDTHS.qty);
  });

  it('leaves the timeline on screen on an iPad held upright', () => {
    const w = fitFrozenWidths(DEFAULT_COLUMN_WIDTHS, cols, dates, 820);
    expect(w.order).toBe(160);
    expect(w.team).toBe(160);
    expect(frozen(w)).toBeLessThan(820 - 250);
  });

  it('takes nothing a hidden column or a narrow reader setting already gave back', () => {
    const narrow = { ...DEFAULT_COLUMN_WIDTHS, order: 150 };
    expect(fitFrozenWidths(narrow, { ...cols, team: false }, dates, 820)).toBe(narrow);
  });
});
