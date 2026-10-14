/**
 * Where the waybill comes from, and where the dispatch planner's decisions go.
 *
 * Run each time the board reads its own exports (`refreshWaybill`):
 *
 * 1. **Sync** — on a screen where the supervisor is signed in: `Waybill.csv`
 *    is read from the folder the other exports are in and compared with the
 *    `Waybill` list row by row; only the cells that differ are written, new
 *    releases added, gone ones stamped `ClosedAt` (`engine/dispatch/waybillList`).
 *    One supervisor's screen is enough to keep the list current, and a screen
 *    nobody is signed in on never writes to it.
 * 2. **Read** — on every screen: the list's open rows are the waybill the
 *    Dispatch page plans from and the board reads Ship By off; the planner's
 *    columns are the decisions and the shipment log.
 *
 * Every change the planner makes is then written back to the rows of the
 * orders it touches, a moment after it is made. A change that did not reach
 * the list is kept on this screen and tried again, rather than replaced by
 * the list's older copy at the next refresh.
 *
 * With no SharePoint session (the dev server) `Waybill.csv` is read straight
 * from its configured URL and the decisions stay in this browser.
 */

import {
  fetchCubicsCsv,
  fetchWaybillCsv,
  hasWaybillSource,
  readCsvConfigFromEnv,
} from '@/data/csv/csv.client';
import { looksLikeCubics } from '@/data/csv/cubics.parser';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import { readConfigFromEnv, type SharePointConfig } from '@/data/sharepoint/site';
import { waybillColumns, waybillRows, writeDecisions, writeSync } from '@/data/sharepoint/waybill.list';
import type { DispatchDecisions } from '@/domain/dispatch';
import { orderKey } from '@/domain/orderLink';
import { SHIPMENT_RETENTION_DAYS } from '@/engine/dispatch/shipments';
import {
  csvTable,
  decisionColumns,
  decisionWrites,
  decisionsByOrder,
  decisionsFromRows,
  planSync,
  rowsToCsv,
  type ListColumn,
  type ListRow,
} from '@/engine/dispatch/waybillList';
import { toDayKey } from '@/lib/time';
import { useDispatchStore } from '@/store/dispatchStore';
import { useWaybillStore, type SyncReport } from '@/store/waybillStore';

export const waybillListName = (): string => (import.meta.env.VITE_WAYBILL_LIST ?? '').trim() || 'Waybill';

/** The list is used where MES runs on the SharePoint site, signed in. */
const listMode = (sp: SharePointConfig): boolean => sp.authMode === 'session' && Boolean(sp.siteUrl);

/**
 * More releases gone from the export at once than this share of the open
 * rows, out of more than `CLOSE_GUARD_MIN`, reads as a partial export rather
 * than a day's shipping: nothing is closed until somebody says so.
 */
const CLOSE_GUARD_SHARE = 0.5;
const CLOSE_GUARD_MIN = 20;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The list's open rows and columns as last read: what the planner's changes are compared with. */
let snapshot: { columns: ListColumn[]; open: ListRow[] } | null = null;
/** Closes held back by the guard, waiting for `closeHeld`. */
let heldCloses: { ids: string[]; column: string } | null = null;
/** Bumped by every change the planner makes; a read begun before one does not undo it. */
let generation = 0;
/** Set while decisions read from the list are being put in place, so they are not written back. */
let applying = false;
/** A planner change has not reached the list yet. */
let unsaved = false;

let running: Promise<void> | null = null;
let queued: { sync: boolean } | null = null;

/** Read the waybill (and sync it first, when `sync`), one read at a time. */
export async function refreshWaybill(opts: { sync: boolean }): Promise<void> {
  if (running) {
    queued = { sync: opts.sync || Boolean(queued?.sync) };
    return running;
  }
  running = load(opts).finally(() => {
    running = null;
  });
  await running;
  if (queued) {
    const next = queued;
    queued = null;
    await refreshWaybill(next);
  }
}

/** Decisions keyed as the waybill parser keys orders, so the plan finds them. */
function rekey(d: DispatchDecisions, csvText: string): DispatchDecisions {
  const ids = new Map(parseWaybillCsv(csvText).orders.map((o) => [orderKey(o.id), o.id]));
  const id = (key: string) => ids.get(orderKey(key)) ?? key;
  const map = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [id(k), v]));
  return {
    pins: map(d.pins),
    holds: map(d.holds),
    volumeOverrides: map(d.volumeOverrides),
    firmLoads: d.firmLoads.map((f) => ({
      ...f,
      orderIds: f.orderIds.map(id),
      volumes: map(f.volumes),
      ...(f.pieces ? { pieces: map(f.pieces) } : {}),
    })),
  };
}

async function load(opts: { sync: boolean }): Promise<void> {
  const csv = readCsvConfigFromEnv();
  const sp = readConfigFromEnv();
  const today = toDayKey(new Date());
  const notes: string[] = [];
  useWaybillStore.setState({ loading: true });
  const cubics = fetchCubicsCsv(csv, sp);
  try {
    if (listMode(sp)) await fromList(csv, sp, opts.sync, notes);
    else if (hasWaybillSource(csv, sp)) {
      const file = await fetchWaybillCsv(csv, sp);
      if (!file.ok) throw new Error(file.error);
      useWaybillStore.setState({
        mode: 'file',
        csvText: file.value,
        source: 'Waybill.csv',
        readAt: new Date().toISOString(),
        error: null,
      });
      useDispatchStore.getState().prune(today);
    } else {
      useWaybillStore.setState({ mode: 'none', csvText: null, source: null, error: null });
    }
  } catch (e) {
    useWaybillStore.setState({ error: message(e) });
  }
  const cub = await cubics;
  if (cub.ok && cub.value) {
    if (looksLikeCubics(cub.value)) useWaybillStore.setState({ cubicsText: cub.value, cubicsSource: 'Cubics.csv' });
    else notes.push('Cubics.csv is not the cubics sheet (no CODE column) — orders are sized from their freight lines.');
  } else if (!cub.ok) {
    notes.push(`Cubics.csv not read (${cub.error}) — orders are sized from their freight lines.`);
  }
  useWaybillStore.setState({ loading: false, notes });
}

async function fromList(
  csv: ReturnType<typeof readCsvConfigFromEnv>,
  sp: SharePointConfig,
  sync: boolean,
  notes: string[],
): Promise<void> {
  const list = waybillListName();
  const started = generation;
  const columns = await waybillColumns(sp, list);
  const { found, missing } = decisionColumns(columns);
  const since = new Date(Date.now() - SHIPMENT_RETENTION_DAYS * 86_400_000).toISOString();
  let rows = await waybillRows(sp, list, columns, since);
  let report: SyncReport | null = null;

  if (sync) {
    const file = await fetchWaybillCsv(csv, sp);
    if (!file.ok) notes.push(`Waybill.csv not read (${file.error}) — the ${list} list is as last synced.`);
    else if (file.value) {
      const table = csvTable(file.value);
      if ('error' in table) notes.push(`Waybill.csv: ${table.error} The ${list} list is as last synced.`);
      else {
        const openIds = new Set(rows.open.map((r) => r.id));
        const plan = planSync({ table, columns, open: rows.open, closed: rows.dispatched.filter((r) => !openIds.has(r.id)) });
        if ('error' in plan) notes.push(`${list} list: ${plan.error}`);
        else {
          const gone = plan.closes.length - plan.duplicates;
          const suspicious = rows.open.length > CLOSE_GUARD_MIN && gone > rows.open.length * CLOSE_GUARD_SHARE;
          heldCloses = suspicious && found.closedAt ? { ids: plan.closes, column: found.closedAt.internal } : null;
          const now = new Date().toISOString();
          const out = await writeSync(
            sp,
            list,
            columns,
            { ...plan, closes: suspicious ? [] : plan.closes },
            found.closedAt?.internal ?? null,
            now,
          );
          const closed = suspicious ? 0 : plan.closes.length;
          report = {
            at: now,
            created: plan.creates.length,
            updated: plan.updates.length,
            closed,
            unchanged: plan.unchanged,
            errors: out.errors,
            heldCloses: suspicious ? plan.closes.length : 0,
          };
          if (plan.missing.length > 0) {
            notes.push(`Waybill.csv columns not on the ${list} list, so not kept: ${plan.missing.join(', ')}.`);
          }
          if (out.done > 0) rows = await waybillRows(sp, list, columns, since);
        }
      }
    }
  }
  if (rows.unindexed.length > 0) {
    notes.push(
      `Index ${rows.unindexed.join(' and ')} on the ${list} list (List settings → Indexed columns): ` +
        'past 5,000 rows SharePoint will not filter on them, and the list is being read whole.',
    );
  }

  snapshot = { columns, open: rows.open };
  const csvText = rowsToCsv(rows.open, columns);
  useWaybillStore.setState((s) => ({
    mode: 'list',
    csvText,
    source: `${list} list`,
    readAt: new Date().toISOString(),
    error: null,
    lastSync: report ?? s.lastSync,
  }));

  // The planner's columns. Without all of them the decisions stay in this
  // browser, as they did before the list, rather than half of them reaching it.
  const planner = missing.filter((name) => name !== 'ClosedAt');
  if (planner.length > 0) {
    notes.push(
      `The ${list} list has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}: ` +
        'planner changes are kept on this screen only until they are added.',
    );
    useDispatchStore.setState({ listBacked: false });
    return;
  }
  if (missing.includes('ClosedAt')) {
    notes.push(`The ${list} list has no ClosedAt column: releases gone from Waybill.csv stay open on it.`);
  }
  if (unsaved) {
    // This screen holds changes the list has not got: send them again
    // instead of taking the list's older copy over them.
    void flush();
    return;
  }
  if (generation !== started) return;
  const { decisions, shipments } = decisionsFromRows(rows.open, rows.dispatched, columns);
  applying = true;
  try {
    useDispatchStore.getState().fromList(rekey(decisions, csvText), shipments);
  } finally {
    applying = false;
  }
}

/** Close the rows the guard held back, now somebody has said the export is whole. */
export async function closeHeld(): Promise<void> {
  const held = heldCloses;
  if (!held) return;
  const sp = readConfigFromEnv();
  const now = new Date().toISOString();
  const out = await writeSync(sp, waybillListName(), snapshot?.columns ?? [], { creates: [], updates: [], closes: held.ids }, held.column, now);
  heldCloses = null;
  useWaybillStore.setState((s) => ({
    lastSync: s.lastSync ? { ...s.lastSync, closed: s.lastSync.closed + out.done, heldCloses: 0, errors: [...s.lastSync.errors, ...out.errors] } : s.lastSync,
  }));
  await refreshWaybill({ sync: false });
}

// ---- The planner's changes, back to the list -----------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;
let again = false;

async function flush(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  const snap = snapshot;
  const state = useDispatchStore.getState();
  if (!snap || !state.listBacked) return;
  const writes = decisionWrites(decisionsByOrder(state.decisions, state.shipments), snap.open, snap.columns);
  if (writes.length === 0) {
    unsaved = false;
    useWaybillStore.setState({ writeError: null });
    return;
  }
  useWaybillStore.setState((s) => ({ saving: s.saving + writes.length }));
  flushing = (async () => {
    try {
      const out = await writeDecisions(readConfigFromEnv(), waybillListName(), snap.columns, writes);
      // What went through is now what the list says.
      const byId = new Map(snap.open.map((r) => [r.id, r]));
      writes.forEach((w, i) => {
        const row = byId.get(w.id);
        if (out.ok[i] && row) row.values = { ...row.values, ...w.fields };
      });
      unsaved = out.errors.length > 0;
      useWaybillStore.setState({
        writeError: out.errors.length > 0 ? `${out.errors.length} of ${writes.length} rows not saved: ${out.errors[0]}` : null,
      });
    } catch (e) {
      unsaved = true;
      useWaybillStore.setState({ writeError: message(e) });
    } finally {
      useWaybillStore.setState((s) => ({ saving: Math.max(0, s.saving - writes.length) }));
      flushing = null;
    }
  })();
  await flushing;
  if (again) {
    again = false;
    await flush();
  }
}

useDispatchStore.subscribe((s, prev) => {
  if (s.decisions === prev.decisions && s.shipments === prev.shipments) return;
  if (applying) return;
  generation++;
  if (!s.listBacked) return;
  unsaved = true;
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), 300);
});
