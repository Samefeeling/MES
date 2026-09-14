/**
 * Keeps the `ASSY_Production` SharePoint list in step with the board.
 *
 * It runs on three triggers, because three different things change:
 *
 *  - the supervisor allocates crew or drags a bar to a new start day;
 *  - the shift books its output in the inspector — Shift Output, Complete,
 *    Reject, Rework, Job Completed, pause and notes;
 *  - a fresh `Planning1.csv` arrives, every five minutes. That is where Due
 *    Date and remaining quantity come back into the list.
 *
 * All three funnel into the same diffing sync, so the last is cheap when
 * nothing actually moved. Writes are debounced: nobody wants a Graph round trip
 * per keystroke of a drag.
 *
 * Writing is **opt-in**: nothing leaves the browser unless `VITE_PRODUCTION_LIST`
 * names a list and Graph is configured. The mock demo never writes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { readConfigFromEnv } from '@/data/excel/sharepoint.client';
import {
  PRODUCTION_LIST,
  orderFactsFromBoard,
  syncProduction,
  type SyncOutcome,
} from '@/data/sharepoint/production.sync';
import { usePlanStore } from '@/store/planStore';

/** Wait this long after the last board change before writing. */
const DEBOUNCE_MS = 1200;
const RETRY_MS = [5_000, 15_000, 60_000] as const;

export interface PlanSyncState {
  /** False when the list is not configured — the board is then read-only. */
  enabled: boolean;
  list: string;
  busy: boolean;
  lastSyncedAt: Date | null;
  last: SyncOutcome | null;
  /** Errors from the most recent attempt, for the banner. */
  errors: string[];
}

export function usePlanSync(board: AssemblyGanttView | null): PlanSyncState {
  const list = (import.meta.env.VITE_PRODUCTION_LIST ?? (import.meta.env.VITE_BACKEND === 'sharepoint' ? 'ASSY_Production' : '')).trim();
  const cfg = readConfigFromEnv();
  const enabled = Boolean(list && cfg.siteUrl && (cfg.token || cfg.authMode === 'session'));
  const production = usePlanStore((s) => s.production);

  const [state, setState] = useState<Omit<PlanSyncState, 'enabled' | 'list'>>({
    busy: false,
    lastSyncedAt: null,
    last: null,
    errors: [],
  });

  const timer = useRef<number | undefined>(undefined);
  const retryTimer = useRef<number | undefined>(undefined);
  const retryAttempt = useRef(0);
  /** Guards against a second sync starting while one is still in flight. */
  const running = useRef(false);
  /** Set when a change arrives mid-flight, so nothing is silently dropped. */
  const stale = useRef(false);

  // What the list should say, serialised. The string is the effect's
  // dependency, so a re-render that changes nothing costs no Graph call; the
  // effect parses it back rather than closing over the array, which keeps the
  // written rows and the fingerprint that triggered them in step.
  //
  // Built only when the board or the bookings move. App watches ten slices of
  // the plan, so it re-renders often, and walking every row of every line to
  // serialise it was being paid for each time.
  const fingerprint = useMemo(
    () => (board ? JSON.stringify(orderFactsFromBoard(board, production)) : ''),
    [board, production],
  );

  useEffect(() => {
    if (!enabled || !fingerprint) return;

    const run = async () => {
      if (running.current) {
        stale.current = true;
        return;
      }
      running.current = true;
      setState((s) => ({ ...s, busy: true }));

      let outcome: SyncOutcome;
      try {
        outcome = await syncProduction(cfg, list, JSON.parse(fingerprint));
      } catch (error) {
        // An exception out of the sync itself never reached an answer, so it
        // reads like the transport failures the sync reports for itself.
        outcome = {
          created: 0,
          updated: 0,
          unchanged: 0,
          errors: [error instanceof Error ? error.message : String(error)],
          retryable: true,
        };
      }

      running.current = false;
      setState({
        busy: false,
        lastSyncedAt: new Date(),
        last: outcome,
        errors: outcome.errors,
      });

      if (stale.current) {
        stale.current = false;
        retryAttempt.current = 0;
        void run();
      } else if (outcome.retryable) {
        // Only what Graph might answer differently next time. This used to
        // match the error text, and every message here contains the word
        // "fetch", so a bad token was retried every minute until the tab was
        // closed — and the banner never stopped saying so.
        const at = Math.min(retryAttempt.current, RETRY_MS.length - 1);
        retryAttempt.current += 1;
        window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => void run(), RETRY_MS[at]);
      } else {
        retryAttempt.current = 0;
      }
    };

    window.clearTimeout(timer.current);
    window.clearTimeout(retryTimer.current);
    retryAttempt.current = 0;
    timer.current = window.setTimeout(() => void run(), DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(retryTimer.current);
    };
    // `cfg` is read from import.meta.env and is stable for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, list, fingerprint]);

  return { enabled, list: list || PRODUCTION_LIST, ...state };
}
