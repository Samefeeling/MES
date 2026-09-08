/**
 * The routing / capability matrix from the `resource` sheet: which part runs
 * on which machine, with which die (tool), colour and insert. One row →
 * one `RoutingEntry`. This is the canonical machine↔tool↔part↔insert link.
 *
 * Column map: 0 BNO (part) | 1 Epicor description | 3 Column1 (colour)
 *   5 machine | 6 die (tool) | 7 Column3 (insert)
 */

import { ColorId, InsertId, MachineId, PartId, ToolId } from '@/domain/ids';
import type { RoutingEntry } from '@/domain/types';
import { asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const C = {
  partNum: 0,
  description: 1,
  color: 3,
  machine: 5,
  tool: 6,
  insert: 7,
} as const;

export function parseRouting(resource: Sheet): ParseOutcome<RoutingEntry> {
  const values: RoutingEntry[] = [];
  const seen = new Set<string>();
  for (const row of dataRows(resource)) {
    const partNum = asStr(row[C.partNum]);
    const machine = asStr(row[C.machine]);
    if (!partNum || !machine) continue;

    const key = `${PartId(partNum)}::${MachineId(machine)}`;
    if (seen.has(key)) continue; // one routing per (part, machine)
    seen.add(key);

    const tool = asStr(row[C.tool]);
    const color = asStr(row[C.color]);
    const insert = asStr(row[C.insert]);
    values.push({
      partNum: PartId(partNum),
      machine: MachineId(machine),
      tool: tool ? ToolId(tool) : null,
      color: color ? ColorId(color) : null,
      insert: insert ? InsertId(insert) : null,
      description: asStr(row[C.description]) ?? '',
    });
  }
  return { values, errors: [] };
}
