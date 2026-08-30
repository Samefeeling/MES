import { describe, it, expect } from 'vitest';
import { rejectSlotBlock, type RejectSlotFacts } from '../src/core/rejectslot';

const facts = (over: Partial<RejectSlotFacts> = {}): RejectSlotFacts => ({
  clock: '15:00–15:30',
  hasOwnStatus: true,
  occupiedBy: null,
  isPast: true,
  existing: 0,
  ...over,
});

describe('rejectSlotBlock', () => {
  it('opens a half-hour this order actually ran', () => {
    expect(rejectSlotBlock(facts()).blocked).toBe(false);
  });

  it('blocks a half-hour that belongs to another order', () => {
    const v = rejectSlotBlock(facts({ occupiedBy: 'SFM507341' }));
    expect(v.blocked).toBe(true);
    // The message has to name the order — "you're on the wrong sheet" is
    // the actual fix, and the operator can't guess whose half-hour it is.
    expect(v.reason).toContain('SFM507341');
    expect(v.reason).toContain('15:00–15:30');
  });

  it('blocks a finished half-hour this order never logged', () => {
    // The reported failure: production ran in the last columns of the
    // shift, the reject went into slot 0, and Trace drew a red marker
    // under a blank column.
    const v = rejectSlotBlock(facts({ hasOwnStatus: false }));
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain('15:00–15:30');
  });

  it('leaves the half-hour running right now open before its status is set', () => {
    // The operator finds a reject at 15:10 and types it in; the status
    // for 15:00–15:30 only gets set when the half-hour ends. Blocking
    // this would break the normal order of work.
    expect(rejectSlotBlock(facts({ hasOwnStatus: false, isPast: false })).blocked).toBe(false);
  });

  it('still blocks the live half-hour when another order owns it', () => {
    // Being in progress is no excuse for writing onto someone else's run.
    expect(
      rejectSlotBlock(facts({ isPast: false, occupiedBy: 'SFM507340' })).blocked,
    ).toBe(true);
  });

  it('keeps a cell that already holds a number editable', () => {
    // The bad rows this guard prevents are already on the floor. If the
    // guard trapped them, a supervisor could see the wrong value in Trace
    // and have no way to clear it.
    expect(rejectSlotBlock(facts({ hasOwnStatus: false, existing: 4 })).blocked).toBe(false);
    expect(rejectSlotBlock(facts({ occupiedBy: 'SFM507341', existing: 6 })).blocked).toBe(false);
  });

  it('blocks the empty cells of a slot where a sibling category has a value', () => {
    // The escape hatch is per-cell: D01 carrying a stray 4 does not open
    // D02 on the same half-hour for a fresh entry.
    expect(rejectSlotBlock(facts({ hasOwnStatus: false, existing: 0 })).blocked).toBe(true);
  });

  it('prefers the other order in the message when both rules apply', () => {
    const v = rejectSlotBlock(facts({ hasOwnStatus: false, occupiedBy: 'SFM507342' }));
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain('SFM507342');
  });

  it('gives every blocked verdict a reason and every open one none', () => {
    const cases: Partial<RejectSlotFacts>[] = [
      {},
      { occupiedBy: 'J1' },
      { hasOwnStatus: false },
      { hasOwnStatus: false, isPast: false },
      { existing: 3, hasOwnStatus: false },
    ];
    for (const c of cases) {
      const v = rejectSlotBlock(facts(c));
      expect(v.blocked ? v.reason.length > 0 : v.reason === '').toBe(true);
    }
  });
});
