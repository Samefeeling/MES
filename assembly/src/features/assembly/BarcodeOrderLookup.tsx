/** Keyboard-wedge barcode lookup: scan a job number and open its order popup. */

import { useEffect, useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { useUiStore } from '@/store/uiStore';
import { createBarcodeBuffer } from './barcodeScanner';

export function findBarcodeJobId(raw: string, knownIds: Iterable<string>): string | null {
  const ids = new Map([...knownIds].map((id) => [id.toUpperCase(), id]));
  const clean = raw.trim().replace(/[\u0000-\u001f]/g, '');
  const tokens = [clean, ...clean.split(/[^A-Za-z0-9_-]+/)]
    .map((token) => token.replace(/^(JOB|JOBNUM|ORDER)[:=-]?/i, '').toUpperCase())
    .filter(Boolean);
  for (const token of tokens) {
    const found = ids.get(token);
    if (found) return found;
  }
  return null;
}

export function BarcodeOrderLookup({ board }: { board: AssemblyGanttView | null }) {
  const select = useUiStore((s) => s.select);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!board) return;
    const scanner = createBarcodeBuffer((raw) => {
      const jobId = findBarcodeJobId(raw, board.rowsByJob.keys());
      if (!jobId) {
        setProblem(`Order not found: ${raw}`);
        return;
      }
      // Use the same selection action as clicking an order on the board.
      select(jobId, { x: window.innerWidth / 2, y: 90 });
      setProblem(null);
    });
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof Element && (
        target.closest('input, textarea, select, [role="textbox"]') !== null ||
        (target instanceof HTMLElement && target.isContentEditable)
      );
      const blocked = editing || event.isComposing || event.repeat ||
        event.ctrlKey || event.altKey || event.metaKey ||
        document.documentElement.dataset.mesActive === 'false' || document.visibilityState !== 'visible' || !document.hasFocus();
      if (scanner.push(event.key, event.timeStamp, blocked)) {
        // The scanner's suffix must not activate a focused button or submit a form.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const reset = () => scanner.reset();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [board, select]);

  if (!board || !problem) return null;
  return (
    <span className="barcode-error" role="alert">
      {problem}{' '}
      <button onClick={() => setProblem(null)} aria-label="Dismiss barcode message">×</button>
    </span>
  );
}
