// Maint → Machine and Team: the plant equipment, its preventive maintenance
// (MachinePM.csv) and its work orders (MangoWorkOrders.csv), joined and
// worked into the numbers the two pages show. Pure — no DOM, no DAL.
//
// The join is the equipment's name: MachinePM.csv's first column, Name, is
// the same string as the work-order report's Plant/Equipment. A press can
// also be named slightly differently in the two (Mango has both "Molding"
// and "Moulding"), so a name that resolves to one of the nine presses joins
// on the press as well.

import type { DieMaintenanceRequest, MachineMaster, MachinePmEvent } from '../types';
import { MACHINE_ASSET_TO_CODE, machineCodeForAsset, normaliseAsset } from './die';

const DAY_MS = 86_400_000;

/** The MES is Minto's. Mango's export covers every site; the other sites
 *  (Hastings) are left out for now, and so is equipment named for New
 *  Zealand ("NZ …"), whatever its branch says. Rows with no branch are kept. */
export const onSite = (branch: string | undefined, asset = ''): boolean =>
  !/^\s*NZ/i.test(asset) && (!branch?.trim() || /minto/i.test(branch));

/** A PMD_Machine Title that names a piece of plant the way Mango does
 *  ("AU - Encore Cold Saw"), not a production machine code ("1600T"). */
export const isEquipmentTitle = (title: string): boolean => /^\s*(AU|NZ)\s*-/i.test(title);

/**
 * The machines that run orders: the nine injection presses and the hot-stamp
 * press. PMD_Machine also holds the rest of the plant maintenance looks after
 * (a 3D scanner, a cold saw…): the Machine page reads every row, the operator
 * sheet, Live Status, KPIs and Trace only these. A press is known by its code
 * however it is written ("Batt-1", "1600 T", "850C"); hot stamp as "Hstamp",
 * "Hot Stamp" or Planning's "HS".
 */
export function isProductionMachine(code: string): boolean {
  if (isEquipmentTitle(code)) return false;
  const k = machineKey(code);
  if (k === 'HS' || k.includes('HSTAMP') || k.includes('HOTSTAMP')) return true;
  if (PRESS_CODES.some((p) => machineKey(p) === k)) return true;
  const ton = /^(\d{3,4})(T|C|TON|TONNE)?$/.exec(k);
  return !!ton && PRESS_CODES.includes(`${ton[1]}T`);
}

/** Equipment named for a die ("AU - Die 280", "DIE-3597", "Trim Dies") —
 *  the tools, which the Tool page already manages, so the Machine page
 *  leaves them out. "Die" must stand as its own word: "Diesel" is plant. */
export const isDieAsset = (asset: string): boolean => /(^|[^a-z])dies?(?![a-z])/i.test(asset);

/** The injection moulding presses, in the order the Machine page lists them first. */
export const PRESS_CODES: readonly string[] = [...new Set(MACHINE_ASSET_TO_CODE.map(([, code]) => code))].sort(
  (a, b) => pressRank(a) - pressRank(b),
);

function pressRank(code: string): number {
  const t = /^(\d+)T$/i.exec(code);
  if (t) return Number(t[1]);
  const b = /^Batt(\d+)$/i.exec(code);
  return b ? 100_000 + Number(b[1]) : 200_000;
}

/** Mango's own name for each press, for a press nothing else names. */
const PRESS_ASSET = new Map(MACHINE_ASSET_TO_CODE.map(([asset, code]) => [code, asset]));
export const pressAssetName = (code: string): string => PRESS_ASSET.get(code) ?? code;

/**
 * The press an equipment name is, or ''. The registered name first
 * (`MACHINE_ASSET_TO_CODE`); failing that, a name that says it is an
 * injection moulding machine and carries a press's tonnage ("125T") or
 * battery-line number ("Batt-1") — so "AU - 125T Superjack Injection
 * Moulding Machine" is the 125T however Mango spells moulding. A robot or
 * chiller beside a press is not the press: without "inject…/mo(u)ld…/press"
 * in the name nothing is inferred.
 */
export function pressCodeOf(asset: string): string {
  const exact = machineCodeForAsset(asset);
  if (exact) return exact;
  if (!/inject|mou?ld|press/i.test(asset)) return '';
  const batt = /\bbatt[\s-]*([12])\b/i.exec(asset);
  if (batt) return `Batt${batt[1]}`;
  const ton = /\b(\d{3,4})\s*T(?:onne)?\b/i.exec(asset);
  if (ton && PRESS_CODES.includes(`${ton[1]}T`)) return `${ton[1]}T`;
  return '';
}

// ---------------------------------------------------------------------
// due dates

export type DueLevel = 'overdue' | 'soon' | 'ok' | 'none';

/** How close a due date is: past it, within `soonDays`, further out, or no date. */
export function dueLevel(due: string | undefined, today: string, soonDays = 7): DueLevel {
  const d = (due ?? '').slice(0, 10);
  if (!d) return 'none';
  if (d < today) return 'overdue';
  const days = (new Date(`${d}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / DAY_MS;
  return days <= soonDays ? 'soon' : 'ok';
}

/** Whole days from `today` to `due` (negative once it has passed). */
export function daysUntil(due: string, today: string): number {
  return Math.round(
    (new Date(`${due.slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / DAY_MS,
  );
}

/** A PM event still in force: has something to do and has not been replaced. */
export const isLivePm = (e: MachinePmEvent): boolean => !e.superseded && (e.detail !== '' || e.dueDate !== '');

// ---------------------------------------------------------------------
// reliability

/** A breakdown: Mango's "2. Breakdown", or a repair where the export has no type text. */
export function isBreakdown(r: DieMaintenanceRequest): boolean {
  if (r.maintTypeRaw) return /break\s*down/i.test(r.maintTypeRaw);
  return r.maintType === 'repair';
}

const hours = (v: string | undefined): number => {
  const n = parseFloat((v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export interface Reliability {
  /** Breakdowns raised in the window. */
  breakdowns: number;
  /** Σ Downtime on them, hours. */
  downtimeH: number;
  /** Mean time to repair: downtime ÷ breakdowns that recorded any. Null with none recorded. */
  mttrH: number | null;
  /** Mean time between failures: (window − downtime) ÷ breakdowns, calendar hours. Null with none. */
  mtbfH: number | null;
  /** MTBF ÷ (MTBF + MTTR). Null without both. */
  availability: number | null;
  /** The window the figures cover, in days. */
  windowDays: number;
}

/**
 * MTBF and MTTR from the machine's work orders.
 *
 * A failure is a breakdown work order; its repair time is the Downtime
 * Mango records on it. Time between failures is CALENDAR time over the
 * window — the last `windowDays`, or less when the export starts later
 * (`dataFrom`, the oldest order in the file) — less the downtime itself.
 * The presses do not run every hour of the calendar, so this reads high
 * against an MTBF on running hours; it is consistent machine to machine,
 * which is what a comparison needs.
 */
export function reliability(
  orders: readonly DieMaintenanceRequest[],
  today: string,
  dataFrom: string,
  windowDays = 365,
): Reliability {
  const end = new Date(`${today}T00:00:00`).getTime() + DAY_MS;
  let start = end - windowDays * DAY_MS;
  const from = dataFrom ? new Date(`${dataFrom.slice(0, 10)}T00:00:00`).getTime() : NaN;
  if (Number.isFinite(from) && from > start) start = from;
  const span = Math.max(DAY_MS, end - start);
  const inWindow = orders.filter((r) => {
    if (!isBreakdown(r)) return false;
    const t = new Date(`${(r.createdAt || '').slice(0, 10)}T00:00:00`).getTime();
    return Number.isFinite(t) && t >= start && t < end;
  });
  const downtimeH = inWindow.reduce((n, r) => n + hours(r.downtime), 0);
  const timed = inWindow.filter((r) => hours(r.downtime) > 0).length;
  const mttrH = timed > 0 ? downtimeH / timed : null;
  const mtbfH = inWindow.length > 0 ? Math.max(0, span / 3_600_000 - downtimeH) / inWindow.length : null;
  return {
    breakdowns: inWindow.length,
    downtimeH,
    mttrH,
    mtbfH,
    availability: mtbfH != null && mttrH != null && mtbfH + mttrH > 0 ? mtbfH / (mtbfH + mttrH) : null,
    windowDays: Math.round(span / DAY_MS),
  };
}

/** The oldest date in the export — where the history the MTBF can see begins. */
export function earliestOrder(orders: readonly DieMaintenanceRequest[]): string {
  let min = '';
  for (const r of orders) {
    const d = (r.createdAt || '').slice(0, 10);
    if (d && (!min || d < min)) min = d;
  }
  return min;
}

// ---------------------------------------------------------------------
// Mango's Actions taken log

export interface MangoActionComment {
  date: string;
  comment: string;
}

/** Turn Mango's verbose audit trail into the useful operator comments.
 *  Lifecycle noise (Created / Completed / Change Stage and the stage in
 *  parentheses) has no Comment: marker, so it is deliberately omitted. */
export function parseMangoActionComments(actionsTaken?: string): MangoActionComment[] {
  if (!actionsTaken?.trim()) return [];
  const entryHeader = /(?:^|\r?\n)\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{1,2})\/(\d{1,2})\/(\d{4}),[^\r\n]*?:[ \t]*/gi;
  const headers = Array.from(actionsTaken.matchAll(entryHeader));
  return headers
    .map((header, index) => {
      const bodyStart = (header.index ?? 0) + header[0].length;
      const bodyEnd = headers[index + 1]?.index ?? actionsTaken.length;
      const body = actionsTaken.slice(bodyStart, bodyEnd);
      const marker = /(?:^|\r?\n)\s*Comment:\s*/i.exec(body);
      if (!marker) return null;
      const comment = body
        .slice(marker.index + marker[0].length)
        .replace(/\s+/g, ' ')
        .trim();
      if (!comment) return null;
      const day = Number(header[1]);
      const month = Number(header[2]);
      const year = Number(header[3]);
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      return {
        date: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
        comment,
        sortKey: year * 10_000 + month * 100 + day,
        sourceIndex: index,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.sortKey - a.sortKey || b.sourceIndex - a.sourceIndex)
    .map(({ date, comment }) => ({ date, comment }));
}

// ---------------------------------------------------------------------
// the Machine page

export type MachineState = 'breakdown' | 'overdue' | 'soon' | 'ok';

export const MACHINE_STATE_META: Record<MachineState, { label: string; cls: string; rank: number }> = {
  breakdown: { label: '🔴 Breakdown open', cls: 'ms-breakdown', rank: 0 },
  overdue: { label: '🟠 Overdue', cls: 'ms-overdue', rank: 1 },
  soon: { label: '🟡 Due soon', cls: 'ms-soon', rank: 2 },
  ok: { label: '🟢 OK', cls: 'ms-ok', rank: 3 },
};

export interface MachineRow {
  /** The equipment's name, as MachinePM.csv / Mango have it. */
  asset: string;
  /** The press code ("125T") for one of the nine presses, else ''. */
  code: string;
  assetNumber: string;
  description: string;
  department: string;
  /** Live PM events, soonest due first. */
  pm: MachinePmEvent[];
  /** Every work order on it, newest first. */
  orders: DieMaintenanceRequest[];
  /** The next PM due (the soonest, overdue included), or null with none. */
  nextPm: MachinePmEvent | null;
  openOrders: number;
  /** The last preventive / calibration order closed on it, YYYY-MM-DD. */
  lastService: string;
  state: MachineState;
  reliability: Reliability;
}

const byDue = (a: MachinePmEvent, b: MachinePmEvent): number =>
  (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : 0;

/**
 * One row per piece of equipment: every name in MachinePM.csv, every press
 * (so the nine are there even before Mango lists them), and any machine in
 * the work-order report from a branch MachinePM covers — dies aside, which
 * are the Tool page's. Presses first, in
 * tonnage order; the rest worst state first, then by name.
 */
export function buildMachineRows(
  pm: readonly MachinePmEvent[],
  orders: readonly DieMaintenanceRequest[],
  today: string,
  dataFrom: string,
): MachineRow[] {
  const rows = new Map<string, MachineRow>();
  const keyOf = (asset: string): string => {
    const code = pressCodeOf(asset);
    return code ? `#${code}` : normaliseAsset(asset);
  };
  const ensure = (asset: string): MachineRow => {
    const key = keyOf(asset);
    let row = rows.get(key);
    if (!row) {
      row = {
        asset,
        code: pressCodeOf(asset),
        assetNumber: '',
        description: '',
        department: '',
        pm: [],
        orders: [],
        nextPm: null,
        openOrders: 0,
        lastService: '',
        state: 'ok',
        reliability: reliability([], today, dataFrom),
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const code of PRESS_CODES) ensure(pressAssetName(code));
  const branches = new Set(pm.map((e) => e.branch.trim().toUpperCase()).filter(Boolean));
  const named = new Set<MachineRow>();
  for (const e of pm) {
    if (isDieAsset(e.asset)) continue;
    const row = ensure(e.asset);
    // MachinePM's own spelling wins over the built-in press name.
    if (!named.has(row)) {
      row.asset = e.asset;
      named.add(row);
    }
    row.assetNumber ||= e.assetNumber;
    row.description ||= e.description;
    row.department ||= e.department;
    if (isLivePm(e)) row.pm.push(e);
  }
  for (const r of orders) {
    const asset = (r.asset ?? '').trim();
    if (!asset || isDieAsset(asset)) continue;
    const known = rows.has(keyOf(asset));
    const sameBranch =
      branches.size === 0 || !r.branch || branches.has(r.branch.trim().toUpperCase());
    if (!known && !sameBranch) continue;
    ensure(asset).orders.push(r);
  }
  for (const row of rows.values()) {
    row.pm.sort(byDue);
    row.nextPm = row.pm.find((e) => e.dueDate) ?? row.pm[0] ?? null;
    row.orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const open = row.orders.filter((r) => r.status !== 'done');
    row.openOrders = open.length;
    row.lastService =
      row.orders
        .filter((r) => r.status === 'done' && r.maintType === 'inspection')
        .map((r) => (r.closedAt || r.createdAt).slice(0, 10))
        .sort()
        .pop() ?? '';
    row.reliability = reliability(row.orders, today, dataFrom);
    const levels = [
      ...row.pm.map((e) => dueLevel(e.dueDate, today)),
      ...open.map((r) => dueLevel(r.dueDate, today)),
    ];
    row.state = open.some(isBreakdown)
      ? 'breakdown'
      : levels.includes('overdue')
        ? 'overdue'
        : levels.includes('soon')
          ? 'soon'
          : 'ok';
  }
  return [...rows.values()].sort((a, b) => {
    const pa = a.code ? pressRank(a.code) : Infinity;
    const pb = b.code ? pressRank(b.code) : Infinity;
    if (pa !== pb) return pa - pb;
    return (
      MACHINE_STATE_META[a.state].rank - MACHINE_STATE_META[b.state].rank ||
      a.asset.localeCompare(b.asset)
    );
  });
}

// ---------------------------------------------------------------------
// PMD_Machine

/** How a machine code is matched against PMD_Machine's Title: "Batt-1",
 *  "BATT1" and "Batt1" are the same press. */
export const machineKey = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The PMD_Machine Titles a Machine page row may be listed under, best
 *  first: the press code, then Mango's name for it with and without its
 *  site prefix ("AU - Encore Cold Saw" / "Encore Cold Saw"), then the
 *  asset number. As machineKey()s. */
export function machineMasterKeys(row: Pick<MachineRow, 'code' | 'asset' | 'assetNumber'>): string[] {
  const keys = [row.code, row.asset, row.asset.replace(/^\s*[A-Z]{2}\s*-\s*/i, ''), row.assetNumber].map((k) => machineKey(k ?? ''));
  return [...new Set(keys.filter(Boolean))];
}

/** The figures the Machine page saves to PMD_Machine. */
export type MachineFigures = Pick<MachineMaster, 'lastService' | 'mtbf' | 'mttr' | 'breakdowns' | 'available'>;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * A press's figures as PMD_Machine keeps them: hours to one decimal,
 * availability as a percentage. Last service is the later of the date on
 * the list (stamped when someone sets the press to Serviced) and the last
 * preventive or calibration order Mango closed on it.
 */
export function machineFigures(row: MachineRow, stored?: MachineMaster): MachineFigures {
  const rel = row.reliability;
  return {
    lastService: [row.lastService, stored?.lastService ?? ''].sort().pop() ?? '',
    mtbf: rel.mtbfH == null ? null : round1(rel.mtbfH),
    mttr: rel.mttrH == null ? null : round1(rel.mttrH),
    breakdowns: rel.breakdowns,
    available: rel.availability == null ? null : round1(rel.availability * 100),
  };
}

/** The figures that differ from what PMD_Machine holds; {} when nothing
 *  needs writing. A stored date is never wiped. */
export function machineFiguresPatch(stored: MachineMaster, figures: MachineFigures): Partial<MachineFigures> {
  const patch: Partial<MachineFigures> = {};
  if (figures.lastService && figures.lastService !== stored.lastService) patch.lastService = figures.lastService;
  for (const k of ['mtbf', 'mttr', 'breakdowns', 'available'] as const) {
    const a = figures[k];
    const b = stored[k];
    if (a == null ? b != null : b == null || Math.abs(a - b) >= 0.05) patch[k] = a;
  }
  return patch;
}

// ---------------------------------------------------------------------
// the Team page

export const UNASSIGNED = 'Unassigned';

/** Mango's maintenance coordinator. She is put on most work orders to assess
 *  them, so on an order with more than one person the work is the other's. */
export const MAINT_COORDINATOR = 'Avila Pushparaj';

/** Who owns a work order: Mango's "Assign to Action" — with two or more
 *  people on it, the first who is not the coordinator. */
export function orderOwner(r: DieMaintenanceRequest): string {
  const people = r.contact
    .split(/[;,\n|/&]|\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (people.length > 1) {
    const coordinator = plain(MAINT_COORDINATOR);
    return people.find((p) => plain(p) !== coordinator) ?? people[0];
  }
  return people[0] ?? UNASSIGNED;
}

export interface DoneOrder {
  ticket: string;
  /** The machine (or die) the order was on: Mango's Plant/Equipment. */
  asset: string;
  /** Brief Description. */
  title: string;
  /** "Describe the issue", where it says more than the brief description. */
  detail: string;
  /** What was done: "Summary of work completed", else "Summary", else
   *  "Corrective action taken". */
  summary: string;
  /** "Preventative action taken", unless it is N/A or already said above.
   *  Some sites leave the work summary empty and put the fix here. */
  prevention: string;
  /** The Comment: entries of Mango's Actions taken log, newest first —
   *  the technicians' own notes; the stage changes around them are left out. */
  notes: MangoActionComment[];
  owner: string;
  /** When it was raised (Mango's Created Date), YYYY-MM-DD; '' if blank. */
  created: string;
  /** When it closed (Mango's Stage 4 date), YYYY-MM-DD; '' when the log never says. */
  closed: string;
  /** Days from raised to closed — the order's cycle time. null without both dates. */
  cycleDays: number | null;
  /** When it closed, else when it was raised. YYYY-MM-DD. */
  day: string;
  hours: number;
  /** Labour Hours was filled in. Many orders close without it, so the
   *  hours total only covers these. */
  booked: boolean;
}

const plain = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** `extra` adds nothing to `text`: empty, N/A, or already inside it. */
function addsNothing(extra: string | undefined, text: string | undefined): boolean {
  const e = plain(extra);
  return !e || /^(n ?a|none|nil|no)$/.test(e) || plain(text).includes(e);
}

/** Closed work orders with the day they closed and the labour booked on them. */
export function doneOrders(orders: readonly DieMaintenanceRequest[]): DoneOrder[] {
  return orders
    .filter((r) => r.status === 'done')
    .map((r) => {
      const summary = r.workSummary || r.summary || r.correctiveAction || '';
      const created = r.createdAt.slice(0, 10);
      const closed = r.closedAt.slice(0, 10);
      const cycle = created && closed ? daysUntil(closed, created) : null;
      return {
        ticket: r.mangoTicket,
        asset: r.asset || r.dieNumber,
        title: r.description,
        detail: addsNothing(r.issueDetail, r.description) ? '' : (r.issueDetail ?? ''),
        summary,
        prevention: addsNothing(r.preventativeAction, summary) ? '' : (r.preventativeAction ?? ''),
        notes: parseMangoActionComments(r.actionsTaken),
        owner: orderOwner(r),
        created,
        closed,
        cycleDays: cycle != null && cycle >= 0 ? cycle : null,
        day: closed || created,
        hours: hours(r.labourHours),
        booked: (r.labourHours ?? '').trim() !== '',
      };
    })
    .filter((o) => o.day !== '')
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

export type BucketUnit = 'day' | 'week' | 'month';

export interface Bucket {
  /** First day of the bucket, YYYY-MM-DD. */
  start: string;
  count: number;
  hours: number;
  /** The same per owner. */
  byOwner: Map<string, { count: number; hours: number }>;
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The start of the bucket `day` falls in: itself, its Monday, or the 1st. */
export function bucketStart(day: string, unit: BucketUnit): string {
  const d = new Date(`${day}T00:00:00`);
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (unit === 'month') d.setDate(1);
  return ymd(d);
}

function nextBucket(start: string, unit: BucketUnit): string {
  const d = new Date(`${start}T00:00:00`);
  if (unit === 'day') d.setDate(d.getDate() + 1);
  else if (unit === 'week') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return ymd(d);
}

/** The last day of the bucket starting `start`. */
export function bucketEnd(start: string, unit: BucketUnit): string {
  const d = new Date(`${nextBucket(start, unit)}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

/** A bucket size that keeps the chart readable: days up to ~6 weeks, weeks up to ~8 months. */
export function unitFor(from: string, to: string): BucketUnit {
  const days = daysUntil(to, from);
  return days <= 45 ? 'day' : days <= 250 ? 'week' : 'month';
}

/** Orders and labour hours per bucket from `from` to `to`, empty buckets included. */
export function bucketDone(
  done: readonly DoneOrder[],
  from: string,
  to: string,
  unit: BucketUnit,
): Bucket[] {
  const out = new Map<string, Bucket>();
  for (let s = bucketStart(from, unit); s <= to; s = nextBucket(s, unit)) {
    out.set(s, { start: s, count: 0, hours: 0, byOwner: new Map() });
  }
  for (const o of done) {
    if (o.day < from || o.day > to) continue;
    const b = out.get(bucketStart(o.day, unit));
    if (!b) continue;
    b.count += 1;
    b.hours += o.hours;
    const p = b.byOwner.get(o.owner) ?? { count: 0, hours: 0 };
    p.count += 1;
    p.hours += o.hours;
    b.byOwner.set(o.owner, p);
  }
  return [...out.values()];
}

/** Monday to Sunday of the week before the one `today` is in. */
export function lastWeek(today: string): { from: string; to: string } {
  const monday = bucketStart(today, 'week');
  const d = new Date(`${monday}T00:00:00`);
  d.setDate(d.getDate() - 7);
  const from = ymd(d);
  d.setDate(d.getDate() + 6);
  return { from, to: ymd(d) };
}

/** Median and mean cycle time, in days, of the orders that have one. */
export function cycleTime(done: readonly DoneOrder[]): { median: number | null; mean: number | null; n: number } {
  const days = done.map((d) => d.cycleDays).filter((d): d is number => d != null).sort((a, b) => a - b);
  if (days.length === 0) return { median: null, mean: null, n: 0 };
  const mid = days.length >> 1;
  const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  return { median, mean: days.reduce((a, b) => a + b, 0) / days.length, n: days.length };
}

export interface OpenItem {
  kind: 'MR' | 'PM';
  asset: string;
  title: string;
  owner: string;
  /** YYYY-MM-DD, '' when there is none. */
  due: string;
  level: DueLevel;
  /** Mango's work-order number, MR only. */
  ticket: string;
  /** Mango stage, MR; the frequency, PM. */
  note: string;
  /** When the request was raised, YYYY-MM-DD; '' for PM. Mango leaves "To be
   *  completed by" empty until the coordinator assesses a request, so for
   *  those its age is what says how urgent it is. */
  raised: string;
}

/**
 * Everything still to do: every open work order and every live PM event,
 * each with how its due date stands. Overdue first, then due soon, then by
 * date; undated last, the oldest request first.
 */
export function openWork(
  orders: readonly DieMaintenanceRequest[],
  pm: readonly MachinePmEvent[],
  today: string,
): OpenItem[] {
  const items: OpenItem[] = [
    ...orders
      .filter((r) => r.status !== 'done')
      .map((r) => ({
        kind: 'MR' as const,
        asset: r.asset || r.dieNumber,
        title: r.description,
        owner: orderOwner(r),
        due: (r.dueDate ?? '').slice(0, 10),
        level: dueLevel(r.dueDate, today),
        ticket: r.mangoTicket,
        note: r.status === 'open' ? 'Raised' : 'In progress',
        raised: r.createdAt.slice(0, 10),
      })),
    ...pm.filter(isLivePm).map((e) => ({
      kind: 'PM' as const,
      asset: e.asset,
      title: e.detail || e.eventType || 'Preventive maintenance',
      owner: e.owner || UNASSIGNED,
      due: e.dueDate,
      level: dueLevel(e.dueDate, today),
      ticket: '',
      note: e.frequency ? `every ${e.frequency}` : '',
      raised: '',
    })),
  ];
  const rank: Record<DueLevel, number> = { overdue: 0, soon: 1, ok: 2, none: 3 };
  return items.sort(
    (a, b) =>
      rank[a.level] - rank[b.level] ||
      (a.due || '9999').localeCompare(b.due || '9999') ||
      // Undated: the longest-waiting request first.
      (a.raised || '9999').localeCompare(b.raised || '9999'),
  );
}
