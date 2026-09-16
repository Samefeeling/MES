import { describe, expect, it } from 'vitest';
import { completeOnTick, popupDate } from '@/features/assembly/AssemblyInspector';

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
