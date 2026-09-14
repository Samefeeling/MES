/**
 * Zero-backend fallback: persist plans in the browser's localStorage. Used
 * automatically when no `VITE_PERSIST_API_URL` is configured, so the board
 * remembers the planner's layout across reloads on a single machine.
 */

import {
  type PersistedPlan,
  type PlanRepository,
  type PlanSummary,
  CURRENT_PLAN_ID,
} from './PlanRepository';

const PREFIX = 'resero.plan.';

export class LocalStoragePlanRepository implements PlanRepository {
  private key(id: string): string {
    return `${PREFIX}${id}`;
  }

  async save(plan: PersistedPlan): Promise<void> {
    localStorage.setItem(this.key(plan.id), JSON.stringify(plan));
  }

  async load(id: string = CURRENT_PLAN_ID): Promise<PersistedPlan | null> {
    const raw = localStorage.getItem(this.key(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedPlan;
    } catch {
      return null;
    }
  }

  async list(): Promise<PlanSummary[]> {
    const out: PlanSummary[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const p = JSON.parse(raw) as PersistedPlan;
        out.push({ id: p.id, name: p.name, savedAt: p.savedAt });
      } catch {
        /* ignore corrupt entries */
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
}
