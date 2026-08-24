import { describe, expect, it } from 'vitest';
import { operatorOrderStartVisible, operatorPlanningOrderVisible } from '../src/ui/operator';
import { order } from './helpers';

describe('Operator planning-order StartDate window', () => {
  const anchor = new Date(2026, 6, 16, 12);

  it('keeps every past / overdue order without a lower date bound', () => {
    expect(operatorOrderStartVisible('2025-01-01T07:00:00', anchor)).toBe(true);
    expect(operatorOrderStartVisible('2026-07-16T07:00:00', anchor)).toBe(true);
  });

  it('includes all of the fifth future day and excludes the sixth', () => {
    expect(operatorOrderStartVisible('2026-07-21T23:59:59', anchor)).toBe(true);
    expect(operatorOrderStartVisible('2026-07-22T00:00:00', anchor)).toBe(false);
  });

  it('removes the future date limit after the operator requests all orders', () => {
    expect(operatorOrderStartVisible('2027-07-22T00:00:00', anchor, true)).toBe(true);
  });

  it('keeps missing or malformed legacy StartDate values selectable', () => {
    expect(operatorOrderStartVisible('', anchor)).toBe(true);
    expect(operatorOrderStartVisible('not-a-date', anchor)).toBe(true);
  });
});

describe('Operator Job# machine filter', () => {
  const anchor = new Date(2026, 6, 16, 12);

  it('matches Planning.csv Machine case-insensitively and trims whitespace', () => {
    expect(
      operatorPlanningOrderVisible(order({ jobNumber: 'J1', machineCode: ' 1300t ' }), '1300T', anchor),
    ).toBe(true);
    expect(
      operatorPlanningOrderVisible(order({ jobNumber: 'J2', machineCode: '125T' }), '1300T', anchor),
    ).toBe(false);
  });

  it('keeps supervisor manual orders without a machine universally selectable', () => {
    expect(
      operatorPlanningOrderVisible(
        order({ jobNumber: 'MANUAL', machineCode: '', manuallyAdded: true, source: 'Manual' }),
        '1300T',
        anchor,
      ),
    ).toBe(true);
  });
});
