/**
 * Pick a plan repository from configuration: a REST backend when
 * `VITE_PERSIST_API_URL` is set, otherwise browser localStorage.
 */

import { readConfigFromEnv } from '@/data/excel/sharepoint.client';
import { SharePointPlanRepository } from './SharePointPlanRepository';
import type { PlanRepository } from './PlanRepository';
import { ApiPlanRepository } from './ApiPlanRepository';
import { LocalStoragePlanRepository } from './LocalStoragePlanRepository';

export function createPlanRepository(): PlanRepository {
  const cfg = readConfigFromEnv();
  if (cfg.authMode === 'session') return new SharePointPlanRepository(cfg, import.meta.env.VITE_ASSEMBLY_PLAN_LIST || 'ASSY_Plans');
  const url = import.meta.env.VITE_PERSIST_API_URL;
  return url
    ? new ApiPlanRepository(url)
    : new LocalStoragePlanRepository();
}

export * from './PlanRepository';
