/**
 * Machines from the `resource` sheet (col 5) + the `makeMachine` factory that
 * turns a raw line label into a domain `Machine`. Shared by the mock source.
 */

import { MachineId } from '@/domain/ids';
import type { WorkCenter } from '@/domain/types';
import { MACHINE_ORDER, isVisibleMachine } from '@/domain/constants';
import { LINES } from '@/domain/assembly';
import { asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

const RESOURCE_MACHINE_COL = 5;

/** Strip "(1000TB)", "PMD Machine" and surrounding whitespace from a label. */
function cleanName(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, '')
    .replace(/\bPMD\b/gi, '')
    .replace(/\bMachine\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a moulding `WorkCenter` from a raw line name. */
export function makeMachine(rawName: string): WorkCenter {
  const name = cleanName(rawName) || rawName.trim();
  const id = MachineId(name);
  const tonnage = (() => {
    const m = name.match(/^(\d+)\s*T/i);
    return m ? Number(m[1]) : undefined;
  })();
  const orderIdx = MACHINE_ORDER.indexOf(id);
  const sortIndex =
    orderIdx >= 0 ? orderIdx : MACHINE_ORDER.length + id.charCodeAt(0);
  const base: WorkCenter = {
    id,
    kind: 'machine',
    department: 'moulding',
    name,
    sortIndex,
  };
  return tonnage === undefined ? base : { ...base, tonnage };
}

/** The assembly lines as work centres (PMD, UPL, ASSY, TABLE). */
export function assemblyWorkCenters(): WorkCenter[] {
  return LINES.map((l) => ({
    id: l.id,
    kind: 'area' as const,
    department: 'assembly' as const,
    name: l.name,
    short: l.name,
    sortIndex: l.sortIndex,
  }));
}

/** Visible moulding lines from the routing sheet, plus the assembly areas. */
export function parseWorkCenters(resource: Sheet): ParseOutcome<WorkCenter> {
  const byId = new Map<string, WorkCenter>();
  for (const row of dataRows(resource)) {
    const raw = asStr(row[RESOURCE_MACHINE_COL]);
    if (!raw) continue;
    const m = makeMachine(raw);
    if (isVisibleMachine(m.id) && !byId.has(m.id)) byId.set(m.id, m);
  }
  const machines = [...byId.values()].sort((a, b) => a.sortIndex - b.sortIndex);
  return { values: [...machines, ...assemblyWorkCenters()], errors: [] };
}
