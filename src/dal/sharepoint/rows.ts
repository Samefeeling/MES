// SharePoint data layer — a shift on a press as one list row: the header a
// sign-off writes, its sixteen slots folded in and out of it, and the OData
// filters that find it.
import type { PlanBarItem } from '../../core/schedule';
import { str } from './values';
import type {
  ShiftCode,
  StatusCode,
  ParetoSlice,
  ProductionRecord,
  ProductionFilter,
  BdCode,
} from '../../types';
import { shiftBounds, slotClock } from '../../core/shifts';
import { encodeBreakdownCauseMap, BD_TAXONOMY, bdCategoryOf } from '../../core/breakdown';

/**
 * A Live Status bar piece as PlanJobs holds it, among the kept orders. Its
 * order goes under `job`, and `jobNumber` is left empty, so a build that reads
 * PlanJobs as orders only passes over it.
 */
export function planBarEntry(b: PlanBarItem): Record<string, string> {
  return {
    bar: b.kind,
    jobNumber: '',
    job: b.jobNumber,
    partNumber: b.partNumber,
    ...(b.fromPart != null ? { fromPart: b.fromPart } : {}),
    start: b.start,
    end: b.end,
  };
}

export function readPlanBarEntry(j: Record<string, unknown>): PlanBarItem | null {
  const start = str(j['start']);
  const end = str(j['end']);
  if (!Number.isFinite(Date.parse(start)) || !(Date.parse(end) > Date.parse(start))) return null;
  return {
    kind: j['bar'] === 'change' ? 'change' : 'run',
    jobNumber: str(j['job']).trim(),
    partNumber: str(j['partNumber']).trim(),
    ...(j['fromPart'] != null ? { fromPart: str(j['fromPart']).trim() } : {}),
    start,
    end,
  };
}

/** Build a value-descending ParetoSlice[] from a code→value tally. */
export function paretoFrom(
  tally: Map<string, number>,
  labelFor: (code: string) => string,
  byShiftFor?: (code: string) => Record<ShiftCode, number> | undefined,
  byStatusFor?: (
    code: string,
  ) => Partial<Record<StatusCode | 'Unknown', number>> | undefined,
): ParetoSlice[] {
  return Array.from(tally.entries())
    .map(([code, value]) => {
      const slice: ParetoSlice = { code, label: labelFor(code), value: +value.toFixed(2) };
      const bs = byShiftFor?.(code);
      if (bs) slice.byShift = bs;
      const status = byStatusFor?.(code);
      if (status) slice.byStatus = status;
      return slice;
    })
    .sort((a, b) => b.value - a.value);
}

export function rejectMachineStatus(value: string): StatusCode | 'Unknown' {
  const code = value.trim().toUpperCase();
  return code === 'R' ||
    code === 'B' ||
    code === 'C' ||
    code === 'D' ||
    code === 'I' ||
    code === 'M' ||
    code === 'O' ||
    code === 'P' ||
    code === 'S'
    ? code
    : 'Unknown';
}

/** A tuple's slot records as the 16-character status timeline. */
export function timelineOf(rows: ReadonlyArray<{ slotIndex: number; statusCode: string }>): string {
  const tl = Array.from({ length: 16 }, () => '·');
  for (const r of rows) if (r.statusCode && r.slotIndex >= 0 && r.slotIndex < 16) tl[r.slotIndex] = r.statusCode;
  return tl.join('');
}

export function parseShiftIdLoose(sid: string): { date: string; shift: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([A-Za-z]+))?/.exec(sid);
  if (!m) return { date: '', shift: '' };
  return { date: m[1], shift: m[2] ?? '' };
}

/**
 * The instant we stamp PMD_Production / PMD_BreakDownlog / PMD_Rejects rows
 * with for a given shift. Midnight UTC of the shift's calendar date.
 *
 * The SP tenant we ship to has its regional setting at Auckland (UTC+12 /
 * +13 NZDT) even though the plant is in Sydney (UTC+10 / +11 AEDT). The
 * earlier choice of noon UTC kept the date stable for negative-offset
 * tenants but slipped a day forward when SP rendered the value in
 * Auckland — the operator reported PMD_Production showing 6/06 in the
 * tooltip while they were working the Sydney 5/06 night shift.
 *
 * Midnight UTC of the shift date works the other way: in any positive
 * regional setting (which is every place this plant could realistically
 * be administered from, +0 through +14) the displayed date is the
 * shift's date, because we add hours to midnight rather than crossing
 * into the next day. Date-Only SP columns also store this correctly —
 * they pick up the date portion of the UTC value as-is.
 *
 * Filters in this file use a ±1-day window so older rows written with
 * the legacy noon-UTC or local-start timestamps still match — no
 * migration required.
 */
export function shiftDateMarker(shiftId: string): string {
  return `${shiftId.slice(0, 10)}T00:00:00.000Z`;
}

/** UTC instant for the start (inclusive) and end (inclusive) of a
 *  date-only window padded by 1 day on either side, so both the new
 *  midnight-UTC marker and any legacy local-start timestamps land inside.
 *  `to` defaults to `from` for single-shift queries. */
export function shiftDateRange(fromShiftId: string, fDate: string, toShiftId = fromShiftId): string {
  const from = new Date(`${fromShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const to = new Date(`${toShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const lo = new Date(from - 86_400_000).toISOString();
  const hi = new Date(to + 2 * 86_400_000).toISOString();
  return `${fDate} ge datetime'${lo}' and ${fDate} le datetime'${hi}'`;
}

/** Convenience for filters with optional `from` / `to` shiftIds —
 *  returns an empty string when neither bound is set so the caller can
 *  just include it in an `and`-chain. */
export function shiftDateRangeFromTo(
  from: string | undefined,
  to: string | undefined,
  fDate: string,
): string {
  if (!from && !to) return '';
  if (from && to) return shiftDateRange(from, fDate, to);
  if (from) {
    const lo = new Date(
      new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime() - 86_400_000,
    ).toISOString();
    return `${fDate} ge datetime'${lo}'`;
  }
  // to-only
  const hi = new Date(
    new Date(`${to!.slice(0, 10)}T00:00:00.000Z`).getTime() + 2 * 86_400_000,
  ).toISOString();
  return `${fDate} le datetime'${hi}'`;
}

/** A row's press against an optional filter press, as SharePoint's own
 *  `eq` compares them: case-insensitive. No press means every press. */
export function onMachine(cell: unknown, machineCode: string | undefined): boolean {
  return !machineCode || str(cell).trim().toUpperCase() === machineCode.trim().toUpperCase();
}

export function productionMatches(r: ProductionRecord, f: ProductionFilter): boolean {
  if (f.machineCode && r.machineCode !== f.machineCode) return false;
  if (f.shiftId && r.shiftId !== f.shiftId) return false;
  if (f.jobNumber && r.jobNumber !== f.jobNumber) return false;
  if (f.shiftIdFrom && r.shiftId < f.shiftIdFrom) return false;
  if (f.shiftIdTo && r.shiftId > f.shiftIdTo) return false;
  return true;
}

export function timelineToSlot(t: string): number {
  if (/^\d+$/.test(t)) return Math.max(0, Math.min(15, Number(t)));
  // Expect "HH:MM-HH:MM" or "HH:MM".
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // Shift starts at 07/15/23 — derive by closest match to 30-min grid from 7am.
  const minutes = h * 60 + min;
  const startCandidates = [7 * 60, 15 * 60, 23 * 60];
  let best = 0;
  for (const start of startCandidates) {
    const span = (minutes - start + 60 * 24) % (60 * 24);
    if (span >= 0 && span < 8 * 60) {
      best = Math.floor(span / 30);
      break;
    }
  }
  return Math.max(0, Math.min(15, best));
}

export interface HeaderRow {
  id: number;
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  jobRequired: number;
  cycleTime: number;
  /** Cavities the shift ran on (pieces per cycle); undefined when the
   *  column is absent / empty, which every Good figure reads as 1.
   *  Stamped onto the canonical record so every Good computation can
   *  multiply (CountEnd − CountStart) by it. */
  cavities?: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string;
  qcChecks: string;
  rejectsBySlot: string;
  /** PMD_Production.Reopened (Yes/No) — true when a signed-off order has been
   *  re-opened for correction. false when locked / column absent. */
  reopened: boolean;
  /** OwnerDevice from PMD_LiveStatus ('' on signed PMD_Production rows). */
  ownerDevice: string;
  /** Sign-off timestamp (ISO) from PMD_Production.Signoff; '' when absent
   *  (live rows, or legacy signed rows from before the column existed). */
  signOff: string;
  /** Job Left frozen at job start from PMD_Production.JobLeft; -1 when the
   *  column is absent or empty (live rows / legacy signed rows). Stamped
   *  onto the canonical record so Trace can read demand-at-start. */
  jobLeft: number;
  /** The shift's Schedule % frozen at sign-off from PMD_Production.VSPLAN;
   *  -1 when the column is absent or was never written. 0 is a real answer
   *  ("none of what was scheduled was made"), so the sentinel cannot be 0. */
  vsPlan: number;
  /** The machine-shift's Schedule Adherence (%, already scaled from a
   *  percentage-format column) and plan pieces saved at sign-off; -1 when
   *  absent or never written. */
  scheduleAttain: number;
  schedulePlan: number;
  /** Shift Target frozen at job start from PMD_Production.ShiftTarget; -1
   *  when absent. Round-tripped onto the canonical record for Trace. */
  shiftTarget: number;
  /** Planned start (local ISO) from PMD_Production.PlannedStart; '' when
   *  the column is absent / empty. Round-tripped onto the canonical
   *  record so Schedule Adherence works after Epicor drops the order. */
  plannedStart: string;
  /** SharePoint's built-in Modified timestamp (ISO). Used to detect a
   *  signed-off tuple that has since been unlocked and re-edited: its
   *  PMD_LiveStatus row gets a Modified NEWER than the PMD_Production
   *  row's, which makes the live mirror win on every device (the unlock
   *  flag itself is device-local). '' when the field is unreadable. */
  modified: string;
}

export interface HeaderInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  jobRequired: number;
  /** Cycle time (hours/piece) for the job — persisted so past shifts
   *  recompute Shift Target. 0 when unknown (the column is skipped). */
  cycleTime: number;
  /** Shift Target snapshot for the SP list / Power BI (PMD_Production
   *  only — live pushes omit it; the value derives from signed rows on
   *  read). null/undefined skips the column write. */
  shiftTarget?: number | null;
  /** The machine-shift's Schedule % at sign-off; null when nothing on the
   *  shift was scheduled, which is not the same as having made none of it. */
  vsPlan?: number | null;
  /** The machine-shift's schedule snapshot (scheduleSnapshotForShift):
   *  % and plan pieces. null/undefined skips the column write. */
  scheduleAttain?: number | null;
  schedulePlan?: number | null;
  /** Identical cavities on the die (pieces per cycle). 1 (or 0/undefined)
   *  leaves the column at its default; written when > 1. */
  cavities?: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string; // JSON {machine,mold,material,method} (4M) from the canonical slot
  /** JSON {"<slotIndex>":"<name>"} — the per-slot QC sign-off map. */
  qcChecks: string;
  /** JSON {"<slotIndex>":{"<code>":qty}} — per-slot per-code reject
   *  breakdown. Mirrors what PMD_Rejects holds for signed-off shifts,
   *  but written eagerly to the LiveStatus row so other iPads can read
   *  the breakdown without waiting for sign-off. */
  rejectsBySlot: string;
  /** PMD_LiveStatus only — the owning device id, or '' to leave the
   *  column untouched. Omitted/'' on PMD_Production writes. */
  ownerDevice?: string;
  /** PMD_Production only — ISO sign-off timestamp written on lockShift.
   *  Omitted on live snapshot pushes so the column is left untouched. */
  signOff?: string;
  /** PMD_Production only — Job Left at sign-off, computed by the
   *  operator UI (jobRequired − sum-of-Good across every shift of this
   *  job including this one). null/undefined skips the column write. */
  jobLeft?: number | null;
  /** PMD_Production only — Reopened (Yes/No). Written explicitly on
   *  sign-off (false, re-locks) and unlock (true). undefined leaves the
   *  column untouched (live snapshot pushes). */
  reopened?: boolean;
  /** PMD_Production only — planned start (local ISO) denormalised at
   *  sign-off. Empty/undefined skips the column write. */
  plannedStart?: string;
}

interface StatusHours {
  R: number;
  B: number;
  C: number;
  D: number;
  I: number;
  M: number;
  O: number;
  P: number;
  S: number;
}

export interface RejectRow {
  id: number;
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

export interface RejectEvent {
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

/**
 * True if the operator has filled in something worth surfacing on
 * other iPads — a status code on any slot, a counter reading, a
 * reject quantity, a purge weight, or a handover note. Picking a
 * Job# / Operator / Supervisor on its own does *not* count: the
 * editCache row gets created from the very first upsert (typically
 * the Operator select), and pushing that to SP would spam Live
 * Status with empty cards every time someone changed their mind
 * about which order to start.
 */
/**
 * Grace window after a shift's end. Past it, a sheet with no machine
 * status on any slot is a mis-tap: swept from PMD_LiveStatus on read
 * (isStaleLiveHeader) and from a device's cache, and no longer mirrored.
 * Real work is kept far longer (LIVE_HARD_CAP_MS).
 */
export const LIVE_STALE_GRACE_MS = 8 * 3600_000;

/**
 * How long unsigned work that carries a machine status is kept: on
 * PMD_LiveStatus, and on the iPad until it is safely there. 62 days, so
 * every period KPIs offer (Last month included) still sees a forgotten
 * sign-off as "unsigned" rather than as a press that never ran.
 *
 * It used to be 24 h, and every read on any device — the KPI page on a PC
 * included — deleted the live rows of a shift that had ended more than a
 * day ago, and every device dropped its own copy at the same age. A sign-off
 * forgotten for over a day therefore vanished: the work was lost and the
 * KPI page scored the press "not run". Status-empty mis-taps are still swept
 * after 8 h (isStaleLiveHeader); only real work is kept this long, and
 * signing it off (or a supervisor deleting the row) ends it.
 */
export const LIVE_HARD_CAP_MS = 62 * 24 * 3600_000;

/**
 * How long a device keeps its own copy of a finished shift's unsigned work
 * once that copy is on PMD_LiveStatus (see mirrorSignature). The server
 * keeps it from then on; a copy that never got there is kept up to
 * LIVE_HARD_CAP_MS and pushed whenever the device next can.
 */
export const DEVICE_COPY_MS = 24 * 3600_000;

/**
 * What of a tuple the live mirror publishes, as one string: equal strings,
 * equal PMD_LiveStatus rows. A device records the signature it last pushed,
 * so it can tell a copy that is safely on the server from one that is not.
 */
export function mirrorSignature(slots: ProductionRecord[]): string {
  const canon = slots.find((s) => s.slotIndex === 0) ?? slots[0];
  const agg = aggregateSlots(slots);
  return JSON.stringify([
    agg.timeline, agg.countStart, agg.countEnd, agg.reject, agg.runTime, agg.downTime,
    agg.handover, agg.qcChecks, agg.rejectsBySlot,
    canon?.operator ?? '', canon?.supervisor ?? '', canon?.cycleTime ?? 0, canon?.cavities ?? null,
    slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired ?? 0,
  ]);
}

/**
 * True when `shiftId`'s shift ended more than `graceMs` ago — i.e. it
 * can't possibly be a live, in-progress shift any more. Unparseable
 * shift ids return false (leave alone). Boundary equality counts as
 * "ended" (`<=`).
 */
export function shiftEndedLongAgo(
  shiftId: string,
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  const b = shiftBounds(shiftId);
  if (!b) return false;
  return b.end.getTime() + graceMs <= now.getTime();
}

/**
 * "Junk" PMD_LiveStatus row: the shift it points to is decisively in
 * the past (ended more than `graceMs` ago) AND nobody ever stamped a
 * MachineStatus on any half-hour slot of it. These are produced when
 * an operator taps a machine, picks a (wrong) job, maybe types a
 * Count Start, then realises the mistake and walks away — the live
 * snapshot push had already mirrored the partial cache onto
 * PMD_LiveStatus and there was no path to clean it up.
 *
 * The user-facing impact was twofold:
 *  1. PMD_LiveStatus grew an ever-longer list of orphans (one per
 *     mis-tap per device).
 *  2. listProduction's editCache backfill (the SFM507068 fix) would
 *     happily absorb those orphans, shadowing the canonical
 *     PMD_Production rows for the same (machine, shift) when an
 *     operator scrolled back to review a past shift.
 *
 * Only flag rows that have ZERO machine status anywhere — countStart /
 * countEnd / reject on their own are NOT proof of run; a finished
 * shift always has at least one timeline letter. Future-dated rows
 * are never flagged: they may be a deliberately scheduled tap-ahead
 * and we don't want to silently delete planned work.
 *
 * NOTE: an OLD row that DOES carry status (e.g. an abandoned 03/06
 * experiment) is NOT junk by this definition — deleting real data is
 * out of scope here. It is unsigned work, kept until it is signed off or
 * LIVE_HARD_CAP_MS passes; pushLiveSnapshot re-sends it only when the
 * device's copy changes, so a row deleted by hand stays deleted.
 *
 * `now` is injected so the helper is testable; pass `new Date()` in
 * the live path.
 */
export function isStaleLiveHeader(
  h: { date: string; shift: string; timeline?: string },
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  if (!shiftEndedLongAgo(`${h.date}-${h.shift}`, now, graceMs)) return false;
  const timeline = h.timeline || '';
  for (const ch of timeline) {
    if (ch && ch !== '·' && ch !== ' ') return false;
  }
  return true;
}

export function hasMeaningfulProgress(slots: ProductionRecord[]): boolean {
  for (const r of slots) {
    if (r.statusCode) return true;
    if (r.countStart != null) return true;
    if (r.countEnd != null) return true;
    if (r.purgeKg != null) return true;
    if (r.rejectCount > 0) return true;
    if (r.rejects && r.rejects !== '{}') return true;
    const note = (r.handoverNote ?? '').trim();
    if (note && note !== '{}') return true;
  }
  return false;
}

export function aggregateSlots(slots: ProductionRecord[]): {
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  runTime: number;
  downTime: number;
  hours: StatusHours;
  rejectEvents: RejectEvent[];
  bdCode: string;
  bdCause: string;
  handover: string;
  qcChecks: string;
  rejectsBySlot: string;
} {
  const timelineArr = Array.from({ length: 16 }, () => '·');
  const hours: StatusHours = { R: 0, B: 0, C: 0, D: 0, I: 0, M: 0, O: 0, P: 0, S: 0 };
  let canonical: ProductionRecord | undefined;
  let reject = 0;
  const rejectEvents: RejectEvent[] = [];
  // Tally BD codes across all B slots so we can pick the most frequent one
  // for PMD_BreakDownlog.BDCode (analytic-level dominant code).
  const bdTally = new Map<string, number>();
  for (const r of slots) {
    if (r.slotIndex === 0) canonical = r;
    if (r.statusCode && r.slotIndex >= 0 && r.slotIndex < 16) {
      timelineArr[r.slotIndex] = r.statusCode;
      const code = r.statusCode as keyof StatusHours;
      if (code in hours) hours[code] += 0.5;
    }
    if (r.statusCode === 'B' && r.bdIssue) {
      bdTally.set(r.bdIssue, (bdTally.get(r.bdIssue) ?? 0) + 1);
    }
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      obj = {};
    }
    const shiftId = r.shiftId;
    const slotLabel = slotClock(shiftId, r.slotIndex) || String(r.slotIndex);
    for (const [code, raw] of Object.entries(obj)) {
      // A count that came back as text ("3") must add, not concatenate.
      const qty = Number(raw);
      if (!Number.isFinite(qty) || qty === 0) continue;
      reject += qty;
      rejectEvents.push({
        timeline: slotLabel,
        code,
        // RejectCategory = the machine STATUS in that slot (R/D/C/...). Lets
        // Power BI split "defects while running" vs "during a die change" etc.
        category: r.statusCode || 'R',
        qty,
      });
    }
  }
  // Most frequent BD code wins; ties broken by insertion order.
  let bdCode = '';
  let bdMax = 0;
  for (const [code, n] of bdTally) {
    if (n > bdMax) {
      bdMax = n;
      bdCode = code;
    }
  }
  // Quality-check sign-offs roll up into one JSON map keyed by slot
  // index — the PMD_Production.QualityChecks column stores this verbatim
  // so the round-trip is lossless.
  const qcMap: Record<string, string> = {};
  for (const r of slots) {
    if (r.qcBy && r.slotIndex >= 0 && r.slotIndex < 16) qcMap[String(r.slotIndex)] = r.qcBy;
  }
  // Per-slot per-code reject map — same data PMD_Rejects holds, but
  // serialised onto the LiveStatus header so other iPads see it during
  // a live shift (PMD_Rejects is only written on sign-off).
  const rejectsBySlotMap: Record<string, Record<string, number>> = {};
  for (const r of slots) {
    if (r.slotIndex < 0 || r.slotIndex >= 16) continue;
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      continue;
    }
    const filtered: Record<string, number> = {};
    for (const [code, qty] of Object.entries(obj)) {
      const n = Number(qty);
      if (!n) continue;
      filtered[code] = n;
    }
    if (Object.keys(filtered).length) rejectsBySlotMap[String(r.slotIndex)] = filtered;
  }
  return {
    timeline: timelineArr.join(''),
    countStart: canonical?.countStart ?? null,
    countEnd: canonical?.countEnd ?? null,
    reject,
    operator: canonical?.operator ?? '',
    runTime: hours.R,
    downTime: hours.B + hours.M,
    hours,
    rejectEvents,
    bdCode,
    bdCause: encodeBreakdownCauseMap(slots),
    handover: canonical?.handoverNote ?? '',
    qcChecks: Object.keys(qcMap).length ? JSON.stringify(qcMap) : '',
    rejectsBySlot: Object.keys(rejectsBySlotMap).length ? JSON.stringify(rejectsBySlotMap) : '',
  };
}

/** Turn the handover JSON {machine,mold,material,method} into readable text. */
/**
 * Strip characters that SharePoint REST rejects from string values in a
 * POST/MERGE body. The 500 "Invalid text value. A text field contains
 * invalid data." error doesn't name the offending column, so the safer
 * play is to scrub up front. Removes:
 *   - C0 control characters U+0000..U+001F except \t \r \n (NUL, VT, etc.
 *     come back from Excel paste / clipboard glitches; SP refuses them).
 *   - C1 controls U+007F..U+009F.
 *   - Unicode line / paragraph separators U+2028 / U+2029 (slip in from
 *     Word and break the JSON parser SP uses for verbose envelopes).
 *   - The BOM U+FEFF anywhere except position 0 (also a common CSV gift).
 * Mutates the body in place. `__metadata` and non-string values are left
 * alone.
 */
export function sanitizeBodyStrings(body: Record<string, unknown>): void {
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/g;
  for (const [k, v] of Object.entries(body)) {
    if (k === '__metadata' || typeof v !== 'string') continue;
    if (bad.test(v)) body[k] = v.replace(bad, '');
  }
}

export function formatHandover(json: string): string {
  if (!json) return '';
  try {
    const h = JSON.parse(json) as Record<string, string>;
    return (['machine', 'mold', 'material', 'method'] as const)
      .filter((k) => (h[k] ?? '').trim())
      .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${h[k].trim()}`)
      .join('\n');
  } catch {
    return json; // already plain text
  }
}

export function bdFallback(): BdCode[] {
  return BD_TAXONOMY.map((c, i) => ({
    code: c.code,
    label: c.cause,
    subCategory: bdCategoryOf(c.code)?.label ?? '',
    sequence: i + 1,
    owner: c.owner,
  }));
}
