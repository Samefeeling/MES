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
  /**
   * Nothing is wrong — nobody has said anything yet.
   *
   * The kit status is a column the export does not always carry, and a plant
   * that does not record kit preparation at all leaves every order on
   * `unknown` forever. That is an absence of evidence, not evidence the kit is
   * missing, so the start gate steps over it (see `startEligibility`) while the
   * card still shows the material picture as unconfirmed.
   */
  unconfirmed: boolean;
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
      unconfirmed: false,
      reason: 'Components short with no PO',
    };
  }
  if (prep === 'shortage') {
    return {
      level: 'blocked',
      releasable: false,
      needsOverride: true,
      unconfirmed: false,
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
      unconfirmed: false,
      reason: `Waiting on material until ${when}`,
    };
  }

  // Stock is there; the kit may still be on its way to the bench.
  if (prep !== 'ready') {
    return {
      level: 'caution',
      releasable: false,
      needsOverride: prep === 'unknown',
      unconfirmed: prep === 'unknown',
      reason: PREP_LABEL[prep],
    };
  }

  return {
    level: 'ready',
    releasable: true,
    needsOverride: false,
    unconfirmed: false,
    reason: 'Material ready',
  };
}

export interface StartEligibility {
  allowed: boolean;
  canOverride: boolean;
  reasons: string[];
}

/**
 * Fail-safe gate for the irreversible transition from planned to started.
 *
 * It gates on what the plant has *said*, never on what it has failed to say.
 * `JobReleased` and `MaterialPrep` are optional export columns, and where they
 * are not carried at all every order reads `null` / `unknown` — so the gate
 * used to stop every start on this floor with "Release status is missing · kit
 * status missing", ask for a supervisor override, and be clicked past every
 * time. A gate nobody can satisfy teaches the floor to override the ones that
 * matter too, so silence is now taken as no objection: only an explicit "not
 * released", a real shortage or a kit somebody has said is not ready holds an
 * order back. A missing crew still does, whatever the paperwork says.
 */
export function startEligibility(
  released: boolean | null,
  release: ReleaseCheck,
  crewCount: number,
): StartEligibility {
  const reasons: string[] = [];
  if (crewCount <= 0) reasons.push('Allocate at least one employee');
  if (released === false) reasons.push('Order is not released');
  if (!release.releasable && !release.unconfirmed) reasons.push(release.reason);
  return {
    allowed: reasons.length === 0,
    // A supervisor may accept release/material uncertainty, never a zero crew.
    canOverride: crewCount > 0,
    reasons,
  };
}
