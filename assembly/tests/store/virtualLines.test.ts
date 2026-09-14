/**
 * Lines the supervisor opens on the floor.
 *
 * The plant is built as eight lines; what it is *running* this week is a
 * different question — a second table bench for a rush, a bay set up for one
 * big order, a crew split off to clear a backlog. Those had nowhere to go, so
 * the work sat on a line it was not happening on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  isVirtualLine,
  readLineKey,
  virtualLineDef,
  virtualLineKey,
  LINES,
} from '@/domain/assembly';
import { usePlanStore, POOL_ID, virtualWorkCenters } from '@/store/planStore';
import { assemblyWorkCenters } from '@/data/excel/parsers/machine.parser';
import { manualJob } from '@/domain/manualOrder';
import { JobId, WorkCenterId } from '@/domain/ids';

const reset = () =>
  usePlanStore.setState({
    virtualLines: [],
    containers: {},
    manualOrders: {},
    workerLines: {},
    lastSeen: {},
    orderStarts: {},
    orderCrewAssignments: {},
    production: {},
    progress: {},
    progressBaselines: {},
    orderActualStarts: {},
  });

describe('naming an added line', () => {
  it('makes a key that is readable in a saved plan and still a line key', () => {
    expect(virtualLineKey('Table 2')).toBe('VL_TABLE_2');
    expect(virtualLineKey('  rush bay  ')).toBe('VL_RUSH_BAY');
    expect(isVirtualLine(virtualLineKey('Table 2'))).toBe(true);
    // Which means everything that reads a line key reads this one too.
    expect(readLineKey('VL_TABLE_2')).toBe('VL_TABLE_2');
  });

  it('never produces an empty key, whatever it is given', () => {
    expect(virtualLineKey('!!!')).toBe('VL_LINE');
  });

  it('runs every order type — nothing has said yet what belongs there', () => {
    const def = virtualLineDef({ key: 'VL_BAY', name: 'Bay' }, 0);
    expect(def.schedulable).toBe(true);
    expect(def.types).toHaveLength(3);
    // After the eight, so the floor's own order is undisturbed.
    expect(def.sortIndex).toBeGreaterThanOrEqual(LINES.length);
  });
});

describe('opening and closing one', () => {
  beforeEach(reset);
  const state = () => usePlanStore.getState();

  it('opens a line with a container of its own', () => {
    const key = state().addVirtualLine('Table 2');
    expect(key).toBe('VL_TABLE_2');
    expect(state().virtualLines).toEqual([{ key: 'VL_TABLE_2', name: 'Table 2' }]);
    expect(state().containers.VL_TABLE_2).toEqual([]);
  });

  it('refuses a blank name, and a second line of the same name', () => {
    expect(state().addVirtualLine('   ')).toBeNull();
    state().addVirtualLine('Rush bay');
    // Two lines with one key would share a container, so the second would
    // silently take the first's orders.
    expect(state().addVirtualLine('rush  BAY')).toBeNull();
    expect(state().virtualLines).toHaveLength(1);
  });

  it('refuses to shadow one of the eight', () => {
    expect(state().addVirtualLine('UPL-CUT')).toBeNull();
    expect(state().addVirtualLine('ASM')).toBeNull();
    expect(state().virtualLines).toEqual([]);
  });

  it('gives its orders back to the pool when it closes, rather than guessing', () => {
    state().addVirtualLine('Rush bay');
    usePlanStore.setState({
      containers: { [POOL_ID]: [], VL_RUSH_BAY: [JobId('ASM1'), JobId('ASM2')] },
      workerLines: { W1: 'VL_RUSH_BAY', W2: 'ASSY' },
    });
    state().removeVirtualLine('VL_RUSH_BAY');
    expect(state().virtualLines).toEqual([]);
    expect(state().containers.VL_RUSH_BAY).toBeUndefined();
    // Closing a bench is not a decision about where its work belongs.
    expect(state().containers[POOL_ID]).toEqual(['ASM1', 'ASM2']);
    // Anyone standing on it loses only that placement.
    expect(state().workerLines).toEqual({ W2: 'ASSY' });
  });
});

describe('surviving a refresh', () => {
  beforeEach(reset);
  const state = () => usePlanStore.getState();

  /*
   * Reconciliation builds its containers from the work centres it is handed,
   * and those come from the export — which has never heard of a line somebody
   * opened this morning. Without the plan supplying them, every order on an
   * added line would be tipped into the pool on the next refresh.
   */
  it('keeps the orders on an added line when a new export lands', () => {
    state().addVirtualLine('Rush bay');
    const job = {
      ...manualJob({
        id: 'FG-1',
        description: 'Rush work',
        supportDepartment: 'Warehouse',
        day: '2026-09-10',
        plannedHours: 7.5,
      }),
      id: JobId('ERP-9'),
      manual: undefined,
      line: WorkCenterId('ASSY'),
    };
    usePlanStore.setState({
      containers: { [POOL_ID]: [], VL_RUSH_BAY: [job.id] },
      orderStarts: { 'ERP-9': '2026-09-10' },
    });

    state().reconcile(assemblyWorkCenters(), [job]);

    expect(state().containers.VL_RUSH_BAY).toEqual(['ERP-9']);
    expect(state().containers[POOL_ID]).toEqual([]);
    expect(state().orderStarts['ERP-9']).toBe('2026-09-10');
  });

  it('tips a line’s orders into the pool once the line itself is gone', () => {
    // No `addVirtualLine`, so the plan does not hold this line: an order
    // filed against it has nowhere to be.
    usePlanStore.setState({ containers: { [POOL_ID]: [], VL_OLD: [JobId('ERP-9')] } });
    const job = {
      ...manualJob({ id: 'x', description: 'x', supportDepartment: 'x', day: '2026-09-10', plannedHours: 1 }),
      id: JobId('ERP-9'),
      manual: undefined,
      line: WorkCenterId('ASSY'),
    };
    state().reconcile(assemblyWorkCenters(), [job]);
    expect(state().containers[POOL_ID]).toEqual(['ERP-9']);
  });

  it('describes its lines as work centres the board can build containers from', () => {
    const centres = virtualWorkCenters([{ key: 'VL_BAY', name: 'Bay' }]);
    expect(centres).toHaveLength(1);
    expect(String(centres[0].id)).toBe('VL_BAY');
    expect(centres[0].department).toBe('assembly');
  });
});
