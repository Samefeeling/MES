/**
 * Production orders from the `planning` sheet — the rows a planner drags onto
 * the board. Each row already carries the current machine, die and run rate.
 *
 * Column map (0-based):
 *   0 machine | 2 qty/hr | 3 Due Date | 4 JobHead_JobNum | 5 JobHead_PartNum
 *   6 PartDescription | 7 Calculated_RemainingQty | 8 JobReleased
 *   10 Req. By | 13 Prod Hours | 14 Die
 */

import { JobId, MachineId, PartId, ToolId } from '@/domain/ids';
import type { Department, Job } from '@/domain/types';
import type { MaterialPrepStatus, OrderType } from '@/domain/assembly';
import { asBool, asDate, asNum, asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = {
  machine: 0,
  qtyPerHr: 2,
  dueDate: 3,
  jobNum: 4,
  partNum: 5,
  description: 6,
  remainingQty: 7,
  released: 8,
  reqBy: 10,
  prodHours: 13,
  die: 14,
  // Columns to be added to the workbook so one sheet feeds both departments
  // (see README). Absent today, so every row defaults to moulding.
  startDate: 34,
  department: 35,
  orderType: 36,
  priority: 37,
  materialPrep: 38,
  line: 39,
  completedQty: 41,
} as const;

const PREP_VALUES = new Set<MaterialPrepStatus>([
  'unknown',
  'not-prepared',
  'preparing',
  'ready',
  'shortage',
]);

function readDepartment(raw: string | null): Department {
  return raw?.toLowerCase().startsWith('assem') ? 'assembly' : 'moulding';
}

const ORDER_TYPES: Record<string, OrderType> = {
  'cutting/sewing': 'cutting-sewing',
  'cutting-sewing': 'cutting-sewing',
  'cut & sew': 'cutting-sewing',
  upholstery: 'upholstery',
  'final assembly': 'final-assembly',
  'final-assembly': 'final-assembly',
};

function readOrderType(raw: string | null): OrderType | null {
  const t = raw?.trim().toLowerCase();
  return t ? (ORDER_TYPES[t] ?? null) : null;
}

function readPrep(raw: string | null): MaterialPrepStatus {
  const p = raw?.trim().toLowerCase().replace(/\s+/g, '-') as MaterialPrepStatus;
  return p && PREP_VALUES.has(p) ? p : 'unknown';
}

export function parseJobs(planning: Sheet): ParseOutcome<Job> {
  const values: Job[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  dataRows(planning).forEach((row, i) => {
    const jobNum = asStr(row[C.jobNum]);
    const partNum = asStr(row[C.partNum]);
    if (!jobNum || !partNum) return; // spacer / summary row
    if (seen.has(jobNum)) return; // first occurrence wins
    seen.add(jobNum);

    const remainingQty = asNum(row[C.remainingQty]) ?? 0;
    const qtyPerHr = asNum(row[C.qtyPerHr]);
    const prodHours = asNum(row[C.prodHours]);
    const laborHrs =
      prodHours ?? (qtyPerHr && qtyPerHr > 0 ? remainingQty / qtyPerHr : 0);

    if (laborHrs <= 0) {
      errors.push(`planning row ${i + 2} (${jobNum}): no labour hours`);
    }

    const machineRaw = asStr(row[C.machine]);
    const dieRaw = asStr(row[C.die]);
    const department = readDepartment(asStr(row[C.department]));
    const lineRaw = asStr(row[C.line]);

    values.push({
      id: JobId(jobNum),
      department,
      partNum: PartId(partNum),
      description: asStr(row[C.description]) ?? '',
      remainingQty,
      qtyPerHr: qtyPerHr ?? null,
      laborHrs,
      dueDate: asDate(row[C.dueDate]),
      startDate: asDate(row[C.startDate]),
      reqBy: asDate(row[C.reqBy]),
      released:
        asStr(row[C.released]) === null ? null : asBool(row[C.released]),
      priority: asNum(row[C.priority]) ?? 3,
      materialPrep: readPrep(asStr(row[C.materialPrep])),
      tool: dieRaw ? ToolId(dieRaw) : null,
      preferredMachine: machineRaw ? MachineId(machineRaw) : null,
      orderType: readOrderType(asStr(row[C.orderType])),
      line: lineRaw ? MachineId(lineRaw) : null,
      completedQty: asNum(row[C.completedQty]) ?? 0,
      predecessors: [],
      assignedWorkers: [],
    });
  });

  return { values, errors };
}
