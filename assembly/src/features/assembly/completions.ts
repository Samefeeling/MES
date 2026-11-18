/**
 * The completed-orders dialog's data: which of Assembly's orders Epicor says
 * were finished in the window (`CompletedJobs.csv`), who is down as having
 * finished them, and writing the supervisor's answer back to `ASSY_Production`.
 *
 * Who is offered before anybody has said, best first: the board's own crew on
 * the order that day, while the board still has the order; the people the
 * order's row for that day names; the latest earlier row that names anyone.
 *
 * On the demo board (no SharePoint, mock data) the dialog is filled from the
 * board's own orders and its answers are kept on this screen only.
 */

import { fetchCompletedJobsCsv, hasCompletedJobsSource, readCsvConfigFromEnv } from '@/data/csv/csv.client';
import { ensureCompletionColumns, storedDaysFor, writeCompletion } from '@/data/sharepoint/completion.list';
import { sessionRequest } from '@/data/sharepoint/session';
import { readConfigFromEnv, type SharePointConfig } from '@/data/sharepoint/site';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import {
  completionsBetween,
  confirmWindow,
  parseCompletedJobsCsv,
  type Completion,
} from '@/engine/assembly/completedJobs';
import {
  completionFields,
  isConfirmed,
  rowForCompletion,
  suggestedCrew,
  type StoredDay,
} from '@/engine/assembly/completionRecord';
import { LINES, rootLineKey, type LineDef } from '@/domain/assembly';
import { fromDayKey, toDayKey } from '@/lib/time';
import { useCompletionStore, type CompletionItem, type Person } from '@/store/completionStore';
import { useDataStore } from '@/store/dataStore';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The production list, named the way the board's own sync names it. */
export const productionListName = (): string =>
  (import.meta.env.VITE_PRODUCTION_LIST ?? (import.meta.env.VITE_BACKEND === 'sharepoint' ? 'ASSY_Production' : '')).trim();

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

/** Names on the list, matched to the roster where the roster knows them. */
function peopleFrom(board: AssemblyGanttView, ids: readonly string[], names: readonly string[]): Person[] {
  return names.map((name, i) => {
    const byId = ids[i] ? board.workers.find((w) => String(w.id) === ids[i]) : undefined;
    const byName = board.workers.find((w) => w.name.toLowerCase() === name.toLowerCase());
    const w = byId ?? byName;
    return { id: w ? String(w.id) : ids[i] ?? '', name: w?.name ?? name };
  });
}

/** One dialog row for a completion and the order's stored rows. */
export function itemFor(
  board: AssemblyGanttView,
  completion: Completion,
  stored: readonly StoredDay[],
): CompletionItem {
  const row = rowForCompletion(stored, completion.day);
  const confirmed = isConfirmed(row);
  const offered = (() => {
    if (confirmed && row) return peopleFrom(board, row.completedByIds, row.completedBy);
    const crew = boardCrewFor(board, completion.jobNum, completion.day);
    if (crew.length) return crew;
    const named = suggestedCrew(stored, completion.day);
    return peopleFrom(board, named.ids, named.names);
  })();
  const onBoard = boardRows(board, completion.jobNum)[0];
  return {
    completion,
    row,
    line: row?.line || stored.find((r) => r.line)?.line || (onBoard ? lineName(onBoard.line) : '') || lineForPlanner(completion.planner),
    people: offered,
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
  const list = productionListName();
  const demo = useDataStore.getState().source.name === 'mock' && !hasCompletedJobsSource(csv, sp);
  const keep = (next: CompletionItem[]): CompletionItem[] => {
    // A name somebody is choosing right now is not thrown away by a refresh.
    const held = new Map(useCompletionStore.getState().items.map((i) => [i.completion.key, i]));
    return next.map((item) => {
      const was = held.get(item.completion.key);
      if (!was) return item;
      if (useCompletionStore.getState().local) return { ...item, people: was.people, confirmed: was.confirmed, confirmedBy: was.confirmedBy };
      return item.confirmed ? item : { ...item, people: was.people };
    });
  };

  if (demo) {
    const sameWindow = useCompletionStore.getState().window?.from === window.from;
    // The demo roster has nobody on past days: offer two people of the line.
    const items = demoCompletions(board, window).map((c) => {
      const item = itemFor(board, c, []);
      if (item.people.length) return item;
      const key = LINES.find((l) => l.name === item.line)?.key;
      const skilled = board.workers.filter((w) => key && w.skills.some((k) => rootLineKey(k) === key)).slice(0, 2);
      return { ...item, people: skilled.map((w) => ({ id: String(w.id), name: w.name })) };
    });
    set({ status: 'ready', window, local: true, error: null, warnings: [], items: sameWindow ? keep(items) : items });
    return;
  }
  if (!hasCompletedJobsSource(csv, sp)) {
    set({ status: 'off', window, items: [], error: null, warnings: [] });
    return;
  }
  set({ status: useCompletionStore.getState().status === 'ready' ? 'ready' : 'loading', window, local: false });
  const text = await fetchCompletedJobsCsv(csv, sp);
  if (!text.ok || text.value === null) {
    set({ status: 'failed', error: text.ok ? 'CompletedJobs.csv not found.' : text.error });
    return;
  }
  const parsed = parseCompletedJobsCsv(text.value);
  const completions = completionsBetween(parsed.rows, window.from, window.to);
  let stored = new Map<string, StoredDay[]>();
  let error: string | null = null;
  if (listEnabled(sp, list) && completions.length) {
    const read = await storedDaysFor(sp, list, [...new Set(completions.map((c) => c.jobNum))]);
    if (read.ok) stored = read.value;
    else error = `${list} not read: ${read.error}`;
  } else if (!listEnabled(sp, list)) {
    error = 'No production list configured: confirmations cannot be saved.';
  }
  const items = completions.map((c) => itemFor(board, c, stored.get(c.jobNum) ?? []));
  set({ status: 'ready', items: keep(items), error, warnings: parsed.errors.slice(0, 3) });
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
  const list = productionListName();
  if (!listEnabled(sp, list)) {
    patch({ error: 'No production list configured.' });
    return;
  }
  patch({ saving: true, error: null });
  try {
    const columns = await ensureCompletionColumns(sp, list);
    if (!columns.ok) throw new Error(columns.error);
    const by = await confirmer(sp);
    const fields = completionFields(item.completion, item.people, by, new Date());
    const res = await writeCompletion(sp, list, item.completion, item.row, item.line, fields);
    if (!res.ok) throw new Error(res.error);
    patch({ saving: false, confirmed: true, confirmedBy: by, row: res.value });
  } catch (e) {
    patch({ saving: false, error: message(e) });
  }
}
