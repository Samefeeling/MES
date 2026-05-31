import type { ProductionRecord, StatusCode, PlanningOrder } from '../src/types';

export function rec(
  partial: Partial<ProductionRecord> & {
    jobNumber: string;
    slotIndex: number;
    statusCode: StatusCode | '';
  },
): ProductionRecord {
  return {
    id: 0,
    machineCode: '125T',
    shiftId: '2026-05-15-Day',
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
    purgeKg: null,
    operator: '',
    supervisor: '',
    bdIssue: '',
    mangoTicket: '',
    handoverNote: '',
    locked: false,
    lockedBy: '',
    lockedAt: '',
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

export function order(partial: Partial<PlanningOrder> & { jobNumber: string }): PlanningOrder {
  return {
    id: 1,
    machineCode: '125T',
    partNumber: 'P1',
    partDescription: 'Part 1',
    plannedStart: '2026-05-15T07:00:00',
    plannedEnd: '2026-05-15T11:00:00',
    jobRequired: 100,
    qtyPerHr: 25,
    duration: 4,
    released: true,
    isDieChange: false,
    manuallyAdded: false,
    source: 'ERP',
    ...partial,
  };
}
