import { describe, expect, it } from 'vitest';
import {
  CREW_ROLL_TYPE,
  crewRollDrop,
  crewRollDropId,
} from '@/features/assembly/CrewRolls';

const worker = { type: 'worker', workerId: 'W1' };
const free = { type: CREW_ROLL_TYPE, roll: 'free' };
const onLeave = { type: CREW_ROLL_TYPE, roll: 'onLeave' };

describe('dragging a name into Free or On Leave', () => {
  it('marks somebody off when they land in On Leave', () => {
    expect(crewRollDrop(worker, onLeave)).toEqual({
      workerId: 'W1',
      onLeave: true,
    });
  });

  it('puts them back in when they land in Free', () => {
    expect(crewRollDrop(worker, free)).toEqual({
      workerId: 'W1',
      onLeave: false,
    });
  });

  it('ignores anything that is not a person', () => {
    expect(crewRollDrop({ type: 'line', lineKey: 'ASSY' }, onLeave)).toBeNull();
    expect(crewRollDrop({ type: 'bar', jobId: 'J1' }, onLeave)).toBeNull();
  });

  it('ignores a person dropped anywhere else', () => {
    expect(crewRollDrop(worker, { type: 'line', lineKey: 'ASSY' })).toBeNull();
    expect(crewRollDrop(worker, { type: 'pool' })).toBeNull();
    expect(crewRollDrop(worker, null)).toBeNull();
  });

  it('writes nothing for a roll it does not know or a nameless drag', () => {
    expect(crewRollDrop(worker, { type: CREW_ROLL_TYPE, roll: 'busy' })).toBeNull();
    expect(crewRollDrop({ type: 'worker' }, onLeave)).toBeNull();
  });

  it('gives each roll its own drop id', () => {
    expect(crewRollDropId('free')).not.toBe(crewRollDropId('onLeave'));
  });
});
