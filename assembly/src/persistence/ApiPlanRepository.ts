/**
 * Server-backed plan storage over a small REST API:
 *   GET    {base}/plans          → PlanSummary[]
 *   GET    {base}/plans/:id      → PersistedPlan (404 when absent)
 *   PUT    {base}/plans/:id      → upsert PersistedPlan
 */

import { PRODUCTION_LIST } from '@/data/sharepoint/production.sync';
import {
  CURRENT_PLAN_ID,
  type PersistedPlan,
  type PlanRepository,
  type PlanSummary,
} from './PlanRepository';

export class ApiPlanRepository implements PlanRepository {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async save(plan: PersistedPlan): Promise<void> {
    const res = await fetch(`${this.baseUrl}/plans/${plan.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        // Keeps the backend adapter explicit: daily production rows belong in
        // the PMD-compatible SharePoint list, not in the source planning CSV.
        // Named once, where the sync names it.
        'X-Production-List': PRODUCTION_LIST,
      },
      body: JSON.stringify(plan),
    });
    if (!res.ok) {
      throw new Error(`Save failed: ${res.status} ${res.statusText}`);
    }
  }

  async load(id: string = CURRENT_PLAN_ID): Promise<PersistedPlan | null> {
    const res = await fetch(`${this.baseUrl}/plans/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Load failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as PersistedPlan;
  }

  async list(): Promise<PlanSummary[]> {
    const res = await fetch(`${this.baseUrl}/plans`);
    if (!res.ok) throw new Error(`List failed: ${res.status}`);
    return (await res.json()) as PlanSummary[];
  }
}
