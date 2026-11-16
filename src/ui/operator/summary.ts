// Operator sheet — the day / week / month summary view.
import type { ProductionRecord } from '../../types';
import { dalRef, S } from './state';
import { cavityGross } from '../../core/metrics';
import { escapeHtml } from '../modal';
import { VIEW_LEVELS } from './sheet';
import { renderOutputRejectChart } from '../charts';
import { buildShiftId, dateKey } from '../../core/shifts';
import { render } from './render';

interface SummaryBucket {
  label: string;
  shiftId: string;
  goCs: number;
  goCe: number;
  /** Gross PIECES = Σ (Count End − Count Start) × cavities, so the
   *  "Output (gross)" column matches Good once a 2-cavity die is in play
   *  (goCe − goCs alone would under-count by half). */
  grossPieces: number;
  good: number;
  rej: number;
  downHrs: number; // B + M slots × 0.5
  setupHrs: number; // C + D + I + P + S slots × 0.5
}

async function loadProdRange(from: Date, to: Date): Promise<ProductionRecord[]> {
  // Lex-from prefix is enough for date-only filtering (IDs start with YYYY-MM-DD).
  const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toKey = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}￿`;
  return dalRef.listProduction({
    machineCode: S!.mc,
    shiftIdFrom: fromKey,
    shiftIdTo: toKey,
  });
}

function rollup(label: string, shiftId: string, rows: ProductionRecord[]): SummaryBucket {
  let good = 0;
  let rej = 0;
  let goCs = 0;
  let goCe = 0;
  let grossPieces = 0;
  let down = 0;
  let setup = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    // Down / setup slot counts ignore SlotIndex grouping — each filled slot
    // contributes 30 min.
    if (r.statusCode === 'B' || r.statusCode === 'M') down++;
    else if (
      r.statusCode === 'C' ||
      r.statusCode === 'D' ||
      r.statusCode === 'I' ||
      r.statusCode === 'P' ||
      r.statusCode === 'S'
    )
      setup++;
    if (r.slotIndex !== 0) continue;
    const key = `${r.jobNumber}|${r.shiftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = Number(r.countStart ?? 0);
    const ce = Number(r.countEnd ?? 0);
    const gross = cavityGross(r.countStart, r.countEnd, r.cavities);
    let jobRej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      jobRej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      jobRej = Number(r.rejectCount) || 0;
    }
    goCs += cs;
    goCe += ce;
    grossPieces += gross;
    rej += jobRej;
    good += Math.max(0, gross - jobRej);
  }
  return {
    label,
    shiftId,
    goCs,
    goCe,
    grossPieces,
    good,
    rej,
    downHrs: down * 0.5,
    setupHrs: setup * 0.5,
  };
}

let summaryCache: { level: number; buckets: SummaryBucket[] } | null = null;

/** The summary is worked out again the next time it is drawn. */
export function dropSummaryCache(): void {
  summaryCache = null;
}

export function buildSummary(): string {
  const lvl = S!.viewLevel;
  // Kick off async fetch; render placeholder, then replace on resolve.
  if (!summaryCache || summaryCache.level !== lvl) {
    void rebuildSummary();
    return `<div class="summary-loading">Loading ${escapeHtml(
      VIEW_LEVELS[lvl - 1]?.label ?? '',
    )} summary…</div>`;
  }
  const rows = summaryCache.buckets
    .map(
      (b) =>
        `<tr data-jump-shift="${escapeHtml(b.shiftId)}">
          <th>${escapeHtml(b.label)}</th>
          <td class="num">${b.good}</td>
          <td class="num r">${b.rej}</td>
          <td class="num">${b.grossPieces}</td>
          <td class="num">${b.downHrs.toFixed(1)}h</td>
          <td class="num">${b.setupHrs.toFixed(1)}h</td>
        </tr>`,
    )
    .join('');
  const title = VIEW_LEVELS[lvl - 1]?.label ?? '';
  const chart = renderOutputRejectChart(
    summaryCache.buckets.map((b) => ({
      label: b.label.split(' — ')[0],
      good: b.good,
      reject: b.rej,
    })),
  );
  return `<div class="summary-wrap">
    <h3 class="summary-title">${escapeHtml(title)} — ${escapeHtml(S!.mc)}</h3>
    <p class="bd-sub">Read-only roll-up · tap a row to drill into that shift.</p>
    <div class="summary-chart">${chart}</div>
    <table class="summary-table">
      <thead><tr>
        <th>Bucket</th><th>Good</th><th>Reject</th><th>Output (gross)</th><th>Down</th><th>Setup</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No data</td></tr>'}</tbody>
    </table>
  </div>`;
}

async function rebuildSummary(): Promise<void> {
  const lvl = S!.viewLevel;
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const buckets: SummaryBucket[] = [];
  if (lvl === 2) {
    // Today × 3 shifts. Night actually starts at 23:00 today (its shiftId
    // date is today), so we pull a 24h window starting at today 00:00.
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const rows = await loadProdRange(today, tomorrow);
    for (const code of ['Day', 'Afternoon', 'Night'] as const) {
      const sid = buildShiftId(today, code);
      buckets.push(
        rollup(`${code} — ${sid.slice(0, 10)}`, sid, rows.filter((r) => r.shiftId === sid)),
      );
    }
  } else {
    const days = lvl === 3 ? 7 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    const rows = await loadProdRange(from, today);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const datePart = dateKey(d);
      const dayRows = rows.filter((r) => r.shiftId.startsWith(`${datePart}-`));
      const label = d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      // shiftId target for click-through: jump to Day shift of that date.
      buckets.push(rollup(label, `${datePart}-Day`, dayRows));
    }
  }
  summaryCache = { level: lvl, buckets };
  render();
}
