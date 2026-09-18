import { describe, expect, it } from 'vitest';
import {
  CREW_ROLL_TYPE,
  crewRollDrop,
  crewRollDropId,
} from '@/features/assembly/crewRoll';

const worker = { type: 'worker', workerId: 'W1' };
const free = { type: CREW_ROLL_TYPE, roll: 'free' };
const absent = { type: CREW_ROLL_TYPE, roll: 'absent' };

describe('dragging a name into Free or Absent', () => {
  it('marks somebody off when they land in Absent', () => {
    expect(crewRollDrop(worker, absent)).toEqual({
      workerId: 'W1',
      away: true,
    });
  });

  it('puts them back in when they land in Free', () => {
    expect(crewRollDrop(worker, free)).toEqual({
      workerId: 'W1',
      away: false,
    });
  });

  it('ignores anything that is not a person', () => {
    expect(crewRollDrop({ type: 'line', lineKey: 'ASSY' }, absent)).toBeNull();
    expect(crewRollDrop({ type: 'bar', jobId: 'J1' }, absent)).toBeNull();
  });

  it('ignores a person dropped anywhere else', () => {
    expect(crewRollDrop(worker, { type: 'line', lineKey: 'ASSY' })).toBeNull();
    expect(crewRollDrop(worker, { type: 'pool' })).toBeNull();
    expect(crewRollDrop(worker, null)).toBeNull();
  });

  it('writes nothing for a roll it does not know or a nameless drag', () => {
    expect(crewRollDrop(worker, { type: CREW_ROLL_TYPE, roll: 'busy' })).toBeNull();
    expect(crewRollDrop({ type: 'worker' }, absent)).toBeNull();
  });

  it('gives each roll its own drop id', () => {
    expect(crewRollDropId('free')).not.toBe(crewRollDropId('absent'));
  });
});
