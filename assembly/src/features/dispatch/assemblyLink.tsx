/**
 * The factory, as Dispatch reads it: for each sales order, the jobs on the
 * board building it and when the board expects them off the line, and for its
 * stock and bought-in lines where their goods are coming from (`lineSupply`).
 * Provided once by the Dispatch page and read wherever an order is shown — a
 * load card, the booking sheet, the order's detail, the day's alerts.
 */

import { createContext, useContext, useMemo } from 'react';
import type { DayKey, WaybillLine } from '@/domain/dispatch';
import { orderKey } from '@/domain/orderLink';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import type { InventoryItem, PoLine } from '@/domain/types';
import {
  checkSupply,
  pegSupply,
  type LineSupply,
  type SupplyCheck,
  type SupplyPiece,
} from '@/engine/dispatch/lineSupply';
import {
  buildsByOrder,
  checkBuild,
  openLinesByOrder,
  type BuildCheck,
  type BuildJob,
  type OrderBuild,
  stockJobsOf,
} from '@/engine/dispatch/assemblyLink';
import { formatDay } from '@/lib/time';
import { shortDay } from './format';

export interface AssemblyLink {
  /** The Assembly board has loaded. */
  loaded: boolean;
  builds: ReadonlyMap<string, OrderBuild>;
  openLines: ReadonlyMap<string, ReadonlySet<string>>;
  /** Stock and bought-in lines short of goods, by order, and where the goods come from. */
  supply: ReadonlyMap<string, LineSupply[]>;
  /** Which of the two supply exports were read; supply says nothing without the on-hand one. */
  stockRead: { inventory: boolean; po: boolean };
  /** The day the supply was worked out on: stock is ready then. */
  today: DayKey;
}

const NONE: AssemblyLink = {
  loaded: false,
  builds: new Map(),
  openLines: new Map(),
  supply: new Map(),
  stockRead: { inventory: false, po: false },
  today: '',
};

/** What the board's data load read of the stock and the open POs. */
export interface StockInputs {
  inventory: readonly InventoryItem[];
  po: readonly PoLine[];
}

export const AssemblyLinkContext = createContext<AssemblyLink>(NONE);

export function useAssemblyLinkValue(
  view: AssemblyGanttView | null | undefined,
  linesByOrder: ReadonlyMap<string, readonly WaybillLine[]>,
  stock: StockInputs | null = null,
  today: DayKey = '',
): AssemblyLink {
  const builds = useMemo(() => (view ? buildsByOrder(view) : new Map<string, OrderBuild>()), [view]);
  const openLines = useMemo(
    () => openLinesByOrder([...linesByOrder.values()].flat().map((l) => ({ order: l.order, line: l.line }))),
    [linesByOrder],
  );
  const stockRead = useMemo(
    () => ({ inventory: (stock?.inventory.length ?? 0) > 0, po: (stock?.po.length ?? 0) > 0 }),
    [stock],
  );
  const supply = useMemo(
    () =>
      // Without the on-hand export every stock line would read "no supply"
      // when the shelf may be full: say nothing rather than that.
      stock && stockRead.inventory && today
        ? pegSupply({
            lines: [...linesByOrder.values()].flat(),
            inventory: stock.inventory,
            po: stock.po,
            stockJobs: view ? stockJobsOf(view) : [],
            today,
          })
        : new Map<string, LineSupply[]>(),
    [stock, stockRead, linesByOrder, view, today],
  );
  return useMemo(
    () => ({ loaded: Boolean(view), builds, openLines, supply, stockRead, today }),
    [view, builds, openLines, supply, stockRead, today],
  );
}

export const useAssemblyLink = (): AssemblyLink => useContext(AssemblyLinkContext);

/** The Assembly check for an order leaving on `day`, or null when nothing on the board builds it. */
export function buildCheckOf(link: AssemblyLink, orderId: string, day: DayKey): BuildCheck | null {
  const key = orderKey(orderId);
  return checkBuild(link.builds.get(key), day, link.openLines.get(key));
}

/** The supply check for an order leaving on `day`, or null when none of its lines is short. */
export function supplyCheckOf(link: AssemblyLink, orderId: string, day: DayKey): SupplyCheck | null {
  return checkSupply(link.supply.get(orderKey(orderId)), day);
}

export interface SupplyIssue {
  orderId: string;
  load: PlannedLoad;
  check: SupplyCheck;
}

/** Orders on these loads whose stock or bought-in goods are in late, or have no date. */
export function supplyIssues(link: AssemblyLink, loads: readonly PlannedLoad[]): SupplyIssue[] {
  const out: SupplyIssue[] = [];
  const seen = new Set<string>();
  for (const load of loads) {
    if (load.firm === 'dispatched') continue;
    for (const d of load.drops) {
      if (seen.has(d.orderId)) continue;
      const check = supplyCheckOf(link, d.orderId, load.day);
      if (!check || check.verdict === 'ok') continue;
      seen.add(d.orderId);
      out.push({ orderId: d.orderId, load, check });
    }
  }
  return out;
}

export interface BuildIssue {
  orderId: string;
  load: PlannedLoad;
  check: BuildCheck;
}

/** Orders on these loads Assembly will not have finished, or has no date for. */
export function buildIssues(link: AssemblyLink, loads: readonly PlannedLoad[]): BuildIssue[] {
  const out: BuildIssue[] = [];
  const seen = new Set<string>();
  for (const load of loads) {
    if (load.firm === 'dispatched') continue;
    for (const d of load.drops) {
      if (seen.has(d.orderId)) continue;
      const check = buildCheckOf(link, d.orderId, load.day);
      if (!check || check.verdict === 'ok' || check.verdict === 'done') continue;
      seen.add(d.orderId);
      out.push({ orderId: d.orderId, load, check });
    }
  }
  return out;
}

const STATE_LABEL: Record<BuildJob['state'], string> = {
  done: 'done',
  dated: 'expect',
  'no-crew': 'on a line, no crew',
  unplaced: 'on no line',
};

/** One line per job, for a tooltip. */
export const jobLines = (jobs: readonly BuildJob[]): string =>
  jobs
    .map(
      (j) =>
        `${j.jobId} · ${j.lineName ?? 'no line'} · ${j.remainingQty} to build · ` +
        (j.state === 'dated' && j.expect ? `expect ${formatDay(j.expect)}` : STATE_LABEL[j.state]),
    )
    .join('\n');

/** The check in words, for the booking CSV: `Expect 14/10/2026 (late)`. */
export function buildText(check: BuildCheck | null): string {
  if (!check) return '';
  switch (check.verdict) {
    case 'done':
      return 'Done';
    case 'unknown':
      return 'No date';
    default: {
      const [y, m, d] = check.finish!.split('-');
      const when = `${Number(d)}/${m}/${y}`;
      return check.verdict === 'ok' ? `Expect ${when}` : `Expect ${when} (${check.verdict === 'late' ? 'late' : 'same day'})`;
    }
  }
}

const VERDICT_TONE: Record<BuildCheck['verdict'], string> = {
  done: 'ok',
  ok: 'ok',
  'same-day': 'mid',
  late: 'bad',
  unknown: 'mid',
};

/** `Assy 14/10`, `Assy done`, `Assy ?` — coloured by whether it makes the load. */
export function BuildChip({ check }: { check: BuildCheck | null }) {
  if (!check) return null;
  const text =
    check.verdict === 'done'
      ? 'Assy done'
      : check.verdict === 'unknown'
        ? 'Assy no date'
        : `Assy ${shortDay(check.finish)}`;
  const why =
    check.verdict === 'late'
      ? 'Assembly finishes after this load leaves'
      : check.verdict === 'same-day'
        ? 'Assembly finishes the day this load leaves'
        : check.verdict === 'unknown'
          ? 'A job still to build has no Expect Date on the Assembly board (no crew, or on no line)'
          : check.verdict === 'done'
            ? 'Every Assembly job for it is finished'
            : 'Assembly finishes before this load leaves';
  return (
    <span className={`build-chip tone-${VERDICT_TONE[check.verdict]}`} title={`${why}\n${jobLines(check.jobs)}`}>
      {text}
    </span>
  );
}

/** One piece of supply in words: `5 from stock`, `4 on PO 4501 (Acme) 22/10`, `6 from ASM900 19/10`. */
export function pieceText(p: SupplyPiece): string {
  const when = p.date ? shortDay(p.date) : 'no date';
  if (p.source === 'stock') return `${p.qty} from stock`;
  if (p.source === 'po') return `${p.qty} on PO ${p.ref ?? '?'}${p.note ? ` (${p.note})` : ''} ${when}`;
  return `${p.qty} from job ${p.ref ?? '?'} ${when}`;
}

/** One line's supply in words, for a table cell or a tooltip. */
export function lineSupplyText(l: LineSupply): string {
  const parts = l.pieces.map(pieceText);
  if (l.uncoveredQty > 0) parts.push(`${l.uncoveredQty} with no stock, PO or job`);
  return parts.join(' · ');
}

const SUPPLY_TONE: Record<SupplyCheck['verdict'], string> = {
  ok: 'ok',
  'same-day': 'mid',
  late: 'bad',
  unknown: 'mid',
};

/**
 * `Goods 22/10`, `Goods in stock`, `Goods no date` — when the stock and
 * bought-in lines short of goods have them, coloured by whether that makes the
 * load. Absent when no line is short.
 */
export function SupplyChip({ check }: { check: SupplyCheck | null }) {
  const { today } = useAssemblyLink();
  if (!check) return null;
  const allStock = check.lines.every((l) => l.pieces.every((p) => p.source === 'stock'));
  const text =
    check.verdict === 'unknown'
      ? 'Goods no date'
      : allStock && check.readyBy === today
        ? 'Goods in stock'
        : `Goods ${shortDay(check.readyBy)}`;
  const why =
    check.verdict === 'late'
      ? 'Stock or bought-in goods arrive after this load leaves'
      : check.verdict === 'same-day'
        ? allStock
          ? 'In stock but not allocated: allocate and pick it today'
          : 'Stock or bought-in goods arrive the day this load leaves'
        : check.verdict === 'unknown'
          ? 'A line short of goods has no stock, open PO or stock job to cover it, or its PO has no date'
          : 'Stock and bought-in goods are in before this load leaves';
  const lines = check.lines.map((l) => `${l.line}/${l.rel} ${l.part} × ${l.shortQty}: ${lineSupplyText(l)}`).join('\n');
  return (
    <span className={`build-chip tone-${SUPPLY_TONE[check.verdict]}`} title={`${why}\n${lines}`}>
      {text}
    </span>
  );
}
