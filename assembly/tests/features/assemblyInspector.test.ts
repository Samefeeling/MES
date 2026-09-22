import { describe, expect, it } from 'vitest';
import {
  completeOnTick,
  popupDate,
  rebookWarning,
} from '@/features/assembly/AssemblyInspector';
import type { ProductionEntry } from '@/store/planStore';

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

describe('booking a day that is already booked', () => {
  const entry = (over: Partial<ProductionEntry> = {}): ProductionEntry => ({
    date: '2026-09-21',
    complete: 0,
    reject: 0,
    rework: 0,
    shiftOutput: 0,
    paused: false,
    pauseReason: null,
    jobCompleted: false,
    notes: '',
    ...over,
  });
  const at = (iso: string) => `at ${iso.slice(11, 16)}`;

  it('reads back what the day already holds, and what saving will do to it', () => {
    expect(
      rebookWarning(
        entry({ shiftOutput: 2, complete: 5, savedAt: '2026-09-21T11:52:00Z' }),
        at,
      ),
    ).toBe(
      'Today is already booked on this order — 2 output, 5 complete, saved ' +
        'at 11:52. Saving replaces that entry rather than adding a second one. ' +
        'Press Save again to replace it.',
    );
  });

  it('names the things that are not figures', () => {
    const said = rebookWarning(
      entry({ shiftOutput: 9, rework: 1, jobCompleted: true }),
      at,
    );
    expect(said).toContain('9 output, 0 complete, 1 rework, job completed');
    // Nothing rejected and nothing reworked is not worth saying twice.
    expect(said).not.toContain('reject');
    expect(said).not.toContain('paused');
  });

  it('says nothing about a time it does not have', () => {
    // Entries written before savedAt existed, and ones a backend supplied.
    expect(rebookWarning(entry({ shiftOutput: 4 }), at)).toContain(
      '4 output, 0 complete. Saving replaces',
    );
  });
});
