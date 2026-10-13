import { describe, expect, it } from 'vitest';
import { SharePointHttpError } from '@/data/sharepoint/session';
import { SharePointPlanRepository, type PlanRow, type PlanRows } from '@/persistence/SharePointPlanRepository';
import { MAX_ROW_CHARS, isEnvelope, layoutPlan, newGeneration, partTitle } from '@/persistence/planCodec';
import type { PersistedPlan } from '@/persistence';

const cfg = { siteUrl: 'https://tenant.sharepoint.com/sites/factory', filePath: '', token: '', authMode: 'session' as const };

/** ASSY_Plans in memory: versions bump on every write, and a stale one is refused as SharePoint does. */
class FakeList implements PlanRows {
  rows: PlanRow[] = [];
  private next = 1;
  failUpdate: SharePointHttpError | Error | null = null;
  /** Called before each find — lets a test change the list between two reads. */
  beforeFind: ((title: string) => void) | null = null;
  async find(title: string) {
    this.beforeFind?.(title);
    return this.rows.filter((r) => r.fields.Title === title).map((r) => ({ ...r, fields: { ...r.fields } }));
  }
  async findPrefix(prefix: string) {
    return this.rows.filter((r) => String(r.fields.Title).startsWith(prefix)).slice(-50).reverse();
  }
  async all() {
    return this.rows;
  }
  async create(fields: Record<string, unknown>) {
    const id = String(this.next++);
    this.rows.push({ id, fields: { ...fields }, etag: '"1"' });
    return id;
  }
  async update(id: string, fields: Record<string, unknown>, etag: string) {
    if (this.failUpdate) throw this.failUpdate;
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new SharePointHttpError(404, 'gone');
    if (row.etag !== etag) throw new SharePointHttpError(412, 'Another session changed this record.');
    row.fields = { ...row.fields, ...fields };
    row.etag = `"${Number(row.etag!.replace(/"/g, '')) + 1}"`;
  }
  async remove(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  titles() {
    return this.rows.map((r) => String(r.fields.Title)).sort();
  }
}

/** A plan whose JSON is about `size` characters. `noise` defeats compression, so it has to split. */
function planOf(size: number, noise: boolean, id = 'current'): PersistedPlan {
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const containers: Record<string, string[]> = {};
  let n = 0;
  while (JSON.stringify(containers).length < size) {
    containers[`ASSY-${n}`] = Array.from({ length: 20 }, (_, i) =>
      noise ? Math.floor(rand() * 36 ** 8).toString(36) : `SFM00000${String(n * 20 + i).padStart(5, '0')}`,
    );
    n++;
  }
  return { id, name: 'Working plan', savedAt: '2026-10-13T00:00:00.000Z', containers: containers as PersistedPlan['containers'] };
}

async function opened(list: FakeList) {
  const repo = new SharePointPlanRepository(cfg, 'ASSY_Plans', list);
  await repo.load();
  return repo;
}

describe('plan layout', () => {
  it('keeps a plan that fits as the plain JSON every build reads', async () => {
    const json = JSON.stringify(planOf(20_000, false));
    expect(await layoutPlan('current', json)).toEqual({ head: json, parts: [], generation: null });
  });

  it('packs a plan that does not fit, in one row when packed it does', async () => {
    const json = JSON.stringify(planOf(150_000, false));
    const layout = await layoutPlan('current', json, 'g1-abcd');
    expect(layout.parts).toEqual([]);
    expect(layout.head.length).toBeLessThanOrEqual(MAX_ROW_CHARS);
    expect(isEnvelope(JSON.parse(layout.head))).toBe(true);
  });

  it('splits what does not fit packed either, each part within a row', async () => {
    const layout = await layoutPlan('current', JSON.stringify(planOf(200_000, true)), 'g1-abcd');
    expect(layout.parts.length).toBeGreaterThan(1);
    expect(layout.parts.every((p) => p.text.length <= MAX_ROW_CHARS)).toBe(true);
    expect(layout.parts.map((p) => p.title)).toEqual(layout.parts.map((_, i) => partTitle('current', 'g1-abcd', i)));
  });
});

describe('SharePoint plan repository', () => {
  it('writes and reads back a small plan unchanged, in one row', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    const plan = planOf(10_000, false);
    await repo.save(plan);
    expect(list.titles()).toEqual(['current']);
    expect(JSON.parse(String(list.rows[0].fields.PlanJson))).toEqual(plan);
    expect(await new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load()).toEqual(plan);
  });

  it('saves a plan past the old 60,000-character limit and reads it back whole', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    const plan = planOf(250_000, true);
    expect(JSON.stringify(plan).length).toBeGreaterThan(MAX_ROW_CHARS);
    await repo.save(plan);
    const titles = list.titles();
    expect(titles.filter((t) => t.startsWith('current#')).length).toBeGreaterThan(1);
    expect(list.rows.every((r) => String(r.fields.PlanJson).length <= MAX_ROW_CHARS)).toBe(true);
    expect(await new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load()).toEqual(plan);
  });

  it('a later save replaces the parts; the old generation is removed after it lands', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    await repo.save(planOf(250_000, true));
    const first = list.titles().filter((t) => t.includes('#'));
    const next = { ...planOf(260_000, true), savedAt: '2026-10-13T01:00:00.000Z' };
    await repo.save(next);
    const second = list.titles().filter((t) => t.includes('#'));
    expect(second.some((t) => first.includes(t))).toBe(false);
    expect(await new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load()).toEqual(next);
    // Growing past the limit and shrinking back: the plain plan names no parts, and the last ones go.
    const small = planOf(5_000, false);
    await repo.save(small);
    expect(list.titles()).toEqual(['current']);
  });

  it('a refused write takes its new parts back and leaves the stored plan as it was', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    const before = planOf(250_000, true);
    await repo.save(before);
    const rowsBefore = list.titles();
    list.failUpdate = new SharePointHttpError(412, 'Another session changed this record.');
    await expect(repo.save(planOf(270_000, true))).rejects.toThrow('Another session');
    expect(list.titles()).toEqual(rowsBefore);
    expect(await new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load()).toEqual(before);
    // And the board stops writing until the plan is read again.
    list.failUpdate = null;
    await expect(repo.save(before)).rejects.toThrow('Reload');
  });

  it('a write that died on the way leaves its parts: it may have landed', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    await repo.save(planOf(250_000, true));
    const partsBefore = list.titles().filter((t) => t.includes('#')).length;
    list.failUpdate = new TypeError('Failed to fetch');
    await expect(repo.save(planOf(270_000, true))).rejects.toThrow('Failed to fetch');
    expect(list.titles().filter((t) => t.includes('#')).length).toBeGreaterThan(partsBefore);
  });

  it('refuses a split plan with a part missing rather than reading half of it', async () => {
    const list = new FakeList();
    await (await opened(list)).save(planOf(250_000, true));
    list.rows = list.rows.filter((r) => !String(r.fields.Title).endsWith('#1'));
    await expect(new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load()).rejects.toThrow('missing a part');
  });

  it('reads again when another board replaced the plan between its row and its parts', async () => {
    const list = new FakeList();
    const writer = await opened(list);
    await writer.save(planOf(250_000, true));
    const before = structuredClone(list.rows);
    const next = { ...planOf(260_000, true), savedAt: '2026-10-13T02:00:00.000Z' };
    await writer.save(next);
    const after = structuredClone(list.rows);
    // The reader gets the plan's row as it was, then asks for a part just as
    // the other board's write lands and sweeps the parts that row named.
    list.rows = before;
    list.beforeFind = (title) => {
      if (title.includes('#')) {
        list.rows = after;
        list.beforeFind = null;
      }
    };
    const reader = new SharePointPlanRepository(cfg, 'ASSY_Plans', list);
    await expect(reader.load()).resolves.toEqual(next);
  });

  it('sweeps parts an unfinished write left over an hour ago, never a fresh one', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    const old = newGeneration(Date.now() - 2 * 3_600_000);
    const fresh = newGeneration(Date.now() - 60_000);
    await list.create({ Title: partTitle('current', old, 0), PlanJson: 'x' });
    await list.create({ Title: partTitle('current', fresh, 0), PlanJson: 'x' });
    await list.create({ Title: partTitle('day-2026-10-12', old, 0), PlanJson: 'x' });
    await repo.save(planOf(250_000, true));
    const titles = list.titles();
    expect(titles).not.toContain(partTitle('current', old, 0));
    expect(titles).toContain(partTitle('current', fresh, 0));
    expect(titles).toContain(partTitle('day-2026-10-12', old, 0));
  });

  it('files a large day once, split, and lists plans without their parts', async () => {
    const list = new FakeList();
    const repo = await opened(list);
    await repo.save(planOf(5_000, false));
    const day = planOf(250_000, true, 'day-2026-10-12');
    await repo.saveSnapshot(day);
    await repo.saveSnapshot({ ...day, savedAt: 'later' });
    expect(list.rows.filter((r) => r.fields.Title === 'day-2026-10-12')).toHaveLength(1);
    expect(await new SharePointPlanRepository(cfg, 'ASSY_Plans', list).load('day-2026-10-12')).toEqual(day);
    expect((await repo.list()).map((p) => p.id).sort()).toEqual(['current', 'day-2026-10-12']);
  });
});
