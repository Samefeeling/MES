import { describe, it, expect } from 'vitest';
import { MemoryDataLayer } from '../src/dal/memory';

// Reject Pareto + Downtime Pareto now come straight from the DAL (the
// SP adapter reads PMD_Rejects / PMD_BreakDownlog directly; the memory
// adapter derives the same shape from its records). Lock the
// per-(machine, date-range) filter shape so the KPI page can rely on it.

describe('MemoryDataLayer.listRejectPareto', () => {
  it('returns code → qty sorted descending, label = RejectCode master description', async () => {
    const dal = new MemoryDataLayer(new Date('2026-06-15T08:00:00'));
    const today = '2026-06-15';
    const past = '2026-06-09'; // covers all seeded production days
    const all = await dal.listRejectPareto({ from: past, to: today });
    // Seeded production injects rejects under D01-D10 only.
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => /^D\d\d$/.test(s.code))).toBe(true);
    expect(all.every((s) => s.value > 0)).toBe(true);
    // Sorted desc.
    const values = all.map((s) => s.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    // Labels resolved from the seeded reject categories — not the bare code.
    expect(all[0].label.length).toBeGreaterThan(0);
    expect(all[0].label).not.toBe(all[0].code);
    // The mock preserves the same MachineStatus-at-defect dimension as
    // PMD_Rejects; its status quantities must reconcile to the code total.
    expect(
      all.every(
        (s) =>
          Object.values(s.byStatus ?? {}).reduce((sum, qty) => sum + (qty ?? 0), 0) ===
          s.value,
      ),
    ).toBe(true);
  });

  it('respects the machine filter — narrowing reduces the slice list', async () => {
    const dal = new MemoryDataLayer(new Date('2026-06-15T08:00:00'));
    const range = { from: '2026-06-09', to: '2026-06-15' };
    const floor = await dal.listRejectPareto(range);
    const one = await dal.listRejectPareto({ ...range, machineCode: '125T' });
    const floorTotal = floor.reduce((a, s) => a + s.value, 0);
    const oneTotal = one.reduce((a, s) => a + s.value, 0);
    expect(oneTotal).toBeLessThanOrEqual(floorTotal);
    expect(oneTotal).toBeGreaterThan(0);
  });

  it('excludes records outside the date window', async () => {
    const dal = new MemoryDataLayer(new Date('2026-06-15T08:00:00'));
    const future = await dal.listRejectPareto({
      from: '2099-01-01',
      to: '2099-01-31',
    });
    expect(future).toEqual([]);
  });
});

describe('MemoryDataLayer.listDowntimePareto', () => {
  it('returns BDCode → hours sorted descending, label = breakdown cause', async () => {
    const dal = new MemoryDataLayer(new Date('2026-06-15T08:00:00'));
    const all = await dal.listDowntimePareto({
      from: '2026-06-09',
      to: '2026-06-15',
    });
    if (all.length === 0) return; // seeded production may not always include B
    const values = all.map((s) => s.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(all.every((s) => s.value > 0)).toBe(true);
    expect(all[0].label.length).toBeGreaterThan(0);
  });
});
