/**
 * Edit loads: changes show at once and are kept only with Save; Cancel puts
 * back what was there when editing began.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DECISIONS } from '@/domain/dispatch';
import { useDispatchStore } from '@/store/dispatchStore';

describe('load edits', () => {
  beforeEach(() => {
    useDispatchStore.setState({ decisions: EMPTY_DECISIONS, shipments: [], editing: null, listBacked: false });
  });

  it('Cancel drops every change made since Edit loads', () => {
    const s = useDispatchStore.getState();
    s.pin('17919', '2026-10-15');
    s.beginEdit();
    s.pin('17920', '2026-10-16');
    s.hold('17919', 'Customer asked');
    expect(useDispatchStore.getState().decisions.pins).toHaveProperty('17920');
    useDispatchStore.getState().cancelEdit();
    const after = useDispatchStore.getState();
    expect(after.editing).toBeNull();
    expect(after.decisions.pins).toEqual({ '17919': '2026-10-15' });
    expect(after.decisions.holds).toEqual({});
  });

  it('Save keeps them', () => {
    const s = useDispatchStore.getState();
    s.beginEdit();
    s.pin('17920', '2026-10-16');
    useDispatchStore.getState().saveEdit();
    expect(useDispatchStore.getState().editing).toBeNull();
    expect(useDispatchStore.getState().decisions.pins).toEqual({ '17920': '2026-10-16' });
  });

  it('a second Edit loads keeps the first starting point', () => {
    const s = useDispatchStore.getState();
    s.beginEdit();
    s.pin('17920', '2026-10-16');
    useDispatchStore.getState().beginEdit();
    useDispatchStore.getState().cancelEdit();
    expect(useDispatchStore.getState().decisions.pins).toEqual({});
  });
});
