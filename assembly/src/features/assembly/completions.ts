/**
 * The completed-orders dialog's data: which of Assembly's orders Epicor says
 * were finished in the window (`CompletedJobs.csv`), who is down as having
 * finished them, and writing the supervisor's answer to `ASSY_CompletedJobs`.
 *
 * Who is offered before anybody has said, best first:
 *
 *   1. The order's line group as the board draws it for that day — the people
 *      it places on that line (`lineOfWorkerToday`, the board's own rule) —
 *      less anyone on leave that day (booked leave, or marked off on the
 *      board). The supervisor runs each line as one team and keeps those
 *      groups current, so this is the answer that needs least changing, and
 *      it holds for an order the board has already let go of — which most
 *      finished orders are by the morning after.
 *   2. The board's own crew on the order that day, while it still has the
 *      order (a line the board has nobody placed on).
 *   3. The people the order's `ASSY_Planning` row for that day names; else the
 *      latest earlier row that names anyone.
 *
 * Who was left out as on leave is kept on the item, for the dialog to show.
 *
 * The groups are the board's as they stand now: a person moved to another
 * line since the completion day is offered on the line they are on now.
 *
 * On the demo board (no SharePoint, mock data) the dialog is filled from the
 * board's own orders and its answers are kept on this screen only.
 */

import { fetchCompletedJobsCsv, hasCompletedJobsSource, readCsvConfigFromEnv } from '@/data/csv/csv.client';
import { ensureCompletionColumns, fieldsFor, storedDaysFor, writeCompletion } from '@/data/sharepoint/completion.list';
import { sessionRequest } from '@/data/sharepoint/session';
import { readConfigFromEnv, type SharePointConfig } from '@/data/sharepoint/site';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import {
  completionsBetween,
  isAssessedLine,
  confirmWindow,
  doneQtyByJob,
  doneQtyThrough,
  parseCompletedJobsCsv,
  type Completion,
} from '@/engine/assembly/completedJobs';
import {
  completionRow,
  isConfirmed,
  orderFromRows,
  recordFor,
  suggestedCrew,
  type CompletionOrder,
  type StoredDay,
} from '@/engine/assembly/completionRecord';
import { LINES, activeLineKey, arrangeLines, rootLineKey, type LineDef, type LineKey } from '@/domain/assembly';
import { isOnLeave } from '@/engine/assembly/attendance';
import { usePlanStore } from '@/store/planStore';
import { lineOfWorkerToday } from './boardView';
import { fromDayKey, toDayKey } from '@/lib/time';
import { useCompletionStore, type CompletionItem, type LineGroupCrew, type Person } from '@/store/completionStore';
import { useDataStore } from '@/store/dataStore';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The board's planning list — the same name the board's own sync writes. */
export const planningListName = (): string =>
  (import.meta.env.VITE_PLANNING_LIST ?? (import.meta.env.VITE_BACKEND === 'sharepoint' ? 'ASSY_Planning' : '')).trim();

/** The list confirmed completions are written to, and KPIs · Assembly reads. */
export const completedListName = (): string =>
  (import.meta.env.VITE_COMPLETED_JOBS_LIST ?? (import.meta.env.VITE_BACKEND === 'sharepoint' ? 'ASSY_CompletedJobs' : '')).trim();

const listEnabled = (sp: SharePointConfig, list: string): boolean =>
  Boolean(list && sp.siteUrl && (sp.token || sp.authMode === 'session'));

/** The board's line name for an ERP planner, for an order the board no longer has. */
export function lineForPlanner(planner: string): string {
  switch (planner.trim().toUpperCase()) {
    case 'ASSY':
      return 'Assembly';
    case 'TABLE':
      return 'Table';
    case 'GENERAL':
    case 'FACTORY_GENERAL':
      return 'General';
    default:
      return planner.trim();
  }
}

/** A bench (Foaming, Sewing…) is named for the line it is part of. */
const lineName = (line: LineDef): string =>
  line.parent ? LINES.find((l) => l.key === line.parent)?.name ?? line.name : line.name;

/** The board's rows for one order number — one, or one per operation of a routed order. */
function boardRows(board: AssemblyGanttView, jobNum: string) {
  return [...board.rowsByJob.values()].filter(
    (row) => String(row.job.operation?.jobNum ?? row.job.id) === jobNum,
  );
}

/** The crew the board had on the order that day, if it still has the order. */
export function boardCrewFor(board: AssemblyGanttView, jobNum: string, day: string): Person[] {
  const rows = boardRows(board, jobNum);
  // The receiving operation is the one that finished it.
  const row = rows.find((r) => !r.job.operation || r.job.operation.last) ?? rows[0];
  if (!row) return [];
  // That day's crew; else whoever the order has now, which is still a better
  // first offer than nobody — the supervisor confirms it either way.
  const ids = row.crewDays.find((d) => d.day === day)?.workerIds;
  const people = ids?.length ? board.workers.filter((w) => ids.includes(String(w.id))) : row.workers;
  return people.map((w) => ({ id: String(w.id), name: w.name }));
}

/** Worker id → the line the supervisor has put them on (`planStore.workerLines`). */
export type WorkerLines = Readonly<Record<string, LineKey>>;

/**
 * The lane a completion's line name means on the board — a bench is its
 * lane's, and by process Smart Soft Seating is Upholstery's — or null for a
 * name the board has no line for.
 */
export function laneOf(board: AssemblyGanttView, line: string): string | null {
  const name = line.trim().toLowerCase();
  if (!name) return null;
  const hit = [...(board.groups ?? []).map((g) => g.line), ...LINES].find(
    (l) => l.name.toLowerCase() === name || String(l.key).toLowerCase() === name,
  );
  return hit ? activeLineKey(rootLineKey(hit.key)) : null;
}

/**
 * The line's group on `day`, as the board draws it: everybody it places on
 * that line, bench people included, split into who was in and who was on
 * leave. Empty for a line the board does not know.
 */
export function lineCrewFor(
  board: AssemblyGanttView,
  workerLines: WorkerLines,
  line: string,
  day: string,
): { people: Person[]; onLeave: Person[] } {
  const lane = laneOf(board, line);
  if (!lane) return { people: [], onLeave: [] };
  const placed = lineOfWorkerToday(board.workers, [...board.rowsByJob.values()], fromDayKey(day), workerLines);
  const todayKey = board.today ? toDayKey(board.today) : '';
  const people: Person[] = [];
  const onLeave: Person[] = [];
  for (const w of board.workers) {
    const at = placed.get(String(w.id));
    if (!at || activeLineKey(rootLineKey(at)) !== lane) continue;
    const person = { id: String(w.id), name: w.name };
    (isOnLeave(w, day, board.workerOnLeave ?? {}, todayKey) ? onLeave : people).push(person);
  }
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  return { people: people.sort(byName), onLeave: onLeave.sort(byName) };
}

/**
 * The dialog's items in the board's line order (the supervisor's own
 * arrangement of the lines), each line's orders by order number. A line the
 * board does not have comes after, by name.
 */
export function groupByLine(
  board: AssemblyGanttView,
  items: readonly CompletionItem[],
  lineOrder: readonly string[] = [],
): { line: string; items: CompletionItem[] }[] {
  const lanes = arrangeLines(
    [...(board.groups ?? []).map((g) => g.line), ...LINES]
      .filter((l, i, all) => !l.parent && all.findIndex((m) => m.key === l.key) === i)
      .map((l) => ({ key: String(l.key), name: l.name })),
    lineOrder,
  );
  const rank = new Map(lanes.map((l, i) => [l.key, i]));
  const byLine = new Map<string, CompletionItem[]>();
  for (const item of items) {
    const name = item.line || '—';
    byLine.set(name, [...(byLine.get(name) ?? []), item]);
  }
  const place = (name: string): number => {
    const lane = laneOf(board, name);
    return lane === null ? lanes.length : rank.get(lane) ?? lanes.length;
  };
  return [...byLine.entries()]
    .sort(([a], [b]) => place(a) - place(b) || a.localeCompare(b))
    .map(([line, list]) => ({
      line,
      items: [...list].sort(
        (a, b) => a.completion.jobNum.localeCompare(b.completion.jobNum) || a.completion.day.localeCompare(b.completion.day),
      ),
    }));
}

/**
 * Each line's group for the dialog's headings: the same group its orders are
 * offered (`lineCrewFor`), on the line's latest completion day.
 */
export function lineGroupsFor(
  board: AssemblyGanttView,
  workerLines: WorkerLines,
  items: readonly CompletionItem[],
): Record<string, LineGroupCrew> {
  const latest = new Map<string, string>();
  for (const item of items) {
    const day = item.completion.day;
    if ((latest.get(item.line) ?? '') < day) latest.set(item.line, day);
  }
  const out: Record<string, LineGroupCrew> = {};
  for (const [line, day] of latest) out[line] = { day, ...lineCrewFor(board, workerLines, line, day), edited: false };
  return out;
}

/** Names on the list, matched to the roster where the roster knows them. */
function peopleFrom(board: AssemblyGanttView, ids: readonly string[], names: readonly string[]): Person[] {
  return names.map((name, i) => {
    const byId = ids[i] ? board.workers.find((w) => String(w.id) === ids[i]) : undefined;
    const byName = board.workers.find((w) => w.name.toLowerCase() === name.toLowerCase());
    const w = byId ?? byName;
    return { id: w ? String(w.id) : ids[i] ?? '', name: w?.name ?? name };
  });
}

/** The order as the board holds it, while it still does. */
function boardOrder(board: AssemblyGanttView, jobNum: string): CompletionOrder | null {
  const rows = boardRows(board, jobNum);
  const row = rows.find((r) => !r.job.operation || r.job.operation.last) ?? rows[0];
  if (!row) return null;
  const qty = row.job.remainingQty + row.job.completedQty;
  return {
    line: lineName(row.line),
    dueDate: row.job.dueDate ? row.job.dueDate.toISOString() : null,
    orderQty: qty > 0 ? qty : null,
  };
}

/**
 * One dialog row for a completion: `planning` is the order's rows in
 * `ASSY_Planning`, `completed` its rows in `ASSY_CompletedJobs`.
 */
export function itemFor(
  board: AssemblyGanttView,
  completion: Completion,
  planning: readonly StoredDay[],
  completed: readonly StoredDay[],
  doneToDate: number,
  workerLines: WorkerLines = {},
): CompletionItem {
  const row = recordFor(completed, completion);
  const confirmed = isConfirmed(row);
  const listed = orderFromRows(planning);
  const held = boardOrder(board, completion.jobNum);
  const order: CompletionOrder = {
    line: held?.line || listed.line || row?.line || lineForPlanner(completion.planner),
    dueDate: held?.dueDate ?? listed.dueDate ?? row?.dueDate ?? null,
    orderQty: held?.orderQty ?? listed.orderQty ?? null,
  };
  const line = (confirmed && row?.line) || order.line;
  const group = lineCrewFor(board, workerLines, line, completion.day);
  const offered = ((): { people: Person[]; from: CompletionItem['offeredFrom'] } => {
    if (confirmed && row) return { people: peopleFrom(board, row.completedByIds, row.completedBy), from: 'saved' };
    if (group.people.length) return { people: group.people, from: 'line' };
    const crew = boardCrewFor(board, completion.jobNum, completion.day);
    if (crew.length) return { people: crew, from: 'order' };
    const named = suggestedCrew(planning, completion.day);
    const people = peopleFrom(board, named.ids, named.names);
    return { people, from: people.length ? 'planning' : 'none' };
  })();
  return {
    completion,
    row,
    line,
    order,
    doneToDate,
    people: offered.people,
    offeredFrom: offered.from,
    onLeave: group.onLeave,
    edited: false,
    confirmed,
    confirmedBy: row?.confirmedBy ?? '',
    saving: false,
    error: null,
  };
}

/**
 * Orders for the demo board: a few of its own (two a line), finished on the days of the
 * window, so the dialog has something to show without an export.
 */
export function demoCompletions(board: AssemblyGanttView, window: { from: string; to: string }): Completion[] {
  const days: string[] = [];
  for (let d = fromDayKey(window.from); toDayKey(d) <= window.to; d.setDate(d.getDate() + 1)) days.push(toDayKey(d));
  // Two orders a line, from every order the board holds.
  const perLine = new Map<string, number>();
  const rows = [...board.rowsByJob.values()].filter((r) => {
    if (!r.line.schedulable || r.job.manual) return false;
    const name = lineName(r.line);
    const n = perLine.get(name) ?? 0;
    perLine.set(name, n + 1);
    return n < 2;
  });
  // One per order: a routed order is a row per bench, all one order number.
  const seen = new Set<string>();
  const orders = rows.filter((row) => {
    const jobNum = String(row.job.operation?.jobNum ?? row.job.id);
    if (seen.has(jobNum)) return false;
    seen.add(jobNum);
    return true;
  });
  return orders.slice(0, 6).map((row, i) => {
    const day = days[i % days.length];
    const jobNum = String(row.job.operation?.jobNum ?? row.job.id);
    const qty = Math.max(1, Math.round(row.job.remainingQty / 2) || 10);
    const perUnit = row.job.laborHrs > 0 && row.job.remainingQty + row.job.completedQty > 0
      ? row.job.laborHrs / (row.job.remainingQty + row.job.completedQty)
      : 0.25;
    return {
      key: `${jobNum}|${day}`,
      jobNum,
      day,
      qty,
      hours: Math.round(qty * perUnit * 100) / 100,
      planner: lineName(row.line).toUpperCase(),
      partNum: String(row.job.partNum),
      description: row.job.description,
      lastAt: `${day}T14:${String(10 + i).padStart(2, '0')}`,
      entries: 1,
    };
  });
}

let signedInName: string | null = null;

/** Who is confirming: the SharePoint user signed in on this screen. */
async function confirmer(sp: SharePointConfig): Promise<string> {
  if (signedInName !== null) return signedInName;
  if (sp.authMode !== 'session' || !sp.siteUrl) return 'Supervisor';
  try {
    const res = await sessionRequest(sp, `${sp.siteUrl.replace(/\/$/, '')}/_api/web/currentuser?$select=Title`);
    const body = (await res.json()) as { Title?: string };
    signedInName = String(body.Title ?? '').trim() || 'Supervisor';
  } catch {
    signedInName = 'Supervisor';
  }
  return signedInName;
}

let loading: Promise<void> | null = null;
let queued: { board: AssemblyGanttView; now: Date } | null = null;

/**
 * Read the window's completions and what the list already says about them.
 *
 * One read at a time; a call made during one is run after it with the board
 * as it then is — not dropped, or the board the plan has since filled in
 * would never be read.
 */
export function loadCompletions(board: AssemblyGanttView, now = new Date()): Promise<void> {
  if (loading) {
    queued = { board, now };
    return loading;
  }
  loading = load(board, now).finally(() => {
    loading = null;
    const next = queued;
    queued = null;
    if (next) void loadCompletions(next.board, next.now);
  });
  return loading;
}

async function load(board: AssemblyGanttView, now: Date): Promise<void> {
  const set = useCompletionStore.setState;
  const window = confirmWindow(now);
  const csv = readCsvConfigFromEnv();
  const sp = readConfigFromEnv();
  const planningList = planningListName();
  const list = completedListName();
  const demo = useDataStore.getState().source.name === 'mock' && !hasCompletedJobsSource(csv, sp);
  const keep = (next: CompletionItem[]): CompletionItem[] => {
    // Names somebody has chosen are not thrown away by a refresh. Names
    // nobody touched are offered afresh: the roster, the line groups and the
    // leave may all have come in since.
    const held = new Map(useCompletionStore.getState().items.map((i) => [i.completion.key, i]));
    return next.map((item) => {
      const was = held.get(item.completion.key);
      if (!was) return item;
      if (useCompletionStore.getState().local && was.confirmed) {
        return { ...item, people: was.people, confirmed: true, confirmedBy: was.confirmedBy, edited: was.edited };
      }
      return item.confirmed || !was.edited ? item : { ...item, people: was.people, edited: true };
    });
  };
  /** The line headings' groups, keeping any the supervisor has changed. */
  const groupsFor = (items: CompletionItem[]): Record<string, LineGroupCrew> => {
    const fresh = lineGroupsFor(board, usePlanStore.getState().workerLines, items);
    const held = useCompletionStore.getState().lineGroups;
    for (const [line, group] of Object.entries(fresh)) {
      if (held[line]?.edited && held[line].day === group.day) fresh[line] = held[line];
    }
    return fresh;
  };

  if (demo) {
    const sameWindow = useCompletionStore.getState().window?.from === window.from;
    // The demo roster has nobody on past days: offer two people of the line.
    const items = demoCompletions(board, window).filter((c) => isAssessedLine(c.planner)).map((c) => {
      const item = itemFor(board, c, [], [], c.qty, usePlanStore.getState().workerLines);
      if (item.people.length) return item;
      const key = LINES.find((l) => l.name === item.line)?.key;
      const skilled = board.workers.filter((w) => key && w.skills.some((k) => rootLineKey(k) === key)).slice(0, 2);
      return { ...item, people: skilled.map((w) => ({ id: String(w.id), name: w.name })) };
    });
    const shown = sameWindow ? keep(items) : items;
    set({ status: 'ready', window, local: true, error: null, warnings: [], doneQty: {}, items: shown, lineGroups: groupsFor(shown) });
    return;
  }
  if (!hasCompletedJobsSource(csv, sp)) {
    set({ status: 'off', window, items: [], error: null, warnings: [], doneQty: {} });
    return;
  }
  set({ status: useCompletionStore.getState().status === 'ready' ? 'ready' : 'loading', window, local: false });
  const text = await fetchCompletedJobsCsv(csv, sp);
  if (!text.ok || text.value === null) {
    set({ status: 'failed', error: text.ok ? 'CompletedJobs.csv not found.' : text.error });
    return;
  }
  const parsed = parseCompletedJobsCsv(text.value);
  const doneQty = doneQtyByJob(parsed.rows);
  const completions = completionsBetween(parsed.rows, window.from, window.to);
  const jobs = [...new Set(completions.map((c) => c.jobNum))];
  let planning = new Map<string, StoredDay[]>();
  let completed = new Map<string, StoredDay[]>();
  const problems: string[] = [];
  if (!listEnabled(sp, list)) {
    problems.push('No ASSY_CompletedJobs list configured: confirmations cannot be saved.');
  } else if (jobs.length) {
    const read = await storedDaysFor(sp, list, jobs);
    if (read.ok) completed = read.value;
    else problems.push(`${list} not read: ${read.error}`);
  }
  if (listEnabled(sp, planningList) && jobs.length) {
    // Only for who to offer and the order's Due Date; the dialog works without it.
    const read = await storedDaysFor(sp, planningList, jobs);
    if (read.ok) planning = read.value;
  }
  const workerLines = usePlanStore.getState().workerLines;
  // An order the board files under TBP is left out too, whatever its planner.
  const items = completions
    .map((c) =>
      itemFor(board, c, planning.get(c.jobNum) ?? [], completed.get(c.jobNum) ?? [], doneQtyThrough(parsed.rows, c.jobNum, c.day), workerLines),
    )
    .filter((item) => isAssessedLine(item.line));
  const shown = keep(items);
  set({
    status: 'ready',
    items: shown,
    lineGroups: groupsFor(shown),
    doneQty,
    error: problems.length ? problems.join(' · ') : null,
    warnings: parsed.errors.slice(0, 3),
  });
}

/** Write who finished one order. */
export async function confirmCompletion(key: string): Promise<void> {
  const store = useCompletionStore;
  const item = store.getState().items.find((i) => i.completion.key === key);
  if (!item || item.saving) return;
  const patch = (over: Partial<CompletionItem>) =>
    store.setState((s) => ({ items: s.items.map((i) => (i.completion.key === key ? { ...i, ...over } : i)) }));
  if (item.people.length === 0) {
    patch({ error: 'Choose who finished it.' });
    return;
  }
  const sp = readConfigFromEnv();
  if (store.getState().local) {
    patch({ confirmed: true, confirmedBy: 'Supervisor (demo)', error: null });
    return;
  }
  const list = completedListName();
  if (!listEnabled(sp, list)) {
    patch({ error: 'No ASSY_CompletedJobs list configured.' });
    return;
  }
  patch({ saving: true, error: null });
  try {
    const columns = await ensureCompletionColumns(sp, list);
    if (!columns.ok) throw new Error(columns.error);
    const by = await confirmer(sp);
    const order = { ...item.order, line: item.line };
    const fields = fieldsFor(completionRow(item.completion, item.people, by, new Date(), order, item.doneToDate), columns.value);
    const res = await writeCompletion(sp, list, item.completion, item.row, fields);
    if (!res.ok) throw new Error(res.error);
    patch({ saving: false, confirmed: true, confirmedBy: by, row: res.value });
  } catch (e) {
    patch({ saving: false, error: message(e) });
  }
}
