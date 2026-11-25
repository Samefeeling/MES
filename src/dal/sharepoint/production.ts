// SharePoint data layer — reading a shift: what this device is still
// editing, what the mirror shows of other devices, and the signed record.
import { LISTS } from './schema';
import type {
  ProductionRecord,
  RejectCategory,
  ProductionCounterRecord,
  ParetoFilter,
  ParetoSlice,
  ShiftCode,
  StatusCode,
  ProductionFilter,
  BreakdownLogDetail,
} from '../../types';
import { odataString, dateOnly, str, getId, num, nullOrNum } from './values';
import {
  shiftDateRange,
  onMachine,
  rejectMachineStatus,
  paretoFrom,
  type HeaderRow,
  shiftEndedLongAgo,
  LIVE_HARD_CAP_MS,
  DEVICE_COPY_MS,
  mirrorSignature,
  isStaleLiveHeader,
  productionMatches,
  timelineOf,
  parseShiftIdLoose,
  shiftDateRangeFromTo,
  type RejectRow,
  timelineToSlot,
} from './rows';
import { bdLabelFor, decodeBreakdownCauseMap } from '../../core/breakdown';
import { SharePointPlanning } from './planning';

/**
 * A read of a span of days, every press and every order — history, as Maint
 * and the Utilization chart read it, by the thousand rows. A read of one
 * press, one shift or one order is the operator sheet's and is left as it is.
 */
function isSpanRead(filter: ProductionFilter): boolean {
  return (
    Boolean(filter.shiftIdFrom || filter.shiftIdTo) && !filter.shiftId && !filter.machineCode && !filter.jobNumber
  );
}

export class SharePointProduction extends SharePointPlanning {
  /**
   * Cache of unsaved slot records for shifts the operator is currently
   * editing. Key = `${machineCode}|${shiftId}|${jobNumber}`. Flushed to
   * the three production lists on lockShift. Mirrored to localStorage on
   * every change so that an accidental nav (back/forward, top-nav tap)
   * or a page refresh does not wipe a half-filled shift — the operator's
   * data is preserved until sign-off explicitly clears it.
   */
  protected editCache = new Map<string, ProductionRecord[]>();

  protected static readonly EDIT_CACHE_KEY = 'pmd_edit_cache_v1';

  /**
   * Tuples (`machine|shiftId|jobNumber`) that the supervisor has just
   * unlocked from a signed-off state. While a tuple is in this set,
   * the listProduction self-heal will NOT purge its editCache entry
   * even though PMD_Production still carries the (locked) header —
   * those slots are the active editable copy. Cleared when lockShift
   * commits the edits back. Persisted alongside editCache so a page
   * reload mid-edit doesn't strand the operator with a "locked" UI
   * over their freshly-unlocked cache.
   */
  protected unlockedTuples = new Set<string>();

  protected static readonly UNLOCKED_TUPLES_KEY = 'pmd_unlocked_tuples_v1';

  /**
   * Unlocked tuples whose PMD_Production.Reopened = Yes this device has SEEN
   * on the server. The local unlock flag alone cannot tell "still open for
   * correction" from "another device has signed it off again": once the
   * server row of a tuple in this set reads Reopened = No, the correction
   * window is over and listProduction drops the local flag and the cache
   * with it. A tuple never seen reopened (a tenant without the column) is
   * never in here, and keeps the device-local behaviour. Persisted with
   * unlockedTuples.
   */
  protected reopenSeen = new Set<string>();

  protected static readonly REOPEN_SEEN_KEY = 'pmd_reopen_seen_v1';

  /**
   * The signed rows the server flags Reopened = Yes, as the last
   * listProduction read them: tuple key → its signed slots. Reopened makes
   * the row editable on EVERY device, but only the device that unlocked it
   * holds the rehydrated copy sign-off needs — so the first edit made
   * anywhere else adopts the tuple from this (upsertProductionRecord).
   */
  protected reopenedOnServer = new Map<string, ProductionRecord[]>();

  /**
   * Tuples whose editCache rows THIS DEVICE authored (an operator or
   * supervisor actually typed/tapped into them here), as opposed to
   * copies backfilled from PMD_LiveStatus purely for VIEWING another
   * press's shift. The distinction is load-bearing twice over:
   *
   *   - pushLiveSnapshot mirrors ONLY dirty tuples. Broadcasting every
   *     cached tuple made a device that merely glanced at another
   *     machine re-publish its stale copy every 60 s, overwriting the
   *     editing iPad's fresh mirror — the "full timeline collapsed
   *     back to one slot" / "iPad1 shows wrong Batt2 data" echo loop.
   *   - the live backfill REPLACES a non-dirty tuple wholesale, so a
   *     viewer always shows the mirror's current picture. (The old
   *     merge-by-absence kept the viewer's first-seen copy forever.)
   *
   * Persisted alongside editCache; pruned to the cache's keys on every
   * persist so it cannot grow unbounded.
   */
  protected dirtyTuples = new Set<string>();

  protected static readonly DIRTY_TUPLES_KEY = 'pmd_dirty_tuples_v1';

  /**
   * The signature (rows.ts `mirrorSignature`) of what this device last got
   * onto PMD_LiveStatus for each tuple it authored. A finished shift's copy
   * whose signature matches is safely on the server: it is not pushed again
   * (so a row a supervisor deleted by hand stays deleted) and the device may
   * let its own copy go. Persisted beside editCache, pruned to its keys.
   */
  protected mirrored = new Map<string, string>();

  protected static readonly MIRRORED_KEY = 'pmd_mirrored_v1';

  /** PMD_Production.ScheduleAttain is a number column formatted as a
   *  percentage (stores 0.875 for 87.5 %). Asked once per session (scheduleAttainAsFraction). */
  protected scheduleAttainFraction: Promise<boolean> | null = null;

  protected rehydrateEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointProduction.EDIT_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<[string, ProductionRecord[]]>;
      for (const [k, v] of parsed) this.editCache.set(k, v);
    } catch (e) {
      console.warn('[pmd] could not rehydrate edit cache:', e);
    }
  }

  protected rehydrateUnlockedTuples(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointProduction.UNLOCKED_TUPLES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as string[];
      for (const k of parsed) this.unlockedTuples.add(k);
      const seen = localStorage.getItem(SharePointProduction.REOPEN_SEEN_KEY);
      for (const k of seen ? (JSON.parse(seen) as string[]) : []) {
        if (this.unlockedTuples.has(k)) this.reopenSeen.add(k);
      }
    } catch (e) {
      console.warn('[pmd] could not rehydrate unlocked tuples:', e);
    }
  }

  protected persistUnlockedTuples(): void {
    // Only an unlocked tuple can be waiting on the server's re-lock.
    for (const k of this.reopenSeen) {
      if (!this.unlockedTuples.has(k)) this.reopenSeen.delete(k);
    }
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        SharePointProduction.UNLOCKED_TUPLES_KEY,
        JSON.stringify(Array.from(this.unlockedTuples)),
      );
      localStorage.setItem(
        SharePointProduction.REOPEN_SEEN_KEY,
        JSON.stringify(Array.from(this.reopenSeen)),
      );
    } catch (e) {
      console.warn('[pmd] could not persist unlocked tuples:', e);
    }
  }

  protected rehydrateMirrored(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointProduction.MIRRORED_KEY);
      for (const [k, v] of raw ? (JSON.parse(raw) as Array<[string, string]>) : []) this.mirrored.set(k, v);
    } catch (e) {
      console.warn('[pmd] could not rehydrate mirror signatures:', e);
    }
  }

  /** Is this device's copy of the tuple the one PMD_LiveStatus holds? */
  protected safelyMirrored(key: string, slots: ProductionRecord[]): boolean {
    return this.mirrored.get(key) === mirrorSignature(slots);
  }

  protected rehydrateDirtyTuples(): void {
    if (typeof localStorage === 'undefined') {
      // Node test env: no persistence, no migration needed.
      return;
    }
    try {
      const raw = localStorage.getItem(SharePointProduction.DIRTY_TUPLES_KEY);
      if (raw != null) {
        for (const k of JSON.parse(raw) as string[]) this.dirtyTuples.add(k);
        return;
      }
      // Migration: a cache persisted by a build that predates dirty
      // tracking can't tell authored tuples from viewed copies. Treat
      // everything present as authored (the old behaviour) so a real
      // half-filled shift is never clobbered by the first backfill;
      // precision starts with the next fresh tuple.
      for (const k of this.editCache.keys()) this.dirtyTuples.add(k);
    } catch (e) {
      console.warn('[pmd] could not rehydrate dirty tuples:', e);
    }
  }

  /**
   * Mark the cache dirty and write it to localStorage in the next
   * microtask. Callers can fire this on every keystroke / per-slot
   * upsert without paying for 10× full-cache stringifies during a
   * drag-fill — the coalesced write happens once per event-loop turn.
   */
  protected persistTimer: ReturnType<typeof setTimeout> | null = null;

  protected persistEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        // Dirty set rides along with the cache: prune keys whose cache
        // entry is gone (signed off / swept) so it tracks live tuples only.
        for (const k of this.dirtyTuples) {
          if (!this.editCache.has(k)) this.dirtyTuples.delete(k);
        }
        for (const k of Array.from(this.mirrored.keys())) {
          if (!this.editCache.has(k)) this.mirrored.delete(k);
        }
        localStorage.setItem(
          SharePointProduction.MIRRORED_KEY,
          JSON.stringify(Array.from(this.mirrored.entries())),
        );
        const payload = JSON.stringify(Array.from(this.editCache.entries()));
        localStorage.setItem(SharePointProduction.EDIT_CACHE_KEY, payload);
        localStorage.setItem(
          SharePointProduction.DIRTY_TUPLES_KEY,
          JSON.stringify(Array.from(this.dirtyTuples)),
        );
      } catch (e) {
        // Quota exceeded or private mode — caller will still get an
        // in-memory copy, we just won't survive a refresh.
        console.warn('[pmd] could not persist edit cache:', e);
      }
    }, 0);
  }

  // ---- management Pareto aggregations --------------------------------

  /**
   * Reject Pareto counts straight from PMD_Rejects — no production-record
   * JSON round-trip. RejectCategory on that event list is intentionally the
   * slot's MachineStatus (R/S/D/…), NOT a defect description, so labels are
   * resolved by RejectCode from PMD_RejectCategories instead. Server-side
   * lower-bounds the DateTime so the fetch stays small, then filters the
   * exact [from, to] day window client-side.
   */
  async listRejectPareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.rejects;
    // Start the shared catalogue read alongside the event read. If the
    // catalogue is temporarily unavailable the Pareto still shows the real
    // PMD_Rejects counts, labelled by code rather than by a false R/S status.
    const categoriesPromise = this.listRejectCategories().catch((e) => {
      console.warn('[pmd] listRejectPareto: PMD_RejectCategories read failed', e);
      return [] as RejectCategory[];
    });
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.paretoRows(LISTS.rejects, F.date, filter);
    } catch (e) {
      console.warn('[pmd] listRejectPareto: PMD_Rejects read failed', e);
      throw e;
    }
    const categories = await categoriesPromise;
    const labelByCode = new Map(categories.map((c) => [c.code, c.label || c.code]));
    const qty = new Map<string, number>();
    // Per-code Day/Afternoon/Night split so the KPI chart can stack the
    // bars by shift. PMD_Rejects.Shift is written from the shiftId at
    // sign-off, so it's always one of the three codes; an unexpected
    // value is simply not attributed to a shift (the bar would then be
    // shorter than `value`, but that doesn't happen with real data).
    const shiftTally = new Map<string, Record<ShiftCode, number>>();
    const statusTally = new Map<
      string,
      Partial<Record<StatusCode | 'Unknown', number>>
    >();
    for (const r of rows) {
      if (!onMachine(r[F.machine], filter.machineCode)) continue;
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.rejectCode]).trim().toUpperCase();
      if (!code) continue;
      const n = num(r[F.rejectNumber]);
      if (n <= 0) continue;
      qty.set(code, (qty.get(code) ?? 0) + n);
      // RejectCategory is the status snapshot by design. Keep it as an
      // independent analytical dimension: R rejects happened during normal
      // production, while S/C/D/I/P etc provide startup/changeover context.
      const status = rejectMachineStatus(str(r[F.rejectCategory]));
      const statuses = statusTally.get(code) ?? {};
      statuses[status] = (statuses[status] ?? 0) + n;
      statusTally.set(code, statuses);
      const shift = str(r[F.shift]).trim();
      if (shift === 'Day' || shift === 'Afternoon' || shift === 'Night') {
        const st = shiftTally.get(code) ?? { Day: 0, Afternoon: 0, Night: 0 };
        st[shift] += n;
        shiftTally.set(code, st);
      }
    }
    return paretoFrom(
      qty,
      (code) => labelByCode.get(code) || code,
      (code) => shiftTally.get(code),
      (code) => statusTally.get(code),
    );
  }

  /**
   * Downtime Pareto from PMD_BreakDownlog — sums the B_BreakDown hours per
   * BDCode (the clearest single attribution the log carries). Label is the
   * breakdown cause from the taxonomy. Rows with a blank BDCode or zero
   * breakdown hours contribute nothing.
   */
  async listDowntimePareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.breakdown;
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.paretoRows(LISTS.breakdown, F.date, filter);
    } catch (e) {
      console.warn('[pmd] listDowntimePareto: PMD_BreakDownlog read failed', e);
      throw e;
    }
    const hrs = new Map<string, number>();
    for (const r of rows) {
      if (!onMachine(r[F.machine], filter.machineCode)) continue;
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.bdCode]).trim();
      if (!code) continue;
      const h = num(r[F.b]);
      if (h <= 0) continue;
      hrs.set(code, (hrs.get(code) ?? 0) + h);
    }
    return paretoFrom(hrs, (code) => bdLabelFor(code) || code);
  }

  /**
   * PMD_Rejects / PMD_BreakDownlog rows for a Pareto window, every press.
   * The KPI page asks for the floor and each press over the same window at
   * once; every call reads the same URL, so they share one request (see
   * shareRead) and each picks its press out of the rows, instead of one
   * more read per press. The window is a day wider on each side to catch
   * the noon-UTC marker and legacy local-start rows; callers keep the
   * exact days via dateOnly.
   */
  protected paretoRows(list: string, field: string, filter: ParetoFilter): Promise<Record<string, unknown>[]> {
    return this.getAllItems(list, '$filter=' + encodeURIComponent(shiftDateRange(filter.from, field, filter.to)));
  }

  // ---- production (header / events) ----------------------------------
  //
  // PmdDataLayer is per-slot, but PMD_Production is per-(machine,shift,job).
  // We keep an in-memory cache of slot edits while a shift is being filled
  // and flush to the three lists on lockShift.

  protected cacheKey(mc: string, sid: string, job: string): string {
    return `${mc}|${sid}|${job}`;
  }

  /** Lightweight production-header read for the mould service planner.
   *  It applies the same signed-over-live precedence as listProduction,
   *  but intentionally skips PMD_Rejects, breakdown timelines and the
   *  16-slot expansion. That makes a 400-day shot ledger practical. */
  async listProductionCounters(filter: ProductionFilter): Promise<ProductionCounterRecord[]> {
    const [prodHeaders, liveHeaders] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchHeaders(LISTS.liveStatus, filter).catch((e) => {
        console.warn('[pmd] service counters: PMD_LiveStatus read failed:', e);
        return [] as HeaderRow[];
      }),
    ]);
    const matches = (h: HeaderRow): boolean => {
      const sid = `${h.date}-${h.shift}`;
      if (filter.shiftId && sid !== filter.shiftId) return false;
      if (filter.shiftIdFrom && sid < filter.shiftIdFrom) return false;
      if (filter.shiftIdTo && sid > filter.shiftIdTo) return false;
      if (filter.machineCode && h.machineCode !== filter.machineCode) return false;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) return false;
      return true;
    };
    const signed = new Map<string, HeaderRow>();
    const chosen = new Map<string, HeaderRow>();
    for (const h of prodHeaders) {
      if (!matches(h)) continue;
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      signed.set(key, h);
      chosen.set(key, h);
    }
    const now = new Date();
    for (const h of liveHeaders) {
      if (!matches(h)) continue;
      const sid = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, sid, h.jobNumber);
      if (
        !this.unlockedTuples.has(key) &&
        (shiftEndedLongAgo(sid, now, LIVE_HARD_CAP_MS) || isStaleLiveHeader(h, now))
      )
        continue;
      const prod = signed.get(key);
      if (!prod) {
        chosen.set(key, h);
        continue;
      }
      // A fresh live correction may replace its Reopened signed header;
      // an ordinary live shadow never double-counts a signed tuple.
      const pmod = prod.modified ? Date.parse(prod.modified) : NaN;
      const lmod = h.modified ? Date.parse(h.modified) : NaN;
      if (prod.reopened && !Number.isNaN(lmod) && (Number.isNaN(pmod) || lmod > pmod))
        chosen.set(key, h);
    }
    const counters = new Map<string, ProductionCounterRecord>();
    for (const [key, h] of chosen) {
      counters.set(key, {
        machineCode: h.machineCode,
        shiftId: `${h.date}-${h.shift}`,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        countStart: h.countStart,
        countEnd: h.countEnd,
        cavities: h.cavities,
        timeline: h.timeline,
      });
    }
    // Counts being edited on this device can be newer than the 60-second
    // live mirror. Only locally-authored/unlocked tuples may override;
    // spectator cache copies are deliberately ignored.
    for (const rows of this.editCache.values()) {
      const r = rows.find((x) => x.slotIndex === 0);
      if (!r || !productionMatches(r, filter)) continue;
      const key = this.cacheKey(r.machineCode, r.shiftId, r.jobNumber);
      if (!this.dirtyTuples.has(key) && !this.unlockedTuples.has(key)) continue;
      if (signed.has(key) && !this.unlockedTuples.has(key)) continue;
      counters.set(key, {
        machineCode: r.machineCode,
        shiftId: r.shiftId,
        jobNumber: r.jobNumber,
        partNumber: r.partNumber,
        countStart: r.countStart,
        countEnd: r.countEnd,
        cavities: r.cavities,
        timeline: timelineOf(rows),
      });
    }
    return [...counters.values()];
  }

  async listProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    // Hydrate header rows from PMD_Production (signed-off) AND
    // PMD_LiveStatus (in-progress mirror) first — precedence is
    //   signed-off  >  local editCache  >  live mirror.
    // Signed-off is the immutable record of truth: once a (machine,
    // shift, job) has a PMD_Production header, any editCache rows for
    // the same tuple are stale by definition (taps that slipped in
    // around sign-off, or another iPad's pre-sign-off localStorage)
    // and must not shadow it — that's how a signed-off order with 53
    // goods rendered as an empty, editable timeline. Purge them.
    const [prodHeaders, liveHeaders, rejectsByKey, breakdownByKey] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchHeaders(LISTS.liveStatus, filter).catch((e) => {
        // The live list may not exist yet on a fresh tenant — fall
        // back to "no live rows" so the rest of the page still loads.
        console.warn('[pmd] PMD_LiveStatus read failed (treating as empty):', e);
        return [] as HeaderRow[];
      }),
      this.fetchRejectsByKey(filter),
      this.fetchBreakdownDetailsByKey(filter).catch((e) => {
        console.warn('[pmd] PMD_BreakDownLog read failed (details unavailable):', e);
        return new Map<string, BreakdownLogDetail>();
      }),
    ]);

    const matchesFilter = (h: HeaderRow): boolean => {
      // Defensive re-filter. shiftDateRange is intentionally loose
      // (±1 d) to catch legacy noon-UTC / local-start timestamps; with
      // the F.shift clause it also catches the same shift code on
      // adjacent calendar dates — yesterday's Day shift would leak
      // into a "today's Day shift" query.
      const hShiftId = `${h.date}-${h.shift}`;
      if (filter.shiftId && hShiftId !== filter.shiftId) return false;
      if (filter.shiftIdFrom && hShiftId < filter.shiftIdFrom) return false;
      if (filter.shiftIdTo && hShiftId > filter.shiftIdTo) return false;
      if (filter.machineCode && h.machineCode !== filter.machineCode) return false;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) return false;
      return true;
    };

    // Self-heal: drop editCache entries whose tuple is already signed
    // off. lockShift deletes the cache on the device that signed off,
    // but other iPads (or a tap that raced the sign-off) can still
    // hold stale rows in localStorage.
    const signedKeys = new Set(
      prodHeaders
        .filter(matchesFilter)
        .map((h) => this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber)),
    );
    // Last-commit time of each signed PMD_Production tuple (SP Modified,
    // server clock). lockShift is the only writer of that row, so its
    // Modified == the sign-off time.
    const prodModMsByKey = new Map<string, number>();
    // Tuples whose signed row carries Reopened=Yes — the server-authoritative
    // "a supervisor re-opened this for correction" flag. Only these may be
    // shadowed by a fresher live mirror (see reEditedKeys below).
    const prodReopenedKeys = new Set<string>();
    for (const h of prodHeaders) {
      if (!matchesFilter(h)) continue;
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      const t = h.modified ? Date.parse(h.modified) : NaN;
      prodModMsByKey.set(key, isNaN(t) ? 0 : t);
      if (h.reopened) prodReopenedKeys.add(key);
    }
    // What the server says is open for correction right now. Kept so a
    // device that did not do the unlock can still adopt the tuple on its
    // first edit (upsertProductionRecord); a tuple this read covers and no
    // longer finds reopened is forgotten.
    const inThisRead = (k: string): boolean => {
      const [machineCode = '', shiftId = '', ...job] = k.split('|');
      return productionMatches(
        { machineCode, shiftId, jobNumber: job.join('|') } as ProductionRecord,
        filter,
      );
    };
    for (const k of Array.from(this.reopenedOnServer.keys())) {
      if (inThisRead(k) && !prodReopenedKeys.has(k)) this.reopenedOnServer.delete(k);
    }
    for (const h of prodHeaders) {
      if (!matchesFilter(h) || !h.reopened) continue;
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: breakdownByKey.get(key)?.timeline ?? '' };
      this.reopenedOnServer.set(
        key,
        this.expandHeaderToSlots(
          hWithTimeline,
          rejectsByKey.get(key) ?? [],
          true,
          breakdownByKey.get(key),
        ),
      );
    }
    // The server's Reopened flag is the authority on whether a correction
    // window is still open. A local unlock the server has confirmed
    // (Reopened = Yes was read back) ends the moment the row reads
    // Reopened = No again: some device has signed the correction off, and
    // holding on to the local flag would let this device's now-stale copy
    // shadow the newly signed record for good. An unlock the server never
    // confirmed (no Reopened column on the tenant) stays device-local.
    let unlockChanged = false;
    for (const k of signedKeys) {
      if (!this.unlockedTuples.has(k)) continue;
      if (prodReopenedKeys.has(k)) {
        if (!this.reopenSeen.has(k)) {
          this.reopenSeen.add(k);
          unlockChanged = true;
        }
      } else if (this.reopenSeen.has(k)) {
        this.unlockedTuples.delete(k);
        this.reopenSeen.delete(k);
        unlockChanged = true;
      }
    }
    if (unlockChanged) this.persistUnlockedTuples();
    let purged = false;
    for (const k of Array.from(this.editCache.keys())) {
      if (!signedKeys.has(k)) continue;
      // Active "unlock & edit": the supervisor unlocked this tuple
      // and the editCache holds the rehydrated rows that the operator
      // is currently editing. PMD_Production still carries the
      // (locked) row because the new unlock design does NOT delete
      // it on the SP side — that's the whole point of the redesign.
      // Self-heal would otherwise wipe the operator's edits the next
      // time anything reads the production list.
      if (this.unlockedTuples.has(k)) continue;
      this.editCache.delete(k);
      // The copy is gone and so is this device's authorship of it: left
      // marked, a spectator copy backfilled below would be re-broadcast
      // from here as if it had been typed here.
      this.dirtyTuples.delete(k);
      purged = true;
    }

    // Drop "junk" PMD_LiveStatus rows: shift ended > 8 h ago AND no
    // MachineStatus letter on any slot. These accumulate when an
    // operator taps a machine, picks a wrong job (or just lands on
    // the wrong shift / date), maybe types a Count Start, and walks
    // away — pushLiveSnapshot had already mirrored the partial cache
    // and there was no path to clean it up. Without this filter, the
    // backfill loop below absorbs them into editCache and shadows
    // the legitimate PMD_Production row when an operator scrolls
    // back to review a past shift. Also fire-and-forget delete the
    // junk from PMD_LiveStatus so the SP list itself stays tidy.
    const liveNow = new Date();
    const liveFresh: HeaderRow[] = [];
    for (const h of liveHeaders) {
      const hSid = `${h.date}-${h.shift}`;
      // Retention cap (LIVE_HARD_CAP_MS, 62 days): sweep ANY live row whose
      // shift ended longer ago than that, status or not. This is the only
      // path that removes an OLD row that DOES carry status —
      // isStaleLiveHeader deliberately leaves those alone. Within the cap
      // such a row is unsigned work, and KPIs must still see it as such. A
      // tuple actively unlocked for correction is exempt (its live mirror
      // is the supervisor's in-progress re-edit).
      if (
        shiftEndedLongAgo(hSid, liveNow, LIVE_HARD_CAP_MS) &&
        !this.unlockedTuples.has(this.cacheKey(h.machineCode, hSid, h.jobNumber))
      ) {
        void this.deleteLiveRow(h.machineCode, hSid, h.jobNumber);
        continue;
      }
      if (isStaleLiveHeader(h, liveNow)) {
        void this.deleteLiveRow(h.machineCode, hSid, h.jobNumber);
      } else {
        liveFresh.push(h);
      }
    }

    // Detect signed-off tuples that have since been UNLOCKED and are being
    // RE-EDITED — the source-conflict that made a PC's Trace keep showing
    // the morning's signed data while the floor iPad corrected it. unlock
    // is a client-side flag (device-local), so another device only sees
    // the still-locked PMD_Production row plus a fresh PMD_LiveStatus row.
    // A live row for a signed tuple wins ONLY when the signed row is flagged
    // Reopened=Yes (server-authoritative unlock) AND the live mirror is
    // fresher than the prod row's last commit — that's a supervisor's
    // in-progress correction and must show on every device. A fresher live
    // row on a NOT-reopened tuple is junk by definition (e.g. another iPad's
    // leftover editCache re-mirrored AFTER a different device signed off —
    // the SFM507147 case that hid a signed order from the KPIs): the signed
    // row stays canonical and the shadow is deleted on sight. Timestamp alone
    // used to decide this, which let that junk shadow win.
    const reEditedKeys = new Set<string>();
    for (const h of liveFresh) {
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      const pmod = prodModMsByKey.get(key);
      if (pmod == null || pmod === 0) continue; // not signed, or no timestamp
      const lmod = h.modified ? Date.parse(h.modified) : NaN;
      const fresher = !isNaN(lmod) && lmod > pmod;
      if (!fresher) continue;
      if (prodReopenedKeys.has(key)) {
        reEditedKeys.add(key);
        continue;
      }
      // Fresher shadow on a signed, not-reopened tuple. Clean it up unless
      // THIS device just unlocked it locally (tenant without the Reopened
      // column falls back to the device-local flag — don't eat its edits).
      if (!this.unlockedTuples.has(key)) {
        void this.deleteLiveRow(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      }
    }
    // GC editCache: drop any status-empty tuple whose shift ended > 8 h
    // ago. UNCONDITIONAL — this must run even when there are no stale
    // server rows left to react to (e.g. the supervisor already deleted
    // the junk from PMD_LiveStatus by hand). Gating it on "saw a stale
    // server row" was the bug that let pushLiveSnapshot keep re-mirroring
    // the local copy straight back onto the list. Real local work (status
    // set) goes only once the server has it, or past LIVE_HARD_CAP_MS.
    for (const k of Array.from(this.editCache.keys())) {
      const slots = this.editCache.get(k) ?? [];
      const sid = k.split('|')[1];
      if (!sid) continue;
      // A tuple a supervisor has just UNLOCKED for correction is exempt
      // from every age sweep — it may legitimately target a months-old
      // shift, and dropping it mid-edit would lose the correction before
      // re-sign-off commits it.
      if (this.unlockedTuples.has(k)) continue;
      // The retention cap mirrors the live-row sweep above.
      if (shiftEndedLongAgo(sid, liveNow, LIVE_HARD_CAP_MS)) {
        this.editCache.delete(k);
        purged = true;
        continue;
      }
      // A day after the shift, this device lets its copy go once the server
      // has it: a copy it only viewed, or one whose last state it pushed.
      // Its own copy that never reached PMD_LiveStatus is the only record of
      // that work — kept, and pushed whenever the mirror next can. (Dropping
      // every copy at 24 h was one way a forgotten sign-off went missing.)
      if (
        shiftEndedLongAgo(sid, liveNow, DEVICE_COPY_MS) &&
        (!this.dirtyTuples.has(k) || this.safelyMirrored(k, slots))
      ) {
        this.editCache.delete(k);
        purged = true;
        continue;
      }
      // Status-empty mis-taps: drop after the shorter 8 h grace.
      if (slots.some((s) => s.statusCode)) continue;
      if (shiftEndedLongAgo(sid, liveNow)) {
        this.editCache.delete(k);
        purged = true;
      }
    }
    if (purged) this.persistEditCache();

    // Backfill editCache from PMD_LiveStatus per slot. PMD_LiveStatus
    // is pushed every 60 s from whichever iPad is editing, and is the
    // only durable source for in-progress slots — if localStorage is
    // stale (page reload between snapshot pushes, fresh device, cleared
    // cache, asset redeploy that forced a refresh) the local cache can
    // be missing slots the broker actually has. Without this merge a
    // subsequent Sign Off & Save aggregates only the local cache and
    // burns a partial timeline into PMD_Production — exactly the
    // SFM507068 14:23 incident.
    //
    // editCache wins per slot — but ONLY for tuples this device actually
    // AUTHORED (dirtyTuples). A copy that landed here purely for viewing
    // (a spectator PC, or an iPad glancing at another press's shift) is
    // stale by definition and must be REPLACED by the mirror's current
    // picture wholesale: the old merge-by-absence kept whatever the
    // viewer first saw forever — PC poll fetches reject=23 from
    // PMD_LiveStatus but its own editCache slot 0 (from an earlier
    // glance at the job) still says reject=1, and the "add only what we
    // lack" merge silently keeps the stale 1. Same bug masked half the
    // QC sign-offs on remote viewers and froze iPad1's view of Batt2 at
    // whatever it backfilled first.
    //
    // Rules:
    //   - tuple signed off → skip; PMD_Production is canonical.
    //   - tuple not authored here (read-only device, or a writable
    //     device that only viewed it) → REPLACE editCache with the live
    //     expansion. We're a spectator for this tuple.
    //   - tuple authored here → merge-by-absence so locally-edited
    //     slots not yet pushed survive.
    const writable = this.canWriteHook();
    let backfilled = false;
    for (const h of liveFresh) {
      if (!matchesFilter(h)) continue;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      // Signed tuples normally skip the live backfill (PMD_Production is
      // canonical). EXCEPT a tuple being re-edited after unlock: its live
      // mirror is fresher than the signed row, so let it backfill and win.
      if (signedKeys.has(key) && !reEditedKeys.has(key)) continue;
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: breakdownByKey.get(key)?.timeline ?? '' };
      const liveSlots = this.expandHeaderToSlots(
        hWithTimeline,
        rejectsByKey.get(key) ?? [],
        false,
        breakdownByKey.get(key),
      );
      if (!writable || !this.dirtyTuples.has(key)) {
        this.editCache.set(key, liveSlots);
        backfilled = true;
        continue;
      }
      const existing = this.editCache.get(key) ?? [];
      const haveSlot = new Set(existing.map((s) => s.slotIndex));
      let added = false;
      for (const ls of liveSlots) {
        if (haveSlot.has(ls.slotIndex)) continue;
        existing.push(ls);
        added = true;
      }
      if (added) {
        this.editCache.set(key, existing);
        backfilled = true;
      }
    }
    if (backfilled) this.persistEditCache();

    // Local edits for tuples that are NOT signed off.
    const cached: ProductionRecord[] = [];
    for (const list of this.editCache.values()) {
      for (const r of list) if (productionMatches(r, filter)) cached.push(r);
    }
    const seen = new Set(cached.map((r) => this.cacheKey(r.machineCode, r.shiftId, r.jobNumber)));

    const ingest = (h: HeaderRow, isSignedOff: boolean): void => {
      if (!matchesFilter(h)) return;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      if (seen.has(key)) return;
      seen.add(key);
      // Splice the breakdown-side timeline onto the header so
      // expandHeaderToSlots can decode it. Without this, every
      // signed-off shift comes back with an empty timeline → no
      // Machine Status row, and every reject collapses into the
      // canonical slot 0 (07:00–07:30 for Day shift).
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: breakdownByKey.get(key)?.timeline ?? '' };
      cached.push(
        ...this.expandHeaderToSlots(
          hWithTimeline,
          rejectsByKey.get(key) ?? [],
          isSignedOff,
          breakdownByKey.get(key),
        ),
      );
    };

    // Signed-off first so it wins any (rare) overlap with a not-yet-
    // deleted live row — EXCEPT a re-edited tuple, whose stale signed row
    // must not shadow the fresh live data the backfill just emitted.
    for (const h of prodHeaders) {
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      if (reEditedKeys.has(key)) continue;
      ingest(h, true);
    }
    // Live rows already merged into editCache above; the ingest pass
    // still runs them to cover tuples that fall outside the editCache
    // filter (e.g. cross-machine Live Status board reads) — the
    // seen-set dedups any already-emitted tuple.
    for (const h of liveFresh) ingest(h, false);
    return cached;
  }

  /**
   * Signed-off history only: reads PMD_Production exclusively — no
   * PMD_LiveStatus mirror, no local editCache. The Trace "Job Number
   * Search" uses this so a historical lookup reflects the canonical
   * source of truth (the signed-off record) and never blends in
   * in-progress / mis-typed live data that hasn't been reviewed. Rejects
   * and breakdown timelines are still joined so each row expands to the
   * correct per-slot status + reject breakdown.
   */
  async listSignedOffProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    const [prodHeaders, rejectsByKey, breakdownByKey] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchRejectsByKey(filter),
      this.fetchBreakdownDetailsByKey(filter).catch((e) => {
        console.warn('[pmd] PMD_BreakDownLog read failed (details unavailable):', e);
        return new Map<string, BreakdownLogDetail>();
      }),
    ]);
    const out: ProductionRecord[] = [];
    for (const h of prodHeaders) {
      // shiftDateRange is intentionally loose (±1 d) — re-filter exactly
      // against the requested predicates so adjacent-day rows that share
      // the shift code don't leak in.
      const hShiftId = `${h.date}-${h.shift}`;
      if (filter.shiftId && hShiftId !== filter.shiftId) continue;
      if (filter.shiftIdFrom && hShiftId < filter.shiftIdFrom) continue;
      if (filter.shiftIdTo && hShiftId > filter.shiftIdTo) continue;
      if (filter.machineCode && h.machineCode !== filter.machineCode) continue;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) continue;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: breakdownByKey.get(key)?.timeline ?? '' };
      out.push(
        ...this.expandHeaderToSlots(
          hWithTimeline,
          rejectsByKey.get(key) ?? [],
          true,
          breakdownByKey.get(key),
        ),
      );
    }
    return out;
  }

  /**
   * Read header rows from PMD_Production OR PMD_LiveStatus. Both
   * share the production field map by design — PMD_LiveStatus is a
   * column-for-column mirror of PMD_Production, holding the same
   * tuple until Sign Off & Save copies it across and deletes it
   * here.
   */
  protected async fetchHeaders(list: string, filter: ProductionFilter): Promise<HeaderRow[]> {
    const F = this.F.production;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNumber} eq '${odataString(filter.jobNumber)}'`);
    // F.date points at SlotStart_x003a_ (DateTime). Filter with datetime'...'
    // and combine with ShiftId for an exact-shift match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.headerRows(list, qs, filter);
    const headers: HeaderRow[] = rows.map((r) => ({
      id: getId(r),
      machineCode: str(r[F.machine]),
      date: dateOnly(r[F.date]),
      shift: str(r[F.shift]),
      jobNumber: str(r[F.jobNumber]),
      partNumber: F.partNum ? str(r[F.partNum]).trim() : '',
      partDescription: F.partDesc ? str(r[F.partDesc]) : '',
      jobRequired: F.jobRequired ? num(r[F.jobRequired]) : 0,
      cycleTime: F.cycleTime ? num(r[F.cycleTime]) : 0,
      // Cavities stays undefined when the column is absent / empty — every
      // Good figure reads that as 1 (a 0 from a blank cell must not zero
      // the multiplier), but the operator sheet must be able to tell "no
      // number yet" (fill it from PMD_DieMaster) from a 1 somebody set
      // because a cavity was blocked off (leave it alone).
      cavities: F.cavities && num(r[F.cavities]) > 0 ? num(r[F.cavities]) : undefined,
      // The 16-char status timeline lives in the MachineCode column on
      // this tenant; prefer it over the (empty / fallback) F.timeline
      // entry so listProduction can rebuild per-slot status without a
      // round-trip to PMD_BreakDownlog.
      timeline:
        (F.machineCodeAlt && str(r[F.machineCodeAlt])) ||
        (F.timeline && str(r[F.timeline])) ||
        '',
      countStart: nullOrNum(r[F.countStart]),
      countEnd: nullOrNum(r[F.countEnd]),
      reject: num(r[F.reject]),
      operator: str(r[F.operator]),
      supervisor: str(r[F.supervisor]),
      runTime: F.runTime ? num(r[F.runTime]) : 0,
      downTime: num(r[F.downTime]),
      // Handover is the JSON {machine,mold,material,method} blob (the
      // "4M"), stored when the shift was signed off. Used by the
      // operator side-panel textareas and the KPI Handover column.
      handover: F.handover ? str(r[F.handover]) : '',
      qcChecks: F.qcChecks ? str(r[F.qcChecks]) : '',
      rejectsBySlot: F.rejectsBySlot ? str(r[F.rejectsBySlot]) : '',
      ownerDevice: F.ownerDevice ? str(r[F.ownerDevice]) : '',
      signOff: F.signOff ? str(r[F.signOff]) : '',
      // Strict native-boolean check, NOT bool(): a Yes/No column returns true/
      // false in verbose OData. If the column was provisioned as text/Choice
      // by mistake, a string like "Yes" must NOT read as reopened — that would
      // unlock the row everywhere and hide it from the KPIs (locked-only view)
      // with no way to clear it (boolean writes 400 on a text column).
      reopened: F.reopened ? r[F.reopened] === true : false,
      jobLeft: F.jobLeft && r[F.jobLeft] != null ? num(r[F.jobLeft]) : -1,
      shiftTarget: F.shiftTarget && r[F.shiftTarget] != null ? num(r[F.shiftTarget]) : -1,
      vsPlan: F.vsPlan && r[F.vsPlan] != null ? num(r[F.vsPlan]) : -1,
      scheduleAttain: F.scheduleAttain ? nullOrNum(r[F.scheduleAttain]) ?? -1 : -1,
      schedulePlan: F.schedulePlan ? nullOrNum(r[F.schedulePlan]) ?? -1 : -1,
      plannedStart: F.plannedStart ? str(r[F.plannedStart]) : '',
      // Built-in SP column, always present in the verbose payload.
      modified: str(r['Modified']),
    }));
    // A ScheduleAttain column shown as a percentage stores 0.875 for 87.5 %.
    // Only asked once there is a value to scale.
    if (headers.some((h) => h.scheduleAttain >= 0) && (await this.scheduleAttainAsFraction())) {
      for (const h of headers) {
        if (h.scheduleAttain >= 0) h.scheduleAttain = Math.round(h.scheduleAttain * 10_000) / 100;
      }
    }
    return headers;
  }

  /** Reads of a span of days, every press and every order, on the wire. */
  protected spanReadsInFlight: Array<{
    list: string;
    lo: number;
    hi: number;
    writes: number;
    rows: Promise<Record<string, unknown>[]>;
  }> = [];

  /**
   * The rows of a header read.
   *
   * A read of a span of days — every press, every order — joins one already
   * on the wire that asks for those days and more, instead of downloading
   * them a second time: Maint asks for 400 days of shot counters and 90 days
   * of records in the same breath, and the second lies inside the first.
   * The rows are cut back to the days the narrower request names, so its
   * caller gets what its own request would have returned. As with
   * shareRead, a read only joins one that started after the last write, and
   * only while that one is still in flight: this is not a cache.
   */
  protected headerRows(list: string, qs: string, filter: ProductionFilter): Promise<Record<string, unknown>[]> {
    const span =
      isSpanRead(filter) && filter.shiftIdFrom && filter.shiftIdTo
        ? {
            // The same days shiftDateRange asks SharePoint for.
            lo: Date.parse(`${filter.shiftIdFrom.slice(0, 10)}T00:00:00.000Z`) - 86_400_000,
            hi: Date.parse(`${filter.shiftIdTo.slice(0, 10)}T00:00:00.000Z`) + 2 * 86_400_000,
          }
        : null;
    if (!span || !Number.isFinite(span.lo) || !Number.isFinite(span.hi)) return this.getAllItems(list, qs);
    const wider = this.spanReadsInFlight.find(
      (r) => r.list === list && r.writes === this.writesStarted && r.lo <= span.lo && r.hi >= span.hi,
    );
    if (wider) {
      if (wider.lo === span.lo && wider.hi === span.hi) return wider.rows.then((rows) => rows.slice());
      const date = this.F.production.date;
      return wider.rows.then((rows) =>
        rows.filter((r) => {
          const at = Date.parse(str(r[date]));
          return at >= span.lo && at <= span.hi;
        }),
      );
    }
    // History by the thousand rows: only the columns a header is read from.
    const columns = [...Object.values(this.F.production), 'Modified'];
    const entry = { list, ...span, writes: this.writesStarted, rows: this.getColumnItems(list, columns, qs) };
    const settled = (): void => {
      this.spanReadsInFlight = this.spanReadsInFlight.filter((r) => r !== entry);
    };
    entry.rows.then(settled, settled);
    this.spanReadsInFlight.push(entry);
    return entry.rows;
  }

  /** A missing column, or a tenant that does not expose the flag, reads as
   *  a plain number. */
  protected scheduleAttainAsFraction(): Promise<boolean> {
    const field = this.F.production.scheduleAttain;
    if (!field) return Promise.resolve(false);
    this.scheduleAttainFraction ??= this.getJson<{ d: { ShowAsPercentage?: boolean } }>(
      `${this.listUrl(LISTS.production)}/fields/getbyinternalnameortitle('${odataString(field)}')`,
    ).then(
      (f) => f.d.ShowAsPercentage === true,
      () => false,
    );
    return this.scheduleAttainFraction;
  }

  /**
   * Pull StatusTimeline strings keyed by (machine|shiftId|jobNumber) from
   * PMD_BreakDownlog so listProduction can splice them onto the header
   * rows that come back from PMD_Production. PMD_Production no longer
   * carries the timeline directly (Status column was deleted from the
   * tenant) — without this fetch, every signed-off shift would come back
   * with no Machine Status row and rejects collapsed to slot 0.
   */
  async listBreakdownDetails(filter: ProductionFilter): Promise<BreakdownLogDetail[]> {
    const F = this.F.breakdown;
    if (!F.statusTimeline) return [];
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${odataString(filter.jobNumber)}'`);
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await (isSpanRead(filter)
      ? this.getColumnItems<Record<string, unknown>>(LISTS.breakdown, Object.values(F), qs)
      : this.getAllItems<Record<string, unknown>>(LISTS.breakdown, qs));
    const out: BreakdownLogDetail[] = [];
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const tl = str(r[F.statusTimeline]);
      if (filter.shiftId && sid !== filter.shiftId) continue;
      if (filter.shiftIdFrom && sid < filter.shiftIdFrom) continue;
      if (filter.shiftIdTo && sid > filter.shiftIdTo) continue;
      if (filter.machineCode && mc !== filter.machineCode) continue;
      if (filter.jobNumber && job !== filter.jobNumber) continue;
      const dominantCode = str(r[F.bdCode]);
      out.push({
        machineCode: mc,
        shiftId: sid,
        jobNumber: job,
        timeline: tl,
        slots: decodeBreakdownCauseMap(str(r[F.bdCause]), dominantCode, tl),
      });
    }
    return out;
  }

  protected async fetchBreakdownDetailsByKey(
    filter: ProductionFilter,
  ): Promise<Map<string, BreakdownLogDetail>> {
    const details = await this.listBreakdownDetails(filter);
    return new Map(
      details.map((detail) => [
        this.cacheKey(detail.machineCode, detail.shiftId, detail.jobNumber),
        detail,
      ]),
    );
  }

  protected async fetchRejectsByKey(
    filter: ProductionFilter,
  ): Promise<Map<string, RejectRow[]>> {
    const F = this.F.rejects;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${odataString(filter.jobNumber)}'`);
    // PMD_Rejects.Date is DateTime — use a ±1d window around the shift's
    // date so both new (noon-UTC marker) and legacy (local-start) rows match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    // A ranged read (Maint's 7–90 days) used to pull every reject ever
    // logged; only the rows the headers can join to are wanted.
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await (isSpanRead(filter)
      ? this.getColumnItems<Record<string, unknown>>(LISTS.rejects, Object.values(F), qs)
      : this.getAllItems<Record<string, unknown>>(LISTS.rejects, qs));
    const out = new Map<string, RejectRow[]>();
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const key = this.cacheKey(mc, sid, job);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push({
        id: getId(r),
        timeline: str(r[F.timeline]),
        code: str(r[F.rejectCode]),
        category: str(r[F.rejectCategory]),
        qty: num(r[F.rejectNumber]),
      });
    }
    return out;
  }

  protected expandHeaderToSlots(
    h: HeaderRow,
    rejects: RejectRow[],
    /** True for rows from PMD_Production (signed off); false for rows
     *  from PMD_LiveStatus (in progress). The caller knows which list
     *  the header came from — no need to infer from supervisor. */
    isSignedOff: boolean,
    breakdown?: BreakdownLogDetail,
  ): ProductionRecord[] {
    const shiftId = `${h.date}-${h.shift}`;
    const slots: ProductionRecord[] = [];
    const timeline = (h.timeline || '').padEnd(16, '·').slice(0, 16);
    const stamp = new Date().toISOString();
    // lockedAt drives the "Signed off … at <time>" banner. Prefer the
    // persisted PMD_Production.Signoff timestamp so the banner shows when
    // sign-off ACTUALLY happened, not this device's current clock. Falls
    // back to the render stamp for legacy rows signed before the column
    // existed (and for live rows, where lockedAt is unused).
    const signedAt = isSignedOff && h.signOff ? h.signOff : stamp;
    const breakdownBySlot = new Map(
      (breakdown?.slots ?? []).map((detail) => [detail.slotIndex, detail]),
    );
    // QualityChecks JSON {"<slotIndex>":"<name>"} → per-slot qcBy.
    // Bare-string fallback so a column that pre-dates the JSON format
    // (or has been mis-edited in SP directly) still surfaces something
    // useful instead of swallowing the value.
    let qcMap: Record<string, string> = {};
    if (h.qcChecks) {
      try {
        const parsed = JSON.parse(h.qcChecks);
        if (parsed && typeof parsed === 'object') {
          qcMap = parsed as Record<string, string>;
        }
      } catch {
        /* not JSON — ignore */
      }
    }
    for (let i = 0; i < 16; i++) {
      const ch = timeline[i];
      const blank = ch === '·' || ch === ' ' || !ch;
      // Materialise a slot record when either the status is filled OR a
      // QC sign-off exists for this slot — otherwise a QC done before
      // production was logged would be silently dropped on round-trip.
      if (blank && !qcMap[String(i)]) continue;
      slots.push({
        id: 0,
        machineCode: h.machineCode,
        shiftId,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        partDescription: h.partDescription,
        slotIndex: i,
        statusCode: blank ? '' : (ch as ProductionRecord['statusCode']),
        countStart: i === 0 ? h.countStart : null,
        countEnd: i === 0 ? h.countEnd : null,
        rejectCount: 0,
        rejects: '{}',
        purgeKg: null,
        operator: i === 0 ? h.operator : '',
        supervisor: i === 0 ? h.supervisor : '',
        bdIssue: breakdownBySlot.get(i)?.code ?? '',
        bdCause: breakdownBySlot.get(i)?.cause ?? '',
        mangoTicket: '',
        handoverNote: i === 0 ? h.handover : '',
        qcBy: qcMap[String(i)] ?? '',
        // A reopened-for-correction row is NOT locked — every device reads
        // the Reopened=Yes flag and unlocks consistently (no device-local
        // unlock split-brain). It still carries reopened=true so the UI can
        // limit edits to the already-signed slots.
        locked: isSignedOff && !h.reopened,
        reopened: isSignedOff && h.reopened,
        lockedBy: h.supervisor,
        lockedAt: signedAt,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    if (slots.length === 0 || slots[0].slotIndex !== 0) {
      // Always provide a canonical slot 0 so the UI can read totals.
      slots.unshift({
        id: 0,
        machineCode: h.machineCode,
        shiftId,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        partDescription: h.partDescription,
        jobRequired: h.jobRequired,
        cycleTime: h.cycleTime,
        slotIndex: 0,
        statusCode: '',
        countStart: h.countStart,
        countEnd: h.countEnd,
        // PMD_Rejects is the source of truth. When events exist they
        // fully populate per-slot rejectCount below, so seed slot 0 at 0
        // to avoid blending a stale PMD_Production.Reject column total
        // with the event total (the 20-vs-28 drift). Only fall back to
        // the column when there are NO events at all (legacy rows signed
        // off before PMD_Rejects existed, or live rows pre-sign-off).
        rejectCount: rejects.length ? 0 : h.reject,
        rejects: '{}',
        purgeKg: null,
        operator: h.operator,
        supervisor: h.supervisor,
        bdIssue: breakdownBySlot.get(0)?.code ?? '',
        bdCause: breakdownBySlot.get(0)?.cause ?? '',
        mangoTicket: '',
        handoverNote: h.handover,
        qcBy: qcMap['0'] ?? '',
        locked: isSignedOff && !h.reopened,
        reopened: isSignedOff && h.reopened,
        lockedBy: h.supervisor,
        lockedAt: signedAt,
        createdAt: stamp,
        updatedAt: stamp,
      });
    } else {
      // slots[0] already exists from the timeline loop — patch its
      // handover note in place so the canonical slot carries it.
      slots[0].handoverNote = h.handover;
      // Same for jobRequired — the per-status slot was created
      // first with jobRequired left blank, but the canonical totals
      // live on slot 0 by convention.
      slots[0].jobRequired = h.jobRequired;
      // CycleTime rides along on the canonical slot so a past-shift
      // review (synthetic order) can recompute Shift Target.
      slots[0].cycleTime = h.cycleTime;
      // And the reject total: the per-status loop initialises
      // rejectCount to 0. Only stamp the column total when there are NO
      // PMD_Rejects events — when events exist they are the source of
      // truth and populate per-slot rejectCount below (see slot-0 seed
      // comment above). This is what stops a stale Reject column from
      // shadowing the real event total on read.
      if (rejects.length === 0) slots[0].rejectCount = h.reject;
    }
    // Cavities MUST reach the canonical slot whichever way it was created:
    // every Good figure multiplies the tuple's gross by it (cavityGross),
    // so losing it silently halves a 2-cavity order. It used to be set only
    // in the branch above — the one that runs when the timeline already
    // filled slot 0 — so an order that started later in the shift (blank
    // 07:00, nothing to materialise slot 0) came back with cavities
    // undefined: 507381 on 550T 29/07 ran 10:00-12:00 with 2 cavities,
    // stored Good 212 in PMD_Production, and read back as 106 everywhere.
    slots[0].cavities = h.cavities;
    // Frozen-at-start Job Left / Shift Target ride on the canonical slot
    // so Trace can read demand-at-start per row. -1 sentinel = column
    // absent / never written (legacy or live-without-freeze rows); 0 is a
    // valid value ("job complete") so guard on >= 0, not truthiness.
    if (h.jobLeft >= 0) slots[0].jobLeft = h.jobLeft;
    if (h.shiftTarget >= 0) slots[0].shiftTarget = h.shiftTarget;
    // The shift's Schedule % as it stood at sign-off — 0 is a real answer
    // ("nothing scheduled was made"), so the sentinel is -1, not falsy.
    if (h.vsPlan >= 0) slots[0].vsPlan = h.vsPlan;
    // Same sentinel rule: 0 is a real answer for both.
    if (h.scheduleAttain >= 0) slots[0].scheduleAttain = h.scheduleAttain;
    if (h.schedulePlan >= 0) slots[0].schedulePlan = h.schedulePlan;
    // Planned start denormalised at sign-off: ride the canonical slot so
    // KPI Schedule Adherence and a re-sign-off (cache-first) can read it
    // after Epicor drops the order from planning.
    if (h.plannedStart) slots[0].plannedStart = h.plannedStart;
    // PMD_Rejects events take precedence (signed-off shifts), but for
    // live (unsigned) rows the events list is empty — fall back to the
    // RejectsBySlot JSON column on PMD_LiveStatus so other iPads see
    // the per-slot per-code breakdown without waiting for sign-off.
    if (rejects.length === 0 && h.rejectsBySlot) {
      let rbsMap: Record<string, Record<string, number>> = {};
      try {
        const parsed = JSON.parse(h.rejectsBySlot);
        if (parsed && typeof parsed === 'object') {
          rbsMap = parsed as Record<string, Record<string, number>>;
        }
      } catch {
        /* not JSON — ignore */
      }
      for (const [slotKey, codes] of Object.entries(rbsMap)) {
        const slotIdx = Number(slotKey);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= 16) continue;
        let target = slots.find((s) => s.slotIndex === slotIdx);
        if (!target) {
          // Reject logged on a slot that has no status set yet — give it
          // a placeholder row so the operator grid can render the count.
          target = {
            id: 0,
            machineCode: h.machineCode,
            shiftId,
            jobNumber: h.jobNumber,
            partNumber: h.partNumber,
            partDescription: h.partDescription,
            slotIndex: slotIdx,
            statusCode: '',
            countStart: null,
            countEnd: null,
            rejectCount: 0,
            rejects: '{}',
            purgeKg: null,
            operator: '',
            supervisor: '',
            bdIssue: breakdownBySlot.get(slotIdx)?.code ?? '',
            bdCause: breakdownBySlot.get(slotIdx)?.cause ?? '',
            mangoTicket: '',
            handoverNote: '',
            qcBy: '',
            locked: isSignedOff,
            lockedBy: h.supervisor,
            lockedAt: signedAt,
            createdAt: stamp,
            updatedAt: stamp,
          };
          slots.push(target);
        }
        let obj: Record<string, number> = {};
        try {
          obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
        } catch {
          /* keep {} */
        }
        for (const [code, qty] of Object.entries(codes)) {
          const n = Number(qty);
          if (!n) continue;
          obj[code] = (obj[code] || 0) + n;
        }
        target.rejects = JSON.stringify(obj);
        target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
      }
    }
    // Merge rejects into the canonical slot 0's `rejects` JSON, and per-slot
    // events into slot records when the Timeline cell matches.
    for (const ev of rejects) {
      const slotIdx = timelineToSlot(ev.timeline);
      const target = slots.find((s) => s.slotIndex === slotIdx) ?? slots[0];
      let obj: Record<string, number> = {};
      try {
        obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
      } catch {
        /* keep {} */
      }
      obj[ev.code] = (obj[ev.code] || 0) + ev.qty;
      target.rejects = JSON.stringify(obj);
      target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    }
    return slots;
  }

  /**
   * Delete every PMD_LiveStatus row matching this (machine, shift,
   * job) tuple. Called at the end of lockShift so the just-signed-off
   * tuple no longer haunts every iPad's Live Status view as an
   * "in-progress" snapshot. Best-effort: a failure leaves a stale row
   * which the next pushLiveSnapshot from anywhere would just refresh,
   * so we surface but don't throw.
   */
  protected async deleteLiveRow(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    const F = this.F.production;
    const shift = shiftId.slice(11);
    try {
      await this.deleteByFilter(
        LISTS.liveStatus,
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shift)}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
        { field: F.date, date: shiftId.slice(0, 10) },
      );
    } catch (e) {
      console.warn('[pmd] live row cleanup failed for', { machineCode, shiftId, jobNumber }, e);
    }
  }
}
