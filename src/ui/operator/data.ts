// Operator sheet — loading the press's shift and writing to it: slots, the
// Confirm of who runs what, counts carried over, and the job's running totals.
import type { ProductionRecord } from '../../types';
import { S, canWriteThisDevice, dalRef, saveView } from './state';
import { toast } from '../toast';
import { isJobLocked } from './lock';
import {
  blankRecord,
  sid,
  shiftOrders,
  isPastShift,
  coRunSiblings,
  isFutureShift,
  jobInPlanning,
  canonical,
  dieRowForJob,
  selectedOrder,
  coRunDieJobs,
  orderForJob,
  partNumberForJob,
  blankRecordForJob,
} from './sheet';
import { compareOrdersByStart } from '../../core/planning';
import { render, paintCavityBlockBanner } from './render';
import { isTupleConfirmed, confirmTuple, pressesRunningJobElsewhere } from '../../core/confirm';
import { isSupervisor } from '../supervisor-auth';
import { previousShift, buildShiftId, dateKey } from '../../core/shifts';
import { escapeHtml, openModal, closeModal } from '../modal';
import { namesForSheet } from '../../core/crew';
import { type CavitySource, resolveCavities, runningCavities } from '../../core/cavities';
import {
  jobLeftPiecesFor,
  shiftTargetFor,
  hoursUnavailableFor,
  totalGoodExceedsShiftTarget,
  SHIFT_TARGET_WARNING_RATIO,
  shiftCapacityFor,
} from '../../core/targets';
import { sumOtherShiftGood, unsignedEarlierTuples } from '../../core/jobgood';
import { orderFactsFromHistory } from '../../core/order-history';
import { cavityGross } from '../../core/metrics';
import { jobTotals } from './index';
import { type CavityBlockReminder, cavityBlockReminders } from '../../core/corun';

export async function upsertSlot(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  // Defence-in-depth lock guard: a signed-off (machine, shift, job) is
  // immutable until a supervisor reopens it via Unlock. Without this,
  // a stray tap on a slot would put a NEW slot record into editCache,
  // and the next pushLiveSnapshot would re-broadcast the (locked) shift
  // as live — polluting PMD_LiveStatus and resetting the timeline. The
  // UI already disables the inputs, but inputs can still emit events
  // when re-enabled by devtools or a flaky disabled-attribute paint;
  // belt-and-braces stop here.
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor to edit', 'warn');
    return;
  }
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  claimForSupervisorEdit();
  const existing = S!.prod.find(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  const rec = existing ? { ...existing } : blankRecord(slot);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  // Sync-update local state so concurrent upsertSlot() calls don't race on a
  // stale S!.prod — without this, typing CountStart then immediately tabbing
  // to CountEnd would have CountEnd's upsert clone the pre-CountStart record
  // and overwrite it on flush.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  try {
    await dalRef.upsertProductionRecord(rec);
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

/**
 * The job with live activity furthest along this press's shift —
 * PMD_LiveStatus rows surface in S!.prod as unsigned (locked=false) slot
 * records with a non-empty statusCode, so the job whose latest filled slot is
 * greatest is what the press is running right now. '' when nothing is live.
 */
function liveActiveJob(): string {
  const lastSlotByJob = new Map<string, number>();
  for (const r of S!.prod) {
    if (!r.locked && r.statusCode && r.jobNumber) {
      const cur = lastSlotByJob.get(r.jobNumber) ?? -1;
      if (r.slotIndex > cur) lastSlotByJob.set(r.jobNumber, r.slotIndex);
    }
  }
  let bestJob = '';
  let bestSlot = -1;
  for (const [j, s] of lastSlotByJob) {
    if (s > bestSlot) {
      bestSlot = s;
      bestJob = j;
    }
  }
  return bestJob;
}

/**
 * @param preferLiveJob boot-time only: when the restored per-tab job has no
 *   rows on this (machine, shift) but another order is live on the press,
 *   land on the live one — the floor reported iPads opening on a stale saved
 *   order and producing junk entries against it. NOT set on ordinary reloads:
 *   an operator who deliberately picks the (still-empty) next order from the
 *   dropdown must not be yanked back to the previous one by the next poll.
 */
export async function reload(preferLiveJob = false): Promise<void> {
  const id = sid();
  S!.prod = await dalRef.listProduction({ machineCode: S!.mc, shiftId: id });
  await loadCarriedJobs();
  const orders = shiftOrders();
  if (!S!.selJob) {
    // No selection (fresh view / machine switch): prefer the order the press
    // is running right now; then the previous shift's unfinished order
    // (handover inheritance — still needs this crew's ✅ Confirm); fall
    // back to the earliest-starting planned order.
    const live = liveActiveJob();
    if (live) S!.selJob = live;
    else {
      const inherited = await prevShiftUnfinishedJob();
      if (inherited) S!.selJob = inherited;
      else if (orders.length) {
        S!.selJob = orders.slice().sort(compareOrdersByStart)[0].jobNumber;
      }
    }
  } else if (preferLiveJob && !isPastShift()) {
    const touched = S!.prod.some((r) => r.jobNumber === S!.selJob);
    const live = liveActiveJob();
    if (!touched && live && live !== S!.selJob) S!.selJob = live;
  }
  // Before anything writes a row: the order's own history is what stamps
  // its Part # and cycle time when Planning.csv no longer holds it.
  await refreshJobTotal();
  await refreshCoRunTotals();
  // Tuples that already carry real data are confirmed by definition —
  // must run before needsConfirm() gates the automation below.
  autoConfirmExistingWork();
  hydrateOperatorSupervisor();
  // Start-of-run automation is deferred until the worker confirms the
  // selection: an unconfirmed browse must leave zero footprint (the
  // auto-carried Count Start was exactly how junk tuples were born).
  if (!needsConfirm()) {
    // Count Start auto-carry: a same-machine/same-job continuation from
    // the previous shift starts where the previous shift's counter ended
    // — Day 14000 → Afternoon 14000 (Count Start) → Afternoon 28000 (End)
    // → Night 28000 (Count Start). Only fires when the operator hasn't
    // typed anything yet (count Start null on the live shift) and we
    // have a non-null Count End from the immediately-preceding shift on
    // the same machine + job.
    await maybeCarryCountStart();
    await syncCavitiesFromDie();
  }
  if (!needsConfirm()) await seedStatusFromCoRunner();
  saveView();
  render();
}

/**
 * Re-read the whole shift before anything decides what the press was
 * doing in a given half-hour.
 *
 * S.prod holds every job on this (machine, shift), but it is a SNAPSHOT:
 * reload() runs on mount and when the machine / job / date changes, and
 * filling in Machine Status deliberately skips it (see upsertSlot) — the
 * 30 s tick only redraws the now-line. So an order signed off on another
 * iPad after this page loaded stays invisible here, occupyingOtherJob()
 * reports its half-hours as free, and both users of that answer go wrong:
 *   - slotGapsForSignoff() counts the other order's slots as MY gaps and
 *     the sign-off gate demands they be filled, and
 *   - 🏁 End order / shift auto-paints R over them.
 * That is how 550T/29-07 ended up with SFM507363 recording 10:00–12:00,
 * which was 507381's run.
 *
 * Best effort by design: a failed read must not strand a finished shift,
 * so we say so and let the sign-off proceed on what we already have.
 *
 * Deliberately NOT debounced. The obvious floor sequence is "gate fires →
 * fill the missing slots → tap Sign off again", and any time window short
 * enough to spare the 🏁 End-order path its second read is also short
 * enough to skip that retry's read — which is the one that matters.
 */
export async function refreshPressState(): Promise<void> {
  try {
    await reload();
  } catch (e) {
    console.warn('[pmd] pre-sign-off refresh failed:', e);
    toast(
      "Couldn't re-check the other orders on this press — continuing with the data already loaded",
      'warn',
    );
  }
}

/**
 * When the operator opens an order that shares a die with one already
 * running this shift but has no machine status of its own yet, copy the
 * co-runner's timeline into it — they run together off the same die, so
 * the new order inherits the same status pattern. Only seeds a live,
 * writable, unsigned order that is genuinely empty (so it never
 * overwrites a status the operator has already entered, and never runs
 * on a past-shift review).
 */
async function seedStatusFromCoRunner(): Promise<void> {
  if (!S!.selJob || isPastShift() || isReadOnlyDevice() || isJobLocked()) return;
  const mineHasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (mineHasStatus) return;
  // Find a co-running sibling that DOES have a timeline to copy from.
  const sib = coRunSiblings(S!.selJob).find((j) =>
    S!.prod.some((r) => r.jobNumber === j && r.statusCode),
  );
  if (!sib) return;
  const sibSlots = S!.prod.filter((r) => r.jobNumber === sib && r.statusCode);
  for (const sr of sibSlots) {
    await upsertSlotForJob(S!.selJob, sr.slotIndex, (r) => {
      r.statusCode = sr.statusCode;
      r.bdIssue = sr.bdIssue;
      r.mangoTicket = sr.mangoTicket;
    });
  }
}

/** True when THIS browser is forbidden from writing — non-iPad without
 *  supervisor sign-in. Distinct from isJobLocked() (a signed-off row);
 *  this is a device-class lock that applies to every shift/job opened
 *  here, past or live. Replaces the old per-device OwnerDevice claim
 *  arbitration which caused iPad-vs-iPad fights on the floor. */
export function isReadOnlyDevice(): boolean {
  return !canWriteThisDevice();
}

// ---------------------------------------------------------------------
// Confirm flow — "this order really runs on this press, by these people".
//
// A live-shift (machine, order) selection starts UNCONFIRMED: the grid is
// locked, nothing is auto-carried or mirrored, and navigating away
// discards whatever the browse left behind. The worker picks Operator +
// Supervisor and taps ✅ Confirm — from then on the tuple is live: grid
// entry opens, Count Start carries over, and the 60 s mirror broadcasts
// it to PMD_LiveStatus (main.ts wires the mirror gate to the same
// registry). An unfinished order inherits onto the next shift's view but
// needs a fresh confirmation there — each shift's crew vouches for its
// own line. This is what keeps machine-hopping browses out of the data.
// ---------------------------------------------------------------------

/** True when the current selection still needs the worker's ✅ Confirm
 *  before data entry / mirroring. Past shifts (history review), locked
 *  orders and read-only devices are exempt — the gate is for creating
 *  NEW live data only. */
export function needsConfirm(): boolean {
  if (!S!.selJob || isPastShift() || isReadOnlyDevice() || isJobLocked()) return false;
  return !isTupleConfirmed(S!.mc, sid(), S!.selJob);
}

/** Whether the ✅ Confirm gate stops a Machine Status or defect edit. A
 *  signed-in supervisor is not stopped: they vouch for the order by editing
 *  it, and `claimForSupervisorEdit` confirms the tuple on their first write.
 *  Kept apart from needsConfirm(), which also holds back the start-of-run
 *  automation and discards a browse — a supervisor merely LOOKING at a
 *  press must still leave no data behind. */
export function confirmBlocksEdit(): boolean {
  return needsConfirm() && !isSupervisor();
}

/** A supervisor's first Machine Status / defect write on an unconfirmed
 *  live order confirms it, so the edit is mirrored like any other and is not
 *  discarded when they move on. */
function claimForSupervisorEdit(): void {
  if (isSupervisor() && needsConfirm()) confirmTuple(S!.mc, sid(), S!.selJob);
}

/** Mirror of the DAL's hasMeaningfulProgress: real production evidence,
 *  not just a picked name. */
function rowHasProgress(r: ProductionRecord): boolean {
  if (r.statusCode) return true;
  if (r.countStart != null || r.countEnd != null || r.purgeKg != null) return true;
  if (r.rejectCount > 0 || (r.rejects && r.rejects !== '{}')) return true;
  const note = (r.handoverNote ?? '').trim();
  return !!note && note !== '{}';
}

/**
 * Grandfather clause, run on every reload: any job on this (machine,
 * shift) that ALREADY carries real production data is treated as
 * confirmed. Covers tuples created before the confirm flow shipped,
 * tuples authored by another device (someone else already vouched), and
 * signed-then-unlocked corrections — without it, deploying the gate
 * would freeze every in-flight shift on the floor.
 */
function autoConfirmExistingWork(): void {
  const byJob = new Map<string, boolean>();
  for (const r of S!.prod) {
    if (!r.jobNumber) continue;
    byJob.set(r.jobNumber, (byJob.get(r.jobNumber) ?? false) || rowHasProgress(r));
  }
  for (const [job, has] of byJob) {
    if (has && !isTupleConfirmed(S!.mc, sid(), job)) confirmTuple(S!.mc, sid(), job);
  }
}

/** Before navigating away from an unconfirmed selection, drop whatever
 *  the browse wrote (staged names, legacy junk) so it can never be
 *  mirrored later. No-op when the tuple is confirmed or has no job. */
export function discardIfUnconfirmed(): void {
  if (!needsConfirm()) return;
  void dalRef
    .discardUnconfirmedTuple?.(S!.mc, sid(), S!.selJob)
    .catch((e) => console.warn('[pmd] unconfirmed-tuple discard failed', e));
  // Keep the in-memory rows consistent with the discarded cache.
  S!.prod = S!.prod.filter((r) => r.locked || r.jobNumber !== S!.selJob);
}

/**
 * The orders this press ran last shift that Planning.csv has since dropped.
 * Read once per press and shift; live shifts only — a past shift lists what
 * it recorded, and a future one has nothing to carry yet.
 */
async function loadCarriedJobs(): Promise<void> {
  if (isPastShift() || isFutureShift()) return;
  const prevSid = previousShift(sid());
  if (!prevSid) return;
  const key = `${S!.mc}|${prevSid}`;
  if (S!.carried?.key === key) return;
  try {
    const rows = await dalRef.listProduction({ machineCode: S!.mc, shiftId: prevSid });
    const jobs = [
      ...new Set(
        rows
          .filter((r) => r.statusCode && r.jobNumber && !r.jobNumber.startsWith('DC_'))
          .map((r) => r.jobNumber),
      ),
    ].filter((j) => !jobInPlanning(j));
    S!.carried = { key, jobs };
  } catch (e) {
    console.warn('[pmd] carried-over orders lookup failed', e);
  }
}

/** Is this order one the press carried over from last shift (see loadCarriedJobs)? */
export function isCarried(job: string): boolean {
  return (
    !!S!.carried &&
    S!.carried.key === `${S!.mc}|${previousShift(sid()) ?? ''}` &&
    S!.carried.jobs.includes(job)
  );
}

/**
 * Shift handover inheritance: when a fresh (unconfirmed, empty) live
 * shift opens with no live job of its own, offer the job the SAME press
 * was running at the end of the PREVIOUS shift — provided it's still
 * selectable (in planning ⇒ not complete). The worker still has to
 * ✅ Confirm it, which is the "inherits but must be re-confirmed" rule.
 */
async function prevShiftUnfinishedJob(): Promise<string> {
  if (isPastShift() || isFutureShift()) return '';
  const prevSid = previousShift(sid());
  if (!prevSid) return '';
  try {
    const rows = await dalRef.listProduction({ machineCode: S!.mc, shiftId: prevSid });
    let best = '';
    let bestSlot = -1;
    for (const r of rows) {
      if (!r.statusCode || !r.jobNumber) continue;
      if (r.slotIndex > bestSlot) {
        bestSlot = r.slotIndex;
        best = r.jobNumber;
      }
    }
    if (!best) return '';
    return shiftOrders().some((o) => o.jobNumber === best) ? best : '';
  } catch (e) {
    console.warn('[pmd] prev-shift job inheritance lookup failed', e);
    return '';
  }
}

/** Other presses already running THIS order live this shift. One die =
 *  one press, so the same job can't legitimately run on two machines at
 *  once — this backs the confirm-time warning. Reads cross-machine rows
 *  (listProduction with no machineCode = every press blends the
 *  PMD_LiveStatus mirror) and keeps only OTHER presses carrying real
 *  evidence: a machine-status letter or a signed-off lock, never a bare
 *  browse selection. */
async function jobRunningElsewhere(job: string): Promise<string[]> {
  if (!job) return [];
  try {
    const rows = await dalRef.listProduction({ shiftId: sid(), jobNumber: job });
    return pressesRunningJobElsewhere(rows, S!.mc, job);
  } catch (e) {
    console.warn('[pmd] cross-machine duplicate-order check failed', e);
    return [];
  }
}

/** Warn that the order is already on another press, and let the worker
 *  either back out to change it (recommended) or override. Resolves true
 *  to proceed with the confirmation, false to abort it. */
function confirmDuplicateOrder(job: string, machines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const list = machines.map((m) => escapeHtml(m)).join('、');
    const mc = openModal(`<div class="bd-modal">
      <h3 class="bd-title">⚠️ Order already running on another press</h3>
      <p class="bd-sub">
        <b>${escapeHtml(job)}</b> is already confirmed and producing on
        <b>${list}</b> this shift. A die is unique — the same order can only
        run on ONE press at a time, so this is almost certainly the wrong
        order or the wrong press. Change the order (or the press) unless the
        die has genuinely been moved here.
      </p>
      <div class="bd-actions">
        <button type="button" class="btn-primary-big" data-dup="change">← Change order</button>
        <button type="button" class="btn-ghost-big" data-dup="anyway">Confirm anyway</button>
      </div>
    </div>`);
    const done = (v: boolean): void => {
      closeModal();
      resolve(v);
    };
    mc.querySelector('[data-dup="change"]')?.addEventListener('click', () => done(false));
    mc.querySelector('[data-dup="anyway"]')?.addEventListener('click', () => done(true));
  });
}

/** The ✅ Confirm tap: requires Operator AND Supervisor picked, writes
 *  them onto the canonical slot, marks the tuple confirmed, then lets
 *  the deferred start-of-run automation (Count Start carry, co-run
 *  seed) run via reload. */
export async function confirmCurrentTuple(): Promise<void> {
  if (!needsConfirm()) return;
  if (!S!.selOperator || !S!.selSupervisor) {
    toast('Pick Operator AND Supervisor first — the confirmation records who is running this order', 'warn');
    return;
  }
  // One die = one press: block the common mistake of a second press
  // confirming an order that's already live elsewhere (a wrong pick).
  const elsewhere = await jobRunningElsewhere(S!.selJob);
  if (elsewhere.length > 0) {
    const proceed = await confirmDuplicateOrder(S!.selJob, elsewhere);
    if (!proceed) return;
  }
  confirmTuple(S!.mc, sid(), S!.selJob);
  await upsertSlotNoReload(0, (r) => {
    r.operator = S!.selOperator;
    r.supervisor = S!.selSupervisor;
  });
  toast(`Confirmed — ${S!.selJob} on ${S!.mc}, ${S!.selOperator}`, 'ok');
  await reload();
}

/**
 * Operator / Supervisor always mirror the selected (machine, shift, job)
 * tuple's canonical slot-0 record — never a selection left over from a
 * previously-viewed date, machine, or order. Reported bug: switching to a
 * past shift kept the live selection, and switching back to today's order
 * showed an edited name instead of the one already chosen for that order.
 *
 * When the tuple has a canonical row (signed-off, unlocked, or a live shift
 * where someone has been picked), load its names; otherwise blank both —
 * nobody has been assigned to this tuple yet. Picking a name in the dropdown
 * writes slot 0 (onMetaChange), so the choice survives the reload that
 * follows and every subsequent slot edit (upsertSlot preserves slot 0's
 * operator/supervisor), which is why an unconditional load never wipes an
 * active operator's own selection.
 */
function hydrateOperatorSupervisor(): void {
  const c = canonical();
  // Unconfirmed tuple: names are STAGED locally (nothing written yet, so
  // canonical is empty) — keep whatever the worker just picked so the
  // reload between pick and ✅ Confirm doesn't blank the dropdowns.
  //
  // Only for the press and shift they were picked on. The next shift's
  // sheet starts with nobody named: left showing the crew before it, it was
  // confirmed as it stood and the Afternoon was recorded under the Day's
  // operator and supervisor (hot-stamp press, 12 Nov 2026).
  const here = `${S!.mc}|${sid()}`;
  const names = namesForSheet({
    here,
    pickedFor: S!.namesFor,
    unconfirmed: needsConfirm() && !c?.operator && !c?.supervisor,
    picked: { operator: S!.selOperator, supervisor: S!.selSupervisor },
    recorded: c,
  });
  S!.selOperator = names.operator;
  S!.selSupervisor = names.supervisor;
  S!.namesFor = here;
}

/**
 * Most recent canonical Count End for this (machine, job) on a shift
 * strictly before the one currently being viewed, looking back 7 days
 * (an arbitrary but reasonable bound — gaps longer than that are
 * almost certainly a brand-new run, not a continuation).
 *
 * One ranged listProduction instead of up to 21 sequential by-shiftId
 * round-trips — on iPad/SP that turns a 2-3 s "switch to a fresh
 * shift" lag into a single sub-200 ms call.
 */
async function prevShiftCountEnd(): Promise<{ countEnd: number; cavities?: number } | null> {
  if (!S!.selJob) return null;
  const currentSid = buildShiftId(S!.viewDate, S!.shiftCode);
  const sevenDaysAgo = new Date(S!.viewDate);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const rows = await dalRef.listProduction({
    machineCode: S!.mc,
    jobNumber: S!.selJob,
    shiftIdFrom: dateKey(sevenDaysAgo),
    // '-￿' suffix keeps same-day shifts inside the range: shiftIds are
    // 'YYYY-MM-DD-<code>' and a bare 'YYYY-MM-DD' upper bound sorts
    // BEFORE them, which silently dropped the Day shift when carrying
    // Count Start into the same day's Afternoon / Night shift.
    shiftIdTo: `${dateKey(S!.viewDate)}-￿`,
  });
  // Pick the canonical row whose shiftId is the largest one strictly
  // before the current shift. Lex-sort works because shiftIds are
  // `YYYY-MM-DD-<code>` and the codes sort Afternoon < Day < Night —
  // chronologically wrong, so we compute the previous shiftId via
  // previousShift() and walk a tiny in-memory list.
  let sid: string | null = previousShift(currentSid);
  const byShift = new Map<string, ProductionRecord>();
  for (const r of rows) {
    if (r.slotIndex === 0 && r.countEnd != null) byShift.set(r.shiftId, r);
  }
  for (let hops = 0; hops < 21 && sid; hops++) {
    const canon = byShift.get(sid);
    if (canon) return { countEnd: Number(canon.countEnd), cavities: canon.cavities };
    sid = previousShift(sid);
  }
  return null;
}

async function maybeCarryCountStart(): Promise<void> {
  if (!S!.selJob) return;
  const c = canonical();
  // Don't touch signed-off shifts or shifts where the operator already
  // typed a Count Start (the existing value wins).
  if (c?.locked) return;
  if (c?.countStart != null) return;
  const prev = await prevShiftCountEnd();
  if (prev == null) return;
  // A cavity blocked off on the last shift is still blocked on this one
  // unless somebody says otherwise: the die has not been out of the press.
  // Carried only when it is BELOW the register's count — a full count is
  // what the row was born with anyway.
  const src = cavitySource();
  const blocked =
    src.known && prev.cavities != null && prev.cavities >= 1 && prev.cavities < src.count
      ? prev.cavities
      : null;
  console.info(
    `[pmd] auto-carry Count Start ← ${prev.countEnd} (prev shift's Count End on ${S!.mc}/${S!.selJob})` +
      (blocked != null ? `, cavities ×${blocked} of ${src.count} (blocked on the prev shift)` : ''),
  );
  // Use no-reload upsert so we don't recurse via reload().
  await upsertSlotNoReload(0, (r) => {
    r.countStart = prev.countEnd;
    if (blocked != null) r.cavities = blocked;
  });
}

/**
 * Give the canonical row a Cavities number when it has none.
 *
 * New rows are born with the register's count (blankRecordForJob), but a
 * row written before the toolroom filled the tool in carries nothing, and
 * every consumer downstream reads the stored number rather than
 * re-deriving it. So the sheet fills it on load.
 *
 * It fills; it never corrects. A number the row already carries is the
 * one the shift ran on — the register's count, or fewer when a cavity was
 * blocked off and somebody set it so on the sheet — and putting the
 * register's count back over it would book Good the press never made.
 *
 * Nor will it create a row (an unconfirmed browse must leave no
 * footprint), touch a signed-off shift (history is frozen), or write
 * anything when PMD_DieMaster has no answer.
 */
async function syncCavitiesFromDie(): Promise<void> {
  if (!S!.selJob) return;
  const src = cavitySource();
  if (!src.known) return;
  const c = canonical();
  if (!c || c.locked) return;
  if (c.cavities != null && c.cavities >= 1) return;
  console.info(`[pmd] cavities → ×${src.count} from ${src.dieNumber} (PMD_DieMaster)`);
  await upsertSlotNoReload(0, (r) => {
    r.cavities = src.count;
  });
}

/** Cavities for a job, and where the number came from: order → part →
 *  Die # (PMD_ProductDieColor) → Cavities (PMD_DieMaster). */
export function cavitySourceForJob(job: string): CavitySource {
  return resolveCavities(dieRowForJob(job)?.dieNumber ?? '', S!.dieCavities);
}

export function cavitySource(): CavitySource {
  return cavitySourceForJob(S!.selJob);
}

/**
 * Cavities to count this job's output on: the number the row carries —
 * the register's count from when the row was born, or fewer where a
 * cavity was blocked off and the sheet was set so — else the register's
 * answer, else 1. See `runningCavities`.
 */
export function cavities(): number {
  return runningCavities(canonical()?.cavities, cavitySource());
}

/**
 * Shift Target = pieces the operator should aim for this shift, from the
 * job demand AT SHIFT START (signed cross-shift good only — goodThis is
 * deliberately excluded, otherwise the target would shrink as the shift
 * produces) over the press hours actually AVAILABLE to this job:
 *
 *   target = min(Job Left,
 *                (8h − hours held by earlier orders this shift
 *                    − this job's changeover D/C/I time) ÷ ProdStandard)
 *
 * S!.prod carries every job's slots for this (machine, shift), so the
 * deduction sees the previous order's footprint and any die-change
 * pseudo-order timeline (co-run mirrors are exempt — see
 * hoursUnavailableFor). Stable while the job runs (its own R slots never
 * deduct); it only steps down when a changeover is logged. Same formula
 * lockShift persists to the ShiftTarget column.
 */
export function shiftTarget(): number | null {
  const o = selectedOrder();
  if (!o) return null;
  const jl = jobLeftPiecesFor(o, S!.jobTotalGood);
  if (jl == null) return null;
  return shiftTargetFor(o, jl, hoursUnavailableFor(S!.prod, S!.selJob));
}

interface ShiftOutputWarning {
  target: number;
  limit: number;
  message: string;
}

/** Build the one warning used by the live side panel and sign-off gate. */
export function shiftOutputWarning(totalGood: number): ShiftOutputWarning | null {
  const target = shiftTarget();
  if (!totalGoodExceedsShiftTarget(totalGood, target) || target == null) return null;
  const limit = Math.floor(target * SHIFT_TARGET_WARNING_RATIO);
  const n = (value: number): string => value.toLocaleString('en-AU');
  return {
    target,
    limit,
    message: `⚠ Total Good ${n(totalGood)} is above 130% of Shift Target ${n(target)} (maximum ${n(limit)}). Check and change Count Start or Count End.`,
  };
}

/**
 * Job Left = JobRequired − sum(Good) across all OTHER shifts of this job.
 * The current (S!.mc, sid()) tuple is EXCLUDED here because jobLeftPieces()
 * adds goodThis (this shift's good) on top of S!.jobTotalGood — counting
 * the current shift in both places double-subtracted it from JobRequired
 * and made Job Left collapse to 0 the moment Count End was filled in.
 *
 * SIGNED rows only (PMD_Production), same source the Trace page and the
 * sign-off JobLeft column use, so all three always agree and the number
 * is exactly reproducible from the list (JobRequired − Σ TotalGood).
 * Mixing in live/editCache tuples made this drift on every stale mirror
 * shadow; the price is that an earlier shift's output only counts once
 * that shift is signed off.
 */
async function refreshJobTotal(): Promise<void> {
  if (!S!.selJob) {
    S!.jobTotalGood = 0;
    S!.unsignedEarlier = [];
    return;
  }
  const currentKey = `${S!.mc}|${sid()}`;
  // Blended read (live mirror + cache + signed) feeds ONLY the unsigned-
  // earlier-shift detector; the Job Left ARITHMETIC below stays strictly
  // signed-only — mixing live tuples into the sum is what caused the
  // SFM507147 phantom-shadow drift.
  const blended = await dalRef.listProduction({ jobNumber: S!.selJob });
  const signed = dalRef.listSignedOffProduction
    ? await dalRef.listSignedOffProduction({ jobNumber: S!.selJob })
    : // Memory DAL fallback: signed rows only (reopened rows are signed
      // rows temporarily unlocked for correction — still counted).
      blended.filter((r) => r.locked || r.reopened);
  S!.jobTotalGood = sumOtherShiftGood(signed, currentKey);
  S!.jobFacts = { job: S!.selJob, facts: orderFactsFromHistory(signed) };
  S!.unsignedEarlier = unsignedEarlierTuples(blended, currentKey);
}

/** How long a co-runner's signed total is reused. It only moves when some
 *  OTHER shift of that order is signed off, so it need not be re-read on
 *  every tap of the sheet. */
const CO_RUN_TOTALS_MS = 5 * 60_000;

/**
 * Good already signed on other shifts for each other order on the selected
 * order's die (coRunDieJobs) — the same signed-only figure refreshJobTotal
 * keeps for the selected order itself, so an order's Job Left in the
 * block-the-cavity reminder is the number its own sheet shows. An order that
 * cannot be read is left out, and its part gets no reminder, rather than be
 * counted from nothing.
 */
async function refreshCoRunTotals(): Promise<void> {
  const state = S!;
  const job = state.selJob;
  const key = `${state.mc}|${sid()}`;
  const links = job && !isPastShift() ? coRunDieJobs(job) : [];
  if (!links.length) {
    state.coRunGood = null;
    return;
  }
  const had = state.coRunGood;
  if (
    had &&
    had.job === job &&
    had.key === key &&
    Date.now() - had.at < CO_RUN_TOTALS_MS &&
    links.every((j) => had.totals.has(j))
  ) {
    return;
  }
  const totals = new Map<string, number>();
  await Promise.all(
    links.map(async (j) => {
      try {
        const signed = dalRef.listSignedOffProduction
          ? await dalRef.listSignedOffProduction({ jobNumber: j })
          : (await dalRef.listProduction({ jobNumber: j })).filter(
              (r) => r.locked || r.reopened,
            );
        totals.set(j, sumOtherShiftGood(signed, key));
      } catch (e) {
        console.warn(`[pmd] co-run: could not read what is already made of ${j}`, e);
      }
    }),
  );
  state.coRunGood = { job, key, at: Date.now(), totals };
}

/** Good made of `job` on the shift on screen: slot-0 counters × cavities,
 *  less every reject entered against it. */
function goodThisShiftFor(job: string): number {
  const c = S!.prod.find((r) => r.jobNumber === job && r.slotIndex === 0);
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, c?.cavities);
  return Math.max(0, gross - jobTotals(job));
}

/**
 * The block-the-cavity reminders for the die the selected order runs on (see
 * cavityBlockReminders). Empty on a past shift, for an order with no
 * co-runner, and until the other orders' signed totals have been read for
 * this very selection.
 */
export function cavityBlockNotes(): CavityBlockReminder[] {
  const job = S!.selJob;
  if (!job || isPastShift()) return [];
  const known = S!.coRunGood;
  if (!known || known.job !== job || known.key !== `${S!.mc}|${sid()}`) return [];
  const others = coRunDieJobs(job);
  if (!others.length) return [];
  const progress = [job, ...others].map((j) => {
    const o = orderForJob(j);
    const signedElsewhere = j === job ? S!.jobTotalGood : known.totals.get(j);
    const jobLeft =
      o && signedElsewhere != null
        ? jobLeftPiecesFor(o, signedElsewhere + goodThisShiftFor(j))
        : null;
    return {
      jobNumber: j,
      partNumber: partNumberForJob(j),
      jobLeft,
      shiftCapacity: o ? shiftCapacityFor(o) : null,
      onShift: S!.prod.some((r) => r.jobNumber === j),
    };
  });
  return cavityBlockReminders(progress);
}

/** "125T|2026-07-06-Afternoon" → "06/07 Afternoon" (+ machine when it's
 *  not the press on screen) for the Job Left ⚠ tooltip. */
function fmtTupleKey(key: string): string {
  const cut = key.indexOf('|');
  const mc = key.slice(0, cut);
  const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(key.slice(cut + 1));
  if (!m) return key;
  return `${m[3]}/${m[2]} ${m[4]}${mc !== S!.mc ? ` (${mc})` : ''}`;
}

export function jobLeftWarnTitle(): string {
  if (!S!.unsignedEarlier.length) return '';
  return `Job Left may be OVERSTATED — earlier shift(s) produced pieces but are NOT signed off yet: ${S!.unsignedEarlier
    .map(fmtTupleKey)
    .join(
      ', ',
    )}. Their output only counts once a supervisor signs them off — then this number (and the shifts after) self-correct.`;
}

/**
 * Live-update the Total Good / Total Reject / Job Left cells without a
 * re-render. Used by the canonical-slot edits (Count Start / End / Purge)
 * that now go through upsertSlotNoReload so the focused input is not
 * destroyed mid-typing.
 */
export async function refreshJobTotalAndPaintSide(): Promise<void> {
  await refreshJobTotal();
  const c = canonical();
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, c?.cavities);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
  const o = selectedOrder();
  // Shared core formula (order TOTAL − good) — see jobLeftPiecesFor for
  // why the base must not be Epicor's already-decremented remaining qty.
  const jobLeft = o ? jobLeftPiecesFor(o, S!.jobTotalGood + good) : null;
  // Patch by data-live tag — text-content matching used to live here,
  // but renaming a label silently broke the live update. Tags are set
  // in buildSide() on each <b> so this stays in sync with the layout.
  const set = (tag: string, v: string | null): void => {
    if (v == null) return;
    const el = document.querySelector<HTMLElement>(`.op-side [data-live="${tag}"]`);
    if (el) el.textContent = v;
  };
  set('jobLeft', jobLeft == null ? null : String(jobLeft));
  set('totalGood', String(good));
  set('totalReject', String(totalReject));
  const outputWarning = shiftOutputWarning(good);
  const outputWarnEl = document.querySelector<HTMLElement>(
    '.op-side [data-live="outputWarn"]',
  );
  if (outputWarnEl) {
    outputWarnEl.hidden = !outputWarning;
    outputWarnEl.textContent = outputWarning?.message ?? '';
  }
  paintCavityBlockBanner();
  document
    .querySelectorAll<HTMLInputElement>(
      '.op-side input[data-meta="cstart"],.op-side input[data-meta="cend"]',
    )
    .forEach((input) => {
      input.classList.toggle('count-invalid', Boolean(outputWarning));
      input.setAttribute('aria-invalid', outputWarning ? 'true' : 'false');
    });
  document
    .querySelector<HTMLElement>('.op-side [data-live="totalGood"]')
    ?.classList.toggle('count-invalid', Boolean(outputWarning));
  const warnEl = document.querySelector<HTMLElement>('.op-side [data-live="jlWarn"]');
  if (warnEl) {
    warnEl.style.display = S!.unsignedEarlier.length ? '' : 'none';
    warnEl.title = jobLeftWarnTitle();
  }
}

/** Like upsertSlot but doesn't call reload — caller batches the final render. */
export async function upsertSlotNoReload(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) return;
  // Same guard as upsertSlot — the side panel inputs are wired to
  // upsertSlotNoReload (Count Start / End / Purge / handover) and
  // must not write when the order is signed off and the user isn't
  // a supervisor, or when this is a read-only (non-iPad) device.
  if (isJobLocked() || isReadOnlyDevice()) return;
  claimForSupervisorEdit();
  const existing = S!.prod.find(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  const rec = existing ? { ...existing } : blankRecord(slot);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  // Same sync-update as upsertSlot — keeps S!.prod consistent for the next
  // hand-* event without triggering a render() that would destroy the
  // textarea the operator is currently typing into.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}

/**
 * Write one slot of an ARBITRARY job (not the selected one) — used by
 * the co-run status mirror / seed to copy the machine status onto each
 * sibling order sharing the die. Skips a sibling that's signed off
 * (never modify a locked order) and respects the read-only device rule.
 */
export async function upsertSlotForJob(
  job: string,
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!job || isReadOnlyDevice()) return;
  if (S!.prod.some((r) => r.jobNumber === job && r.locked)) return;
  const existing = S!.prod.find((r) => r.jobNumber === job && r.slotIndex === slot);
  const rec = existing ? { ...existing } : blankRecordForJob(slot, job);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  const idx = S!.prod.findIndex((r) => r.jobNumber === job && r.slotIndex === slot);
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}
