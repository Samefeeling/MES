import { describe, expect, it } from 'vitest';
import {
  PLANNING_KEYS,
  SHIFT_RECORD_KEYS,
  joinPlan,
  mergeShiftRecords,
  planningFingerprint,
  planningOf,
  shiftRecordsOf,
} from '@/persistence/planParts';
import { JobId } from '@/domain/ids';
import type { PersistedPlan } from '@/persistence/PlanRepository';
import type { ActualStartRecord, ProductionEntry } from '@/store/planStore';

const plan = (over: Partial<PersistedPlan> = {}): PersistedPlan => ({
  id: 'current',
  name: 'Working plan',
  savedAt: '2026-09-17T00:00:00.000Z',
  ...over,
  containers: over.containers ?? { TBP: [JobId('J1')], __pool__: [JobId('J2')] },
  assembly: {
    orderCrewAssignments: { J1: [] },
    orderStarts: { J1: '2026-09-17' },
    lineOrder: ['TBP'],
    production: { J1: [] },
    progress: { J1: [{ date: '2026-09-17', qty: 4 }] },
    lastSeen: { J1: '2026-09-17' },
    workerOnLeave: { W1: ['2026-09-17'] },
    ...over.assembly,
  },
});

describe('the two halves of a stored plan', () => {
  it('sorts every stored key into exactly one of them', () => {
    const both = [...PLANNING_KEYS, ...SHIFT_RECORD_KEYS];
    expect(new Set(both).size).toBe(both.length);
  });

  it('gives Save the planner’s opinion and nothing the floor recorded', () => {
    const part = planningOf(plan());
    expect(part.containers).toEqual({ TBP: [JobId('J1')], __pool__: [JobId('J2')] });
    expect(part.assembly.orderStarts).toEqual({ J1: '2026-09-17' });
    expect(part.assembly).not.toHaveProperty('production');
    expect(part.assembly).not.toHaveProperty('progress');
  });

  it('gives the shift write what happened and none of the planning', () => {
    const part = shiftRecordsOf(plan());
    expect(part.assembly.production).toEqual({ J1: [] });
    expect(part.assembly.lastSeen).toEqual({ J1: '2026-09-17' });
    expect(part.assembly).not.toHaveProperty('orderStarts');
    expect(part.assembly).not.toHaveProperty('orderCrewAssignments');
  });

  /*
   * Who rang in sick is not an opinion two supervisors can differ on, and
   * losing it because whoever took the call walked away without pressing Save
   * would leave the schedule planning hours nobody is going to work.
   */
  it('writes an absence straight through, without waiting for Save', () => {
    expect(shiftRecordsOf(plan()).assembly.workerOnLeave).toEqual({
      W1: ['2026-09-17'],
    });
    expect(planningOf(plan()).assembly).not.toHaveProperty('workerOnLeave');
  });

  it('does not make the board dirty when somebody is marked off', () => {
    // A draft is the planner's unpublished opinion. Marking Bob off is not
    // one, so it must not put the Save button up or arm the unsaved banner.
    const before = planningFingerprint(planningOf(plan()));
    const after = planningFingerprint(
      planningOf(plan({ assembly: { workerOnLeave: { W2: ['2026-09-18'] } } })),
    );
    expect(after).toBe(before);
  });

  it('leaves a key the stored plan never had absent, so it is not blanked', () => {
    // planStore.setAssemblyPlan reads a missing key as "keep what is in the
    // store" — which is how a plan written by an older build is migrated.
    const part = planningOf({
      id: 'current',
      name: 'Working plan',
      savedAt: '2026-09-17T00:00:00.000Z',
      containers: {},
      assembly: { orderStarts: {} },
    });
    expect('virtualLines' in part.assembly).toBe(false);
    expect('lineOrder' in part.assembly).toBe(false);
  });

  it('puts a booked shift onto somebody else’s newer planning', () => {
    // The whole point of the split: the operator books a shift, and the
    // planning underneath it stays whoever pressed Save last.
    const theirs = planningOf(plan({ containers: { ASSY: [JobId('J1')] } }));
    const mine = shiftRecordsOf(plan({ assembly: { production: { J1: [] }, progress: { J1: [{ date: '2026-09-17', qty: 9 }] } } }));
    const joined = joinPlan('current', 'Working plan', theirs, mine, 'now');
    expect(joined.containers).toEqual({ ASSY: [JobId('J1')] });
    expect(joined.assembly?.progress).toEqual({ J1: [{ date: '2026-09-17', qty: 9 }] });
    expect(joined.savedAt).toBe('now');
  });
});

describe('planningFingerprint', () => {
  it('reads the same plan the same way whatever order its keys came in', () => {
    const a = planningOf(plan({ containers: { TBP: [JobId('J1')], __pool__: [JobId('J2')] } }));
    const b = planningOf(plan({ containers: { __pool__: [JobId('J2')], TBP: [JobId('J1')] } }));
    expect(planningFingerprint(a)).toBe(planningFingerprint(b));
  });

  it('notices an order moved to another line', () => {
    const before = planningOf(plan());
    const after = planningOf(plan({ containers: { TBP: [], __pool__: [JobId('J2'), JobId('J1')] } }));
    expect(planningFingerprint(before)).not.toBe(planningFingerprint(after));
  });

  it('ignores a shift booking — that is not something to save', () => {
    const before = planningOf(plan());
    const after = planningOf(
      plan({ assembly: { production: { J1: [{ date: '2026-09-17' } as never] } } }),
    );
    expect(planningFingerprint(before)).toBe(planningFingerprint(after));
  });
});

describe('mergeShiftRecords — one board cannot write another board\'s bookings away', () => {
  const entry = (date: string, complete: number): ProductionEntry =>
    ({ date, complete, reject: 0, rework: 0, shiftOutput: complete, paused: false, jobCompleted: false, notes: '' }) as ProductionEntry;
  const start = (at: string): ActualStartRecord =>
    ({ startedAt: at, operatorIds: [], operatorNames: [] }) as unknown as ActualStartRecord;

  it('keeps a booking only the stored plan holds, for an order this board still has', () => {
    // Board B opened at six and was never refreshed; A booked J2 at nine.
    const local = { assembly: { production: { J1: [entry('2026-09-22', 5)] }, orderActualStarts: {}, lastSeen: { J1: '2026-09-22', J2: '2026-09-22' } } };
    const stored = { assembly: { production: { J2: [entry('2026-09-22', 7)] }, orderActualStarts: { J2: start('2026-09-22T07:40:00') } } };
    const merged = mergeShiftRecords(local, stored).assembly;
    expect(merged.production?.J2).toEqual([entry('2026-09-22', 7)]);
    expect(merged.production?.J1).toEqual([entry('2026-09-22', 5)]);
    expect(merged.orderActualStarts?.J2).toEqual(start('2026-09-22T07:40:00'));
  });

  it('lets this board\'s own word win on a day it holds — a reopen included', () => {
    const local = { assembly: { production: { J1: [{ ...entry('2026-09-22', 5), jobCompleted: false }] }, lastSeen: { J1: '2026-09-22' } } };
    const stored = { assembly: { production: { J1: [{ ...entry('2026-09-22', 5), jobCompleted: true }, entry('2026-09-21', 3)] } } };
    const merged = mergeShiftRecords(local, stored).assembly.production!.J1;
    expect(merged.map((e: { date: string }) => e.date)).toEqual(['2026-09-21', '2026-09-22']);
    expect(merged.find((e: { date: string }) => e.date === '2026-09-22')).toMatchObject({ jobCompleted: false });
  });

  it('lets go of an order this board\'s retention has dropped', () => {
    const local = { assembly: { production: {}, orderActualStarts: {}, lastSeen: {} } };
    const stored = { assembly: { production: { OLD: [entry('2026-06-01', 1)] }, orderActualStarts: { OLD: start('2026-06-01T07:00:00') } } };
    const merged = mergeShiftRecords(local, stored).assembly;
    expect(merged.production).toEqual({});
    expect(merged.orderActualStarts).toEqual({});
  });

  it('never merges records that can be taken back', () => {
    const local = { assembly: { workerOnLeave: {}, lastSeen: {} } };
    const stored = { assembly: { workerOnLeave: { W1: ['2026-09-22'] } } };
    expect(mergeShiftRecords(local, stored).assembly.workerOnLeave).toEqual({});
  });
});
