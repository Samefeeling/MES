/**
 * Load the Epicor exports from disk.
 *
 * The scheduled path is SharePoint → Graph, but that needs a token the planner
 * does not have in a browser tab. Picking the files by hand runs exactly the
 * same parsers, so an export can be checked against the board before any auth
 * is wired up.
 *
 * Separate buttons, because the three files answer different questions and are
 * checked separately: `Planning1.csv` is what to build, `JobMaterialReq.csv`
 * is what each order consumes — and therefore which order has to finish before
 * which. Either can still be dropped into the other picker; which is which is
 * decided by the header row rather than the file name, because an export saved
 * from Excel rarely keeps the name the BAQ gave it. Picking the wrong one says
 * so instead of quietly loading it as the other.
 */

import { useRef, useState } from 'react';
import { useDataStore } from '@/store/dataStore';
import { useUiStore } from '@/store/uiStore';
import {
  setManualCsv,
  setManualJobMaterialCsv,
  setManualOnHandInventoryCsv,
} from '@/data/csv/csv.client';
import { PlanningCsvSource } from '@/data/csv/PlanningCsvSource';
import { normalizeHeader, parseCsv } from '@/lib/csv';
import { Button } from '@/ui';

/**
 * A material-link export names the job on the `JobMtl` table; the order export
 * never does. That one header is enough to tell them apart.
 */
function exportKind(text: string): Kind {
  const header = parseCsv(text.slice(0, 4096))[0] ?? [];
  const names = new Set(header.map(normalizeHeader));
  if (names.has('partnum') && names.has('onhand')) return 'inventory';
  if (
    names.has('jobmtljobnum') ||
    names.has('jobmtlpartnum') ||
    (names.has('mtlpartnum') && names.has('jobnum'))
  ) return 'links';
  return 'orders';
}

type Kind = 'orders' | 'links' | 'inventory';

const KIND_LABEL: Record<Kind, string> = {
  orders: 'order',
  links: 'material',
  inventory: 'on-hand inventory',
};

export function CsvLoader() {
  const setSource = useDataStore((s) => s.setSource);
  const load = useDataStore((s) => s.load);
  const setLastRefresh = useUiStore((s) => s.setLastRefresh);
  const orders = useRef<HTMLInputElement>(null);
  const links = useRef<HTMLInputElement>(null);
  const inventory = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onPick = async (files: FileList | null, want: Kind) => {
    if (!files || files.length === 0) return;
    setBusy(want);
    setProblem(null);
    try {
      let read = 0;
      for (const file of Array.from(files)) {
        const text = await file.text();
        const kind = exportKind(text);
        // Both pickers take either file, but say so when they differ — a
        // silent swap is how you end up sure you loaded something you did not.
        if (kind !== want) {
          setProblem(
            `${file.name} looks like the ${KIND_LABEL[kind]} export, not the ` +
              `${KIND_LABEL[want]} ` +
              'one — loaded as what it is.',
          );
        }
        if (kind === 'links') setManualJobMaterialCsv(text);
        else if (kind === 'inventory') setManualOnHandInventoryCsv(text);
        else setManualCsv(text);
        read++;
      }
      if (read === 0) return;
      setSource(new PlanningCsvSource());
      await load();
      setLastRefresh(new Date());
    } finally {
      setBusy(null);
      // Allow re-picking the same file.
      if (orders.current) orders.current.value = '';
      if (links.current) links.current.value = '';
      if (inventory.current) inventory.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={orders}
        type="file"
        accept=".csv,text/csv"
        multiple
        hidden
        onChange={(e) => void onPick(e.target.files, 'orders')}
      />
      <input
        ref={links}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => void onPick(e.target.files, 'links')}
      />
      <input
        ref={inventory}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => void onPick(e.target.files, 'inventory')}
      />
      <Button
        onClick={() => orders.current?.click()}
        disabled={busy !== null}
        title="Parse Planning1.csv — the orders, their hours and their dates"
      >
        {busy === 'orders' ? 'Loading…' : 'Load orders'}
      </Button>
      <Button
        onClick={() => links.current?.click()}
        disabled={busy !== null}
        title={
          'Parse JobMaterialReq.csv — what each order consumes, which is ' +
          'what tells the board that one order has to finish before another'
        }
      >
        {busy === 'links' ? 'Loading…' : 'Load JobMaterialReq'}
      </Button>
      <Button
        onClick={() => inventory.current?.click()}
        disabled={busy !== null}
        title="Parse OnHandInventory.csv — Calculated_OnHand by Part_PartNum"
      >
        {busy === 'inventory' ? 'Loading…' : 'Load OnHandInventory'}
      </Button>
      {problem && (
        <span className="board-warn" title={problem}>
          Check the file
        </span>
      )}
    </>
  );
}
