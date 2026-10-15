import { describe, expect, it } from 'vitest';
import { isRerunMachine, nextRerunJob, rerunBase, rerunNumber } from '../src/core/rerun';
import { planningOrderMatchesMachine } from '../src/core/schedule';
import { operatorPlanningOrderVisible } from '../src/ui/operator';
import { order } from './helpers';

describe('Running an order again on the hot-stamping press', () => {
  it('names the second run of an order -R2, then -R3', () => {
    expect(nextRerunJob('SFM507147', ['SFM507147', 'SFM507148'])).toBe('SFM507147-R2');
    expect(nextRerunJob('SFM507147', ['SFM507147', 'SFM507147-R2'])).toBe('SFM507147-R3');
    // Asked from the second run itself, it still counts from the order.
    expect(nextRerunJob('SFM507147-R2', ['SFM507147-R2'])).toBe('SFM507147-R3');
    // Another order's runs don't count.
    expect(nextRerunJob('SFM507147', ['SFM507148-R4'])).toBe('SFM507147-R2');
  });

  it('reads the order and the run back from the Job#', () => {
    expect(rerunNumber('SFM507147-R2')).toBe(2);
    expect(rerunBase('SFM507147-R2')).toBe('SFM507147');
    expect(rerunNumber('SFM507147')).toBeNull();
    expect(rerunBase('SFM507147')).toBe('SFM507147');
  });

  it('is the Hstamp only', () => {
    expect(isRerunMachine('Hstamp')).toBe(true);
    expect(isRerunMachine(' HSTAMP ')).toBe(true);
    expect(isRerunMachine('1300T')).toBe(false);
    expect(isRerunMachine('HS')).toBe(false);
  });

  const second = order({
    jobNumber: 'SFM507147-R2',
    machineCode: '',
    manuallyAdded: true,
    source: 'Manual',
    createdAt: '2026-10-15T09:00:00',
  });

  it('offers the second run in the Hstamp Job# list, and on no other press', () => {
    const now = new Date('2026-10-15T10:00:00');
    expect(operatorPlanningOrderVisible(second, 'Hstamp', now, false, now)).toBe(true);
    expect(operatorPlanningOrderVisible(second, '1300T', now, false, now)).toBe(false);
    expect(planningOrderMatchesMachine(second, 'Hstamp')).toBe(false);
  });

  it('leaves an ordinary manual order on every press', () => {
    const manual = { ...second, jobNumber: 'RUSH-2' };
    const now = new Date('2026-10-15T10:00:00');
    expect(operatorPlanningOrderVisible(manual, '1300T', now, false, now)).toBe(true);
  });
});
