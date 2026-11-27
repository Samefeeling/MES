// SharePoint data layer — the PmdDataLayer over SharePoint REST: an edit on
// the device, the live mirror, sign-off and unlock.
import type { PmdDataLayer } from '../types';
import { type SharePointOptions, LISTS } from './schema';
import type { ProductionRecord, ProductDieColor } from '../../types';
import { type RollbackAction, runRollback } from './http';
import { shiftEndedLongAgo, aggregateSlots, hasMeaningfulProgress, mirrorSignature, LIVE_HARD_CAP_MS } from './rows';
import {
  type SavedShiftPlan,
  keptPlanSnapshot,
  scheduleAdherenceForShift,
  scheduleSnapshotForShift,
  snapshotToSave,
  savedScheduleSnapshot,
} from '../../core/kpi-attainment';
import { previousShift } from '../../core/shifts';
import { dieLookup } from '../../core/schedule';
import { sumGoodStartedBefore } from '../../core/jobgood';
import { orderFactsFromHistory } from '../../core/order-history';
import { shiftTargetFor, hoursUnavailableFor } from '../../core/targets';
import { SharePointRecords } from './records';

export class SharePointDataLayer extends SharePointRecords implements PmdDataLayer {
  /** Live-mirror gate (setLiveGate) — pushLiveSnapshot skips any tuple
   *  the hook rejects. null = no gate (mirror everything dirty). */
  protected liveGate: ((machineCode: string, shiftId: string, jobNumber: string) => boolean) | null =
    null;

  /**
   * Reentrancy guard for pushLiveSnapshot. operatorPollTick is
   * fire-and-forget on a 60 s setInterval, so if a snapshot's network
   * work takes longer than 60 s (slow Wi-Fi + N upserts × 3 round
   * trips) the next tick used to start a SECOND snapshot in parallel,
   * which stacked onto the third, fourth, … until Safari's 6-
   * concurrent-connections cap was saturated and the tab locked up.
   * One-in-flight at a time is the correct policy — a missed tick just
   * pushes one minute later.
   *
   * Timestamp, not boolean: iPad Safari can leave a fetch pending FOREVER
   * (Wi-Fi drop / network switch mid-request settles neither way), which
   * kept the old boolean stuck true and silently killed the mirror until
   * someone reloaded the page — the floor iPad had fresh data for hours
   * while PMD_LiveStatus / Trace never saw it. A guard older than
   * SNAPSHOT_STUCK_MS is presumed hung and a new snapshot may start.
   */
  protected snapshotInFlightSince: number | null = null;

  protected static readonly SNAPSHOT_STUCK_MS = 5 * 60_000;

  /**
   * Live-mirror health, surfaced by mirrorHealth() for the on-screen
   * badge. "One iPad never gets its data onto SharePoint" was pure
   * guesswork on the floor — the badge turns it into a glanceable fact:
   * when did THIS device last push its mirror successfully, and if it's
   * failing, with what error.
   */
  protected lastMirrorOkAt: number | null = null;

  protected lastMirrorFailAt: number | null = null;

  protected lastMirrorError = '';

  /**
   * Stable per-device identity, persisted in localStorage. Written to
   * PMD_LiveStatus.OwnerDevice on every snapshot push so we can see
   * after the fact which iPad last touched a press, but no longer used
   * to gate writes — the write rule is device-CLASS (iPad vs not) via
   * SharePointOptions.canWrite, not per-device-id arbitration. The
   * old per-device claim caused fights between iPads in practice (one
   * iPad "owned" the press and locked the others out for no good
   * floor-operations reason).
   */
  protected deviceId = '';

  protected static readonly DEVICE_ID_KEY = 'pmd.deviceId';

  constructor(opts: SharePointOptions | string) {
    super(opts);
    this.deviceId = this.resolveDeviceId();
    this.rehydrateEditCache();
    this.rehydrateUnlockedTuples();
    this.rehydrateDirtyTuples();
    this.rehydrateMirrored();
  }

  /** Read (or mint + persist) this device's stable id. */
  protected resolveDeviceId(): string {
    if (typeof localStorage === 'undefined') {
      // Non-browser (tests / SSR): a per-instance id is fine — there's
      // no second device to arbitrate against.
      return `mem-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      let id = localStorage.getItem(SharePointDataLayer.DEVICE_ID_KEY);
      if (!id) {
        id =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(SharePointDataLayer.DEVICE_ID_KEY, id);
      }
      return id;
    } catch {
      return `dev-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  /** This iPad's stable device id. Still stamped onto PMD_LiveStatus's
   *  OwnerDevice column for after-the-fact diagnostics ("which iPad
   *  last touched this press?"), but the write/read rule is now purely
   *  device-class based — see SharePointOptions.canWrite. */
  getDeviceId(): string {
    return this.deviceId;
  }

  async upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord> {
    // Cache live edit; do not write to SharePoint until sign-off.
    const key = this.cacheKey(record.machineCode, record.shiftId, record.jobNumber);
    this.adoptReopenedTuple(key);
    const list = this.editCache.get(key) ?? [];
    const idx = list.findIndex((r) => r.slotIndex === record.slotIndex);
    const stored = { ...record, id: idx >= 0 ? list[idx].id || -1 : -(list.length + 1) };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    this.editCache.set(key, list);
    // A local write makes this device an AUTHOR of the tuple: it may
    // mirror it outward and its copy wins the per-slot backfill merge.
    this.dirtyTuples.add(key);
    this.persistEditCache();
    return stored;
  }

  /**
   * First edit, on this device, of a tuple ANOTHER device unlocked.
   *
   * PMD_Production.Reopened = Yes opens the row for correction on every
   * device, but unlockShift's rehydrate + unlock flag only ever ran on the
   * device that did the unlock. Anywhere else the sheet rendered as open
   * and nothing typed into it survived: the cache held the one edited slot,
   * and the next read purged it as a stale copy of a signed tuple — so the
   * value snapped back, and a Sign Off pressed there found nothing to write
   * and still reported success, leaving the row Reopened (and therefore out
   * of every KPI, which count signed rows only).
   *
   * So the edit adopts the tuple exactly as the unlock would have: the
   * signed slots as the server last gave them go into the cache (a slot
   * already there — the unlocking device's live mirror — is kept), and the
   * tuple is marked unlocked here too. Sign-off then has the whole tuple to
   * write, and the server's re-lock ends the window on every device.
   */
  protected adoptReopenedTuple(key: string): void {
    if (this.unlockedTuples.has(key)) return;
    const signedSlots = this.reopenedOnServer.get(key);
    if (!signedSlots) return;
    const list = this.editCache.get(key) ?? [];
    for (const slot of signedSlots) {
      if (list.some((s) => s.slotIndex === slot.slotIndex)) continue;
      list.push({ ...slot, locked: false, reopened: true, lockedBy: '', lockedAt: '' });
    }
    this.editCache.set(key, list);
    this.unlockedTuples.add(key);
    // Adopted BECAUSE the server said reopened: its re-lock ends it here too.
    this.reopenSeen.add(key);
    this.persistUnlockedTuples();
  }

  /**
   * Sign off & Save (§5): flush every cached (machine, shiftId, job) tuple
   * to PMD_Production header + PMD_BreakDown analytic + PMD_Rejects events.
   */
  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
    jobNumber?: string,
    /** Job Left as the operator UI computed it. FALLBACK ONLY: the JobLeft
     *  column is normally recomputed here from the production list itself
     *  (see the jobLeftSnap block); this value is used when that read
     *  fails and no frozen canonical value exists. */
    jobLeft?: number | null,
  ): Promise<void> {
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const ownKey = (job: string): string => this.cacheKey(machineCode, shiftId, job);
    const myTuples: ProductionRecord[][] = [];
    for (const [key, list] of this.editCache) {
      if (!key.startsWith(`${machineCode}|${shiftId}|`)) continue;
      // Sign-off is per (machine, shift, JOB): when the supervisor is
      // signing off SFM507006, an operator's in-progress SFM507057 on
      // the same press/shift must NOT be swept up and locked with it —
      // they're still filling the remaining timeline slots.
      if (jobNumber && key !== ownKey(jobNumber)) continue;
      myTuples.push(list);
    }
    if (myTuples.length === 0) {
      // Nothing in editCache for this (machine, shift[, job]) — there
      // is literally nothing to write. Crucially, do NOT push a
      // placeholder header here: upsertHeaderInto's MERGE-if-exists
      // path would PATCH a real PMD_Production row with all-blank
      // values, which is exactly the SFM507068 data-loss path we just
      // redesigned away. If the supervisor pressed Sign Off without
      // any local edits (e.g. on a freshly unlocked shift to confirm
      // "yes, the existing numbers are fine"), the existing row stays
      // as-is and the unlock flag clears below.
      //
      // What may still be owed is the lock itself. A row left at
      // Reopened = Yes reads as unsigned on every device and drops out of
      // the KPIs (signed rows only) — so a sign-off that changes nothing
      // still has to close the correction window on the server, or it
      // reports "saved" over a row that stays open. A failure here is
      // thrown: the supervisor must not be told it is signed when it is not.
      const prefix = `${machineCode}|${shiftId}|`;
      const signing = (k: string): boolean =>
        jobNumber ? k === ownKey(jobNumber) : k.startsWith(prefix);
      for (const k of Array.from(this.reopenedOnServer.keys()).filter(signing)) {
        await this.setReopenedFlag(machineCode, shiftId, k.slice(prefix.length), false);
        this.reopenedOnServer.delete(k);
      }
      for (const k of Array.from(this.unlockedTuples).filter(signing)) {
        this.unlockedTuples.delete(k);
      }
      this.persistUnlockedTuples();
      return;
    }
    // Single planning lookup (per machine) for FALLBACK only. The
    // rehydrated editCache slots already carry the canonical
    // partNumber / partDescription that came back from the existing
    // signed-off row — those are the truth. Planning is consulted
    // only when the cache lacks them (fresh in-progress order).
    // Without this, a re-sign-off after unlock would overwrite the
    // header with whatever the CURRENT planning CSV says, and Epicor
    // drops completed orders from planning — blanking the
    // PartNum / Description columns on the existing row.
    const orders = await this.listPlanning({ machineCode });
    const partNumOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partNumber)?.partNumber;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partNumber ?? '';
    };
    const partDescOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partDescription)?.partDescription;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partDescription ?? '';
    };
    // The denormalised PMD_Production "JobRequired" column carries the order
    // total (Order Qty / JobHead_ProdQty), not the remaining qty — it exists
    // so the UI can show Order Qty after Epicor drops a completed order.
    const jobRequiredOf = (job: string, slots: ProductionRecord[]): number => {
      const fromCache = slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.orderQty ?? 0;
    };
    // Cycle time (hours/piece) — same cache-first, planning-fallback rule
    // as jobRequiredOf. Persisting it lets a past-shift review recompute
    // Shift Target after Epicor has dropped the order from planning.
    const cycleTimeOf = (job: string, slots: ProductionRecord[]): number => {
      const fromCache = slots.find((s) => s.cycleTime && s.cycleTime > 0)?.cycleTime;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.qtyPerHr ?? 0;
    };
    // Cavities frozen on the canonical slot by the operator UI; 1 when
    // absent. Multiplies the tuple's gross when computing Good / Job Left.
    const cavitiesOf = (slots: ProductionRecord[]): number => {
      const v = slots.find((s) => s.slotIndex === 0)?.cavities;
      return v && v > 0 ? v : 1;
    };
    // Planned start (JobHead_StartDate + StartHour) — same cache-first,
    // planning-fallback rule as jobRequiredOf. Persisting it is what lets
    // KPI Schedule Adherence see when a job was SCHEDULED after Epicor
    // drops the completed order from planning.
    const plannedStartOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.plannedStart)?.plannedStart;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.plannedStart ?? '';
    };
    // Every job's slots on this (machine, shift) — the Shift Target
    // deduction needs the WHOLE press picture (a previous order's
    // footprint, a die-change pseudo-order's D block), not just the
    // tuple being signed. Blended read = the same signed+live+cache view
    // the operator side panel computed its target from, so the stamped
    // column matches what the sheet showed. On a read failure fall back
    // to this device's cached tuples for the shift rather than aborting
    // the sign-off.
    let shiftRows: ProductionRecord[];
    let shiftReadOk = true;
    try {
      shiftRows = await this.listProduction({ machineCode, shiftId });
    } catch (e) {
      console.warn('[pmd] shift-wide read for Shift Target failed, using cache:', e);
      shiftReadOk = false;
      shiftRows = [];
      for (const [key, list] of this.editCache) {
        if (key.startsWith(`${machineCode}|${shiftId}|`)) shiftRows.push(...list);
      }
    }
    /*
     * The shift's Schedule % as it stands at this sign-off, frozen onto every
     * header this call writes.
     *
     * It is recomputed live everywhere else, against Planning.csv — and Epicor
     * drops an order from planning the moment it completes, so the number the
     * Monday meeting read could not be reproduced on the Friday. This is the
     * same function the KPI page calls, given the same picture: the shift as
     * the server has it, with the tuples being signed off now taking the place
     * of their older rows.
     *
     * Null when nothing on the shift was scheduled at all. "No plan to adhere
     * to" is not "made none of the plan", and 0 would read as the second.
     */
    const signedNow = myTuples.flat();
    const signingJobs = new Set(signedNow.map((r) => r.jobNumber));
    // The plan needs each part's die and what the press ran just before, to
    // tell a window that opens with a die change (core/schedule
    // dieChangeLeadHours). Neither read may cost the sign-off.
    const planCtx = {
      dieOf: dieLookup(await this.listProductDieColors().catch(() => [] as ProductDieColor[])),
    };
    const prevSid = previousShift(shiftId);
    const prevShiftRows = prevSid
      ? await this.listProduction({ machineCode, shiftId: prevSid }).catch(() => [] as ProductionRecord[])
      : [];
    const shiftAsSigned = [
      ...shiftRows.filter((r) => !signingJobs.has(r.jobNumber)),
      ...signedNow,
    ];
    // The press's plan of record for the shift (PMD_ShiftPlan), kept now if
    // nobody kept it while the shift ran. With one, the shift is judged by
    // it rather than by Planning.csv as it stands at this sign-off — a Night
    // signed after the morning export has had its in-progress order moved
    // out of it. Best-effort: never costs the sign-off.
    let kept: SavedShiftPlan | undefined;
    try {
      kept = (await this.keepShiftPlans(shiftId))?.find(
        (row) => row.machineCode.trim().toUpperCase() === machineCode.trim().toUpperCase(),
      );
    } catch (e) {
      console.warn('[pmd] PMD_ShiftPlan keep failed, judging the shift by Planning.csv:', e);
    }
    let vsPlanSnap: number | null = null;
    try {
      vsPlanSnap = kept
        ? keptPlanSnapshot(kept, shiftAsSigned).pct
        : scheduleAdherenceForShift(
            [...prevShiftRows, ...shiftAsSigned],
            orders,
            machineCode,
            shiftId,
            new Date(),
            planCtx,
          ).pct;
    } catch (e) {
      // A KPI snapshot must never cost somebody the shift they just signed.
      console.warn('[pmd] Schedule % snapshot failed, signing off without it:', e);
    }
    /*
     * ScheduleAttain / SchedulePlan: the shift's Last 24h Schedule Adherence
     * and the pieces its plan asked for, kept for the weeks after Planning.csv
     * has moved on (scheduleSnapshotForShift). Credited from signed output
     * only, as the KPI page credits it — the orders already signed plus the
     * ones signing now.
     *
     * Not written when the shift could not be read: a snapshot that misses
     * the orders signed before would be the newest one, and the one the KPI
     * page believes. Nor when Planning.csv has dropped every order of the
     * shift by now (a re-sign-off a week later): the plan saved the first time
     * is kept, rather than one rebuilt from ShiftTargets.
     */
    let schedule: { pct: number | null; plan: number } | null = null;
    if (shiftReadOk) {
      try {
        const signedAlready = shiftRows.filter((r) => r.locked && !signingJobs.has(r.jobNumber));
        const snap = kept
          ? keptPlanSnapshot(kept, [...signedAlready, ...signedNow])
          : scheduleSnapshotForShift([...prevShiftRows, ...signedAlready, ...signedNow], orders, machineCode, shiftId, new Date(), planCtx);
        schedule = snapshotToSave(snap, savedScheduleSnapshot(shiftRows));
      } catch (e) {
        console.warn('[pmd] ScheduleAttain snapshot failed, signing off without it:', e);
      }
    }

    for (const slots of myTuples) {
      const job = slots[0]?.jobNumber ?? jobNumber ?? '';
      const agg = aggregateSlots(slots);
      const tag = `${machineCode}|${shiftId}|${job}`;
      // The order's signed history: Job Left below, and the third source of
      // its part, Order Qty and cycle time after this tuple's own slots and
      // Planning.csv — an order overrun past its quantity is complete in
      // Epicor and gone from planning while the press is still running it,
      // and without this the shift was signed with no part, no CycleTime
      // and no ShiftTarget (see core/order-history).
      let history: ProductionRecord[] | null = null;
      try {
        history = await this.listSignedOffProduction({ jobNumber: job });
      } catch (e) {
        console.warn('[pmd] order history read failed, signing off without it:', e);
      }
      const facts = history ? orderFactsFromHistory(history) : null;
      const partNum = partNumOf(job, slots) || facts?.partNumber || '';
      const partDesc = partDescOf(job, slots) || facts?.partDescription || '';
      const required = jobRequiredOf(job, slots) || facts?.jobRequired || 0;
      // PMD_Rejects is the source of truth. agg.reject is by construction
      // Σ agg.rejectEvents (same loop), and those events are what
      // replaceRejectEvents writes below — so whenever per-slot detail
      // exists, the Reject column, RejectsBySlot and TotalGood all derive
      // from the SAME event set and cannot drift. The drift we hit on
      // SFM507067 (column 20 vs events 28) came from the READ path
      // blending a stale column total into slot 0; that is fixed in
      // expandHeaderToSlots, so a rehydrated re-sign-off now re-aggregates
      // the real events and self-heals the column.
      //
      // The `|| canon.rejectCount` fallback ONLY fires for a legacy row
      // that has a Reject column total but no PMD_Rejects events at all
      // (per-code detail destroyed by an old broken-unlock incident).
      // There is nothing to re-derive from, so preserving the surviving
      // total beats zeroing it — and since there are no events, the
      // column is still the only record, so this introduces no drift.
      const canon = slots.find((s) => s.slotIndex === 0);
      const reject = agg.reject || (canon?.rejectCount ?? 0);
      const cycleTime = cycleTimeOf(job, slots) || facts?.cycleTime || 0;
      const cavities = cavitiesOf(slots);
      // This tuple's own net Good — last-resort Job Left estimate below.
      const tupleGood = Math.max(
        0,
        ((agg.countEnd ?? 0) - (agg.countStart ?? 0)) * cavities - reject,
      );
      // Job Left column = pieces still needed when this shift BEGAN,
      // recomputed from SIGNED PMD_Production rows only — the one
      // source every device sees identically (JobRequired − Σ TotalGood
      // of earlier-started signed shifts, exactly reproducible from the
      // list itself). Client-side snapshots proved untrustable twice:
      // the frozen-at-start value inherits whatever junk the freezing
      // device could see (a stale PMD_LiveStatus shadow burned Job Left
      // 574/397 into SFM507147), and the old tuple-only fallback
      // ignored every other shift (the 1380 row). Live/editCache tuples
      // are deliberately EXCLUDED: an unsigned earlier shift simply
      // isn't counted until it signs off, and a re-sign-off after
      // unlock refreshes the column — corrections self-heal. Frozen
      // value → UI param → tuple-only estimate remain as fallbacks when
      // the list read itself fails.
      let jobLeftSnap: number | null = null;
      if (required > 0 && history) {
        const before = sumGoodStartedBefore(history, machineCode, shiftId);
        if (before != null) jobLeftSnap = Math.max(0, required - before);
      }
      if (jobLeftSnap == null) {
        jobLeftSnap =
          canon?.jobLeft != null
            ? Math.max(0, canon.jobLeft)
            : jobLeft != null
              ? Math.max(0, jobLeft)
              : Math.max(0, required - tupleGood);
      }
      // Shift Target column: recompute from the at-start Job Left (same
      // signed-rows source as jobLeftSnap) over the hours actually left
      // to this job — 8h minus other orders' recorded footprint on this
      // press/shift minus this job's own changeover slots (see
      // hoursUnavailableFor). A value stamped on the canonical slot is
      // legacy client-frozen data — contaminated by whatever that device
      // saw at freeze time — and is only used when the recompute
      // produced nothing.
      const shiftTargetSnap =
        shiftTargetFor(
          { qtyPerHr: cycleTime },
          jobLeftSnap,
          hoursUnavailableFor(shiftRows, job),
        ) ?? canon?.shiftTarget ?? null;
      // SharePoint has no multi-list transaction. Stage both child-list
      // replacements first and write the signed PMD_Production header LAST.
      // Each replacement returns a compensating rollback, so a later failure
      // restores the exact pre-sign-off rows instead of leaving a signed
      // header with missing/half-written analytic detail.
      let undoBreakdown: RollbackAction = async () => {};
      try {
        undoBreakdown =
          (await this.replaceBreakdownEvents(
          {
            machineCode,
            date,
            shift,
            jobNumber: job,
            partNumber: partNum,
            timeline: agg.timeline,
          },
          slots,
          )) ?? undoBreakdown;
      } catch (e) {
        throw new Error(`PMD_BreakDownlog write failed (${tag}): ${(e as Error).message}`);
      }
      let undoRejects: RollbackAction = async () => {};
      try {
        undoRejects =
          (await this.replaceRejectEvents(
            { machineCode, date, shift, jobNumber: job },
            agg.rejectEvents,
          )) ?? undoRejects;
      } catch (e) {
        const rollbackError = await runRollback(undoBreakdown);
        const suffix = rollbackError ? `; breakdown rollback also failed: ${rollbackError}` : '';
        throw new Error(`PMD_Rejects write failed (${tag}): ${(e as Error).message}${suffix}`);
      }
      try {
        await this.upsertProductionHeader({
          signOff: new Date().toISOString(),
          jobLeft: jobLeftSnap,
          // Re-lock: a fresh sign-off always clears any prior reopened flag.
          reopened: false,
          machineCode,
          date,
          shift,
          jobNumber: job,
          partNumber: partNum,
          partDescription: partDesc,
          jobRequired: required,
          cycleTime,
          cavities,
          batchJobs: slots.find((s) => s.slotIndex === 0)?.batchJobs,
          plannedStart: plannedStartOf(job, slots),
          shiftTarget: shiftTargetSnap,
          vsPlan: vsPlanSnap,
          scheduleAttain: schedule?.pct ?? null,
          schedulePlan: schedule?.plan ?? null,
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject,
          operator: operator || agg.operator,
          supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
          qcChecks: agg.qcChecks,
          rejectsBySlot: agg.rejectsBySlot,
        });
      } catch (e) {
        const rejectRollbackError = await runRollback(undoRejects);
        const breakdownRollbackError = await runRollback(undoBreakdown);
        const rollbackErrors = [rejectRollbackError, breakdownRollbackError].filter(Boolean);
        const suffix = rollbackErrors.length
          ? `; detail rollback also failed: ${rollbackErrors.join('; ')}`
          : '';
        throw new Error(`PMD_Production write failed (${tag}): ${(e as Error).message}${suffix}`);
      }
      // Sweep the in-progress mirror so other iPads' Live Status drops
      // this row in favour of the new signed-off Production record on
      // their next poll. Best-effort — pushLiveSnapshot won't re-create
      // the row because lockShift also clears editCache below.
      await this.deleteLiveRow(machineCode, shiftId, job);
      // Late sign-off heal: if LATER shifts of this job signed first,
      // their JobLeft columns were computed without this shift's output
      // — bring the per-shift ledger back to exact. Best-effort: the
      // sign-off itself already succeeded, and the next sign-off of the
      // job retries any heal that fails here.
      await this.healLaterJobLeft(machineCode, shiftId, job, required).catch((e) => {
        console.warn('[pmd] JobLeft heal failed (next sign-off retries):', e);
      });
      const tupleKey = ownKey(job);
      this.editCache.delete(tupleKey);
      this.unlockedTuples.delete(tupleKey);
      // Signed again: an edit before the next read must not re-adopt it.
      this.reopenedOnServer.delete(tupleKey);
    }
    this.persistEditCache();
    this.persistUnlockedTuples();
  }

  /**
   * Push every unsigned editCache entry to **PMD_LiveStatus** as an
   * in-progress snapshot. Other iPads' Live Status reads PMD_LiveStatus
   * (alongside PMD_Production for signed-off rows) so the floor view
   * shows what's happening on every press without waiting for Sign
   * Off & Save.
   *
   * PMD_LiveStatus mirrors PMD_Production's column schema; lockShift
   * copies the row across and deletes it from here, so the two lists
   * never hold the same tuple simultaneously beyond a brief window.
   *
   * Called from the operator poll tick (every 60 s) and right after
   * multiFillApply so the new status pattern shows up immediately.
   * Fire-and-forget; a failure just means the live view is up-to-60-s
   * stale until the next tick succeeds.
   */
  /** Live-mirror health for the on-screen badge: is this device allowed
   *  to push, when did its last snapshot fully succeed, and what did the
   *  last failure say. */
  mirrorHealth(): { writable: boolean; okAt: number | null; failAt: number | null; error: string } {
    return {
      writable: this.canWriteHook(),
      okAt: this.lastMirrorOkAt,
      failAt: this.lastMirrorFailAt,
      error: this.lastMirrorError,
    };
  }

  setLiveGate(gate: (machineCode: string, shiftId: string, jobNumber: string) => boolean): void {
    this.liveGate = gate;
  }

  /**
   * Forget a tuple the worker never confirmed: drop its editCache entry +
   * authorship mark so the 60 s mirror can't re-broadcast it, and
   * best-effort delete any PMD_LiveStatus row an earlier tick already
   * pushed. This is the "unconfirmed cache is cleared" half of the
   * confirm flow — signed-off PMD_Production rows are never touched.
   */
  async discardUnconfirmedTuple(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    const key = this.cacheKey(machineCode, shiftId, jobNumber);
    // An unlock-edit window holds REAL signed data rehydrated for
    // correction — never discard that, whatever the confirm registry says.
    if (this.unlockedTuples.has(key)) return;
    if (this.editCache.delete(key)) {
      this.dirtyTuples.delete(key);
      this.persistEditCache();
    }
    await this.deleteLiveRow(machineCode, shiftId, jobNumber);
  }

  async pushLiveSnapshot(): Promise<void> {
    if (this.editCache.size === 0) {
      // Nothing to push is a healthy state — the mirror loop ran.
      this.lastMirrorOkAt = Date.now();
      return;
    }
    // Reentrancy guard — see snapshotInFlightSince field comment. The
    // poll tick is fire-and-forget; without this, a slow tick stacks
    // onto the next one and saturates Safari's connection pool → freeze.
    const now = Date.now();
    if (this.snapshotInFlightSince != null) {
      if (now - this.snapshotInFlightSince < SharePointDataLayer.SNAPSHOT_STUCK_MS) return;
      console.warn('[pmd] live snapshot stuck for 5+ min (hung fetch?) — starting a fresh one');
    }
    this.snapshotInFlightSince = now;
    try {
      await this.pushLiveSnapshotInner();
    } finally {
      // Only clear our own claim: if the watchdog already let a newer
      // snapshot start, a late-settling hung run must not unlock it.
      if (this.snapshotInFlightSince === now) this.snapshotInFlightSince = null;
    }
  }

  protected async pushLiveSnapshotInner(): Promise<void> {
    // PartNum lookup for the live mirror. Cached for 5 min so we don't
    // re-download the whole Planning CSV every 60 s — see
    // partNumByJobCache field comment.
    const partNumByJob = await this.getPartNumByJob();
    const now = new Date();
    let failures = 0;
    const tasks: Array<() => Promise<void>> = [];
    for (const [key, slots] of this.editCache) {
      if (slots.length === 0) continue;
      // ONLY tuples this device authored. A cache entry backfilled from
      // PMD_LiveStatus for viewing another press must never be
      // re-broadcast: a device that glanced at a shift once would
      // otherwise republish that stale copy every 60 s, overwriting the
      // editing iPad's fresh mirror (the Batt2 "full timeline collapsed
      // to one slot" echo loop).
      if (!this.dirtyTuples.has(key)) continue;
      // Skip cache entries that hold nothing but a freshly-picked
      // operator / supervisor name with no actual production data —
      // see hasMeaningfulProgress(). Avoids littering the broker with
      // empty rows every time someone picked the wrong job and
      // switched.
      if (!hasMeaningfulProgress(slots)) continue;
      const canon = slots.find((s) => s.slotIndex === 0) ?? slots[0];
      if (!canon) continue;
      const [machineCode, shiftId, jobNumber] = key.split('|');
      if (!machineCode || !shiftId || !jobNumber) continue;
      // Confirm gate: only a tuple the worker explicitly confirmed
      // ("this order really runs on this press, by these people") is
      // broadcast. Browse artefacts stay local until discarded.
      if (this.liveGate && !this.liveGate(machineCode, shiftId, jobNumber)) continue;
      // How long after its shift a tuple is still mirrored. It used to stop
      // 8 h after the shift ended — and that was a way unsigned work stayed
      // on the iPad alone: a sheet back-filled the next morning (Afternoon
      // ends 23:00, so from 07:00), or one whose pushes failed while the
      // shift ran (Wi-Fi, an expired sign-in, the iPad asleep), never
      // reached PMD_LiveStatus, so KPIs could not see it was unsigned.
      //   - Real work (a machine status on any slot) is mirrored for as long
      //     as it is kept (LIVE_HARD_CAP_MS) — until it is signed off.
      //   - A status-empty tuple stops at 8 h: it is a mis-tap, swept from
      //     the list on read (isStaleLiveHeader) and from the cache.
      //   - Once the shift is over, a tuple is pushed only when it differs
      //     from what this device last got onto the list (`mirrored`). That
      //     keeps the retained tuples from costing a round trip a minute,
      //     and a row a supervisor deleted by hand from coming back — the
      //     reason the old 8 h stop was there.
      if (shiftEndedLongAgo(shiftId, now, LIVE_HARD_CAP_MS)) continue;
      if (shiftEndedLongAgo(shiftId, now) && !slots.some((s) => s.statusCode)) continue;
      const signature = mirrorSignature(slots);
      if (shiftEndedLongAgo(shiftId, now, 0) && this.mirrored.get(key) === signature) continue;
      // Read-only devices (PC viewer with no supervisor signed in)
      // never push. Without this gate a stale local cache on a viewer
      // would mirror straight back over the iPad's fresh data on every
      // poll. The device-class rule replaced per-device ownership
      // arbitration after the latter caused fights between iPads on
      // the floor.
      if (!this.canWriteHook()) continue;
      // OwnerDevice column still gets stamped with this device's id
      // (purely for after-the-fact diagnostics — "which iPad last
      // touched this press?"). No claim arbitration: every writable
      // device just overwrites.
      const ownerDevice = this.deviceId;
      const date = shiftId.slice(0, 10);
      const shift = shiftId.slice(11);
      const agg = aggregateSlots(slots);
      tasks.push(async () => {
        try {
          await this.upsertHeaderInto(LISTS.liveStatus, {
            machineCode,
            date,
            shift,
            jobNumber,
            partNumber: partNumByJob.get(jobNumber) ?? '',
            partDescription: '',
            // Order total when the cache knows it — lets another device
            // (or the Trace live board) rebuild a synthetic order for an
            // in-progress job even after Epicor drops it from planning.
            // upsertHeaderInto skips the column when this is 0.
            jobRequired: slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired ?? 0,
            // Carry cycle time + cavities so a mid-shift reload (editCache
            // lost, rehydrate from PMD_LiveStatus) keeps them. Job Left /
            // Shift Target are deliberately NOT mirrored: they are derived
            // from signed PMD_Production rows on read now — mirroring the
            // old client-frozen snapshot is how a contaminated value
            // spread to every device (SFM507147's phantom "200").
            cycleTime: canon.cycleTime ?? 0,
            cavities: canon.cavities,
            batchJobs: canon.batchJobs,
            timeline: agg.timeline,
            countStart: agg.countStart,
            countEnd: agg.countEnd,
            reject: agg.reject,
            operator: canon.operator,
            supervisor: canon.supervisor,
            runTime: agg.runTime,
            downTime: agg.downTime,
            handover: agg.handover,
            qcChecks: agg.qcChecks,
            rejectsBySlot: agg.rejectsBySlot,
            ownerDevice,
          });
          // PMD_LiveStatus already carries the complete status timeline.
          // The extra live BreakdownLog write is needed only while B exists,
          // to publish its slot-level BDCause before sign-off.
          if (slots.some((slot) => slot.statusCode === 'B')) {
            await this.upsertBreakdownSnapshot(
              {
                machineCode,
                date,
                shift,
                jobNumber,
                partNumber: partNumByJob.get(jobNumber) ?? '',
                timeline: agg.timeline,
              },
              slots,
            );
          }
          this.mirrored.set(key, signature);
          this.persistEditCache();
        } catch (e) {
          // Snapshot push is best-effort; never propagate. Recorded for
          // the mirror-health badge so a silently-failing iPad is
          // visible on its own screen.
          failures++;
          this.lastMirrorError = `${key}: ${(e as Error)?.message ?? e}`;
          console.warn('[pmd] live snapshot push failed for', key, e);
        }
      });
    }
    // Push in serial — each upsert is digest + GET-by-key + POST/PATCH
    // (3 round trips). With 5-10 jobs cached on a busy iPad, the old
    // Promise.all fired 15-30 requests at once, immediately hit
    // Safari's 6-connection-per-origin cap and queued the rest while
    // the main thread waited. Serial keeps the connection pool free
    // for the UI's own taps and reload(), at the cost of a slightly
    // longer total snapshot wall-clock — fine, this is a best-effort
    // background mirror, not a user-facing path.
    for (const t of tasks) await t();
    if (failures === 0) this.lastMirrorOkAt = Date.now();
    else this.lastMirrorFailAt = Date.now();
  }

  async unlockShift(
    machineCode: string,
    shiftId: string,
    jobNumber?: string,
  ): Promise<void> {
    // Redesigned 2026-06-16 (SFM507068 incident): unlock is now
    // PURELY a client-side rehydrate + mark. The signed-off
    // PMD_Production / PMD_BreakDownlog / PMD_Rejects rows STAY on
    // the SharePoint side untouched. lockShift's upsertHeaderInto
    // already merges-if-exists, so the re-sign-off path PATCHes the
    // existing row by ID rather than POSTing a fresh one — original
    // PartNum, PartDescription, Counts, Timeline and Rejects survive
    // any abandonment, network failure, or planning-CSV ageing
    // (Epicor drops completed orders from planning, which the old
    // delete-then-rewrite path then wrote back as empty PartNum).
    //
    // The tuple is added to `unlockedTuples` so the listProduction
    // self-heal does not purge the editCache rows back out (PMD_
    // Production still carries the locked header so signedKeys would
    // otherwise match). lockShift clears the flag on successful
    // commit. The flag is persisted alongside editCache so a page
    // reload mid-edit doesn't strand the operator.
    const existing = await this.listProduction({
      machineCode,
      shiftId,
      ...(jobNumber ? { jobNumber } : {}),
    });
    // Authoritative server-side unlock: flip PMD_Production.Reopened = Yes on
    // the signed row(s) so EVERY device reads the same "reopened" state. This
    // is a single-field MERGE — it never deletes or rewrites the row's data,
    // so it carries none of the data-loss risk that retired the old
    // delete-then-rewrite unlock. The client rehydrate below still runs so the
    // unlocking device can edit immediately without waiting for a reload.
    const reopenJobs = new Set(existing.map((r) => r.jobNumber).filter(Boolean));
    for (const job of reopenJobs) {
      await this.setReopenedFlag(machineCode, shiftId, job, true).catch((e) => {
        console.warn('[unlock] setReopened failed (falling back to device-local):', e);
      });
    }
    let touchedAnyTuple = false;
    for (const r of existing) {
      const rehydrated: ProductionRecord = {
        ...r,
        locked: false,
        reopened: true,
        lockedBy: '',
        lockedAt: '',
      };
      const key = this.cacheKey(r.machineCode, r.shiftId, r.jobNumber);
      const list = this.editCache.get(key) ?? [];
      // Don't clobber any in-flight edits already in cache for the
      // same slot — `existing` may include unsigned slots when
      // listProduction also returns LiveStatus rows.
      if (!list.some((s) => s.slotIndex === r.slotIndex)) list.push(rehydrated);
      this.editCache.set(key, list);
      this.unlockedTuples.add(key);
      // The unlocking device is about to author corrections here.
      this.dirtyTuples.add(key);
      touchedAnyTuple = true;
    }
    this.persistEditCache();
    if (touchedAnyTuple) this.persistUnlockedTuples();
  }

  isUnlockedTuple(machineCode: string, shiftId: string, jobNumber: string): boolean {
    return this.unlockedTuples.has(this.cacheKey(machineCode, shiftId, jobNumber));
  }
}
