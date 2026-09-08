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

export interface ComponentRequirement {
  componentPart: PartId;
  requiredQty: number;
}

export function explodeMaterials(
  job: Job,
  bomByJob: Map<string, BomLine[]>,
  bomByPart: Map<PartId, BomLine[]>,
): ComponentRequirement[] {
  const direct = bomByJob.get(job.id);
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
