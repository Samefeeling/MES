import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '@/store/uiStore';

describe('single employee picker', () => {
  beforeEach(() => {
    useUiStore.setState({
      crewPickerJobId: null,
      selectedJobId: null,
      selectedAt: null,
    });
  });

  it('replaces the previous order picker when another is opened', () => {
    useUiStore.getState().setCrewPicker('JOB-1');
    useUiStore.getState().setCrewPicker('JOB-2');
    expect(useUiStore.getState().crewPickerJobId).toBe('JOB-2');
  });

  it('closes the employee picker when an order block is selected', () => {
    useUiStore.getState().setCrewPicker('JOB-1');
    useUiStore.getState().select('JOB-2', { x: 10, y: 20 });
    expect(useUiStore.getState().crewPickerJobId).toBeNull();
    expect(useUiStore.getState().selectedJobId).toBe('JOB-2');
  });
});

describe('board display defaults', () => {
  it('opens on every order with weekends hidden and starts ascending', () => {
    const state = useUiStore.getState();
    // Every order. A board that opens already hiding most of its rows, with
    // nothing on screen saying so, reads as a board that has lost them.
    expect(state.orderWindow).toBe('all');
    expect(state.showWeekends).toBe(false);
    expect(state.orderSort).toEqual({ key: 'start', direction: 'asc' });
    state.toggleWeekends();
    expect(useUiStore.getState().showWeekends).toBe(true);
    useUiStore.getState().toggleWeekends();
  });

  it('restores earliest-start ordering when Refresh resets a custom sort', () => {
    useUiStore.getState().changeOrderSort('due');
    useUiStore.getState().changeOrderSort('due');
    expect(useUiStore.getState().orderSort).toEqual({ key: 'due', direction: 'desc' });
    useUiStore.getState().resetOrderSort();
    expect(useUiStore.getState().orderSort).toEqual({ key: 'start', direction: 'asc' });
    const snapshot = useUiStore.getState().orderSort;
    useUiStore.getState().resetOrderSort();
    expect(useUiStore.getState().orderSort).not.toBe(snapshot);
  });

  it('selects a day without changing the order snapshot and clears back to the window it interrupted', () => {
    const sort = useUiStore.getState().orderSort;
    useUiStore.getState().setOrderDay('2026-09-04');
    expect(useUiStore.getState().orderWindow).toBe('day');
    expect(useUiStore.getState().orderDay).toBe('2026-09-04');
    expect(useUiStore.getState().orderSort).toBe(sort);
    useUiStore.getState().setOrderDay(null);
    expect(useUiStore.getState().orderWindow).toBe('all');
    expect(useUiStore.getState().orderDay).toBeNull();
  });
});

/**
 * Marking a run of orders with Ctrl to shift them together. Kept apart from
 * the single selection that opens the detail: they answer different questions.
 */
describe('the marked set', () => {
  beforeEach(() => {
    useUiStore.setState({ marked: [], selectedJobId: null });
  });

  it('starts empty and ticks orders on and off', () => {
    expect(useUiStore.getInitialState().marked).toEqual([]);
    useUiStore.getState().toggleMark('ASM8018');
    useUiStore.getState().toggleMark('ASM8019');
    expect(useUiStore.getState().marked).toEqual(['ASM8018', 'ASM8019']);
    useUiStore.getState().toggleMark('ASM8018');
    expect(useUiStore.getState().marked).toEqual(['ASM8019']);
  });

  it('keeps the open order and the marked set apart', () => {
    useUiStore.getState().toggleMark('ASM8018');
    useUiStore.getState().select('ASM8021', { x: 1, y: 2 });
    // Opening one to read it does not tick it, nor let go of what is ticked.
    expect(useUiStore.getState().marked).toEqual(['ASM8018']);
    expect(useUiStore.getState().selectedJobId).toBe('ASM8021');
  });

  it('lets go of the whole set at once', () => {
    useUiStore.getState().toggleMark('A');
    useUiStore.getState().toggleMark('B');
    useUiStore.getState().clearMarks();
    expect(useUiStore.getState().marked).toEqual([]);
  });
});

/**
 * Escape used to be five listeners that all fired at once, so closing the
 * order detail also let go of a run of orders somebody had marked. One press
 * now closes one layer, worst interruption first.
 */
describe('what Escape closes', () => {
  const everythingOpen = () =>
    useUiStore.setState({
      overtimeRequest: {
        jobId: 'ASM8001',
        isoDay: '2026-09-12',
        nextWorkingIsoDay: '2026-09-14',
      },
      clashRequest: {
        jobId: 'ASM8002',
        workerId: 'W01',
        workerName: 'Mary',
        withJobIds: ['ASM8003'],
        withLabels: ['ASM8003 · UPL · 4 Sep – 8 Sep'],
      },
      crewPickerJobId: 'ASM8004',
      workerLoadId: 'W02',
      selectedJobId: 'ASM8005',
      marked: ['ASM8006', 'ASM8007'],
    });

  const dismiss = () => useUiStore.getState().dismissTop();
  const state = () => useUiStore.getState();

  beforeEach(everythingOpen);

  it('takes one layer at a time, in order', () => {
    expect(dismiss()).toBe(true);
    expect(state().overtimeRequest).toBeNull();
    // Everything under it is untouched.
    expect(state().clashRequest).not.toBeNull();
    expect(state().marked).toEqual(['ASM8006', 'ASM8007']);

    expect(dismiss()).toBe(true);
    expect(state().clashRequest).toBeNull();
    expect(dismiss()).toBe(true);
    expect(state().crewPickerJobId).toBeNull();
    expect(dismiss()).toBe(true);
    expect(state().workerLoadId).toBeNull();

    // The detail goes before the marked set, which is the pairing that used
    // to cost somebody their selection.
    expect(dismiss()).toBe(true);
    expect(state().selectedJobId).toBeNull();
    expect(state().marked).toEqual(['ASM8006', 'ASM8007']);

    expect(dismiss()).toBe(true);
    expect(state().marked).toEqual([]);
  });

  it('says when there was nothing to close', () => {
    while (dismiss()) {
      /* down to a bare board */
    }
    expect(dismiss()).toBe(false);
  });

  it('closes the detail without letting go of the set', () => {
    useUiStore.setState({
      overtimeRequest: null,
      clashRequest: null,
      crewPickerJobId: null,
      workerLoadId: null,
    });
    expect(dismiss()).toBe(true);
    expect(state().selectedJobId).toBeNull();
    expect(state().marked).toEqual(['ASM8006', 'ASM8007']);
  });
});

describe('the two popups over the board', () => {
  it('never has both open at once', () => {
    useUiStore.getState().setCrewPicker('ASM8001');
    useUiStore.getState().setWorkerLoad('W01');
    expect(useUiStore.getState().crewPickerJobId).toBeNull();
    expect(useUiStore.getState().workerLoadId).toBe('W01');

    useUiStore.getState().setCrewPicker('ASM8002');
    expect(useUiStore.getState().workerLoadId).toBeNull();

    // Opening an order's detail closes whichever was showing.
    useUiStore.getState().setWorkerLoad('W02');
    useUiStore.getState().select('ASM8003', { x: 0, y: 0 });
    expect(useUiStore.getState().workerLoadId).toBeNull();
    expect(useUiStore.getState().crewPickerJobId).toBeNull();
  });
});

/**
 * Clearing a filter should undo it, not choose something else. Reading every
 * order, checking one day and clearing the date used to drop you into the
 * five-day window, which is neither where you were nor what you asked for.
 */
describe('the date filter and the window behind it', () => {
  beforeEach(() => {
    useUiStore.setState({
      orderWindow: 'next-five',
      orderDay: null,
      windowBeforeDay: 'next-five',
    });
  });

  const state = () => useUiStore.getState();

  it('goes back to the window the day filter interrupted', () => {
    state().setOrderWindow('all');
    state().setOrderDay('2026-09-14');
    expect(state().orderWindow).toBe('day');
    state().setOrderDay(null);
    expect(state().orderWindow).toBe('all');
    expect(state().orderDay).toBeNull();
  });

  it('still returns to the five-day window when that is where it came from', () => {
    state().setOrderDay('2026-09-14');
    state().setOrderDay(null);
    expect(state().orderWindow).toBe('next-five');
  });

  it('does not lose the window when the day is changed twice', () => {
    state().setOrderWindow('all');
    state().setOrderDay('2026-09-14');
    state().setOrderDay('2026-09-15');
    expect(state().orderWindow).toBe('day');
    state().setOrderDay(null);
    expect(state().orderWindow).toBe('all');
  });

  it('clears the day when a window is picked instead', () => {
    state().setOrderDay('2026-09-14');
    state().setOrderWindow('all');
    expect(state().orderDay).toBeNull();
    expect(state().orderWindow).toBe('all');
  });
});
