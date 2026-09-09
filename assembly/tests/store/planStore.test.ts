import { beforeEach, describe, expect, it } from 'vitest';
import { JobId } from '@/domain/ids';
import { usePlanStore, type ProductionEntry } from '@/store/planStore';
import type { CrewAssignment } from '@/domain/assembly';

/** Whole-order allocations — the plain case, with no day windows. */
const crewOf = (
  byJob: Record<string, string[]>,
): Record<string, CrewAssignment[]> =>
  Object.fromEntries(
    Object.entries(byJob).map(([jobId, ids]) => [
      jobId,
      ids.map((workerId) => ({ workerId, fromDay: null, toDayExclusive: null })),
    ]),
  );

const entry = (complete: number): ProductionEntry => ({
  date: '2026-08-31',
  complete,
  reject: 1,
  rework: 2,
  shiftOutput: 3,
  paused: true,
  pauseReason: 'material-shortage',
  jobCompleted: false,
  notes: 'Foam awaiting delivery',
});

describe('ASSY_Production bookings', () => {
  beforeEach(() => {
    usePlanStore.setState({
      production: {},
      progress: {},
      progressBaselines: {},
      workerLines: {},
      orderCrewAssignments: {},
      orderDoubleBooked: {},
      orderActualStarts: {},
    });
  });

  it('saves progress and releases crew atomically only on completion', () => {
    const job = JobId('ASSY-102');
    usePlanStore.setState({
      orderCrewAssignments: {
        [String(job)]: [
          { workerId: 'W01', fromDay: null, toDayExclusive: null },
          {
            workerId: 'W02',
            fromDay: '2026-08-31',
            toDayExclusive: '2026-09-02',
          },
        ],
      },
      orderDoubleBooked: { [String(job)]: ['W02'] },
    });
    usePlanStore.getState().startOrder(job, {
      startedAt: '2026-08-31T00:00:00.000Z',
      overrideReason: null,
      operatorIds: ['W01', 'W02'],
      operatorNames: ['Lee', 'Gate'],
    });

    usePlanStore.getState().saveProductionEntry(
      job,
      {
        ...entry(7),
        paused: false,
        pauseReason: null,
        jobCompleted: true,
        operatorIds: ['W01', 'W02'],
        operatorNames: ['Lee', 'Gate'],
        completedAt: '2026-08-31T05:30:00.000Z',
      },
      { remainingQty: 7, completedQty: 93 },
    );

    const state = usePlanStore.getState();
    expect(state.progress[String(job)]).toEqual([{ date: '2026-08-31', qty: 7 }]);
    expect(state.orderCrewAssignments[String(job)]).toBeUndefined();
    expect(state.orderCrewAssignments[String(job)]).toBeUndefined();
    expect(state.orderDoubleBooked[String(job)]).toBeUndefined();
    expect(state.production[String(job)][0].operatorIds).toEqual(['W01', 'W02']);
  });

  it('keeps each person\u2019s own days on the one record of the crew', () => {
    // This used to prove that a bounded allocation stayed out of the
    // window-less mirror the store kept alongside it. There is no mirror now,
    // so what is worth proving is that one record carries both shapes at once.
    const job = JobId('SFM507569');
    usePlanStore.getState().assignWorkerWindow(
      job,
      'Bill',
      '2026-09-02',
      '2026-09-04',
    );
    usePlanStore.getState().assignWorker(job, 'Jones');

    expect(usePlanStore.getState().orderCrewAssignments[String(job)]).toEqual([
      {
        workerId: 'Bill',
        fromDay: '2026-09-02',
        toDayExclusive: '2026-09-04',
      },
      { workerId: 'Jones', fromDay: null, toDayExclusive: null },
    ]);
  });

  it('keeps the crew allocated after a normal save', () => {
    const job = JobId('ASSY-103');
    usePlanStore.setState({
      orderCrewAssignments: crewOf({ [String(job)]: ['W01'] }),
    });
    usePlanStore.getState().startOrder(job, {
      startedAt: '2026-08-31T00:00:00.000Z',
      overrideReason: null,
      operatorIds: ['W01'],
      operatorNames: ['Lee'],
    });
    usePlanStore.getState().saveProductionEntry(
      job,
      entry(2),
      { remainingQty: 10, completedQty: 0 },
    );
    expect(
      usePlanStore.getState().orderCrewAssignments[String(job)],
    ).toEqual(crewOf({ x: ['W01'] }).x);
  });

  it('records the first actual start once and preserves its crew snapshot', () => {
    const job = JobId('ASSY-104');
    const first = {
      startedAt: '2026-08-31T00:00:00.000Z',
      overrideReason: null,
      operatorIds: ['W01'],
      operatorNames: ['Lee'],
    };
    usePlanStore.getState().startOrder(job, first);
    usePlanStore.getState().startOrder(job, { ...first, startedAt: '2026-09-01T00:00:00.000Z' });
    expect(usePlanStore.getState().orderActualStarts[String(job)]).toEqual(first);
  });

  it('upserts one production record per job and day', () => {
    const job = JobId('ASSY-101');
    usePlanStore.getState().recordProduction(job, entry(4));
    usePlanStore.getState().recordProduction(job, entry(7));

    expect(usePlanStore.getState().production[String(job)]).toEqual([entry(7)]);
  });
});

describe('operator production-line placement', () => {
  beforeEach(() => {
    usePlanStore.setState({
      containers: {
        UPL: [JobId('UPL-1')],
        ASSY: [JobId('ASSY-1')],
        TABLE: [JobId('TABLE-1')],
      },
      workerLines: {},
      orderCrewAssignments: crewOf({
        'UPL-1': ['Bill'],
        'ASSY-1': ['Bill'],
      }),
      orderActualStarts: {},
      orderDoubleBooked: { 'UPL-1': ['Bill'] },
    });
  });

  it('moves the roster and removes only off-line unstarted allocations', () => {
    usePlanStore.getState().moveWorkerToLine('Bill', 'ASSY');
    const state = usePlanStore.getState();
    expect(state.workerLines.Bill).toBe('ASSY');
    expect(state.orderCrewAssignments['UPL-1']).toEqual([]);
    expect(state.orderCrewAssignments['ASSY-1']).toEqual(crewOf({ x: ['Bill'] }).x);
    expect(state.orderDoubleBooked['UPL-1']).toBeUndefined();
  });

  it('moves a started crew without changing the recorded start snapshot', () => {
    usePlanStore.setState({
      orderActualStarts: {
        'UPL-1': {
          startedAt: '2026-09-03T07:00:00.000Z',
          overrideReason: null,
          operatorIds: ['Bill'],
          operatorNames: ['Bill'],
        },
      },
    });
    usePlanStore.getState().moveWorkerToLine('Bill', 'ASSY');
    expect(usePlanStore.getState().workerLines.Bill).toBe('ASSY');
    expect(usePlanStore.getState().orderActualStarts['UPL-1'].operatorIds).toEqual(['Bill']);
    expect(
      usePlanStore.getState().orderCrewAssignments['UPL-1'],
    ).toEqual([]);
  });
});

describe('weekend overtime approvals', () => {
  const job = JobId('ASSY-202');

  beforeEach(() => {
    usePlanStore.setState({ orderOvertime: {} });
  });

  it('is off until the supervisor approves it, and clears again', () => {
    const state = () => usePlanStore.getState();
    expect(state().orderOvertime[String(job)]).toBeUndefined();

    state().setOvertime(job, true);
    expect(state().orderOvertime[String(job)]).toBe(true);

    // Withdrawn approval leaves no trace, so nothing can read as "explicitly
    // not allowed" and be mistaken for an approval later.
    state().setOvertime(job, false);
    expect(String(job) in state().orderOvertime).toBe(false);
  });
});

/**
 * `Planning1.csv` is re-exported twice a day. Orders leave it when they finish
 * — and, from time to time, when they should not have: the BAQ was still
 * running, a filter changed, a row lost its part number on the way out.
 * Reconciling has to tell those apart, and it can only do so over time.
 */
describe('surviving a twice-daily export', () => {
  const centres = [
    { id: 'UPL', name: 'Upholstery', sortIndex: 1 },
    { id: 'ASSY', name: 'Assembly', sortIndex: 2 },
  ] as unknown as Parameters<
    ReturnType<typeof usePlanStore.getState>['reconcile']
  >[0];

  const job = (id: string, line: string) =>
    ({
      id: JobId(id),
      department: 'assembly',
      line,
      preferredMachine: null,
      assignedWorkers: [],
    }) as unknown as Parameters<
      ReturnType<typeof usePlanStore.getState>['reconcile']
    >[1][number];

  const planned = [job('A', 'UPL'), job('B', 'UPL'), job('C', 'ASSY')];
  const day = (iso: string) => new Date(`${iso}T09:00:00`);

  beforeEach(() => {
    usePlanStore.setState({
      containers: {},
      orderCrewAssignments: {},
      orderStarts: {},
      orderActualStarts: {},
      orderOvertime: {},
      orderDoubleBooked: {},
      progress: {},
      progressBaselines: {},
      production: {},
      lastSeen: {},
    });
    usePlanStore.getState().reconcile(centres, planned, day('2026-09-08'));
    usePlanStore.setState({
      orderCrewAssignments: crewOf({ B: ['W01', 'W02'] }),
      orderStarts: { B: '2026-09-14' },
      orderOvertime: { B: true },
    });
  });

  it('holds an absent order’s crew, start and place in the line', () => {
    const state = () => usePlanStore.getState();
    // B is missing from the next export — a partial file, not a finished job.
    state().reconcile(
      centres,
      [planned[0], planned[2]],
      day('2026-09-08'),
    );
    expect(state().orderCrewAssignments.B).toHaveLength(2);
    expect(state().orderStarts.B).toBe('2026-09-14');
    expect(state().orderOvertime.B).toBe(true);
    // And in its own place on its own line, so the row does not come back at
    // the bottom of the pool when the export is fixed.
    expect(state().containers.UPL.map(String)).toEqual(['A', 'B']);

    // The export is fixed that afternoon and nothing was lost.
    state().reconcile(centres, planned, day('2026-09-08'));
    expect(state().containers.UPL.map(String)).toEqual(['A', 'B']);
    expect(state().orderStarts.B).toBe('2026-09-14');
  });

  it('lets go of an order once it has been gone a fortnight', () => {
    const state = () => usePlanStore.getState();
    const without = [planned[0], planned[2]];
    state().reconcile(centres, without, day('2026-09-21'));
    expect(state().orderStarts.B).toBe('2026-09-14');
    expect(state().containers.UPL.map(String)).toEqual(['A', 'B']);

    // Fifteen days after it was last exported.
    state().reconcile(centres, without, day('2026-09-23'));
    expect('B' in state().orderStarts).toBe(false);
    expect('B' in state().orderCrewAssignments).toBe(false);
    expect(state().containers.UPL.map(String)).toEqual(['A']);
    expect('B' in state().lastSeen).toBe(false);
  });

  it('files a genuinely new order onto its own line and keeps the rest', () => {
    const state = () => usePlanStore.getState();
    state().reconcile(
      centres,
      [...planned, job('D', 'UPL')],
      day('2026-09-08'),
    );
    expect(state().containers.UPL.map(String)).toEqual(['A', 'B', 'D']);
    expect(state().orderStarts.B).toBe('2026-09-14');
  });

  it('gives a plan saved before absences were recorded the same fortnight', () => {
    const state = () => usePlanStore.getState();
    usePlanStore.setState({ lastSeen: {} });
    state().reconcile(centres, [planned[0]], day('2026-09-08'));
    expect(state().orderStarts.B).toBe('2026-09-14');
    expect(state().lastSeen.B).toBe('2026-09-08');
  });
});
