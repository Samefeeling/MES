import { describe, it, expect } from 'vitest';
import { parsePlanningCsv } from '@/data/csv/planning.parser';
import { workKind } from '@/domain/assembly';

describe('Cut routing priority', () => {
  it.each(['UPL', 'ASSY', 'TABLE', 'Softie', 'PMD'])('routes a Cut description from %s to C/S', line => {
    const result = parsePlanningCsv('JobNum,PartNum,PartDescription,Line,ProdQty,RemainingQty,RemainingLaborHrs\nSFM507623,P1,Cut Fabric for Smart Softie,' + line + ',10,10,5');
    expect(result.values).toHaveLength(1);
    const job = result.values[0];
    expect(job.department).toBe('assembly');
    expect(job.line).toBe('UPL');
    expect(job.orderType).toBe('cutting-sewing');
    expect(workKind(job.description, 'UPL')).toBe('cut-sew');
  });
  it.each(['CUT Fabric', 'cut fabric', 'Cutting Smart Softie'])('recognises %s', text => {
    expect(workKind(text, 'UPL')).toBe('cut-sew');
  });
});

it('corrects a saved wrong line without resetting crew or start dates', async () => {
  const { usePlanStore } = await import('@/store/planStore');
  const { assemblyWorkCenters } = await import('@/data/excel/parsers/machine.parser');
  const jobs = parsePlanningCsv('JobNum,PartNum,PartDescription,Line,ProdQty,RemainingQty,RemainingLaborHrs\nSFM507623,P1,Cut Fabric for Smart Softie,ASSY,10,10,5').values;
  usePlanStore.setState({ containers: { ASSY: [jobs[0].id] }, orderStarts: { SFM507623: '2026-09-10' },
    orderCrewAssignments: { SFM507623: [{ workerId: '7', fromDay: null, toDayExclusive: null }] } });
  usePlanStore.getState().reconcile(assemblyWorkCenters(), jobs);
  const state = usePlanStore.getState();
  expect(state.containers.UPL).toContain(jobs[0].id);
  expect(state.containers.ASSY).not.toContain(jobs[0].id);
  expect(state.orderStarts.SFM507623).toBe('2026-09-10');
  expect(state.orderCrewAssignments.SFM507623[0].workerId).toBe('7');
});
