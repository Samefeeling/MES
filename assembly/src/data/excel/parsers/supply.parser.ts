/**
 * Raw-material supply (open purchase orders) from the `po` sheet.
 *
 * Column map: 0 PODetail_PartNum | 1 PORel_DueDate
 *   2 Calculated_OutstandingQty | 3 PORel_PONum | 4 PORel_PromiseDt
 *   5 PurAgent_Name
 */

import { PartId } from '@/domain/ids';
import type { PoLine } from '@/domain/types';
import { asDate, asNumOr0, asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = {
  partNum: 0,
  dueDate: 1,
  outstandingQty: 2,
  poNum: 3,
  promiseDate: 4,
  buyer: 5,
} as const;

export function parseSupply(po: Sheet): ParseOutcome<PoLine> {
  const values: PoLine[] = [];
  for (const row of dataRows(po)) {
    const partNum = asStr(row[C.partNum]);
    if (!partNum) continue;
    values.push({
      partNum: PartId(partNum),
      poNum: asStr(row[C.poNum]),
      outstandingQty: asNumOr0(row[C.outstandingQty]),
      dueDate: asDate(row[C.dueDate]),
      promiseDate: asDate(row[C.promiseDate]),
      buyer: asStr(row[C.buyer]),
    });
  }
  return { values, errors: [] };
}
