import { describe, expect, it } from 'vitest';
import {
  manualOrderDropdownVisible,
  operatorOrderStartVisible,
  operatorPlanningOrderVisible,
} from '../src/ui/operator';
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

  it('matches Planning HS to the Hstamp Operator machine', () => {
    expect(
      operatorPlanningOrderVisible(order({ jobNumber: 'HOT', machineCode: 'HS' }), 'Hstamp', anchor),
    ).toBe(true);
  });

  it('keeps supervisor manual orders without a machine universally selectable', () => {
    expect(
      operatorPlanningOrderVisible(
        order({
          jobNumber: 'MANUAL',
          machineCode: '',
          manuallyAdded: true,
          source: 'Manual',
          createdAt: '2026-07-16T11:00:00',
        }),
        '1300T',
        anchor,
        false,
        anchor,
      ),
    ).toBe(true);
  });
});

describe('Manual order 48-hour dropdown life', () => {
  const now = new Date('2026-08-25T10:00:00');

  it('shows a manual order before 48 hours and hides it at 48 hours', () => {
    const recent = order({
      jobNumber: 'RECENT',
      machineCode: '',
      manuallyAdded: true,
      source: 'Manual',
      createdAt: '2026-08-23T10:00:01',
    });
    const expired = { ...recent, jobNumber: 'OLD', createdAt: '2026-08-23T10:00:00' };
    expect(manualOrderDropdownVisible(recent, now)).toBe(true);
    expect(manualOrderDropdownVisible(expired, now)).toBe(false);
    expect(operatorPlanningOrderVisible(expired, '1300T', now, true, now)).toBe(false);
  });

  it('hides a legacy manual row with no trustworthy Created value', () => {
    expect(
      manualOrderDropdownVisible(
        order({
          jobNumber: 'LEGACY',
          machineCode: '',
          manuallyAdded: true,
          source: 'Manual',
          createdAt: 'not-a-date',
        }),
        now,
      ),
    ).toBe(false);
    expect(
      manualOrderDropdownVisible(
        order({
          jobNumber: 'NO-DATE',
          machineCode: '',
          manuallyAdded: true,
          source: 'Manual',
          createdAt: undefined,
        }),
        now,
      ),
    ).toBe(false);
  });
});
