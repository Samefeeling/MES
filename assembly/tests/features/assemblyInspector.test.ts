import { describe, expect, it } from 'vitest';
import { pickShortfall, popupDate } from '@/features/assembly/AssemblyInspector';

describe('order popup date format', () => {
  it('uses fixed dd/mm/yyyy formatting', () => {
    expect(popupDate(new Date(2026, 8, 7))).toBe('07/09/2026');
    expect(popupDate(null)).toBe('—');
  });
});

describe('the pick list’s shortage rule', () => {
  it('marks a component the order needs more of than the warehouse has', () => {
    expect(pickShortfall(40, 12)).toBe(28);
  });

  it('says nothing about a component that is covered, exactly or over', () => {
    expect(pickShortfall(40, 40)).toBe(0);
    expect(pickShortfall(40, 400)).toBe(0);
  });

  it('never calls a figure it does not have short', () => {
    // A part missing from the loaded OnHandInventory.csv, and a material line
    // the order export gave no required quantity. Both are unknown, and
    // unknown is not a shortage — the sheet shows "—" for them.
    expect(pickShortfall(40, undefined)).toBe(0);
    expect(pickShortfall(null, 0)).toBe(0);
  });

  it('treats nothing in stock against a real requirement as short', () => {
    expect(pickShortfall(40, 0)).toBe(40);
  });
});
