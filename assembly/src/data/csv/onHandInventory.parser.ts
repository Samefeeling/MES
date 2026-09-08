/** On-hand balances exported from Epicor as `OnHandInventory.csv`. */

import { PartId } from '@/domain/ids';
import type { InventoryItem } from '@/domain/types';
import { normalizeHeader, parseCsv } from '@/lib/csv';

const aliases = {
  part: ['partpartnum', 'partnum'],
  onHand: ['calculatedonhand', 'onhand'],
  demand: ['calculateddemand', 'demand'],
  description: ['partdescription', 'description'],
} as const;

const column = (headers: string[], names: readonly string[]): number =>
  names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;

const numberValue = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.replaceAll(',', '').trim());
  return Number.isFinite(value) ? value : null;
};

/**
 * Multiple warehouse/bin rows for the same part are summed. The requested
 * figure is `Calculated_OnHand`; reservations and supply are not inferred.
 */
export function parseOnHandInventoryCsv(text: string): {
  values: InventoryItem[];
  errors: string[];
} {
  const rows = parseCsv(text);
  if (rows.length === 0) return { values: [], errors: ['OnHandInventory.csv is empty'] };
  const headers = rows[0].map(normalizeHeader);
  const partCol = column(headers, aliases.part);
  const onHandCol = column(headers, aliases.onHand);
  const demandCol = column(headers, aliases.demand);
  const descriptionCol = column(headers, aliases.description);
  if (partCol < 0 || onHandCol < 0) {
    return {
      values: [],
      errors: [
        'OnHandInventory.csv needs Part_PartNum and Calculated_OnHand columns',
      ],
    };
  }

  const totals = new Map<string, number>();
  const demands = new Map<string, number>();
  const descriptions = new Map<string, string>();
  const errors: string[] = [];
  rows.slice(1).forEach((row, index) => {
    const part = row[partCol]?.trim();
    if (!part) return;
    const onHand = numberValue(row[onHandCol]);
    if (onHand === null) {
      errors.push(`OnHandInventory.csv row ${index + 2}: invalid Calculated_OnHand`);
      return;
    }
    totals.set(part, (totals.get(part) ?? 0) + onHand);
    const demand = numberValue(row[demandCol]);
    if (demand !== null) demands.set(part, (demands.get(part) ?? 0) + demand);
    else if (demandCol >= 0 && row[demandCol]?.trim()) {
      errors.push(`OnHandInventory.csv row ${index + 2}: invalid Calculated_Demand`);
    }
    const description = row[descriptionCol]?.trim();
    if (description) descriptions.set(part, description);
  });

  return {
    values: [...totals].map(([partNum, onHand]) => ({
      partNum: PartId(partNum),
      description: descriptions.get(partNum) ?? '',
      typeCode: null,
      onHand,
      cmplWip: 0,
      supply: 0,
      demand: demands.get(partNum) ?? 0,
      calculatedDemand: demands.get(partNum) ?? null,
      freeOnHand: onHand,
    })),
    errors,
  };
}
