/**
 * The Assembly board, as Dispatch reads it: for each sales order, the jobs
 * building it and when the board expects them off the line. Provided once by
 * the Dispatch page and read wherever an order is shown — a load card, the
 * booking sheet, the order's detail, the day's alerts.
 */

import { createContext, useContext, useMemo } from 'react';
import type { DayKey, WaybillLine } from '@/domain/dispatch';
import { orderKey } from '@/domain/orderLink';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import type { PlannedLoad } from '@/engine/dispatch/plan';
import {
  buildsByOrder,
  checkBuild,
  openLinesByOrder,
  type BuildCheck,
  type BuildJob,
  type OrderBuild,
} from '@/engine/dispatch/assemblyLink';
import { formatDay } from '@/lib/time';
import { shortDay } from './format';

export interface AssemblyLink {
  /** The Assembly board has loaded. */
  loaded: boolean;
  builds: ReadonlyMap<string, OrderBuild>;
  openLines: ReadonlyMap<string, ReadonlySet<string>>;
}

const NONE: AssemblyLink = { loaded: false, builds: new Map(), openLines: new Map() };

export const AssemblyLinkContext = createContext<AssemblyLink>(NONE);

export function useAssemblyLinkValue(
  view: AssemblyGanttView | null | undefined,
  linesByOrder: ReadonlyMap<string, readonly WaybillLine[]>,
): AssemblyLink {
  const builds = useMemo(() => (view ? buildsByOrder(view) : new Map<string, OrderBuild>()), [view]);
  const openLines = useMemo(
    () => openLinesByOrder([...linesByOrder.values()].flat().map((l) => ({ order: l.order, line: l.line }))),
    [linesByOrder],
  );
  return useMemo(() => ({ loaded: Boolean(view), builds, openLines }), [view, builds, openLines]);
}

export const useAssemblyLink = (): AssemblyLink => useContext(AssemblyLinkContext);

/** The Assembly check for an order leaving on `day`, or null when nothing on the board builds it. */
export function buildCheckOf(link: AssemblyLink, orderId: string, day: DayKey): BuildCheck | null {
  const key = orderKey(orderId);
  return checkBuild(link.builds.get(key), day, link.openLines.get(key));
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
