/**
 * Distinct dies / tools referenced by the `resource` sheet (col 6). Used by the
 * inspector and for routing integrity checks. The canonical part↔tool link
 * lives in `toolToPart.parser`; this is just the deduplicated catalogue.
 */

import { ToolId } from '@/domain/ids';
import { asStr, dataRows, type Sheet } from './cell';
import type { ParseOutcome } from './types';

export interface ToolRecord {
  id: ToolId;
  /** Original-case display name (first spelling seen). */
  name: string;
}

const TOOL_COL = 6;

export function parseTools(resource: Sheet): ParseOutcome<ToolRecord> {
  const byId = new Map<string, ToolRecord>();
  for (const row of dataRows(resource)) {
    const raw = asStr(row[TOOL_COL]);
    if (!raw) continue;
    const id = ToolId(raw);
    if (!byId.has(id)) byId.set(id, { id, name: raw });
  }
  return { values: [...byId.values()], errors: [] };
}
