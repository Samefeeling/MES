/**
 * On-hand balances from the `ohb` sheet.
 *
 * Column map: 0 Part_PartNum | 1 Part_PartDescription | 2 Part_TypeCode
 *   3 Calculated_OnHand | 4 Calculated_CmplWIP | 5 Calculated_Supply
 *   6 Calculated_Demand | 7 FREE ON HAND
 */

import { PartId } from '@/domain/ids';
import type { InventoryItem } from '@/domain/types';
import { asNumOr0, asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = {
  partNum: 0,
  description: 1,
  typeCode: 2,
  onHand: 3,
  cmplWip: 4,
  supply: 5,
  demand: 6,
  freeOnHand: 7,
} as const;

export function parseInventory(ohb: Sheet): ParseOutcome<InventoryItem> {
  const values: InventoryItem[] = [];
  for (const row of dataRows(ohb)) {
    const partNum = asStr(row[C.partNum]);
    if (!partNum) continue;
    const onHand = asNumOr0(row[C.onHand]);
    const supply = asNumOr0(row[C.supply]);
    const demand = asNumOr0(row[C.demand]);
    values.push({
      partNum: PartId(partNum),
      description: asStr(row[C.description]) ?? '',
      typeCode: asStr(row[C.typeCode]),
      onHand,
      cmplWip: asNumOr0(row[C.cmplWip]),
      supply,
      demand,
      // Prefer the workbook's own free figure; fall back to the formula.
      freeOnHand: asStr(row[C.freeOnHand])
        ? asNumOr0(row[C.freeOnHand])
        : onHand + supply - demand,
    });
  }
  return { values, errors: [] };
}
