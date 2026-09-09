import { beforeEach, describe, expect, it } from 'vitest';
import { initialLine, LINES } from '@/domain/assembly';
import { parseOperators } from '@/data/sharepoint/operator.parser';
import { usePlanStore } from '@/store/planStore';
import { assemblyWorkCenters } from '@/data/excel/parsers/machine.parser';
import { manualJob } from '@/domain/manualOrder';
import { JobId, WorkCenterId } from '@/domain/ids';

describe('operational lines', () => {
  it('provides seven production lines and a general support group', () => {
    expect(LINES.filter(l => l.schedulable).map(l => l.name)).toEqual([
      'UPL - Cut/Sewing', 'UPL - Gluing', 'UPL - ASSY', 'UPL - Softie (SSS)',
      'ASSY - Stool', 'ASSY - Seats', 'Table', 'Factory General',
    ]);
  });
  it.each([
    ['Cut Fabric Smart Softies', 'PMD', 'UPL_CUT_SEW'],
    ['Cosmic Stool Grey', 'ASSY', 'ASSY_STOOL'],
    ['Podium Aluminium Arm', 'ASSY', 'ASSY'],
    ['Trolleys Slim n Comfy', 'ASSY', 'ASSY'],
    ['Gluing Podium pad', 'UPL', 'UPL_GLUING'],
    ['Orbit Foamed Up Smart Softies', 'UPL', 'UPL_GLUING'],
    ['Podium Back Pad', 'UPL', 'UPL'],
    ['Leg Adjustable Tables TNL2', 'PMD', 'PMD'],
    ['REGRIND', 'TBP', null],
  ])('places %s without SKU rules', (description, resource, expected) => {
    expect(initialLine(description, resource)).toBe(expected);
  });
  it('accepts all displayed skill labels without splitting Cut/Sewing', () => {
    const labels = LINES.filter(l => l.schedulable).map(l => l.name);
    const parsed = parseOperators([{ id: '1', Title: 'Alex', Skills: labels.join(';') }]);
    expect(parsed.values[0].skills).toEqual(LINES.filter(l => l.schedulable).map(l => l.key));
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
  it('migrates old placements once and preserves subsequent supervisor moves', () => {
    const job = { ...manualJob(support), id: JobId('ERP-1'), manual: undefined, description: 'Cosmic Stool', line: WorkCenterId('ASSY') };
    usePlanStore.setState({ containers: { ASSY: [job.id] }, orderStarts: { 'ERP-1': '2026-09-10' } });
    usePlanStore.getState().reconcile(assemblyWorkCenters(), [job]);
    expect(usePlanStore.getState().containers.ASSY_STOOL).toEqual(['ERP-1']);
    usePlanStore.getState().moveJob(job.id, 'ASSY');
    usePlanStore.getState().reconcile(assemblyWorkCenters(), [job]);
    expect(usePlanStore.getState().containers.ASSY).toEqual(['ERP-1']);
    expect(usePlanStore.getState().orderStarts['ERP-1']).toBe('2026-09-10');
  });
});
