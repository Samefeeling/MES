import type { PlanningOrder, ProductionRecord } from '../types';
import { aggregate, countSetupEvents } from './metrics';
import { crewedWindowHoursBefore, plannedOrdersForShift, plannedRuntimeForShift } from './schedule';
import { SLOT_MINUTES, shiftBounds } from './shifts';
import { setupStandardHours } from './standards';
import { wholePieces } from './targets';

const SLOT_HOURS = SLOT_MINUTES / 60;

export interface KpiAttainment {
  /** Good pieces allowed into the comparison numerator. */
  actual: number;
  /** Scheduled/target pieces in the comparison denominator. */
  expected: number;
  pct: number | null;
  /** Tuples with a usable comparison value. */
  covered: number;
  /** Tuples that should have had a comparison value. */
  total: number;
}

/**
 * Where a period's Schedule Adherence comes from. Last 24h plans live from
 * Planning.csv; a wider period reads the plan each shift saved when it was
 * signed off (`savedScheduleTuples`), because Planning.csv is overwritten on
 * every export and no longer holds last week's plan.
 */
export type KpiComparisonMode = 'schedule' | 'saved';

export function kpiComparisonMode(period: string): KpiComparisonMode {
  return period === 'last3' ? 'schedule' : 'saved';
}

export function kpiComparisonLabel(_mode: KpiComparisonMode): 'Schedule Adherence' {
  return 'Schedule Adherence';
}

function result(actual: number, expected: number, covered: number, total: number): KpiAttainment {
  return {
    actual,
    expected,
    pct: expected > 0 ? Math.round((actual / expected) * 100) : null,
    covered,
    total,
  };
}


// Legacy VSPLAN sign-off snapshot. The KPI page plans through scheduleTuplesForShift.
/**
 * Hours of one shift the plan was never going to be running in.
 *
 *   - Each changeover the shift recorded earns its STANDARD allowance — a die
 *     change 4 h, a colour or insert change 30 min — not the time it actually
 *     took. Standard, so a die change that dragged to six hours shows up as
 *     missed output instead of quietly lowering the bar it is judged against.
 *   - Smoko is deducted at its actual length. It is a scheduled break, there is
 *     no site standard for it in the data, and a shift cannot be asked to
 *     produce through one.
 *
 * Capped at the hours the press spent NOT running: it cannot have lost more
 * than that, whatever the allowance adds up to. That cap is also what keeps a
 * pair of co-running orders — one die change written on both their rows, which
 * counts as two changeovers — from deducting eight hours from an eight-hour
 * shift.
 *
 * Everything here is counted in DISTINCT SLOTS. Co-running orders (one die
 * making two or three parts at once) mirror the same statuses onto the same
 * half-hours, and a half-hour the press spent changing over is one half-hour
 * however many order rows say so.
 */
function unavailableHoursForShift(records: ReadonlyArray<ProductionRecord>): number {
  const flat = [...records];
  const std = setupStandardHours(countSetupEvents(flat));
  const stdSetupHrs = std.dieStdHrs + std.colorStdHrs + std.insertStdHrs;
  const smoko = new Set<number>();
  const filled = new Set<number>();
  const running = new Set<number>();
  for (const r of flat) {
    if (!r.statusCode) continue;
    filled.add(r.slotIndex);
    if (r.statusCode === 'M') smoko.add(r.slotIndex);
    if (r.statusCode === 'R') running.add(r.slotIndex);
  }
  const notRunning = Math.max(0, filled.size - running.size) * SLOT_HOURS;
  return Math.min(stdSetupHrs + smoko.size * SLOT_HOURS, notRunning);
}

/**
 * True schedule adherence for one machine-shift.
 *
 * The bar is the floor's own formula — **Shift Planned Runtime ×
 * JobOper_ProdStandard** — worked out by `plannedRuntimeForShift` from the
 * hours this shift actually had to run in: elapsed, less the standard
 * changeover allowance and smoko, and shared out between the planned orders so
 * the plan can never ask one press for more hours than the shift holds.
 *
 * It used to be each order's whole Start–Due overlap with the shift at rate,
 * with no deduction at all. On a press carrying three overlapping planned
 * windows and a die change that was a bar two or three times what anybody could
 * have made, and the page read single-digit adherence on shifts that had run
 * their plan.
 *
 * Each scheduled order is still judged independently and capped at 100%, so
 * over-producing Job A cannot compensate for missing Job B. Unscheduled output
 * never enters the numerator.
 */
export function scheduleAdherenceForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
): KpiAttainment {
  const onShift = records.filter((record) => record.shiftId === shiftId);
  const planned = plannedRuntimeForShift(
    shiftId,
    orders,
    machineCode,
    asOf,
    unavailableHoursForShift(onShift),
  );
  const expectedByJob = new Map<string, number>();
  for (const run of planned.runs) {
    if (run.pieces <= 0) continue;
    const job = run.order.jobNumber.trim().toUpperCase();
    if (!job) continue;
    expectedByJob.set(job, (expectedByJob.get(job) ?? 0) + run.pieces);
  }

  let actual = 0;
  let expected = 0;
  let covered = 0;
  for (const [job, want] of expectedByJob) {
    const matching = onShift.filter(
      (record) => record.jobNumber.trim().toUpperCase() === job,
    );
    const good = aggregate([...matching]).output;
    actual += Math.min(good, want);
    expected += want;
    if (matching.length) covered++;
  }
  return result(actual, expected, covered, expectedByJob.size);
}


/**
 * One Machine + Shift + Job line of a KPI comparison. Every figure the page
 * shows for a plan — the "/plan" beside Output and the percentage — is a sum
 * of these, so a machine, a shift, an order and a category can never be
 * judged by different rules.
 *
 *   - `schedule`     planned in Planning.csv for this press and shift.
 *   - `shiftTarget`  run, but its order has left Planning.csv (Epicor drops a
 *                    finished job), so the ShiftTarget saved when it ran is
 *                    the only record of what it was asked for.
 *   - `unscheduled`  run, while Planning.csv has the order somewhere else —
 *                    another press or another shift. Not part of the plan,
 *                    so it is neither credited nor asked for.
 *   - `saved`        a whole machine-shift, from the plan its sign-off saved
 *                    (ScheduleAttain / SchedulePlan). `jobNumber` is blank:
 *                    the plan is the press's, not one order's.
 */
export type AttainmentSource = 'schedule' | 'shiftTarget' | 'unscheduled' | 'saved';

export interface AttainmentTuple {
  machineCode: string;
  shiftId: string;
  jobNumber: string;
  /** Pieces asked for. null = this line should carry a plan and none is known
   *  (no ShiftTarget saved, no rate in Planning.csv). */
  planned: number | null;
  /** Good made (signed-off records only — the caller's filter). */
  good: number;
  /** Good allowed into the numerator: capped at the plan when adherence is
   *  capped, 0 when there is no plan to credit it against. */
  credited: number;
  source: AttainmentSource;
  /** `saved` lines only: the order that made most of the shift's Good. A
   *  shift's plan cannot be split between its orders after the fact, so this
   *  is the order whose part category the whole line is counted under. */
  leadJob?: string;
  /** The press booked something in the shift and nobody has signed it off.
   *  Its plan counts and nothing is credited until it is signed: only signed
   *  output counts on the KPI page, and a shift left unsigned must not take
   *  its plan out of the comparison with it. */
  unsigned?: boolean;
  /** Wider periods: a machine-shift with no signed production at all, one
   *  line for the press (`idleShiftTuples`). */
  idle?: boolean;
}

/** The comparison over a set of lines. Unscheduled lines are outside it on
 *  both sides; a line with no known plan counts against coverage, not
 *  against the percentage. */
export function attainmentOfTuples(tuples: ReadonlyArray<AttainmentTuple>): KpiAttainment {
  let actual = 0;
  let expected = 0;
  let covered = 0;
  let total = 0;
  for (const tuple of tuples) {
    if (tuple.source === 'unscheduled') continue;
    total++;
    if (tuple.planned == null) continue;
    covered++;
    actual += tuple.credited;
    expected += tuple.planned;
  }
  return result(actual, expected, covered, total);
}

const jobKey = (job: string): string => job.trim().toUpperCase();

/**
 * ShiftTarget lines: one per Machine + Shift + Job in the records.
 *
 * ShiftTarget is a tuple-level snapshot but may be present on more than
 * one slot in legacy data. Group by Machine + Shift + Job, prefer slot 0,
 * and count both the target and Good exactly once. A line without a valid
 * target carries planned: null and is reported through coverage. Zero is
 * an explicit target, not a missing value. `capPerJob` caps each line at its
 * target; without it over-production is kept.
 */
export function targetTuplesForRecords(
  records: ReadonlyArray<ProductionRecord>,
  capPerJob = false,
): AttainmentTuple[] {
  const groups = new Map<string, ProductionRecord[]>();
  for (const record of records) {
    const machine = record.machineCode.trim().toUpperCase();
    const job = jobKey(record.jobNumber);
    if (!machine || !record.shiftId || !job || job.startsWith('DC_')) continue;
    const key = `${machine}|${record.shiftId}|${job}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const out: AttainmentTuple[] = [];
  for (const group of groups.values()) {
    const canonical = group.find((record) => record.slotIndex === 0);
    const targetRecord =
      canonical && Number.isFinite(canonical.shiftTarget) && (canonical.shiftTarget ?? -1) >= 0
        ? canonical
        : group.find(
            (record) =>
              Number.isFinite(record.shiftTarget) && (record.shiftTarget ?? -1) >= 0,
          );
    const good = aggregate(group).output;
    const target = targetRecord ? targetRecord.shiftTarget! : null;
    out.push({
      machineCode: group[0].machineCode.trim(),
      shiftId: group[0].shiftId,
      jobNumber: group[0].jobNumber.trim(),
      planned: target,
      good,
      credited: target == null ? 0 : capPerJob ? Math.min(good, target) : good,
      source: 'shiftTarget',
    });
  }
  return out;
}

/** Vs Target over a set of records: Σ Good ÷ Σ ShiftTarget, capped per line
 *  when `capPerJob`. */
export function targetAttainmentForRecords(
  records: ReadonlyArray<ProductionRecord>,
  capPerJob = false,
): KpiAttainment {
  return attainmentOfTuples(targetTuplesForRecords(records, capPerJob));
}

/**
 * Schedule Adherence lines for one machine-shift, planned from Planning.csv.
 *
 * The plan is what Planning.csv put on this press in this shift — whether or
 * not anybody came to run it. That is the whole point: a press planned for
 * the afternoon that stood idle for want of a crew has no production records
 * and so no ShiftTarget, and a plan read off the records left it out of the
 * denominator altogether. The floor read 96% on a day an entire press's
 * schedule was missed.
 *
 *   planned  = the order's share of the shift's planned runtime ×
 *              JobOper_ProdStandard (`plannedRuntimeForShift`), only in the
 *              shifts its "no of shift" says the press is crewed for, and never
 *              more than is left of the order's quantity after the shifts
 *              before this one were asked for theirs — Epicor's Start–Due
 *              window carries the setup time as well, so hours × rate alone
 *              asks for more pieces than the order holds.
 *   credited = min(Good, planned) per order, so over-producing one order
 *              cannot hide missing another.
 *
 * Output of an order Planning.csv still holds but not here is `unscheduled`;
 * output of an order it no longer holds at all falls back to that line's saved
 * ShiftTarget (see AttainmentSource). `unsigned` marks every line of a shift
 * the caller knows has unsigned records and no signed ones: still planned,
 * nothing credited, and labelled so a press waiting for its supervisor does
 * not read as one that never ran.
 *
 * Records are this machine's signed-off records; lines for other shifts are
 * ignored.
 */
export function scheduleTuplesForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
  unsigned = false,
): AttainmentTuple[] {
  const bounds = shiftBounds(shiftId);
  if (!bounds || asOf <= bounds.start) return [];
  const onShift = records.filter((record) => record.shiftId === shiftId);
  const planned = plannedRuntimeForShift(
    shiftId,
    orders,
    machineCode,
    asOf,
    unavailableHoursForShift(onShift),
  );

  const plan = new Map<string, { jobNumber: string; pieces: number | null }>();
  for (const run of planned.runs) {
    const key = jobKey(run.order.jobNumber);
    if (!key) continue;
    // What is left of the order once the shifts before this one have had
    // their share at the same rate: an order is never asked for more pieces
    // than it holds, however its window is spread across shifts.
    const quantity = run.order.orderQty > 0
      ? run.order.orderQty
      : run.order.jobRequired > 0 ? run.order.jobRequired : Infinity;
    const askedBefore = wholePieces(crewedWindowHoursBefore(run.order, bounds.start) / run.order.qtyPerHr);
    const pieces = Math.min(run.pieces, Math.max(0, quantity - askedBefore));
    const prior = plan.get(key);
    plan.set(key, {
      jobNumber: prior?.jobNumber ?? run.order.jobNumber.trim(),
      pieces: (prior?.pieces ?? 0) + pieces,
    });
  }
  // Planned here with no rate: still planned, but nobody can say for how
  // many pieces — a gap in coverage, not a zero.
  for (const order of plannedOrdersForShift(orders, machineCode, shiftId)) {
    const key = jobKey(order.jobNumber);
    if (key && !(order.qtyPerHr > 0) && !plan.has(key)) {
      plan.set(key, { jobNumber: order.jobNumber.trim(), pieces: null });
    }
  }

  const machine = machineCode.trim();

  const ran = new Map<string, ProductionRecord[]>();
  for (const record of onShift) {
    const key = jobKey(record.jobNumber);
    if (!key || key.startsWith('DC_')) continue;
    const group = ran.get(key) ?? [];
    group.push(record);
    ran.set(key, group);
  }
  const known = new Set(orders.filter((order) => !order.isDieChange).map((order) => jobKey(order.jobNumber)));

  const out: AttainmentTuple[] = [];
  for (const [key, { jobNumber, pieces }] of plan) {
    const good = aggregate(ran.get(key) ?? []).output;
    // A planned line nobody got to is a planned line with nothing made — the
    // miss this comparison exists to show. Only a line that asked for nothing
    // and made nothing says nothing, and is left out.
    if (pieces === 0 && good === 0) continue;
    out.push({
      machineCode: machine,
      shiftId,
      jobNumber,
      planned: pieces,
      good,
      credited: pieces == null ? 0 : Math.min(good, pieces),
      source: 'schedule',
    });
  }
  for (const [key, group] of ran) {
    if (plan.has(key)) continue;
    if (known.has(key)) {
      out.push({
        machineCode: machine,
        shiftId,
        jobNumber: group[0].jobNumber.trim(),
        planned: 0,
        good: aggregate(group).output,
        credited: 0,
        source: 'unscheduled',
      });
    } else {
      out.push(...targetTuplesForRecords(group, true));
    }
  }
  return unsigned ? out.map((line) => ({ ...line, unsigned: true })) : out;
}

/**
 * The machine-shift's Schedule Adherence as its sign-off saves it to
 * PMD_Production.ScheduleAttain (%) and SchedulePlan (pieces).
 *
 * Planning.csv is overwritten on every export, so last week's plan is gone by
 * the time anybody asks for last week's adherence. Sign-off is the last moment
 * the plan for the shift is still on hand: this is the Last 24h figure for the
 * press and shift — the same `scheduleTuplesForShift` lines — frozen then.
 *
 * Both numbers are kept because a percentage alone cannot be added up: a 95%
 * shift asked for 20 pieces and a 60% shift asked for 5,000 are not 77.5%
 * together. Credited = ScheduleAttain × SchedulePlan, and a period is
 * Σ credited ÷ Σ plan — the Last 24h formula over more shifts.
 *
 *   - `records` are the shift's signed rows as sign-off will leave them; only
 *     signed output is credited, as on the KPI page.
 *   - The shift is judged whole, up to its end, even when it is signed before
 *     the end: a press that stops early has stopped against the full plan.
 *   - `plan` 0 with `pct` null: nothing was planned on the press in the shift.
 *     There is nothing to adhere to, which is not the same as 0%.
 *   - `fromPlanning` false when Planning.csv no longer has the shift at all
 *     (every order dropped by Epicor). Whatever was saved before is the
 *     better record then, and `snapshotToSave` keeps it.
 *   - `complete` false when a planned order has no rate, or a run order no
 *     saved ShiftTarget, so a quantity is unknown — the KPI page shows "—"
 *     for such a shift, and a guess saved now would outlive the gap.
 */
export interface ScheduleSnapshot {
  /** % to two decimals, so Σ credited rebuilt from it is within 0.005% of a
   *  piece per piece planned. */
  pct: number | null;
  plan: number;
  fromPlanning: boolean;
  complete: boolean;
}

export function scheduleSnapshotForShift(
  records: ReadonlyArray<ProductionRecord>,
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
): ScheduleSnapshot | null {
  const bounds = shiftBounds(shiftId);
  if (!bounds) return null;
  const judgedAt = new Date(Math.max(asOf.getTime(), bounds.end.getTime()));
  const lines = scheduleTuplesForShift(records, orders, machineCode, shiftId, judgedAt);
  const a = attainmentOfTuples(lines);
  return {
    pct: a.expected > 0 ? Math.round((a.actual / a.expected) * 10_000) / 100 : null,
    plan: a.expected,
    fromPlanning: lines.some((line) => line.source === 'schedule'),
    complete: a.covered === a.total,
  };
}

/**
 * What a sign-off writes: the snapshot just worked out, unless Planning.csv
 * has forgotten the shift and an earlier sign-off saved its plan — then that
 * one again. null writes nothing.
 */
export function snapshotToSave(
  snap: ScheduleSnapshot | null,
  prior: SavedSnapshot | null,
): { pct: number | null; plan: number } | null {
  if (!snap) return null;
  if (!snap.fromPlanning && prior?.plan != null) return { pct: prior.pct, plan: prior.plan };
  return snap.complete ? { pct: snap.pct, plan: snap.plan } : null;
}

export interface SavedSnapshot {
  pct: number | null;
  /** null on a tenant without the SchedulePlan column. */
  plan: number | null;
}

/**
 * The snapshot a machine-shift carries. Each sign-off writes the whole
 * shift's figure onto the orders it signs, so a shift whose orders were
 * signed at different times holds several; the last one saw the most of the
 * shift signed and is the answer. Signed together (or no Signoff time to
 * tell them apart), the one crediting most is the later picture.
 */
export function savedScheduleSnapshot(records: ReadonlyArray<ProductionRecord>): SavedSnapshot | null {
  let best: SavedSnapshot | null = null;
  let bestAt = -Infinity;
  let bestCredit = -Infinity;
  for (const r of records) {
    if (r.slotIndex !== 0) continue;
    const pct = r.scheduleAttain != null && r.scheduleAttain >= 0 ? r.scheduleAttain : null;
    const plan = r.schedulePlan != null && r.schedulePlan >= 0 ? r.schedulePlan : null;
    if (pct == null && plan == null) continue;
    const parsed = Date.parse(r.lockedAt);
    const at = Number.isFinite(parsed) ? parsed : 0;
    const credit = (pct ?? 0) * (plan ?? 1);
    if (at > bestAt || (at === bestAt && credit > bestCredit)) {
      best = { pct, plan };
      bestAt = at;
      bestCredit = credit;
    }
  }
  return best;
}

/** True when some shift in the records saved its % but not its plan — the
 *  SchedulePlan column was not there yet when it was signed. */
export function savedPlanMissing(records: ReadonlyArray<ProductionRecord>): boolean {
  for (const group of machineShifts(records).values()) {
    const snap = savedScheduleSnapshot(group);
    if (snap && snap.plan == null && snap.pct != null) return true;
  }
  return false;
}

function machineShifts(records: ReadonlyArray<ProductionRecord>): Map<string, ProductionRecord[]> {
  const out = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const machine = r.machineCode.trim().toUpperCase();
    if (!machine || !r.shiftId) continue;
    const key = `${machine}|${r.shiftId}`;
    const group = out.get(key) ?? [];
    group.push(r);
    out.set(key, group);
  }
  return out;
}

/** The order that made most of the shift's Good; the first order when none
 *  made any. */
function leadJobOf(group: ReadonlyArray<ProductionRecord>): string {
  const byJob = new Map<string, ProductionRecord[]>();
  for (const r of group) {
    const job = r.jobNumber.trim();
    if (!job || jobKey(job).startsWith('DC_')) continue;
    const arr = byJob.get(job) ?? [];
    arr.push(r);
    byJob.set(job, arr);
  }
  let lead = '';
  let most = -1;
  for (const [job, recs] of byJob) {
    const good = aggregate(recs).output;
    if (good > most) {
      lead = job;
      most = good;
    }
  }
  return lead;
}

/**
 * Schedule Adherence lines for a period wider than the last 24 h, one per
 * machine-shift, from the plans sign-off saved (`scheduleSnapshotForShift`).
 *
 * A shift with no snapshot — signed before the columns existed, or with an
 * order Planning.csv could not price — falls back to the rule Last 24h uses
 * for an order Epicor has dropped: the ShiftTarget saved when it ran, capped
 * per order.
 *
 * `equalWeight` is for the time before SchedulePlan exists: with only a
 * percentage per shift there is nothing to weight by, so every machine-shift
 * becomes one line of 100 asked and its % credited — Σ credited ÷ Σ asked is
 * then the plain mean of the shifts. It has to be all or nothing over
 * everything summed together (`savedPlanMissing`), or pieces and shares
 * would be added to each other.
 *
 * Shifts that ran nothing are not here: they have no row to have saved a plan
 * on. A press planned for a shift and left idle shows in Last 24h, and drops
 * out of a wider period.
 */
export function savedScheduleTuples(
  records: ReadonlyArray<ProductionRecord>,
  equalWeight = false,
): AttainmentTuple[] {
  const out: AttainmentTuple[] = [];
  for (const group of machineShifts(records).values()) {
    const machineCode = group[0].machineCode.trim();
    const shiftId = group[0].shiftId;
    const good = aggregate(group.filter((r) => !jobKey(r.jobNumber).startsWith('DC_'))).output;
    const line = (planned: number | null, credited: number, source: AttainmentSource = 'saved'): AttainmentTuple => ({
      machineCode, shiftId, jobNumber: '', planned, good, credited, source, leadJob: leadJobOf(group),
    });
    const snap = savedScheduleSnapshot(group);
    if (snap && snap.plan != null) {
      if (snap.plan === 0) {
        if (good > 0) out.push(line(0, 0, 'unscheduled'));
        continue;
      }
      if (snap.pct == null) out.push(line(null, 0));
      else if (equalWeight) out.push(line(100, snap.pct));
      else out.push(line(snap.plan, Math.round((snap.pct * snap.plan) / 100)));
      continue;
    }
    if (snap && snap.pct != null) {
      // % without its plan: only meaningful as an equal share.
      out.push(equalWeight ? line(100, snap.pct) : line(null, 0));
      continue;
    }
    const fallback = targetTuplesForRecords(group, true);
    if (!equalWeight) {
      out.push(...fallback);
      continue;
    }
    const a = attainmentOfTuples(fallback);
    if (a.total === 0) continue;
    if (a.covered < a.total) out.push(line(null, 0, 'shiftTarget'));
    else if (a.expected > 0) out.push(line(100, (a.actual / a.expected) * 100, 'shiftTarget'));
  }
  return out;
}

/**
 * PMD_ShiftPlan: the plan Planning.csv had for a press in a shift that no
 * signed production covers — the press nobody ran, or nobody signed.
 *
 * ScheduleAttain and SchedulePlan ride on the PMD_Production rows a sign-off
 * writes, and a press left idle has none, so its plan used to vanish from
 * every period wider than Last 24h — and from Last 24h too once Epicor
 * rescheduled the missed order. Every sign-off of a shift therefore also
 * saves the plan of each press in that shift with nothing signed: the miss
 * is kept at the moment the plan is still on hand, like the snapshot of a
 * press that ran.
 */
export interface SavedShiftPlan {
  machineCode: string;
  shiftId: string;
  /** Pieces asked for, judged to the end of the shift. Always > 0. */
  plan: number;
  /** The planned orders, most pieces first — the first is the order whose
   *  part category the line is counted under. */
  jobs: Array<{ jobNumber: string; partNumber: string; pieces: number }>;
}

/**
 * The plan Planning.csv asks of a press in a shift with nothing made — the
 * Last 24h plan of a press that did not run, judged to the end of the shift.
 * null when there is nothing to keep: no planned order, or one with no rate
 * (its quantity unknown, as `scheduleSnapshotForShift` leaves it).
 */
export function shiftPlanFor(
  orders: ReadonlyArray<PlanningOrder>,
  machineCode: string,
  shiftId: string,
  asOf: Date = new Date(),
): SavedShiftPlan | null {
  const bounds = shiftBounds(shiftId);
  if (!bounds) return null;
  const judgedAt = new Date(Math.max(asOf.getTime(), bounds.end.getTime()));
  const lines = scheduleTuplesForShift([], orders, machineCode, shiftId, judgedAt);
  if (!lines.length || lines.some((line) => line.planned == null)) return null;
  const plan = lines.reduce((sum, line) => sum + (line.planned ?? 0), 0);
  if (plan <= 0) return null;
  const partOf = (job: string): string =>
    orders.find((o) => jobKey(o.jobNumber) === jobKey(job))?.partNumber.trim() ?? '';
  return {
    machineCode: machineCode.trim(),
    shiftId,
    plan,
    jobs: lines
      .map((line) => ({ jobNumber: line.jobNumber, partNumber: partOf(line.jobNumber), pieces: line.planned ?? 0 }))
      .sort((a, b) => b.pieces - a.pieces),
  };
}

/**
 * What a sign-off of `shiftId` changes in PMD_ShiftPlan, given the presses,
 * the ones with signed production in the shift (the press signing now among
 * them) and the rows already saved for it.
 *
 *   - A press with signed production carries its own ScheduleAttain /
 *     SchedulePlan now, so a row saved for it while it had none goes.
 *   - A press with none, planned, and not yet saved is saved. A saved row is
 *     never rewritten: it is the plan as it stood when the shift was first
 *     closed, and Planning.csv only gets further from that — Epicor drops a
 *     finished order and moves a missed one forward.
 *   - Two sign-offs saving at once can each write a row for the same press;
 *     the next sign-off of the shift removes the later one.
 */
export function shiftPlanChanges<Row extends SavedShiftPlan>(
  machineCodes: ReadonlyArray<string>,
  signed: ReadonlySet<string>,
  saved: ReadonlyArray<Row>,
  orders: ReadonlyArray<PlanningOrder>,
  shiftId: string,
  asOf: Date = new Date(),
): { save: SavedShiftPlan[]; remove: Row[] } {
  const key = (code: string): string => code.trim().toUpperCase();
  const signedKeys = new Set([...signed].map(key));
  const savedKeys = new Set<string>();
  const remove: Row[] = [];
  for (const row of saved) {
    // Signed since; or a second row for the press, from two sign-offs of
    // the shift saving at the same moment — the first one stands.
    if (signedKeys.has(key(row.machineCode)) || savedKeys.has(key(row.machineCode))) remove.push(row);
    savedKeys.add(key(row.machineCode));
  }
  const save: SavedShiftPlan[] = [];
  for (const code of machineCodes) {
    if (signedKeys.has(key(code)) || savedKeys.has(key(code))) continue;
    const plan = shiftPlanFor(orders, code, shiftId, asOf);
    if (plan) save.push(plan);
  }
  return { save, remove };
}

/**
 * Last 24h plan lines of a machine-shift with nothing signed whose plan was
 * kept at the shift's sign-off: order by order, nothing credited. The kept
 * plan beats Planning.csv as it stands now, which may have moved the missed
 * orders forward since.
 */
export function keptPlanTuples(row: SavedShiftPlan, unsigned = false): AttainmentTuple[] {
  const flag = unsigned ? { unsigned: true } : {};
  const jobs = row.jobs.length ? row.jobs : [{ jobNumber: '', partNumber: '', pieces: row.plan }];
  return jobs.map((job) => ({
    machineCode: row.machineCode.trim(), shiftId: row.shiftId, jobNumber: job.jobNumber,
    planned: job.pieces, good: 0, credited: 0, source: 'saved', ...flag,
  }));
}

/**
 * Plan lines of a wider period for the machine-shifts with no signed
 * production — one line per machine-shift, nothing credited, as Last 24h
 * counts a press that did not run.
 *
 * The plan is the one PMD_ShiftPlan saved at the shift's sign-off; failing
 * that (a shift before the list, or one nobody signed anything in), what
 * Planning.csv still has for it — the Last 24h rule. Planning.csv forgets a
 * finished order and moves a missed one forward, so the further back the
 * shift, the more of its plan that fallback misses.
 *
 * `shiftIds` are the finished shifts with no signed record of the press;
 * `unsignedShifts` the ones among them with unsigned records. `equalWeight`
 * as in `savedScheduleTuples`: each machine-shift becomes 100 asked, 0
 * credited.
 */
export function idleShiftTuples(
  machineCode: string,
  shiftIds: ReadonlyArray<string>,
  saved: ReadonlyArray<SavedShiftPlan>,
  orders: ReadonlyArray<PlanningOrder>,
  asOf: Date = new Date(),
  unsignedShifts: ReadonlySet<string> = new Set(),
  equalWeight = false,
): AttainmentTuple[] {
  const asked = (planned: number | null): number | null => (equalWeight && planned != null ? 100 : planned);
  const machine = machineCode.trim();
  const savedByShift = new Map(
    saved
      .filter((row) => row.machineCode.trim().toUpperCase() === machine.toUpperCase())
      .map((row) => [row.shiftId, row] as const),
  );
  const out: AttainmentTuple[] = [];
  for (const shiftId of shiftIds) {
    const unsigned = unsignedShifts.has(shiftId) ? { unsigned: true } : {};
    const row = savedByShift.get(shiftId);
    if (row) {
      out.push({
        machineCode: machine, shiftId, jobNumber: '', planned: asked(row.plan), good: 0, credited: 0,
        source: 'saved', leadJob: row.jobs[0]?.jobNumber ?? '', idle: true, ...unsigned,
      });
      continue;
    }
    const lines = scheduleTuplesForShift([], orders, machine, shiftId, asOf);
    if (!lines.length) continue;
    const known = lines.every((line) => line.planned != null);
    const lead = [...lines].sort((a, b) => (b.planned ?? 0) - (a.planned ?? 0))[0];
    out.push({
      machineCode: machine, shiftId, jobNumber: '',
      planned: asked(known ? lines.reduce((sum, line) => sum + (line.planned ?? 0), 0) : null),
      good: 0, credited: 0, source: 'schedule', leadJob: lead.jobNumber, idle: true, ...unsigned,
    });
  }
  return out;
}
