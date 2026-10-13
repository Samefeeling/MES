/**
 * Crew orders, by the supervisor's rules rather than the engine's numbers.
 *
 * The defaults are what the board did before (see crew.test.ts, which runs on
 * them unchanged) plus two: unfirm SUNF orders are never crewed, and nobody is
 * put on a bench whose trade they do not have.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { MockSource } from '@/data/mock/MockSource';
import { buildIndexes } from '@/engine/indexes';
import { computeAssemblyGantt, type OrderRow } from '@/engine/assembly/board';
import { countUnstaffed, crewSkipReason, preferredCrewSize, suggestCrew } from '@/engine/assembly/crew';
import { addDays } from '@/engine/assembly/dates';
import { usePlanStore } from '@/store/planStore';
import { WorkerId } from '@/domain/ids';
import type { LineKey, Worker } from '@/domain/assembly';
import { DEFAULT_CREW_RULES, crewSizeFor, readCrewRules, type CrewRules } from '@/domain/crewRules';
import type { PlanningDataset } from '@/domain/types';

let dataset: PlanningDataset;
beforeAll(async () => {
  const result = await new MockSource().loadAll();
  if (!result.ok) throw new Error(result.error);
  dataset = result.value;
});

const TODAY = new Date('2026-09-11T00:00:00');
const rules = (patch: Partial<CrewRules> = {}): CrewRules => ({ ...structuredClone(DEFAULT_CREW_RULES), ...patch });
const person = (id: string, skills: LineKey[] = ['ASSY'], extra: Partial<Worker> = {}): Worker => ({
  id: WorkerId(id), name: id, skills, onShift: true, ...extra,
});

/** One line holding the given orders, nobody on them, these people on its roster. */
function fixture(line: LineKey, workers: Worker[], orders: Array<{ id: string; hours?: number; released?: boolean | null; dueIn?: number | null }>) {
  usePlanStore.getState().reconcile(dataset.workCenters, dataset.jobs, undefined, dataset.jobLinks);
  const original = computeAssemblyGantt({
    dataset, indexes: buildIndexes(dataset), containers: usePlanStore.getState().containers,
    orderCrewAssignments: {}, orderStarts: {}, progress: {}, production: {}, workers: dataset.workers, today: TODAY,
  });
  const group = original.groups.find((g) => g.line.key === line)!;
  const base = group.rows[0];
  const rows: OrderRow[] = orders.map((o) => ({
    ...base, workers: [], crewDays: [], plannedStart: TODAY,
    job: {
      ...base.job, id: o.id as never, laborHrs: o.hours ?? 4, remainingQty: 1, completedQty: 0,
      released: o.released === undefined ? true : o.released,
      dueDate: o.dueIn === null ? null : addDays(TODAY, o.dueIn ?? 5),
    },
    mustStartBy: null,
  }));
  return { ...original, workers, groups: [{ ...group, rows }], rowsByJob: new Map(rows.map((r) => [String(r.job.id), r])) };
}

describe('which orders the button crews', () => {
  it('never crews an unfirm SUNF order, and does not count it as waiting', () => {
    const b = fixture('ASSY', [person('A'), person('B')], [{ id: 'SUNF0000000231-1-10' }, { id: 'SFM0001-1-10' }]);
    expect(countUnstaffed(b, rules())).toBe(1);
    const out = suggestCrew(b, undefined, undefined, rules());
    expect(Object.keys(out.allocations)).toEqual(['SFM0001-1-10']);
    expect(out.skipped.prefix).toEqual(['SUNF0000000231-1-10']);
  });

  it('takes the prefixes from the rules, any case', () => {
    const b = fixture('ASSY', [person('A')], [{ id: 'sunf0000000231-1-10' }]);
    expect(suggestCrew(b, undefined, undefined, rules()).skipped.prefix).toHaveLength(1);
    expect(Object.keys(suggestCrew(b, undefined, undefined, rules({ skipPrefixes: [] })).allocations)).toEqual(['sunf0000000231-1-10']);
  });

  it('leaves an unreleased order alone unless the rules allow it', () => {
    const b = fixture('ASSY', [person('A')], [{ id: 'SFM0002-1-10', released: false }]);
    expect(suggestCrew(b, undefined, undefined, rules()).skipped.unreleased).toEqual(['SFM0002-1-10']);
    expect(suggestCrew(b, undefined, undefined, rules({ releasedOnly: false })).staffed).toBe(1);
  });

  it('leaves a line switched off for crewing by hand', () => {
    const b = fixture('ASSY', [person('A')], [{ id: 'SFM0003-1-10' }]);
    const out = suggestCrew(b, undefined, undefined, rules({ lines: { ASSY: { auto: false, crew: null } } }));
    expect(out.staffed).toBe(0);
    expect(out.skipped.line).toEqual(['SFM0003-1-10']);
  });

  it('crews only within the horizon; an order with no Due Date is outside any horizon', () => {
    const b = fixture('ASSY', [person('A'), person('B'), person('C')], [
      { id: 'NEAR', dueIn: 10 }, { id: 'LATE', dueIn: -2 }, { id: 'FAR', dueIn: 40 }, { id: 'NONE', dueIn: null },
    ]);
    const r = rules({ horizonDays: 28 });
    expect(['NEAR', 'LATE', 'FAR', 'NONE'].map((id) => crewSkipReason(b.rowsByJob.get(id)!, r, TODAY)))
      .toEqual([null, null, 'horizon', 'horizon']);
    expect(countUnstaffed(b, r)).toBe(2);
  });
});

describe('how many, and who', () => {
  it("sizes the team by the supervisor's hour bands", () => {
    const r = rules({ sizeBands: [{ upToHours: 4, crew: 1 }, { upToHours: null, crew: 4 }] });
    const b = fixture('ASSY', ['A', 'B', 'C', 'D'].map((id) => person(id)), [{ id: 'BIG', hours: 20 }]);
    expect(preferredCrewSize(b.rowsByJob.get('BIG')!, r)).toBe(4);
    expect(suggestCrew(b, undefined, undefined, r).allocations.BIG).toHaveLength(4);
  });

  it("a fixed team on a line wins over the bands; a bench takes its lane's", () => {
    const r = rules({ lines: { ASSY: { auto: true, crew: 2 }, UPL_SOFTIE: { auto: true, crew: 1 } } });
    expect(crewSizeFor(r, 'ASSY', 100)).toBe(2);
    expect(crewSizeFor(r, 'UPL_SOFTIE', 100)).toBe(1);
    expect(crewSizeFor(r, 'UPL_GLUING', 100)).toBe(3);
    expect(crewSizeFor(r, 'ASSY', 0)).toBe(0);
  });

  it('with the trade rule on, a cutter is not put on gluing even when nobody else is free', () => {
    const cutter = person('Cutter', ['UPL_CUT_SEW'], { trades: ['cut-sew'] });
    const b = fixture('UPL_CUT_SEW', [cutter], [{ id: 'GLUE' }]);
    b.groups[0].rows[0].kind = 'upholstery';
    expect(suggestCrew(b, undefined, undefined, rules()).left).toEqual(['GLUE']);
    expect(suggestCrew(b, undefined, undefined, rules({ requireTrade: false })).allocations.GLUE).toEqual(['Cutter']);
  });

  it('passes over somebody booked off inside the stretch the order runs', () => {
    const away = person('Away', ['ASSY'], { plannedLeave: ['2026-09-14'] });
    const b = fixture('ASSY', [away, person('Here')], [{ id: 'JOB', hours: 30 }]);
    expect(suggestCrew(b, undefined, undefined, rules({ lines: { ASSY: { auto: true, crew: 1 } } })).allocations.JOB).toEqual(['Here']);
  });
});

describe('reading stored rules', () => {
  it('a plan with no rules crews by the defaults', () => {
    expect(readCrewRules(undefined)).toEqual(DEFAULT_CREW_RULES);
    expect(readCrewRules('nonsense')).toEqual(DEFAULT_CREW_RULES);
  });

  it('cleans what it is given and fills in what is missing', () => {
    const r = readCrewRules({
      skipPrefixes: [' sunf ', 'SUNF', '', 'ztest'],
      horizonDays: 0,
      dueTiersDays: [56, 7, 7, -1],
      sizeBands: [{ upToHours: 40, crew: 9 }, { upToHours: null, crew: 0.4 }, { upToHours: 8, crew: 1 }],
      lines: { TABLE: { auto: false, crew: 'x' } },
    });
    expect(r.skipPrefixes).toEqual(['SUNF', 'ZTEST']);
    expect(r.horizonDays).toBeNull();
    expect(r.dueTiersDays).toEqual([7, 56]);
    expect(r.sizeBands).toEqual([{ upToHours: 8, crew: 1 }, { upToHours: 40, crew: 4 }, { upToHours: null, crew: 1 }]);
    expect(r.lines).toEqual({ TABLE: { auto: false, crew: null } });
    expect(r.releasedOnly).toBe(true);
    expect(r.requireTrade).toBe(true);
  });
});
