/**
 * The order's planned dispatch day, on the board: `SHIP 22/10` beside a job
 * built for a sales order, red when the job comes off the line after it, and
 * `LAST` when it is the one line the order is still waiting for.
 *
 * Read from the waybill as every screen reads it (`store/waybillStore`, filled
 * from the Waybill list by `features/dispatch/waybillSource`). With no waybill
 * the board shows nothing of it. Display only: nothing on the board moves for
 * it. See `engine/dispatch/shipBy`.
 */

import { createContext, useContext, useMemo } from 'react';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { buildsByOrder, stockJobsOf } from '@/engine/dispatch/assemblyLink';
import { pegSupply, type LineSupply } from '@/engine/dispatch/lineSupply';
import { shipByJob, type ShipInfo } from '@/engine/dispatch/shipBy';
import { formatDay, formatShortDay, fromDayKey, toDayKey } from '@/lib/time';
import { useDataStore } from '@/store/dataStore';
import { useWaybillStore } from '@/store/waybillStore';

const NONE: ReadonlyMap<string, ShipInfo> = new Map();

export const ShipByContext = createContext<ReadonlyMap<string, ShipInfo>>(NONE);

/** Ship By for every job on the plan built for a line still on the waybill. */
export function useShipByValue(plan: AssemblyGanttView | null): ReadonlyMap<string, ShipInfo> {
  const csvText = useWaybillStore((s) => s.csvText);
  const dataset = useDataStore((s) => s.dataset);
  const parsed = useMemo(() => (csvText ? parseWaybillCsv(csvText) : null), [csvText]);
  const today = toDayKey(new Date());
  return useMemo(() => {
    if (!plan || !parsed || parsed.error) return NONE;
    const supply =
      dataset && dataset.inventory.length > 0
        ? pegSupply({
            lines: parsed.lines,
            inventory: dataset.inventory,
            po: dataset.po,
            stockJobs: stockJobsOf(plan),
            today,
          })
        : new Map<string, LineSupply[]>();
    return shipByJob(parsed.lines, buildsByOrder(plan), supply, today);
  }, [plan, parsed, dataset, today]);
}

const dayText = (day: string): string => formatDay(fromDayKey(day));

function title(info: ShipInfo, jobNum: string): string {
  const head =
    `Order ${info.order} line ${info.line}/${info.rel} — Ship By ${dayText(info.shipBy)}, the planned dispatch day` +
    (info.needBy ? `; customer Need By ${dayText(info.needBy)}` : '') +
    ` (${info.zone}).`;
  const own =
    info.verdict === 'done'
      ? `${jobNum} is finished.`
      : info.verdict === 'unknown'
        ? `${jobNum} has no Expect Date yet, so nothing says it makes the truck.`
        : info.verdict === 'late'
          ? `${jobNum} comes off the line ${dayText(info.expect!)} — after the truck. The order misses its dispatch unless this comes forward.`
          : info.verdict === 'same-day'
            ? `${jobNum} comes off the line ${dayText(info.expect!)}, the day it ships: tight.`
            : `${jobNum} comes off the line ${dayText(info.expect!)}, before it ships.`;
  const rest =
    info.others === 0
      ? 'It is the only goods line on the order.'
      : `${info.othersByShip} of the order's ${info.others} other line${info.others === 1 ? '' : 's'} ready by Ship By` +
        (info.othersUnknown > 0 ? `, ${info.othersUnknown} with no date` : '') +
        (info.othersLatest ? `; the last of them ${dayText(info.othersLatest)}` : '') +
        '.' +
        (info.holds ? ' This job is the last line the order is waiting for.' : '');
  return `${head}\n${own}\n${rest}`;
}

/** `SHIP 22/10`, and `LAST` when the order waits on this job alone. */
export function ShipTag({ jobNum }: { jobNum: string }) {
  const info = useContext(ShipByContext).get(jobNum);
  if (!info) return null;
  const tone = info.verdict === 'late' ? 'late' : info.verdict === 'same-day' || info.verdict === 'unknown' ? 'tight' : 'ok';
  const text = title(info, jobNum);
  return (
    <>
      <span className={`order-tag ship ${tone}`} title={text}>
        SHIP {formatShortDay(fromDayKey(info.shipBy))}
      </span>
      {info.holds && info.verdict !== 'done' && (
        <span className={`order-tag holds ${tone}`} title={text}>
          LAST
        </span>
      )}
    </>
  );
}
