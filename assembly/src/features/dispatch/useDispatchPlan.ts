/**
 * The waybill and cubics sheet, parsed, and the plan built over them —
 * recomputed only when an export, the settings, the planner's decisions or
 * the day change.
 */

import { useMemo } from 'react';
import { parseWaybillCsv, type WaybillParseResult } from '@/data/csv/waybill.parser';
import { parseCubicsCsv, type CubicsParseResult } from '@/data/csv/cubics.parser';
import type { ShipmentOrder, WaybillLine } from '@/domain/dispatch';
import { cubicMaster, orderCube } from '@/engine/dispatch/cube';
import { planDispatch, type DispatchPlan } from '@/engine/dispatch/plan';
import { useDispatchStore } from '@/store/dispatchStore';
import { toDayKey } from '@/lib/time';

export interface DispatchModel {
  parsed: WaybillParseResult | null;
  cubics: CubicsParseResult | null;
  /** Orders with their cube from the cubics sheet attached. */
  orders: ShipmentOrder[];
  plan: DispatchPlan | null;
  ordersById: Map<string, ShipmentOrder>;
  linesByOrder: Map<string, WaybillLine[]>;
}

export function useDispatchPlan(): DispatchModel {
  const csvText = useDispatchStore((s) => s.csvText);
  const cubicsText = useDispatchStore((s) => s.cubicsText);
  const settings = useDispatchStore((s) => s.settings);
  const decisions = useDispatchStore((s) => s.decisions);
  const today = toDayKey(new Date());

  const parsed = useMemo(() => (csvText ? parseWaybillCsv(csvText) : null), [csvText]);
  const cubics = useMemo(() => (cubicsText ? parseCubicsCsv(cubicsText) : null), [cubicsText]);

  const indexes = useMemo(() => {
    const linesByOrder = new Map<string, WaybillLine[]>();
    for (const l of parsed?.lines ?? []) {
      const list = linesByOrder.get(l.order);
      if (list) list.push(l);
      else linesByOrder.set(l.order, [l]);
    }
    const master = cubics && !cubics.error && cubics.items.length > 0 ? cubicMaster(cubics.items) : null;
    const orders = (parsed?.orders ?? []).map((o) =>
      master ? { ...o, cube: orderCube(linesByOrder.get(o.id) ?? [], master) } : o,
    );
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    return { orders, ordersById, linesByOrder };
  }, [parsed, cubics]);

  const plan = useMemo(
    () =>
      parsed && !parsed.error
        ? planDispatch(indexes.orders, settings, decisions, today)
        : null,
    [parsed, indexes, settings, decisions, today],
  );

  return { parsed, cubics, plan, ...indexes };
}
