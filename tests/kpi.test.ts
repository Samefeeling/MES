import { describe, it, expect } from 'vitest';
import {
  applyRejectDescriptions,
  byCompletion,
  collectHandovers,
  isHotStampMachine,
  lastRunAt,
  paretoRelativeBarWidth,
  rejectActionContext,
  rejectCell,
  REJECT_PER_SHIFT_MAX,
  sortHandoversNewest,
  type HandoverEntry,
} from '../src/ui/kpi';
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
  it('keeps the same job once per shift and returns the newest shift first', () => {
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
      '2026-07-14-Afternoon',
      '2026-07-14-Day',
    ]);
  });

  it('sorts by newest shift, then natural Job # order within that shift', () => {
    const h = (shiftId: string, jobNumber: string): HandoverEntry => ({
      shiftId,
      jobNumber,
      machine: 'Check press',
      mold: '',
      material: '',
      method: '',
    });
    const input = [
      h('2026-07-15-Night', 'SFM10'),
      h('2026-07-14-Afternoon', 'SFM1'),
      h('2026-07-15-Day', 'SFM20'),
      h('2026-07-15-Night', 'SFM2'),
    ];
    expect(sortHandoversNewest(input).map((x) => `${x.shiftId}|${x.jobNumber}`)).toEqual([
      '2026-07-15-Night|SFM2',
      '2026-07-15-Night|SFM10',
      '2026-07-15-Day|SFM20',
      '2026-07-14-Afternoon|SFM1',
    ]);
    expect(input[0].jobNumber).toBe('SFM10');
  });
});

describe('KPI Reject Pareto labels', () => {
  it('scales MachineStatus bars against Top 1 while preserving the real % separately', () => {
    expect(paretoRelativeBarWidth(93, 93)).toBe(100);
    expect(paretoRelativeBarWidth(71, 93)).toBeCloseTo(76.34, 2);
    expect(paretoRelativeBarWidth(1, 93)).toBeCloseTo(1.075, 2);
    expect(paretoRelativeBarWidth(0, 93)).toBe(0);
  });

  it('replaces PMD_Rejects MachineStatus R/S with the RejectCode description', () => {
    const slices = [
      {
        code: 'D05',
        label: 'R',
        value: 15,
        byShift: { Day: 0, Afternoon: 2, Night: 13 },
        byStatus: { R: 12, S: 3 },
      },
      {
        code: 'D09',
        label: 'S',
        value: 3,
        byShift: { Day: 0, Afternoon: 0, Night: 3 },
        byStatus: { S: 3 },
      },
    ] as const;
    const descriptions = new Map([
      ['D05', 'Short shot'],
      ['D09', 'Black spot'],
    ]);
    const out = applyRejectDescriptions(slices, descriptions);
    expect(out.map((s) => s.label)).toEqual(['Short shot', 'Black spot']);
    expect(out[0].byShift).toEqual({ Day: 0, Afternoon: 2, Night: 13 });
    // Status is preserved as a separate analytical dimension.
    expect(out[0].byStatus).toEqual({ R: 12, S: 3 });
    expect(rejectActionContext(out[0])).toEqual({
      runningQty: 12,
      startupQty: 3,
      unknownQty: 0,
      statusTotal: 15,
      runningPct: 80,
    });
  });

  it('falls back to RejectCode rather than exposing a status letter', () => {
    const out = applyRejectDescriptions(
      [{ code: 'D10', label: 'S', value: 1 }],
      new Map(),
    );
    expect(out[0].label).toBe('D10');
  });

  it('distinguishes startup-only scrap from rejects recorded while Running', () => {
    expect(
      rejectActionContext({ code: 'D05', label: 'Short shot', value: 7, byStatus: { S: 7 } }),
    ).toEqual({
      runningQty: 0,
      startupQty: 7,
      unknownQty: 0,
      statusTotal: 7,
      runningPct: 0,
    });
    expect(
      rejectActionContext({ code: 'D05', label: 'Short shot', value: 7, byStatus: { R: 7 } })
        .runningPct,
    ).toBe(100);
  });
});

describe('KPI Reject cell — per-shift traffic light', () => {
  it('is green up to the per-shift allowance and red above it', () => {
    expect(rejectCell(REJECT_PER_SHIFT_MAX, 1)).toContain('class="num green"');
    expect(rejectCell(REJECT_PER_SHIFT_MAX + 1, 1)).toContain('class="num red"');
  });

  it('scales the allowance by the shifts the row rolls up', () => {
    // 12 rejects is red for one shift but green across three — the same
    // number means something different on a shift row and a machine row.
    expect(rejectCell(12, 1)).toContain('class="num red"');
    expect(rejectCell(12, 3)).toContain('class="num green"');
    expect(rejectCell(16, 3)).toContain('class="num red"');
  });

  it('treats a slice with no shift count as a single shift', () => {
    expect(rejectCell(4, 0)).toContain('class="num green"');
    expect(rejectCell(6, 0)).toContain('class="num red"');
  });

  it('leaves a scrap-free row as an uncoloured dash', () => {
    const out = rejectCell(0, 3);
    expect(out).toBe('<td class="num">—</td>');
  });

  it('says how it judged the number, per shift', () => {
    expect(rejectCell(12, 3)).toContain('12 over 3 shifts = 4.0/shift');
    expect(rejectCell(2, 1)).toContain('2 in the shift');
  });

  it('keeps the drill-down button, and its verdict, on drillable rows', () => {
    const out = rejectCell(9, 1, 'FLOOR');
    expect(out).toContain('class="num red"');
    expect(out).toContain('data-reject-drill="FLOOR"');
    expect(out).toContain('RejectCode (Pareto)');
    // Zero scrap has nothing to break down: no button even with a key.
    expect(rejectCell(0, 1, 'FLOOR')).not.toContain('button');
  });
});

describe('Order rollup — listed in the sequence the press finished them', () => {
  const slots = (job: string, shiftId: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      rec({ jobNumber: job, shiftId, slotIndex: from + i, statusCode: 'R' }),
    );

  it('takes the end of the last worked slot as the finish time', () => {
    // Day starts 07:00; slot 5 spans 09:30–10:00, so the order came off
    // at 10:00 — the slot's END, not its start.
    const t = lastRunAt(slots('J1', '2026-05-15-Day', 0, 5));
    expect(new Date(t!).getHours()).toBe(10);
    expect(new Date(t!).getMinutes()).toBe(0);
  });

  it('ignores slots with no status — an empty row is not a run', () => {
    const recs = [
      ...slots('J1', '2026-05-15-Day', 0, 1),
      rec({ jobNumber: 'J1', shiftId: '2026-05-15-Day', slotIndex: 15, statusCode: '' }),
    ];
    // 08:00, the end of slot 1 — not 15:00, the end of the blank slot 15.
    expect(new Date(lastRunAt(recs)!).getHours()).toBe(8);
  });

  it('returns null when nothing was ever worked', () => {
    expect(lastRunAt([rec({ jobNumber: 'J1', slotIndex: 0, statusCode: '' })])).toBeNull();
    expect(lastRunAt([])).toBeNull();
  });

  it('orders earliest finish first, whatever the output', () => {
    const jobs = [
      { jobNumber: 'BIG', lastRunAt: lastRunAt(slots('BIG', '2026-05-15-Night', 0, 15)) },
      { jobNumber: 'MID', lastRunAt: lastRunAt(slots('MID', '2026-05-15-Day', 0, 3)) },
      { jobNumber: 'SML', lastRunAt: lastRunAt(slots('SML', '2026-05-15-Afternoon', 0, 1)) },
    ];
    expect([...jobs].sort(byCompletion).map((j) => j.jobNumber)).toEqual(['MID', 'SML', 'BIG']);
  });

  /** Night starts 23:00 and runs past midnight, so its slots are LATER
   *  than the same date's Day and Afternoon — a shift code compared as
   *  text would sort "Afternoon" first and put 15:00 before 07:00. */
  it('puts a Night order after the same day it started on', () => {
    const night = lastRunAt(slots('N', '2026-05-15-Night', 0, 15))!;
    const day = lastRunAt(slots('D', '2026-05-15-Day', 0, 15))!;
    const arvo = lastRunAt(slots('A', '2026-05-15-Afternoon', 0, 15))!;
    expect(day).toBeLessThan(arvo);
    expect(arvo).toBeLessThan(night);
    // …and Night genuinely lands on the next calendar day.
    expect(new Date(night).getDate()).toBe(16);
  });

  it('sorts orders with no finish time last, in a stable job order', () => {
    const jobs = [
      { jobNumber: 'Z', lastRunAt: null },
      { jobNumber: 'RAN', lastRunAt: lastRunAt(slots('RAN', '2026-05-15-Day', 0, 0)) },
      { jobNumber: 'A', lastRunAt: null },
    ];
    expect([...jobs].sort(byCompletion).map((j) => j.jobNumber)).toEqual(['RAN', 'A', 'Z']);
  });

  it('breaks a same-half-hour tie by job number rather than by Map order', () => {
    const at = lastRunAt(slots('x', '2026-05-15-Day', 0, 2));
    const jobs = [
      { jobNumber: 'SFM9', lastRunAt: at },
      { jobNumber: 'SFM1', lastRunAt: at },
    ];
    expect([...jobs].sort(byCompletion).map((j) => j.jobNumber)).toEqual(['SFM1', 'SFM9']);
    expect([...jobs].reverse().sort(byCompletion).map((j) => j.jobNumber)).toEqual([
      'SFM1',
      'SFM9',
    ]);
  });
});
