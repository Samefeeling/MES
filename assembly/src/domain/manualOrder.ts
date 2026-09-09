import { JobId, PartId, WorkCenterId } from './ids';
import type { Job } from './types';

export interface ManualOrder {
  id: string;
  description: string;
  supportDepartment: string;
  day: string;
  plannedHours: number;
}

export function manualJob(order: ManualOrder): Job {
  return {
    id: JobId(order.id), department: 'assembly', partNum: PartId(order.id),
    description: order.description, remainingQty: order.plannedHours, completedQty: 0,
    laborHrs: order.plannedHours, qtyPerHr: 1, dueDate: new Date(order.day + 'T15:30:00'),
    startDate: new Date(order.day + 'T07:00:00'), reqBy: null, released: true,
    priority: 1, materialPrep: 'ready', tool: null, preferredMachine: null,
    orderType: 'final-assembly', line: WorkCenterId('FACTORY_GENERAL'),
    predecessors: [], assignedWorkers: [], manual: order,
  };
}
