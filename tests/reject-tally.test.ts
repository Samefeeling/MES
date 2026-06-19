import { describe, it, expect } from 'vitest';
import { tallyTupleRejects } from '../src/ui/kpi';
import { rec } from './helpers';

// Regression for the "Unspecified" bucket bug: the SP read stamps the
// whole-shift Reject total onto slot 0's rejectCount AND distributes the
// per-code events to their actual slot. A naive per-record tally that
// falls back to slot 0's rejectCount when its rejects JSON is '{}' would
// double-count the same scrap and dump the duplicate under "Unspecified".

describe('tallyTupleRejects (KPI Pareto)', () => {
  it('uses per-code data only when ANY slot in the tuple has it', () => {
    // Real SP shape: slot 0 carries the aggregate Reject=8 with rejects='{}';
    // slots 1 and 3 carry the per-code maps that already sum to 8.
    const group = [
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        rejectCount: 8,
        rejects: '{}', // SP per-rejects-event distribution wrote nothing here
      }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R', rejects: '{"D01":5}' }),
      rec({ jobNumber: 'J1', slotIndex: 3, statusCode: 'R', rejects: '{"D02":3}' }),
    ];
    const into = new Map<string, number>();
    tallyTupleRejects(group, into);
    expect(into.get('D01')).toBe(5);
    expect(into.get('D02')).toBe(3);
    expect(into.get('—')).toBeUndefined(); // no phantom "Unspecified"
    const total = Array.from(into.values()).reduce((a, v) => a + v, 0);
    expect(total).toBe(8); // matches the displayed Reject — no double count
  });

  it('merges duplicate codes across slots into one bucket', () => {
    const group = [
      rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R', rejects: '{}' }),
      rec({ jobNumber: 'J1', slotIndex: 1, statusCode: 'R', rejects: '{"D01":2}' }),
      rec({ jobNumber: 'J1', slotIndex: 5, statusCode: 'R', rejects: '{"D01":3}' }),
    ];
    const into = new Map<string, number>();
    tallyTupleRejects(group, into);
    expect(into.get('D01')).toBe(5);
    expect(into.size).toBe(1);
  });

  it('falls back to slot 0 rejectCount only when NO slot has per-code data', () => {
    // Pre-Pareto-era row or a partial-data tuple: total exists, no map.
    const group = [
      rec({
        jobNumber: 'J1',
        slotIndex: 0,
        statusCode: 'R',
        rejectCount: 4,
        rejects: '{}',
      }),
    ];
    const into = new Map<string, number>();
    tallyTupleRejects(group, into);
    expect(into.get('—')).toBe(4);
  });

  it('contributes nothing for a clean tuple', () => {
    const group = [rec({ jobNumber: 'J1', slotIndex: 0, statusCode: 'R' })];
    const into = new Map<string, number>();
    tallyTupleRejects(group, into);
    expect(into.size).toBe(0);
  });
});
