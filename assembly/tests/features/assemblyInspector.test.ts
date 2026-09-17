import { describe, expect, it } from 'vitest';
import { completeOnTick, pickShortfall, popupDate } from '@/features/assembly/AssemblyInspector';

describe('order popup date format', () => {
  it('uses fixed dd/mm/yyyy formatting', () => {
    expect(popupDate(new Date(2026, 8, 7))).toBe('07/09/2026');
    expect(popupDate(null)).toBe('—');
  });
});

describe('ticking Job completed', () => {
  const form = { draft: '', maxComplete: 40, booked: '', filled: false };

  it('fills Complete with everything still owed on the order', () => {
    expect(completeOnTick(true, form)).toEqual({ draft: '40', filled: true });
    // A box explicitly on zero is the same empty claim, and is filled too.
    expect(completeOnTick(true, { ...form, draft: '0' })).toEqual({
      draft: '40',
      filled: true,
    });
  });

  it('never overwrites a figure the shift entered', () => {
    expect(completeOnTick(true, { ...form, draft: '12' })).toEqual({
      draft: '12',
      filled: false,
    });
  });

  it('takes back only its own number when the tick comes off', () => {
    const filled = completeOnTick(true, form);
    expect(completeOnTick(false, { ...form, ...filled })).toEqual({
      draft: '',
      filled: false,
    });
    // Typed over after it was filled: that figure is the shift's now.
    expect(
      completeOnTick(false, { ...form, draft: '31', filled: true }),
    ).toEqual({ draft: '31', filled: false });
  });

  it('goes back to what today already booked, not to nothing', () => {
    expect(
      completeOnTick(false, { ...form, draft: '40', booked: '6', filled: true }),
    ).toEqual({ draft: '6', filled: false });
  });

  it('has nothing to offer an order with nothing left to book', () => {
    expect(completeOnTick(true, { ...form, maxComplete: 0 })).toEqual({
      draft: '',
      filled: false,
    });
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
