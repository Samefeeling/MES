import { describe, expect, it } from 'vitest';
import { updateKnownOrders } from '@/features/refresh/newOrders';

describe('incremental new-order tracking', () => {
  it('creates the first setup baseline without calling every order new', () => {
    const result = updateKnownOrders(null, ['A', 'B'], '2026-09-07');
    expect(result.newToday).toEqual([]);
    expect(result.state.known).toEqual({ A: null, B: null });
  });

  it('keeps the baseline and reports only first-seen orders for today', () => {
    const first = updateKnownOrders(null, ['A', 'B'], '2026-09-07');
    const update = updateKnownOrders(first.state, ['A', 'B', 'C'], '2026-09-08');
    expect(update.newToday).toEqual(['C']);
    expect(update.state.known).toEqual({ A: null, B: null, C: '2026-09-08' });
    expect(updateKnownOrders(update.state, ['B', 'C'], '2026-09-09').newToday)
      .toEqual([]);
  });

  it('keeps removed order ids so a later reappearance is not called new', () => {
    const previous = { known: { A: null, B: '2026-09-07' } };
    const missing = updateKnownOrders(previous, ['A'], '2026-09-08');
    expect(updateKnownOrders(missing.state, ['A', 'B'], '2026-09-09').newToday)
      .toEqual([]);
  });
});
