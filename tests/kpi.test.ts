import { describe, it, expect } from 'vitest';
import { collectHandovers, isHotStampMachine } from '../src/ui/kpi';
import { rec } from './helpers';

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

describe('KPI handover collection', () => {
  it('keeps the same job once per shift instead of discarding later-shift notes', () => {
    const rows = [
      rec({
        jobNumber: 'SFM1',
        slotIndex: 0,
        statusCode: 'R',
        shiftId: '2026-07-14-Day',
        handoverNote: JSON.stringify({ machine: 'Check robot', mold: '', material: '', method: '' }),
      }),
      rec({
        jobNumber: 'SFM1',
        slotIndex: 0,
        statusCode: 'R',
        shiftId: '2026-07-14-Afternoon',
        handoverNote: JSON.stringify({ machine: '', mold: 'Clean vent', material: '', method: '' }),
      }),
    ];
    const out = collectHandovers(rows);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.shiftId)).toEqual([
      '2026-07-14-Day',
      '2026-07-14-Afternoon',
    ]);
  });
});
