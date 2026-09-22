/**
 * BOM explosion: a job → the raw-material components it consumes.
 *
 * Epicor already explodes the BOM per job in the `part req` sheet, so the
 * primary path is a direct lookup by job number. When a job has no exploded
 * lines (e.g. it isn't in `part req` yet) we fall back to the components seen
 * for the same finished part, taking the worst-case quantity per component.
 */

import type { PartId } from '@/domain/ids';
import type { BomLine, Job } from '@/domain/types';
import { jobNumOf } from '@/domain/routing';

export interface ComponentRequirement {
  componentPart: PartId;
  requiredQty: number;
}

export function explodeMaterials(
  job: Job,
  bomByJob: Map<string, BomLine[]>,
  bomByPart: Map<PartId, BomLine[]>,
): ComponentRequirement[] {
  // By order number, not by the board's row key: a routed order's row is
  // ASM8002#20, and `part req` knows only ASM8002. Looked up by the row key it
  // missed every time and quietly fell through to the worst-case part-level
  // figures below, which is an estimate standing in for an exploded BOM the
  // export actually had.
  const direct = bomByJob.get(jobNumOf(job.id));
  if (direct && direct.length > 0) {
    return direct.map((b) => ({
      componentPart: b.componentPart,
      requiredQty: b.requiredQty,
    }));
  }

  // Fallback: collapse the finished part's known components to one line each.
  const byPart = bomByPart.get(job.partNum) ?? [];
  const worst = new Map<PartId, number>();
  for (const b of byPart) {
    worst.set(
      b.componentPart,
      Math.max(worst.get(b.componentPart) ?? 0, b.requiredQty),
    );
  }
  return [...worst.entries()].map(([componentPart, requiredQty]) => ({
    componentPart,
    requiredQty,
  }));
}
