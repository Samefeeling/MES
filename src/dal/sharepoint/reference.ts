// SharePoint data layer — the reference lists: presses, people, reject and
// breakdown codes, part colours and dies, the factory calendar.
import { LISTS } from './schema';
import type {
  ProductDieColor,
  RejectCategory,
  Machine,
  Operator,
  Supervisor,
  BdCode,
} from '../../types';
import {
  str,
  getId,
  num,
  bool,
  resolveBreakdownMasterKey,
  resolveDieNumberKey,
  resolveDieDescKey,
  normaliseHex,
  readSiteZone,
  readCalendarDay,
} from './values';
import { bdFallback } from './rows';
import { isProductionMachine } from '../../core/maint';
import type { CalendarDay } from '../../core/utilization';
import { SharePointRest } from './rest';

export class SharePointReference extends SharePointRest {
  /**
   * Module-lived cache of PMD_ProductDieColor — the list is small (a
   * few thousand rows) and effectively read-only at runtime, but every
   * view (Operator / KPI / Trace) was re-fetching it on first render,
   * which is a 2-3 s round trip against the live tenant. Cache once,
   * reuse forever; the user can hard-refresh to repopulate.
   */
  protected dieColorCache: ProductDieColor[] | null = null;

  /** Small, read-only RejectCode → description catalogue. Keep the in-flight
   *  promise too: KPI loads floor + every machine Pareto concurrently, and
   *  all of them should share one PMD_RejectCategories request. A failed
   *  request clears the cache so the next refresh can retry. */
  protected rejectCategoryCache: Promise<RejectCategory[]> | null = null;

  // ---- reference lists ------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    const F = this.F.machine;
    // PMD_Machine also lists the plant maintenance looks after (a 3D
    // scanner, "AU - Encore Cold Saw"); the production pages want only the
    // nine presses and hot stamp.
    const rows = (await this.getAllItems(LISTS.machine)).filter((r) => isProductionMachine(str(r[F.code])));
    return rows.map((r, i) => ({
      id: getId(r),
      machineCode: str(r[F.code]),
      displayName: str(r[F.code]),
      sequence: num(r[F.displayOrder]) || i + 1,
      active: bool(r[F.active]) ?? true,
    }));
  }

  async listOperators(): Promise<Operator[]> {
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    return rows.map((r) => ({
      id: getId(r),
      operatorName: str(r[F.name]),
      active: true,
      shift: str(r[F.shift]).trim(),
    }));
  }

  async listSupervisors(): Promise<Supervisor[]> {
    // Supervisors are now derived from the distinct Supervisor_1 column
    // on PMD_Operator (a free-text field on each operator's row), not
    // from the separate PMD_Supervisor list. Drops the Lookup column
    // and the second REST round-trip on every boot — listOperators
    // already brings these rows back, so in practice this is free.
    // A supervisor named on operator rows of more than one shift is
    // emitted once per (name, shift) so the operator sheet's roster
    // filter can surface them on each shift they cover.
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    const seen = new Set<string>();
    const out: Supervisor[] = [];
    for (const r of rows) {
      const name = str(r[F.supervisor1]).trim();
      if (!name) continue;
      const shift = str(r[F.shift]).trim();
      const key = `${name}|${shift}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: out.length + 1, operatorName: name, active: true, shift });
    }
    return out;
  }

  async listRejectCategories(): Promise<RejectCategory[]> {
    if (!this.rejectCategoryCache) {
      const F = this.F.rejectCategories;
      this.rejectCategoryCache = this.getAllItems(LISTS.rejectCategories)
        .then((rows) =>
          rows
            .map((r, i) => ({
              code: str(r[F.code]).trim().toUpperCase(),
              label: str(r[F.description]).trim(),
              sequence: i + 1,
            }))
            .filter((r) => r.code),
        )
        .catch((e) => {
          this.rejectCategoryCache = null;
          throw e;
        });
    }
    return this.rejectCategoryCache;
  }

  async listBdCodes(): Promise<BdCode[]> {
    const F = this.F.breakdownMaster;
    try {
      const rows = await this.getAllItems(LISTS.breakdownMaster);
      if (rows.length === 0) return bdFallback();
      const codeKey = resolveBreakdownMasterKey(rows, [F.code, 'BDCODE', 'BDCode', 'Code']);
      const causeKey = resolveBreakdownMasterKey(rows, [F.cause, 'Cause', 'Title']);
      const categoryKey = resolveBreakdownMasterKey(rows, [F.category, 'Category']);
      const ownerKey = resolveBreakdownMasterKey(rows, [F.likelyOwner, 'LikelyOwner']);
      return rows
        .map((r, i) => ({
          code: codeKey ? str(r[codeKey]).trim().toUpperCase() : '',
          label: causeKey ? str(r[causeKey]).trim() : '',
          subCategory: categoryKey ? str(r[categoryKey]).trim() : '',
          sequence: i + 1,
          owner: ownerKey ? str(r[ownerKey]).trim() : '',
        }))
        .filter((row) => row.code);
    } catch {
      // If the list is empty / unreadable, fall back to the hard-coded
      // taxonomy so the cascade UI keeps working.
      return bdFallback();
    }
  }

  async listProductDieColors(opts: { fresh?: boolean } = {}): Promise<ProductDieColor[]> {
    // Cached after the first successful read — the list is small and
    // rarely changes at runtime; refetching it on every nav was a 2-3 s
    // round-trip per view. Operators hard-reload the page to pick up
    // colour list edits, which is the established workflow anyway.
    // `fresh` reads past the cache: the new-part matcher checks the list
    // as it stands right before it adds a row.
    if (this.dieColorCache && !opts.fresh) return this.dieColorCache;
    const F = this.F.productDieColor;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.productDieColor);
      if (rows.length === 0) {
        this.dieColorCache = [];
        return this.dieColorCache;
      }
      // Resolve the DieNumber column once against the first row. SP often
      // mangles display names with spaces into _x0020_ internal names,
      // and operators add the column with a few different conventions
      // ("DieNumber", "Die Number", "DieNum", "DieNo"), so probe the
      // common variants instead of giving up when the configured name
      // doesn't match. Logged so a missing column is obvious in F12.
      const dieKey = resolveDieNumberKey(rows[0], F.dieNumber);
      // The `Die` (description) column, same naming-variant tolerance.
      const dieDescKey = resolveDieDescKey(rows[0], F.die);
      this.dieColorKeys = { dieNumber: dieKey, die: dieDescKey };
      if (!dieKey) {
        console.warn(
          '[pmd] PMD_ProductDieColor: no DieNumber column matched. Keys present on row[0]:',
          Object.keys(rows[0]),
        );
      } else if (dieKey !== F.dieNumber) {
        console.info(
          '[pmd] PMD_ProductDieColor: resolved DieNumber as internal name',
          dieKey,
          '(field map default was',
          F.dieNumber + ')',
        );
      }
      // Direct field reads against the PartNum / ColorHex / ActualColor /
      // Category columns. Keep rows that carry a category even when the
      // hex is missing / invalid: they can't drive a swatch but still
      // bucket their part into the right KPI category subtotal.
      const direct = rows
        .map((r) => ({
          partNumber: str(r[F.partNum]).trim(),
          hex: normaliseHex(str(r[F.hex])),
          name: str(r[F.name]).trim(),
          category: str(r[F.category]).trim(),
          dieNumber: dieKey ? str(r[dieKey]).trim() : '',
          die: dieDescKey ? str(r[dieDescKey]).trim() : '',
          // CoRun Yes/No — true only on an explicit yes. SP Yes/No comes
          // back as a real boolean; a choice/text column as "Yes". Absent
          // column ⇒ undefined ⇒ false (parts default to NOT co-running).
          coRun: F.coRun ? bool(r[F.coRun]) === true : false,
        }))
        .filter((c) => c.partNumber && (c.hex || c.category || c.dieNumber || c.coRun));
      const withDie = direct.filter((c) => c.dieNumber).length;
      const withCoRun = direct.filter((c) => c.coRun).length;
      console.info(
        '[pmd] PMD_ProductDieColor cached:', direct.length, 'of', rows.length, 'rows ·',
        withDie, 'carry DieNumber ·', withCoRun, 'flagged CoRun=Yes',
      );
      this.dieColorCache = direct;
      return this.dieColorCache;
    } catch (e) {
      // Tenant without PMD_ProductDieColor → no swatch is fine; the
      // existing keyword-derived colour on KPIs takes over.
      // Do NOT cache the failure — the next call retries.
      console.warn('[pmd] PMD_ProductDieColor unavailable, swatches disabled:', e);
      throw e;
    }
  }

  /** PMD_ProductDieColor's DieNumber / Die internal names, as the last read
   *  resolved them — the columns a new row is written to. */
  protected dieColorKeys: { dieNumber: string | null; die: string | null } | null = null;

  async createProductDieColor(row: ProductDieColor): Promise<void> {
    if (!this.dieColorKeys) await this.listProductDieColors({ fresh: true });
    const keys = this.dieColorKeys;
    if (!keys?.dieNumber) {
      throw new Error('PMD_ProductDieColor has no DieNumber column the app can resolve');
    }
    const F = this.F.productDieColor;
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.productDieColor) },
      Title: row.partNumber,
      [F.partNum]: row.partNumber,
      [keys.dieNumber]: row.dieNumber,
    };
    if (row.hex) body[F.hex] = row.hex;
    if (row.name) body[F.name] = row.name;
    if (row.category) body[F.category] = row.category;
    if (row.die && keys.die) body[keys.die] = row.die;
    await this.post(`${this.listUrl(LISTS.productDieColor)}/items`, body);
    const { partNumber, hex, name, category, dieNumber, die, coRun } = row;
    this.dieColorCache?.push({ partNumber, hex, name, category, dieNumber, die, coRun });
  }

  async listPartDescriptions(): Promise<Map<string, string>> {
    const F = this.F.production;
    // Two columns of every header: light, however long the history.
    const rows = await this.getAllItems<Record<string, unknown>>(
      LISTS.production,
      `$select=${F.partNum},${F.partDesc}`,
    );
    const out = new Map<string, string>();
    for (const r of rows) {
      const part = str(r[F.partNum]).trim().toUpperCase();
      const desc = str(r[F.partDesc]).trim();
      if (part && desc) out.set(part, desc);
    }
    return out;
  }

  /**
   * The FactoryCalendar list's days, for Machine Utilization's available
   * hours. Its Date and Name columns are found by what they are, as the
   * Assembly board finds them: a column made as "Name" can come out as
   * `Name0`, and hidden built-in columns are titled "Name" too.
   */
  async listFactoryCalendar(): Promise<CalendarDay[]> {
    const env = await this.getJson<{ d: { results: Array<{ Title: string; InternalName: string; TypeAsString?: string }> } }>(
      `${this.listUrl(LISTS.factoryCalendar)}/fields?$filter=Hidden eq false and ReadOnlyField eq false&$select=Title,InternalName,TypeAsString`,
    );
    const titled = (title: string) =>
      env.d.results.filter((f) => f.Title.trim().toLowerCase() === title || f.InternalName.toLowerCase() === title);
    const date = titled('date').find((f) => /DateTime/i.test(f.TypeAsString ?? 'DateTime'));
    const name = titled('name').find((f) => f.InternalName !== 'Title');
    if (!date) throw new Error(`${LISTS.factoryCalendar}: no Date column`);
    // The days are the site's days, so they are read in the site's zone. A
    // site that will not say leaves them read the old way rather than fail
    // the page.
    const [rows, zone] = await Promise.all([
      this.getAllItems<Record<string, unknown>>(LISTS.factoryCalendar),
      this.getJson<unknown>(`${this.siteUrl}/_api/web/RegionalSettings/TimeZone`)
        .then(readSiteZone)
        .catch((e) => {
          console.warn('[pmd] FactoryCalendar: site time zone not read, days taken to the nearest UTC midnight', e);
          return null;
        }),
    ]);
    const out: CalendarDay[] = [];
    for (const r of rows) {
      const day = readCalendarDay(r[date.InternalName], zone);
      if (!day) continue;
      const raw = (name ? str(r[name.InternalName]) : '') || str(r['Title']);
      out.push({ day, name: raw.trim() || 'RDO' });
    }
    return out;
  }
}
