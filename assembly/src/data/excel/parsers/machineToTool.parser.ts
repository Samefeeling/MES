/**
 * Machine → tools capability map derived from the `resource` sheet
 * (col 5 machine, col 6 die). Answers "which dies can this line hold?" — used
 * for routing validation and the inspector's machine picker.
 */

import { MachineId, ToolId } from '@/domain/ids';
import { asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

export interface MachineToolLink {
  machine: MachineId;
  tools: ToolId[];
}

const C = { machine: 5, tool: 6 } as const;

export function parseMachineToTool(resource: Sheet): ParseOutcome<MachineToolLink> {
  const map = new Map<string, Set<string>>();
  for (const row of dataRows(resource)) {
    const machine = asStr(row[C.machine]);
    const tool = asStr(row[C.tool]);
    if (!machine || !tool) continue;
    const mid = MachineId(machine);
    const set = map.get(mid) ?? new Set<string>();
    set.add(ToolId(tool));
    map.set(mid, set);
  }
  const values: MachineToolLink[] = [...map.entries()].map(([machine, tools]) => ({
    machine: machine as MachineId,
    tools: [...tools].map((t) => t as ToolId),
  }));
  return { values, errors: [] };
}
