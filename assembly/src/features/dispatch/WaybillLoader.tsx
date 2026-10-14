/**
 * Load the two dispatch inputs: the waybill (what is to ship) and the cubics
 * sheet (how much room each product takes). From disk, which always works,
 * or the waybill from its configured export location when one is set
 * (`VITE_WAYBILL_CSV_URL` / `_PATH`).
 *
 * Which file is which is read from its header row, so either button takes
 * either file and says so when they differ. A file that is neither is
 * refused before it replaces anything, so a wrong pick never empties the plan.
 */

import { useRef, useState } from 'react';
import { fetchWaybillCsv, hasWaybillSource, readCsvConfigFromEnv } from '@/data/csv/csv.client';
import { readConfigFromEnv } from '@/data/sharepoint/site';
import { parseWaybillCsv } from '@/data/csv/waybill.parser';
import { looksLikeCubics, parseCubicsCsv } from '@/data/csv/cubics.parser';
import { useDispatchStore } from '@/store/dispatchStore';

type Kind = 'waybill' | 'cubics';

export function WaybillLoader() {
  const loadWaybill = useDispatchStore((s) => s.loadWaybill);
  const loadCubics = useDispatchStore((s) => s.loadCubics);
  const input = useRef<HTMLInputElement>(null);
  const [want, setWant] = useState<Kind>('waybill');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const csvCfg = readCsvConfigFromEnv();
  const spCfg = readConfigFromEnv();
  const canRefresh = hasWaybillSource(csvCfg, spCfg);

  const accept = (text: string, name: string, asked: Kind) => {
    if (looksLikeCubics(text)) {
      const result = parseCubicsCsv(text);
      if (result.error || result.items.length === 0) {
        setProblem(`${name}: ${result.error ?? 'no product rows with a code'}`);
        return;
      }
      setProblem(asked === 'cubics' ? null : `${name} is the cubics sheet — loaded as that.`);
      loadCubics(text, name);
      return;
    }
    const result = parseWaybillCsv(text);
    if (result.error) {
      setProblem(`${name}: ${result.error}`);
      return;
    }
    if (result.orders.length === 0) {
      setProblem(`${name}: no order lines`);
      return;
    }
    setProblem(asked === 'waybill' ? null : `${name} is a waybill — loaded as that.`);
    loadWaybill(text, name);
  };

  const pick = (kind: Kind) => {
    setWant(kind);
    input.current?.click();
  };

  const onPick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      accept(await file.text(), file.name, want);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const onRefresh = async () => {
    setBusy(true);
    try {
      const res = await fetchWaybillCsv(csvCfg, spCfg);
      if (!res.ok) setProblem(res.error);
      else if (res.value) accept(res.value, csvCfg.waybillUrl || csvCfg.waybillFilePath || 'Waybill', 'waybill');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="waybill-loader">
      <input
        ref={input}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        hidden
        onChange={(e) => void onPick(e.target.files)}
      />
      <button
        type="button"
        className="kpi-btn primary"
        disabled={busy}
        onClick={() => pick('waybill')}
        title="Pick the waybill CSV export from disk"
      >
        {busy && want === 'waybill' ? 'Loading…' : 'Load waybill'}
      </button>
      <button
        type="button"
        className="kpi-btn"
        disabled={busy}
        onClick={() => pick('cubics')}
        title="Pick the cubics sheet (Drews Cubics and Freight Calc, saved as CSV)"
      >
        {busy && want === 'cubics' ? 'Loading…' : 'Load cubics'}
      </button>
      {canRefresh && (
        <button
          type="button"
          className="kpi-btn"
          disabled={busy}
          onClick={() => void onRefresh()}
          title="Fetch the configured waybill export"
        >
          Refresh
        </button>
      )}
      {problem && <span className="dispatch-problem">{problem}</span>}
    </div>
  );
}
