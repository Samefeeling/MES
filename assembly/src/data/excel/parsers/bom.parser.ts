/**
 * Material requirement lines from the `part req` sheet — the BOM components a
 * job consumes, already exploded per job by Epicor.
 *
 * Column map: 0 JobHead_PartNum | 1 JobMtl_JobNum | 2 JobMtl_PartNum
 *   3 JobMtl_RequiredQty | 4 JobMtl_IUM | 5 JobHead_ReqDueDate
 *   6 Calculated_OutstandingQty
 */

import { JobId, PartId } from '@/domain/ids';
import type { BomLine } from '@/domain/types';
import { asDate, asNumOr0, asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = {
  finishedPart: 0,
  jobNum: 1,
  componentPart: 2,
  requiredQty: 3,
  uom: 4,
  dueDate: 5,
  outstandingQty: 6,
} as const;

export function parseBom(partReq: Sheet): ParseOutcome<BomLine> {
  const values: BomLine[] = [];
  for (const row of dataRows(partReq)) {
    const finishedPart = asStr(row[C.finishedPart]);
    const componentPart = asStr(row[C.componentPart]);
    if (!finishedPart || !componentPart) continue;
    const jobNum = asStr(row[C.jobNum]);
    values.push({
      finishedPart: PartId(finishedPart),
      jobNum: jobNum ? JobId(jobNum) : null,
      componentPart: PartId(componentPart),
      requiredQty: asNumOr0(row[C.requiredQty]),
      uom: asStr(row[C.uom]) ?? 'EA',
      dueDate: asDate(row[C.dueDate]),
      outstandingQty: asNumOr0(row[C.outstandingQty]),
    });
  }
  return { values, errors: [] };
}
