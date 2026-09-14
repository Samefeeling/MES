/**
 * Period demand from the `total req` sheet.
 *
 * Column map: 0 partnumber | 1 Reqdate | 2 req_qty
 */

import { PartId } from '@/domain/ids';
import type { DemandLine } from '@/domain/types';
import { asDate, asNumOr0, asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = { partNum: 0, reqDate: 1, reqQty: 2 } as const;

export function parseDemand(totalReq: Sheet): ParseOutcome<DemandLine> {
  const values: DemandLine[] = [];
  for (const row of dataRows(totalReq)) {
    const partNum = asStr(row[C.partNum]);
    if (!partNum) continue;
    values.push({
      partNum: PartId(partNum),
      reqDate: asDate(row[C.reqDate]),
      reqQty: asNumOr0(row[C.reqQty]),
    });
  }
  return { values, errors: [] };
}
