import { beforeEach, describe, expect, it } from 'vitest';
import { erpNamedLine, readLineKey, LINES } from '@/domain/assembly';
import { parseOperators } from '@/data/sharepoint/operator.parser';
import { usePlanStore } from '@/store/planStore';
import { assemblyWorkCenters } from '@/data/excel/parsers/machine.parser';
import { manualJob } from '@/domain/manualOrder';
import { JobId, WorkCenterId } from '@/domain/ids';

describe('operational lines', () => {
  it('is the eight lines the floor names, in the floor’s own order', () => {
    expect(LINES.map((l) => l.name)).toEqual([
      'TBP', 'PMD', 'UPL-CUT', 'UPL-Gluing', 'UPL-SSS', 'Assembly Seats', 'Table', 'General',
    ]);
    // PMD mirrors moulding's plan for context; it is scheduled on the PMD
    // dashboard, not here.
    expect(LINES.filter((l) => l.schedulable).map((l) => l.name)).toEqual([
      'TBP', 'UPL-CUT', 'UPL-Gluing', 'UPL-SSS', 'Assembly Seats', 'Table', 'General',
    ]);
  });

  it.each([
    ['TBP', 'TBP'],
    ['PMD', 'PMD'],
    ['Table', 'TABLE'],
    ['FACTORY_GENERAL', 'FACTORY_GENERAL'],
  ])('lets ERP name %s outright', (resource, expected) => {
    expect(erpNamedLine(resource)).toBe(expected);
  });

  it.each(['UPL', 'ASSY'])('leaves %s to the BOM — it names a department, not a line', (resource) => {
    expect(erpNamedLine(resource)).toBeNull();
  });

  it('migrates the two retired lines rather than losing their work', () => {
    expect(readLineKey('UPL')).toBe('UPL_GLUING');
    expect(readLineKey('ASSY_STOOL')).toBe('ASSY');
    expect(readLineKey('UPL-CUT')).toBe('UPL_CUT_SEW');
    expect(readLineKey('Laser')).toBeNull();
  });

  it('accepts every displayed line name as a roster skill', () => {
    const labels = LINES.filter((l) => l.schedulable).map((l) => l.name);
    const parsed = parseOperators([{ id: '1', Title: 'Alex', Skills: labels.join(';') }]);
    expect(parsed.values[0].skills).toEqual(LINES.filter((l) => l.schedulable).map((l) => l.key));
  });

  it('reads "Upholstery" as the Gluing bench, never as the restricted SSS one', () => {
    expect(parseOperators([{ Title: 'Alex', Skills: 'Upholstery' }]).values[0].skills).toEqual(['UPL_GLUING']);
    expect(parseOperators([{ Title: 'Bo', Skills: 'Cutting' }]).values[0].skills).toEqual(['UPL_CUT_SEW']);
  });

  it('does not turn an assembly press skill into PMD', () => {
    expect(parseOperators([{ Title: 'Alex', Skills: 'Press Milling' }]).values[0].skills).toEqual([]);
  });
});

describe('manual orders and migration', () => {
  beforeEach(() => usePlanStore.setState({
    manualOrders: {}, containers: {}, lineLayoutVersion: 0, lastSeen: {},
    orderActualStarts: {}, orderCrewAssignments: {}, production: {}, progress: {}, progressBaselines: {}, workerLines: {},
  }));
  const support = { id: 'FG-test', description: 'Cut cardboard for warehouse assistance', supportDepartment: 'Warehouse', day: '2026-09-09', plannedHours: 7.5 };

  it('retains a manual order across exports, including empty exports', () => {
    const plan = usePlanStore.getState();
    plan.addManualOrder(support);
    plan.reconcile(assemblyWorkCenters(), [], new Date('2026-10-10T12:00:00'));
    expect(usePlanStore.getState().containers.FACTORY_GENERAL).toEqual(['FG-test']);
    expect(usePlanStore.getState().manualOrders['FG-test']).toEqual(support);
    expect(manualJob(support).laborHrs).toBe(7.5);
  });

  it('carries a plan saved on a retired line over to the line that took it', () => {
    const job = { ...manualJob(support), id: JobId('ERP-1'), manual: undefined, description: 'Podium Back Pad', line: WorkCenterId('UPL_GLUING') };
    usePlanStore.setState({ containers: { UPL: [job.id] }, orderStarts: { 'ERP-1': '2026-09-10' } });
    usePlanStore.getState().reconcile(assemblyWorkCenters(), [job]);
    expect(usePlanStore.getState().containers.UPL_GLUING).toEqual(['ERP-1']);
    expect(usePlanStore.getState().orderStarts['ERP-1']).toBe('2026-09-10');
  });

  it('leaves a supervisor’s own move alone on the next export', () => {
    const job = { ...manualJob(support), id: JobId('ERP-1'), manual: undefined, description: 'Cosmic Stool', line: WorkCenterId('ASSY') };
    usePlanStore.setState({ containers: { ASSY: [job.id] }, orderStarts: { 'ERP-1': '2026-09-10' } });
    usePlanStore.getState().reconcile(assemblyWorkCenters(), [job]);
    expect(usePlanStore.getState().containers.ASSY).toEqual(['ERP-1']);
    usePlanStore.getState().moveJob(job.id, 'TABLE');
    usePlanStore.getState().reconcile(assemblyWorkCenters(), [job]);
    expect(usePlanStore.getState().containers.TABLE).toEqual(['ERP-1']);
    expect(usePlanStore.getState().orderStarts['ERP-1']).toBe('2026-09-10');
  });
});
