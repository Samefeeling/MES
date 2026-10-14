/**
 * Where the waybill on this page came from, when, and what the last sync did —
 * in place of the buttons that once loaded it from disk. There is nothing to
 * load by hand: the Waybill list is kept up to date from Waybill.csv by every
 * supervisor's screen, and every screen reads it (`waybillSource`).
 *
 * **Refresh** syncs and reads again now, instead of at the board's next
 * refresh.
 */

import { useState } from 'react';
import { formatTime } from '@/lib/time';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useWaybillStore } from '@/store/waybillStore';
import { closeHeld, refreshWaybill } from './waybillSource';

const at = (iso: string | null): string => (iso ? formatTime(new Date(iso)) : '—');

export function WaybillStatus({ cubicsParts }: { cubicsParts: number | null }) {
  const source = useWaybillStore((s) => s.source);
  const readAt = useWaybillStore((s) => s.readAt);
  const loading = useWaybillStore((s) => s.loading);
  const lastSync = useWaybillStore((s) => s.lastSync);
  const saving = useWaybillStore((s) => s.saving);
  const cubicsSource = useWaybillStore((s) => s.cubicsSource);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const [closing, setClosing] = useState(false);

  const synced = lastSync
    ? `synced ${at(lastSync.at)}: ${lastSync.created} new, ${lastSync.updated} changed, ${lastSync.closed} closed` +
      (lastSync.errors.length > 0 ? `, ${lastSync.errors.length} not written` : '')
    : null;

  return (
    <div className="waybill-loader">
      <span className="dispatch-source">
        {source ? (
          <span title={lastSync?.errors[0] ?? 'Where the waybill on this page was read from'}>
            Waybill <b>{source}</b> · read {at(readAt)}
            {synced && ` · ${synced}`}
            {saving > 0 && ` · saving ${saving}…`}
          </span>
        ) : (
          <span>No waybill</span>
        )}
        {cubicsSource && cubicsParts !== null && (
          <span title="The product cube master orders are sized from">
            Cubics <b>{cubicsSource}</b> · {cubicsParts} parts
          </span>
        )}
      </span>
      {lastSync && lastSync.heldCloses > 0 && (
        <button
          type="button"
          className="kpi-btn"
          disabled={closing}
          title="Waybill.csv lists far fewer releases than the list has open, which looks like a partial export, so none were closed. Close them if the export is complete."
          onClick={() => {
            setClosing(true);
            void closeHeld().finally(() => setClosing(false));
          }}
        >
          Close {lastSync.heldCloses} gone from the export
        </button>
      )}
      <button
        type="button"
        className="kpi-btn primary"
        disabled={loading}
        onClick={() => void refreshWaybill({ sync: unlocked })}
        title="Bring the Waybill list into line with Waybill.csv, and read it again"
      >
        {loading ? 'Reading…' : 'Refresh'}
      </button>
    </div>
  );
}
