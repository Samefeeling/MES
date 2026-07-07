import { describe, it, expect } from 'vitest';
import { isHotStampMachine } from '../src/ui/kpi';

describe('isHotStampMachine — hot-stamp KPI category', () => {
  it('matches the hot-stamp press by code, whatever the tenant named it', () => {
    for (const code of ['Hstamp', 'HStamp', 'HOTSTAMP', 'Hot-Stamp', 'hot_stamp']) {
      expect(isHotStampMachine({ machineCode: code, displayName: '' })).toBe(true);
    }
  });

  it('matches by display name when the code is opaque', () => {
    expect(
      isHotStampMachine({ machineCode: 'M09', displayName: 'Hot Stamping Press' }),
    ).toBe(true);
    expect(
      isHotStampMachine({ machineCode: 'HSP', displayName: 'Hot-Stamp' }),
    ).toBe(true);
  });

  it('does NOT match the High-Speed press ("HS") or the moulding presses', () => {
    expect(
      isHotStampMachine({ machineCode: 'HS', displayName: 'High-Speed Press' }),
    ).toBe(false);
    expect(
      isHotStampMachine({ machineCode: '1600T', displayName: '1600 Tonne Press' }),
    ).toBe(false);
    expect(
      isHotStampMachine({ machineCode: 'Batt1', displayName: 'Battery Cell Line 1' }),
    ).toBe(false);
  });
});
