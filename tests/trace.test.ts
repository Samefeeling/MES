import { describe, it, expect } from 'vitest';
import {
  goodForRecords,
  groupByDay,
  renderCard,
  renderSchedule,
  syntheticOrderFromRecord,
  type TraceRow,
} from '../src/ui/trace';
import {
  jobLeftPiecesFor,
  shiftTargetFor,
  totalGoodExceedsShiftTarget,
} from '../src/ui/operator';
import { order, rec } from './helpers';

// Job Left / Shift Target are pure formulas owned by the operator module
// — the Trace page reuses them so management sees the same numbers as
// the operator. These tests fence the formula behaviour at that seam.

describe('jobLeftPiecesFor (shared with operator side panel)', () => {
  it('Job Left = ORDER TOTAL − cumulative Good across every shift', () => {
    // The base is orderQty (JobHead_ProdQty), NOT jobRequired (Epicor's
    // Calculated_RemainingQty): Epicor decrements the latter as
    // production is reported back to it, so subtracting PMD's Good from
    // it again double-counted every reported piece — SFM507147 showed
    // Job Left 0 while 656 genuinely remained.
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 30)).toBe(170); // 200 − 30
  });

  it('falls back to the remaining qty when no total was exported', () => {
    const o = order({ jobNumber: 'J1', orderQty: 0, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 30)).toBe(66); // 96 − 30
  });

  it('never goes negative', () => {
    const o = order({ jobNumber: 'J1', orderQty: 200, jobRequired: 96 });
    expect(jobLeftPiecesFor(o, 250)).toBe(0);
  });

  it('returns null for die-change pseudo-orders', () => {
    const dc = order({ jobNumber: 'DC', isDieChange: true });
    expect(jobLeftPiecesFor(dc, 0)).toBeNull();
  });
});

describe('shiftTargetFor (shared with operator side panel)', () => {
  it('caps at a full 8 h run when the job will not finish', () => {
    // cycle time 0.05 h/piece → a full shift is floor(8 / 0.05) = 160.
    // Job Left 1000 × 0.05 = 50 h ≥ 8 h, so the cap wins.
    const o = order({ jobNumber: 'J1', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 1000)).toBe(160);
  });

  it('= Job Left when the job finishes inside the shift', () => {
    // 40 × 0.05 = 2 h < 8 h, so the target is just the remainder.
    const o = order({ jobNumber: 'J1', qtyPerHr: 0.05 });
    expect(shiftTargetFor(o, 40)).toBe(40);
  });

  it('returns null when no cycle time is on the planning row', () => {
    const o = order({ jobNumber: 'J1', qtyPerHr: 0 });
    expect(shiftTargetFor(o, 100)).toBeNull();
  });
});

describe('Total Good vs Shift Target warning', () => {
  it('warns only when Total Good is strictly above 130% of target', () => {
    expect(totalGoodExceedsShiftTarget(130, 100)).toBe(false);
    expect(totalGoodExceedsShiftTarget(131, 100)).toBe(true);
    expect(totalGoodExceedsShiftTarget(1, 0)).toBe(true);
  });

  it('does not guess when Shift Target cannot be calculated', () => {
    expect(totalGoodExceedsShiftTarget(9999, null)).toBe(false);
  });
});

describe('goodForRecords (job-wide Good across shifts)', () => {
  it('sums gross − reject per (machine, shift) tuple', () => {
    const recs = [
      // Day shift: gross 100, 4 rejects → 96 good.
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', countStart: 0, countEnd: 100 }),
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'R', rejects: '{"D01":4}' }),
      // Afternoon shift on the same machine: gross 50, no rejects → 50.
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        shiftId: '2026-05-15-Afternoon',
        countStart: 100,
        countEnd: 150,
      }),
    ];
    expect(goodForRecords(recs)).toBe(146); // 96 + 50
  });
});

describe('syntheticOrderFromRecord (past-shift order rebuilt from PMD_Production)', () => {
  it('rebuilds Order Qty + Job Left basis from the denormalised JobRequired total', () => {
    // PMD_Production.JobRequired denormalises the ORDER TOTAL, so a Job
    // Number search for a job Epicor has dropped from Planning.csv still
    // resolves Order Qty / Job Left straight from the List.
    const canon = rec({
      jobNumber: 'SFM507067',
      slotIndex: 0,
      statusCode: 'R',
      partNumber: 'V11690',
      partDescription: 'Ned Stool',
      jobRequired: 96,
      countStart: 0,
      countEnd: 83,
    });
    const o = syntheticOrderFromRecord(canon, 'SFM507067')!;
    expect(o.orderQty).toBe(96);
    expect(o.jobRequired).toBe(96);
    expect(o.partNumber).toBe('V11690');
    // Job Left flows through the SAME formula the operator sheet uses.
    expect(jobLeftPiecesFor(o, 30)).toBe(66); // 96 − 30
    // No cycle time is recorded on PMD_Production, so Shift Target is "—"
    // (null) — identical to how the operator sheet renders a dropped order.
    expect(shiftTargetFor(o, jobLeftPiecesFor(o, 30)!)).toBeNull();
  });

  it('returns null when there is no recorded order total to rebuild from', () => {
    const canon = rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' });
    expect(syntheticOrderFromRecord(canon, 'J1')).toBeNull();
    expect(syntheticOrderFromRecord(undefined, 'J1')).toBeNull();
  });
});

describe('groupByDay (the unit a day card draws)', () => {
  const row = (over: Partial<TraceRow>): TraceRow =>
    ({
      key: '',
      machineCode: '125T',
      shiftId: '2026-07-01-Day',
      jobNumber: 'J1',
      partNumber: '',
      partDescription: '',
      operator: '',
      supervisor: '',
      timeline: '·'.repeat(16),
      countStart: null,
      countEnd: null,
      good: 0,
      reject: 0,
      orderQty: null,
      jobLeft: null,
      shiftTarget: null,
      qcBySlot: [],
      rejects: [],
      bdSlots: [],
      records: [],
      ...over,
    }) as TraceRow;

  it('gathers one order-press-date into a single card', () => {
    const groups = groupByDay([
      row({ shiftId: '2026-07-01-Day' }),
      row({ shiftId: '2026-07-01-Afternoon' }),
      row({ shiftId: '2026-07-01-Night' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ jobNumber: 'J1', machineCode: '125T', date: '2026-07-01' });
    expect(groups[0].rows).toHaveLength(3);
  });

  it('splits two orders that shared a press on the same day', () => {
    // A job finishing and the next starting in the same shift: merged
    // into one card, their timelines would overwrite each other in the
    // same three blocks.
    const groups = groupByDay([
      row({ jobNumber: 'J1', shiftId: '2026-07-01-Day' }),
      row({ jobNumber: 'J2', shiftId: '2026-07-01-Day' }),
    ]);
    expect(groups.map((g) => g.jobNumber)).toEqual(['J1', 'J2']);
  });

  it('splits by press and by date', () => {
    const groups = groupByDay([
      row({ shiftId: '2026-07-01-Day' }),
      row({ shiftId: '2026-07-02-Day' }),
      row({ machineCode: '550T', shiftId: '2026-07-01-Day' }),
    ]);
    expect(groups.map((g) => `${g.machineCode}|${g.date}`)).toEqual([
      '125T|2026-07-01',
      '125T|2026-07-02',
      '550T|2026-07-01',
    ]);
  });

  it('keeps the caller’s order — the sort decides which way time runs', () => {
    const groups = groupByDay([
      row({ shiftId: '2026-07-03-Day' }),
      row({ shiftId: '2026-07-01-Day' }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(['2026-07-03', '2026-07-01']);
  });
});

describe('Live Status card for a press with no order', () => {
  const live = (over: Partial<TraceRow>): TraceRow =>
    ({
      key: '',
      machineCode: '1300T',
      shiftId: '2026-07-01-Day',
      jobNumber: '',
      partNumber: '',
      partDescription: 'No production logged this shift',
      operator: '',
      supervisor: '',
      timeline: '·'.repeat(16),
      countStart: null,
      countEnd: null,
      good: 0,
      reject: 0,
      orderQty: null,
      jobLeft: null,
      shiftTarget: null,
      qcBySlot: Array.from({ length: 16 }, () => ''),
      rejects: [],
      bdSlots: [],
      records: [],
      idle: true,
      ...over,
    }) as TraceRow;

  it('collapses to one line: machine, (no job), Idle', () => {
    const html = renderCard(live({}));
    expect(html).toContain('trace-card-slim');
    expect(html).toContain('>1300T<');
    expect(html).toContain('(no job)');
    expect(html).toContain('>Idle<');
    // Nothing else is known about it — no counts, no grids, no operator.
    expect(html).not.toContain('trace-timeline');
    expect(html).not.toContain('trace-qc-row');
    expect(html).not.toContain('trace-card-totals');
  });

  it('still draws the full card for a press that has an order', () => {
    const html = renderCard(
      live({ jobNumber: 'J1', idle: false, timeline: 'R'.repeat(16), good: 400 }),
    );
    expect(html).not.toContain('trace-card-slim');
    expect(html).toContain('trace-timeline');
    expect(html).toContain('trace-card-totals');
    expect(html).toContain('>J1<');
  });

  it('shows the planned schedule even while the machine is idle', () => {
    const schedule = [
      order({
        jobNumber: 'PLAN-42',
        machineCode: '1300T',
        plannedStart: '2026-07-01T08:00:00',
        plannedEnd: '2026-07-01T10:00:00',
        qtyPerHr: 1 / 40,
      }),
    ];
    const card = renderCard(live({ schedule }));
    expect(card).not.toContain('trace-card-slim');
    expect(card).toContain('Schedule');
    expect(card).toContain('PLAN-42');
    expect(card).toContain('(no live job)');
    expect(renderSchedule(live({ schedule }))).toContain('left:12.500%');
  });

  it('colours Schedule bars with the same 95/80 vs Plan thresholds as KPI', () => {
    const plan = order({
      jobNumber: 'PLAN-COLOUR',
      machineCode: '1300T',
      plannedStart: '2026-07-01T07:00:00',
      plannedEnd: '2026-07-01T15:00:00',
      qtyPerHr: 1 / 50,
    });
    const now = new Date('2026-07-01T11:00:00'); // expected = 200
    expect(
      renderSchedule(live({ schedule: [plan], scheduleGoodByJob: { 'PLAN-COLOUR': 190 } }), now),
    ).toContain('is-green');
    expect(
      renderSchedule(live({ schedule: [plan], scheduleGoodByJob: { 'PLAN-COLOUR': 170 } }), now),
    ).toContain('is-orange');
    expect(
      renderSchedule(live({ schedule: [plan], scheduleGoodByJob: { 'PLAN-COLOUR': 100 } }), now),
    ).toContain('is-red');
  });

  it('keeps a not-yet-started Schedule bar neutral instead of falsely red', () => {
    const plan = order({
      jobNumber: 'FUTURE',
      machineCode: '1300T',
      plannedStart: '2026-07-01T12:00:00',
      plannedEnd: '2026-07-01T14:00:00',
      qtyPerHr: 1 / 50,
    });
    expect(
      renderSchedule(live({ schedule: [plan] }), new Date('2026-07-01T11:00:00')),
    ).toContain('is-future');
  });

  it('shows full breakdown taxonomy detail when hovering a B block', () => {
    const breakdown = rec({
      machineCode: '1300T',
      shiftId: '2026-07-01-Day',
      jobNumber: 'J-BD',
      slotIndex: 0,
      statusCode: 'B',
      bdIssue: 'MEC-11',
      mangoTicket: 'MAN-77',
    });
    const html = renderCard(
      live({
        jobNumber: 'J-BD',
        idle: false,
        timeline: 'B' + '·'.repeat(15),
        records: [breakdown],
      }),
    );
    expect(html).toContain('Breakdown code: MEC-11');
    expect(html).toContain('Category: Mechanical');
    expect(html).toContain('Cause: Abnormal noise / vibration');
    expect(html).toContain('Likely owner: Operator → Maintenance');
    expect(html).toContain('Note / Mango ticket: MAN-77');
  });
});
