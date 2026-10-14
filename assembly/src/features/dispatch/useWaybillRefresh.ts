/**
 * Fetch the configured waybill export whenever the board reads its own
 * exports, so every screen has it — not only the browser somebody loaded the
 * file into.
 *
 * The board needs it for each job's Ship By (`features/assembly/shipBy`), on
 * screens where nobody ever opens Dispatch. Only when a source is configured
 * (`VITE_WAYBILL_CSV_URL` / `_PATH`); without one, the waybill is the one
 * loaded by hand on the Dispatch page, in this browser. A fetch that fails, or
 * returns something that is not a waybill, keeps the one already held.
 */

import { useEffect } from 'react';
import { fetchWaybillCsv, hasWaybillSource, readCsvConfigFromEnv } from '@/data/csv/csv.client';
import { readConfigFromEnv } from '@/data/sharepoint/site';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import { useDispatchStore } from '@/store/dispatchStore';

export function useWaybillRefresh(readAt: Date | null | undefined): void {
  const stamp = readAt?.getTime() ?? null;
  useEffect(() => {
    if (stamp === null) return;
    const csv = readCsvConfigFromEnv();
    const sp = readConfigFromEnv();
    if (!hasWaybillSource(csv, sp)) return;
    let live = true;
    void fetchWaybillCsv(csv, sp).then((res) => {
      if (!live || !res.ok || !res.value) return;
      const parsed = parseWaybillCsv(res.value);
      if (parsed.error || parsed.orders.length === 0) return;
      const name = csv.waybillUrl || csv.waybillFilePath || 'Waybill';
      // The same file again is not a new load.
      if (useDispatchStore.getState().csvText === res.value) return;
      useDispatchStore.getState().loadWaybill(res.value, name.slice(name.lastIndexOf('/') + 1));
    });
    return () => {
      live = false;
    };
  }, [stamp]);
}
