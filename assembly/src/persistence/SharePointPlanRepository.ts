import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import { sessionRows, sessionCreate, sessionUpdate } from '@/data/sharepoint/session';
import { CURRENT_PLAN_ID, type PersistedPlan, type PlanRepository, type PlanSummary } from './PlanRepository';

/** One versioned working plan; conflicts stop autosave instead of discarding another planner's changes. */
export class SharePointPlanRepository implements PlanRepository {
  private version: { id: string; etag: string } | null = null;
  private loaded = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly cfg: SharePointConfig, private readonly listName = 'ASSY_Plans') {}

  async load(id = CURRENT_PLAN_ID): Promise<PersistedPlan | null> {
    const rows = (await sessionRows(this.cfg, this.listName)).filter(r => r.fields.Title === id);
    if (rows.length > 1) throw new Error('Duplicate saved plans found. Make ASSY_Plans.Title unique before continuing.');
    const row = rows[0];
    if (row && !row.etag) throw new Error('Saved plan has no version; editing is disabled.');
    const plan: PersistedPlan | null = row ? JSON.parse(String(row.fields.PlanJson)) : null;
    if (plan && (plan.id !== id || !plan.containers)) throw new Error('Saved plan is invalid; editing is disabled.');
    this.version = row ? { id: row.id, etag: row.etag! } : null;
    this.loaded = true;
    this.failed = false;
    return plan;
  }

  save(plan: PersistedPlan): Promise<void> {
    const json = JSON.stringify(plan);
    const run = async (): Promise<void> => {
      if (!this.loaded || this.failed) throw new Error('Reload the saved plan before saving again.');
      if (json.length > 60000) throw new Error('The saved plan exceeds the SharePoint snapshot limit. No existing plan was overwritten.');
      const fields = { Title: plan.id, PlanJson: json, SavedAt: plan.savedAt };
      try {
        if (this.version) await sessionUpdate(this.cfg, this.listName, this.version.id, fields, this.version.etag);
        else await sessionCreate(this.cfg, this.listName, fields);
        const rows = (await sessionRows(this.cfg, this.listName)).filter(r => r.fields.Title === plan.id);
        const row = rows[0];
        if (rows.length !== 1 || row.fields.PlanJson !== json || !row.etag) throw new Error('The saved plan changed in another session. Reload before editing again.');
        this.version = { id: row.id, etag: row.etag };
      } catch (e) {
        this.failed = true;
        throw e;
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async list(): Promise<PlanSummary[]> {
    return (await sessionRows(this.cfg, this.listName)).map(row => ({
      id: String(row.fields.Title), name: 'Working plan', savedAt: String(row.fields.SavedAt),
    }));
  }
}
