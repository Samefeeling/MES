import { formatDay } from '@/lib/time';
/**
 * The release gate: may the supervisor start this order?
 *
 * Two independent facts combine:
 *   - what the *engine* computes from stock, BOM and incoming POs
 *     (`MaterialStatus` — shared with the moulding board, unchanged)
 *   - what the *material handler* physically did (`MaterialPrepStatus`)
 *
 * Stock existing is not the same as the kit being picked, so an order is only
 * releasable when both agree. Anything else needs a supervisor override with a
 * reason, which is exactly the workflow on the floor today.
 */

import type { MaterialPrepStatus } from '@/domain/assembly';
import type { MaterialStatus } from '@/domain/types';

export type ReleaseLevel = 'ready' | 'caution' | 'blocked';

export interface ReleaseCheck {
  level: ReleaseLevel;
  releasable: boolean;
  /** Short reason shown on the card / in the inspector. */
  reason: string;
  /** True when only a supervisor override can start it. */
  needsOverride: boolean;
}

const PREP_LABEL: Record<MaterialPrepStatus, string> = {
  unknown: 'kit status missing',
  'not-prepared': 'kit not prepared',
  preparing: 'kit being prepared',
  ready: 'kit ready',
  shortage: 'handler flagged a shortage',
};

export function releaseCheck(
  material: MaterialStatus,
  prep: MaterialPrepStatus,
): ReleaseCheck {
  // Hard stop: stock genuinely missing with nothing inbound.
  if (material.level === 'short') {
    return {
      level: 'blocked',
      releasable: false,
      needsOverride: true,
      reason: 'Components short with no PO',
    };
  }
  if (prep === 'shortage') {
    return {
      level: 'blocked',
      releasable: false,
      needsOverride: true,
      reason: PREP_LABEL.shortage,
    };
  }

  // Stock only arrives later — schedulable, but not startable now.
  if (material.level === 'covered') {
    const when = material.earliestStart
      ? formatDay(material.earliestStart)
      : 'a future PO';
    return {
      level: 'caution',
      releasable: false,
      needsOverride: true,
      reason: `Waiting on material until ${when}`,
    };
  }

  // Stock is there; the kit may still be on its way to the bench.
  if (prep !== 'ready') {
    return {
      level: 'caution',
      releasable: false,
      needsOverride: prep === 'unknown',
      reason: PREP_LABEL[prep],
    };
  }

  return {
    level: 'ready',
    releasable: true,
    needsOverride: false,
    reason: 'Material ready',
  };
}

export interface StartEligibility {
  allowed: boolean;
  canOverride: boolean;
  reasons: string[];
}

/** Fail-safe gate for the irreversible transition from planned to started. */
export function startEligibility(
  released: boolean | null,
  release: ReleaseCheck,
  crewCount: number,
): StartEligibility {
  const reasons: string[] = [];
  if (crewCount <= 0) reasons.push('Allocate at least one employee');
  if (released !== true) {
    reasons.push(released === false ? 'Order is not released' : 'Release status is missing');
  }
  if (!release.releasable) reasons.push(release.reason);
  return {
    allowed: reasons.length === 0,
    // A supervisor may accept release/material uncertainty, never a zero crew.
    canOverride: crewCount > 0,
    reasons,
  };
}
