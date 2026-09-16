import type { SharePointConfig } from '@/data/excel/sharepoint.client';
import { sessionRows, sessionCreate, sessionUpdate } from '@/data/sharepoint/session';
import { CURRENT_PLAN_ID, isDailyPlanId, type PersistedPlan, type PlanRepository, type PlanSummary } from './PlanRepository';

/** The largest plan one list row will hold, in characters of JSON. */
const MAX_PLAN_JSON = 60000;

/**
 * One versioned working plan, plus a read-only row per day of history.
 *
 * Conflicts stop autosave instead of discarding another planner's changes, so
 * every row this writes is addressed by the version it was read at. Versions
 * are held per plan id: the working plan and each day's archive are separate
 * rows, and a repository that remembered only one of them would send the
 * archive's write to the working plan's row.
 */
export class SharePointPlanRepository implements PlanRepository {
  private versions = new Map<string, { id: string; etag: string }>();
  private loaded = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly cfg: SharePointConfig, private readonly listName = 'ASSY_Plans') {}

  private async row(id: string) {
    const rows = (await sessionRows(this.cfg, this.listName)).filter(r => r.fields.Title === id);
    if (rows.length > 1) throw new Error('Duplicate saved plans found. Make ASSY_Plans.Title unique before continuing.');
    return rows[0];
  }

  async load(id = CURRENT_PLAN_ID): Promise<PersistedPlan | null> {
    const row = await this.row(id);
    if (row && !row.etag) throw new Error('Saved plan has no version; editing is disabled.');
    const plan: PersistedPlan | null = row ? JSON.parse(String(row.fields.PlanJson)) : null;
    if (plan && (plan.id !== id || !plan.containers)) throw new Error('Saved plan is invalid; editing is disabled.');
    if (row) this.versions.set(id, { id: row.id, etag: row.etag! });
    else this.versions.delete(id);
    // Reading a day out of the archive says nothing about the working plan, so
    // it neither opens autosave nor clears a failure that closed it.
    if (id === CURRENT_PLAN_ID) {
      this.loaded = true;
      this.failed = false;
    }
    return plan;
  }

  save(plan: PersistedPlan): Promise<void> {
    const json = JSON.stringify(plan);
    const run = async (): Promise<void> => {
      if (!this.loaded || this.failed) throw new Error('Reload the saved plan before saving again.');
      if (json.length > MAX_PLAN_JSON) throw new Error('The saved plan exceeds the SharePoint snapshot limit. No existing plan was overwritten.');
      const fields = { Title: plan.id, PlanJson: json, SavedAt: plan.savedAt };
      const version = this.versions.get(plan.id);
      try {
        if (version) await sessionUpdate(this.cfg, this.listName, version.id, fields, version.etag);
        else await sessionCreate(this.cfg, this.listName, fields);
        const row = await this.row(plan.id);
        if (!row || row.fields.PlanJson !== json || !row.etag) throw new Error('The saved plan changed in another session. Reload before editing again.');
        this.versions.set(plan.id, { id: row.id, etag: row.etag });
      } catch (e) {
        this.failed = true;
        throw e;
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * File a day's closing plan, once.
   *
   * A day already in the list keeps the copy it was filed with — the first
   * board to open after midnight writes the history, and a tab that was open
   * across it, or a second screen coming along at noon, must not overwrite
   * that with whatever it happens to be holding.
   *
   * It never touches the working plan's version and never closes autosave: a
   * board that cannot write its history is still a board that can be worked
   * on, and the day it failed to file is the one thing it cannot fix by
   * refusing to save anything else.
   */
  saveSnapshot(plan: PersistedPlan): Promise<void> {
    const json = JSON.stringify(plan);
    const run = async (): Promise<void> => {
      if (!this.loaded || this.failed) throw new Error('Reload the saved plan before saving again.');
      if (json.length > MAX_PLAN_JSON) throw new Error(`Plan ${plan.id} exceeds the SharePoint snapshot limit and was not filed.`);
      if (await this.row(plan.id)) return;
      await sessionCreate(this.cfg, this.listName, { Title: plan.id, PlanJson: json, SavedAt: plan.savedAt });
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async list(): Promise<PlanSummary[]> {
    return (await sessionRows(this.cfg, this.listName)).map(row => {
      const id = String(row.fields.Title);
      return {
        id,
        name: isDailyPlanId(id) ? `Plan on ${id.slice(4)}` : 'Working plan',
        savedAt: String(row.fields.SavedAt),
      };
    });
  }
}
