import type { SharePointConfig } from '@/data/sharepoint/site';
import type { ListItemFields } from '@/data/sharepoint/lists.write';
import {
  SharePointHttpError,
  sessionCreate,
  sessionDelete,
  sessionRows,
  sessionRowsStartingWith,
  sessionRowsWhere,
  sessionUpdate,
} from '@/data/sharepoint/session';
import { CURRENT_PLAN_ID, isDailyPlanId, type PersistedPlan, type PlanRepository, type PlanSummary } from './PlanRepository';
import {
  IncompletePlanError,
  generationOfPart,
  generationTime,
  isEnvelope,
  layoutPlan,
  partPrefix,
  readPlanText,
} from './planCodec';

/** One row of the plans list, as this repository needs it. */
export interface PlanRow {
  id: string;
  fields: ListItemFields;
  etag?: string;
}

/** The list operations the repository is built on — SharePoint, or a fake. */
export interface PlanRows {
  /** Rows whose Title is exactly this. */
  find(title: string): Promise<PlanRow[]>;
  /** Rows whose Title starts with this (up to fifty, newest first). */
  findPrefix(prefix: string): Promise<PlanRow[]>;
  all(): Promise<PlanRow[]>;
  create(fields: ListItemFields): Promise<string>;
  update(id: string, fields: ListItemFields, etag: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const sessionPlanRows = (cfg: SharePointConfig, list: string): PlanRows => ({
  find: (title) => sessionRowsWhere(cfg, list, 'Title', title),
  findPrefix: (prefix) => sessionRowsStartingWith(cfg, list, 'Title', prefix),
  all: () => sessionRows(cfg, list),
  create: (fields) => sessionCreate(cfg, list, fields),
  update: (id, fields, etag) => sessionUpdate(cfg, list, id, fields, etag),
  remove: (id) => sessionDelete(cfg, list, id),
});

/**
 * Part rows of a generation the plan no longer names, older than this, are
 * left over from a write that never finished. No write takes an hour, so
 * nothing younger is touched — it may be another board's write in flight.
 */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** The generation a plan's own row names part rows by, if it has any. */
function partsGeneration(head: string): string | null {
  try {
    const parsed: unknown = JSON.parse(head);
    return isEnvelope(parsed) && parsed.parts > 0 ? parsed.generation : null;
  } catch {
    return null;
  }
}

/**
 * One versioned working plan, plus a read-only row per day of history.
 *
 * Conflicts stop autosave instead of discarding another planner's changes, so
 * every row this writes is addressed by the version it was read at. Versions
 * are held per plan id: the working plan and each day's archive are separate
 * rows, and a repository that remembered only one of them would send the
 * archive's write to the working plan's row.
 *
 * A plan too big for one row is packed and, if need be, split into part rows
 * (see `planCodec`). The parts are written first and are invisible until the
 * plan's own row is updated to name them — that update, made at the version
 * the plan was read at, is still the one moment a write lands or does not.
 * The parts it replaced are removed after it.
 */
export class SharePointPlanRepository implements PlanRepository {
  private versions = new Map<string, { id: string; etag: string; generation: string | null }>();
  private loaded = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly rows: PlanRows;
  constructor(cfg: SharePointConfig, listName = 'ASSY_Plans', rows?: PlanRows) {
    this.rows = rows ?? sessionPlanRows(cfg, listName);
  }

  private async row(id: string): Promise<PlanRow | undefined> {
    const rows = (await this.rows.find(id)).filter(r => r.fields.Title === id);
    if (rows.length > 1) throw new Error('Duplicate saved plans found. Make ASSY_Plans.Title unique before continuing.');
    return rows[0];
  }

  private async readPart(title: string): Promise<string | null> {
    const rows = (await this.rows.find(title)).filter(r => r.fields.Title === title);
    return rows.length === 1 ? String(rows[0].fields.PlanJson ?? '') : null;
  }

  /**
   * The plan's row and the plan it holds. A split plan read while another
   * board was replacing it can find a part already gone; the row is read
   * again, by when it names the new ones.
   */
  private async read(id: string): Promise<{ row: PlanRow; plan: PersistedPlan; generation: string | null } | null> {
    for (let attempt = 0; ; attempt++) {
      const row = await this.row(id);
      if (!row) return null;
      const head = String(row.fields.PlanJson);
      try {
        const json = await readPlanText(head, (title) => this.readPart(title), id);
        return { row, plan: JSON.parse(json), generation: partsGeneration(head) };
      } catch (e) {
        if (e instanceof IncompletePlanError && attempt < 2) continue;
        throw e;
      }
    }
  }

  async load(id = CURRENT_PLAN_ID): Promise<PersistedPlan | null> {
    const read = await this.read(id);
    if (read && !read.row.etag) throw new Error('Saved plan has no version; editing is disabled.');
    const plan: PersistedPlan | null = read ? read.plan : null;
    if (plan && (plan.id !== id || !plan.containers)) throw new Error('Saved plan is invalid; editing is disabled.');
    if (read) this.versions.set(id, { id: read.row.id, etag: read.row.etag!, generation: read.generation });
    else this.versions.delete(id);
    // Reading a day out of the archive says nothing about the working plan, so
    // it neither opens autosave nor clears a failure that closed it.
    if (id === CURRENT_PLAN_ID) {
      this.loaded = true;
      this.failed = false;
    }
    return plan;
  }

  /** Best effort: a part row left behind is only ever space. */
  private async drop(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.rows.remove(id).catch(() => {})));
  }

  /** Write a layout's part rows, taking them back again if any one fails. */
  private async writeParts(parts: { title: string; text: string }[], savedAt: string): Promise<string[]> {
    const written: string[] = [];
    try {
      for (const part of parts) {
        written.push(await this.rows.create({ Title: part.title, PlanJson: part.text, SavedAt: savedAt }));
      }
    } catch (e) {
      await this.drop(written);
      throw e;
    }
    return written;
  }

  /**
   * Remove the parts the plan's row no longer names: the generation this
   * write replaced, and any older than an hour that a write never finished.
   */
  private async sweep(planId: string, keep: string | null, replaced: string | null): Promise<void> {
    const now = Date.now();
    const stale = (await this.rows.findPrefix(partPrefix(planId))).filter((row) => {
      const generation = generationOfPart(planId, String(row.fields.Title ?? ''));
      if (!generation || generation === keep) return false;
      return generation === replaced || now - generationTime(generation) > ORPHAN_AGE_MS;
    });
    await this.drop(stale.map((row) => row.id));
  }

  save(plan: PersistedPlan): Promise<void> {
    const json = JSON.stringify(plan);
    const run = async (): Promise<void> => {
      if (!this.loaded || this.failed) throw new Error('Reload the saved plan before saving again.');
      const layout = await layoutPlan(plan.id, json);
      const version = this.versions.get(plan.id);
      const fields = { Title: plan.id, PlanJson: layout.head, SavedAt: plan.savedAt };
      /** The generation this write's part rows go by; null when it has none. */
      const generation = layout.parts.length ? layout.generation : null;
      try {
        const written = await this.writeParts(layout.parts, plan.savedAt);
        try {
          if (version) await this.rows.update(version.id, fields, version.etag);
          else await this.rows.create(fields);
        } catch (e) {
          // SharePoint refused it, so the plan's row still names the parts it
          // had and these are nobody's. A write that died on the way may have
          // landed, and then they are the plan: those are left for the sweep.
          if (e instanceof SharePointHttpError) await this.drop(written);
          throw e;
        }
        const row = await this.row(plan.id);
        if (!row || row.fields.PlanJson !== layout.head || !row.etag) throw new Error('The saved plan changed in another session. Reload before editing again.');
        this.versions.set(plan.id, { id: row.id, etag: row.etag, generation });
      } catch (e) {
        this.failed = true;
        throw e;
      }
      // Only a plan that is or was split has parts to clear: a plan that has
      // always fitted in its row costs no extra request per save.
      const replaced = version?.generation ?? null;
      if (generation || replaced) await this.sweep(plan.id, generation, replaced).catch(() => {});
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
      if (await this.row(plan.id)) return;
      const layout = await layoutPlan(plan.id, json);
      const written = await this.writeParts(layout.parts, plan.savedAt);
      try {
        await this.rows.create({ Title: plan.id, PlanJson: layout.head, SavedAt: plan.savedAt });
      } catch (e) {
        if (e instanceof SharePointHttpError) await this.drop(written);
        throw e;
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async list(): Promise<PlanSummary[]> {
    return (await this.rows.all())
      // Part rows hold pieces of a plan, not plans.
      .filter(row => !String(row.fields.Title).includes('#'))
      .map(row => {
        const id = String(row.fields.Title);
        return {
          id,
          name: isDailyPlanId(id) ? `Plan on ${id.slice(4)}` : 'Working plan',
          savedAt: String(row.fields.SavedAt),
        };
      });
  }
}
