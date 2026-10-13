import { afterEach, describe, expect, it } from 'vitest';
import { usePlanStore } from '@/store/planStore';
import { DEFAULT_CREW_RULES } from '@/domain/crewRules';
import { preferredCrewSize } from '@/engine/assembly/crew';
import { PLANNING_KEYS, planningOf } from '@/persistence';
import type { OrderRow } from '@/engine/assembly/board';

afterEach(() => usePlanStore.getState().setCrewRules(DEFAULT_CREW_RULES));

describe('crew rules in the plan', () => {
  it('are planning: published by Save with the crews, not written as a shift record', () => {
    expect(PLANNING_KEYS).toContain('crewRules');
    const plan = { id: 'current', name: 'Working plan', savedAt: '', containers: {}, assembly: { crewRules: { ...DEFAULT_CREW_RULES, skipPrefixes: ['X'] } } };
    expect(planningOf(plan).assembly.crewRules?.skipPrefixes).toEqual(['X']);
  });

  it('a stored plan is read through the cleaner; a plan without rules keeps the ones on the board', () => {
    const store = usePlanStore.getState();
    store.setAssemblyPlan({ crewRules: { skipPrefixes: [' sunf', 'zz'], lines: { ASSY: { auto: true, crew: 2 } } } });
    expect(usePlanStore.getState().crewRules.skipPrefixes).toEqual(['SUNF', 'ZZ']);
    expect(usePlanStore.getState().crewRules.dueTiersDays).toEqual([14, 28, 56]);
    usePlanStore.getState().setAssemblyPlan({});
    expect(usePlanStore.getState().crewRules.skipPrefixes).toEqual(['SUNF', 'ZZ']);
  });

  it('the board draws an order nobody is on at the team the rules give it', () => {
    const row = { line: { key: 'ASSY' }, job: { laborHrs: 20, remainingQty: 1, completedQty: 0, qtyPerHr: null } } as unknown as OrderRow;
    expect(preferredCrewSize(row)).toBe(2);
    usePlanStore.getState().setCrewRules({ ...DEFAULT_CREW_RULES, lines: { ASSY: { auto: true, crew: 4 } } });
    expect(preferredCrewSize(row)).toBe(4);
  });
});
