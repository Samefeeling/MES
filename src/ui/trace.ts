import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord } from '../types';
import { STATUS_MAP } from '../core/status';
import {
  SHIFTS,
  SLOTS_PER_SHIFT,
  currentShift,
  currentSlotIndex,
  shiftBounds,
  slotClock,
} from '../core/shifts';
import { bdLabelFor, breakdownDetailFor } from '../core/breakdown';
import { cavityGross } from '../core/metrics';
import { ordersCoRun, type DieCoRun } from '../core/corun';
import {
  expectedScheduledPiecesForOrder,
  plannedOrdersForShift,
  scheduleSegmentsForShift,
} from '../core/schedule';
import { loadKpiThresholds, planColourClass } from '../core/kpi-thresholds';
import {
  hoursUnavailableFor,
  jobLeftPiecesFor,
  qcCellPresentation,
  shiftTargetFor,
} from './operator';
import { escapeHtml } from './modal';

export type TracePanelView = 'live' | 'search';

interface TraceState {
  view: TracePanelView;
  query: { jobNumber: string; dateFrom: string; dateTo: string; machine: string };
  machines: Machine[];
  /** Search results (populated when view === 'search'). */
  results: TraceRow[];
  /** Per-machine live snapshot (populated when view === 'live'). One row
   *  per machine — covers the live shift even if nothing has been logged
   *  yet (Idle card). */
  liveRows: TraceRow[];
  searched: boolean;
  loading: boolean;
  /** Wall-clock of the last successful live pull — shown on the Live
   *  Status summary strip so a stalled poll is visible at a glance. */
  lastUpdated: Date | null;
  /** Read failures for the active live/search request. Existing successful
   *  cards stay on screen, with this warning instead of being replaced by
   *  fake Idle / no-results states. */
  errors: string[];
}

export interface TraceRow {
  key: string; // machineCode|shiftId|jobNumber
  machineCode: string;
  shiftId: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  operator: string;
  supervisor: string;
  timeline: string; // 16-char status string with '·' for empty
  countStart: number | null;
  countEnd: number | null;
  good: number;
  reject: number;
  /** Total order quantity (Epicor JobHead_ProdQty). null for die-change
   *  pseudo-orders or jobs with no planning row. */
  orderQty: number | null;
  /** Pieces still to make for the whole job = remaining qty − Σ Good
   *  across every (machine, shift) tuple of this job. null when unknown. */
  jobLeft: number | null;
  /** Pieces to aim for this shift (full 8 h run at cycle time, or the
   *  remainder if the job finishes sooner). null when no cycle-time. */
  shiftTarget: number | null;
  /** Per-slot QC sign-off name, slot index → person's full name (empty
   *  when not yet signed). 16 entries, mirrors the operator sheet's
   *  Quality Checks row so management sees the same per-slot status. */
  qcBySlot: string[];
  rejects: ProductionRecord[];
  bdSlots: { slot: number; code: string; ticket: string; note: string }[];
  records: ProductionRecord[];
  /** Planning.csv rows for this machine that overlap the live shift. */
  schedule?: PlanningOrder[];
  /** Current-shift actual Good by scheduled Job#, used to colour each
   *  Schedule bar against the same vs Plan thresholds as KPI. */
  scheduleGoodByJob?: Record<string, number>;
  /** True when this row is just a placeholder for an idle machine on
   *  the live view — render the card with a muted "Idle" badge. */
  idle?: boolean;
  /** True when this row is part of a co-run group (≥2 orders sharing a
   *  die, both CoRun=Yes, running on the press at the same time). The
   *  Live board shows every co-runner as its own card with a badge, not
   *  just the single "latest" job. */
  coRun?: boolean;
}

/**
 * Live Status renders one card per press in the floor's physical
 * order (the layout the supervisor walks past), used as a tie-break
 * after the "active first" sort. Anything not in this list is
 * appended in whatever order listMachines returned, so a new press
 * automatically shows up at the end instead of being silently
 * dropped.
 */
const FLOOR_ORDER: string[] = [
  '1600T',
  '1300T',
  'Batt1',
  'Batt2',
  '850C',
  '550C',
  '320C',
  '125T',
  'HS',
];

function floorIndex(code: string): number {
  const i = FLOOR_ORDER.indexOf(code);
  return i === -1 ? FLOOR_ORDER.length : i;
}

type Activity = 'running' | 'changeover' | 'breakdown' | 'idle';

const ACTIVITY_COLOURS: Record<Activity, string> = {
  running: '#16a34a',   // green — R
  changeover: '#f97316', // orange — D / C / I
  breakdown: '#dc2626',  // red — B
  idle: '#94a3b8',       // slate — nothing logged or M/O/P/S
};

const ACTIVITY_LABELS: Record<Activity, string> = {
  running: 'Running',
  changeover: 'Changeover',
  breakdown: 'Breakdown',
  idle: 'Idle',
};

/**
 * Pick the status code that represents what the press is doing **right
 * now** on this row. Prefer the slot covering the live wall clock; if
 * that slot is blank or the row isn't the live shift, fall back to the
 * last filled slot in the timeline. The four-bucket mapping lives in
 * activityFor below.
 */
function currentTimelineCode(timeline: string, shiftId: string): string {
  const live = currentShift(new Date());
  if (shiftId === live.shiftId) {
    const idx = currentSlotIndex(shiftId, new Date());
    if (idx != null) {
      const ch = timeline[idx];
      if (ch && ch !== '·') return ch;
    }
  }
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ch = timeline[i];
    if (ch && ch !== '·') return ch;
  }
  return '';
}

/** Index of the last filled (non-'·') slot in a 16-char timeline, or
 *  -1 when the row has logged nothing yet. Proxy for "how recently did
 *  this job have activity" when collapsing a machine's several jobs to
 *  one Live Status card. */
function lastFilledSlot(timeline: string): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ch = timeline[i];
    if (ch && ch !== '·') return i;
  }
  return -1;
}

/**
 * Pick the single most-current TraceRow for a machine from its per-job
 * rows. The row whose timeline reaches furthest along the shift is the
 * one the press is running now (or ran most recently); ties break on
 * the higher count (more pieces = the substantive job, not a stray
 * mis-tap). Used by the Live Status board to show one card per press.
 */
function latestRow(rows: TraceRow[]): TraceRow {
  return rows.reduce((best, r) => {
    const bSlot = lastFilledSlot(best.timeline);
    const rSlot = lastFilledSlot(r.timeline);
    if (rSlot !== bSlot) return rSlot > bSlot ? r : best;
    return (r.countEnd ?? 0) > (best.countEnd ?? 0) ? r : best;
  });
}

function activityFor(r: TraceRow): Activity {
  if (r.idle) return 'idle';
  const code = currentTimelineCode(r.timeline, r.shiftId);
  if (code === 'R') return 'running';
  if (code === 'D' || code === 'C' || code === 'I') return 'changeover';
  if (code === 'B') return 'breakdown';
  return 'idle';
}

let S: TraceState | null = null;
let dalRef: PmdDataLayer;
let hostEl: HTMLElement | null = null;
let mountVersion = 0;
/** Auto-refresh + now-line ticker. Cleared whenever KPI changes panel or
 *  route so we don't leak fetches when no one is looking. */
let livePollTimer: ReturnType<typeof setInterval> | undefined;
let nowLineTimer: ReturnType<typeof setInterval> | undefined;
/** How often Live Status re-pulls from PMD_LiveStatus / PMD_Production.
 *  2 min balances timeliness against SharePoint load (the per-job
 *  cross-shift Good fetches needed by Job Left / Shift Target make a
 *  per-keystroke poll expensive). The floor iPads mirror every 60 s, so
 *  worst-case staleness on this view is ~3 min; switching back to the
 *  tab refreshes immediately (visibility listener below). */
const LIVE_POLL_MS = 2 * 60_000;
/** Throttle for the focus/visibility-triggered refresh so tabbing back
 *  and forth doesn't hammer SharePoint. */
const LIVE_FOCUS_REFRESH_MIN_GAP_MS = 15_000;
let lastLiveLoadMs = 0;
let liveLoadVersion = 0;
let searchLoadVersion = 0;

/** RejectCode → description ("D07" → "ShortShot"), for the reject
 *  tooltips. Empty until loaded and after a failed read — a missing
 *  description degrades to the bare code, never to a blank tooltip. */
let rejectLabels = new Map<string, string>();
let rejectLabelsLoaded = false;

/**
 * Fetch PMD_RejectCategories once per session. The list is small and
 * changes rarely, so every view that renders a reject tooltip can await
 * this without adding a round-trip after the first. Deliberately
 * swallows failures: the grids are worth showing with bare codes.
 */
async function ensureRejectLabels(dal: PmdDataLayer): Promise<void> {
  if (rejectLabelsLoaded) return;
  rejectLabelsLoaded = true;
  try {
    const cats = await dal.listRejectCategories();
    rejectLabels = new Map(cats.map((c) => [c.code.trim().toUpperCase(), c.label]));
  } catch (e) {
    console.warn('[pmd] reject categories load failed, showing bare codes:', e);
  }
}

/** Mount Live Status or Job Search inside the KPI page. The KPI toolbar
 *  owns navigation; this module owns the selected panel's data and poll. */
export async function mountTracePanel(
  dal: PmdDataLayer,
  host: HTMLElement,
  view: TracePanelView,
): Promise<void> {
  const version = ++mountVersion;
  dalRef = dal;
  stopLivePoll();
  hostEl = host;
  let machines: Machine[] = [];
  const errors: string[] = [];
  // Reject descriptions ride along with the machine list: both are small
  // lookups the first render needs, and neither should wait on the other.
  const labels = ensureRejectLabels(dal);
  try {
    machines = await dal.listMachines();
  } catch (e) {
    console.warn('[pmd] Trace machine list failed:', e);
    errors.push(`Machines: ${(e as Error).message || 'read failed'}`);
  }
  await labels;
  if (version !== mountVersion || !host.isConnected) return;
  S = {
    view,
    query: { jobNumber: '', dateFrom: '', dateTo: '', machine: '' },
    machines,
    results: [],
    liveRows: [],
    searched: false,
    loading: view === 'live',
    lastUpdated: null,
    errors,
  };
  render();
  if (view === 'live') {
    await loadLive();
    if (version === mountVersion && host.isConnected) startLivePoll();
  }
}

/** Cancel pending mounts and timers when KPI changes panel or route. */
export function unmountTracePanel(): void {
  mountVersion++;
  liveLoadVersion++;
  searchLoadVersion++;
  stopLivePoll();
  hostEl = null;
  S = null;
}

function startLivePoll(): void {
  stopLivePoll();
  livePollTimer = setInterval(() => {
    // KPI navigation replaces the host; its disconnection is a reliable
    // signal that this panel no longer owns a visible page.
    if (!hostEl?.isConnected) {
      stopLivePoll();
      return;
    }
    if (!S || S.view !== 'live') return;
    void loadLive({ silent: true });
  }, LIVE_POLL_MS);
  // Refresh the now-line every 30 s so the red line walks across the
  // timeline in real time even when no new data has arrived.
  nowLineTimer = setInterval(() => {
    if (!hostEl?.isConnected) {
      stopLivePoll();
      return;
    }
    drawNowLines();
  }, 30_000);
}

function stopLivePoll(): void {
  if (livePollTimer) clearInterval(livePollTimer);
  if (nowLineTimer) clearInterval(nowLineTimer);
  livePollTimer = undefined;
  nowLineTimer = undefined;
}

/**
 * "Just looked at it" refresh: a supervisor tabbing back to the Live
 * board expects the current picture, not up-to-2-min-old data (worse if
 * the tab was backgrounded — browsers throttle interval timers, so the
 * poll may not have fired at all while hidden). One module-level
 * listener, self-gating on the trace view being active.
 */
function refreshLiveOnReturn(): void {
  if (document.visibilityState !== 'visible') return;
  if (!hostEl?.isConnected || !S || S.view !== 'live') return;
  if (Date.now() - lastLiveLoadMs < LIVE_FOCUS_REFRESH_MIN_GAP_MS) return;
  void loadLive({ silent: true });
}
// Guarded so importing this module under the Node test runner (no DOM)
// doesn't explode at load time.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', refreshLiveOnReturn);
  window.addEventListener('focus', refreshLiveOnReturn);
}

function render(): void {
  const host = hostEl;
  if (!host?.isConnected || !S) return;
  const body = S.view === 'live' ? renderLiveBody() : renderSearchBody();
  const errorBanner =
    S.errors.length
      ? `<div class="data-error-banner" role="alert"><b>⚠ Data could not be fully refreshed.</b> ${S!.errors
          .map((e) => escapeHtml(e))
          .join(' · ')}</div>`
      : '';
  host.innerHTML = `<div class="trace">${errorBanner}${body}</div>`;
  wire();
}

function renderLiveBody(): string {
  // No standalone heading on Live — the 📡 Live Status tab at the top
  // already names the view, and supervisors kept asking to remove the
  // descriptive block as visual noise. Cards go straight under the tabs.
  if (S!.loading) {
    return `<div class="trace-empty">Loading live status…</div>`;
  }
  if (S!.liveRows.length === 0) {
    return `<div class="trace-empty">No machines configured.</div>`;
  }
  // Floor summary strip: activity counts + shift + refresh heartbeat.
  // Mirrors a classic andon header — the supervisor reads the floor's
  // overall state here, then scans down for the press that needs them.
  const counts: Record<Activity, number> = { running: 0, changeover: 0, breakdown: 0, idle: 0 };
  for (const r of S!.liveRows) counts[activityFor(r)]++;
  const chip = (a: Activity): string =>
    `<span class="live-chip" style="--c:${ACTIVITY_COLOURS[a]}"><i></i>${ACTIVITY_LABELS[a]} <b>${counts[a]}</b></span>`;
  const live = currentShift(new Date());
  const updated = S!.lastUpdated
    ? S!.lastUpdated.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  const head = `<div class="live-head">
    <div class="live-chips">${chip('running')}${chip('changeover')}${chip('breakdown')}${chip('idle')}</div>
    <div class="live-meta">${escapeHtml(live.shiftId)} · updated ${escapeHtml(updated)} · auto-refresh ${LIVE_POLL_MS / 1000}s</div>
  </div>`;
  return `${head}<div class="trace-results">${S!.liveRows.map(renderCard).join('')}</div>`;
}

function renderSearchBody(): string {
  return `
    <div class="trace-search">
      <div class="trace-form">
        <label>Job Number<input type="text" data-q="jobNumber" placeholder="SFM…" value="${escapeHtml(S!.query.jobNumber)}"></label>
        <label>Date from<input type="date" data-q="dateFrom" value="${escapeHtml(S!.query.dateFrom)}"></label>
        <label>Date to<input type="date" data-q="dateTo" value="${escapeHtml(S!.query.dateTo)}"></label>
        <label>Machine<select data-q="machine">
          <option value="">— Any —</option>
          ${S!.machines
            .map(
              (m) =>
                `<option value="${escapeHtml(m.machineCode)}"${
                  m.machineCode === S!.query.machine ? ' selected' : ''
                }>${escapeHtml(m.machineCode)}</option>`,
            )
            .join('')}
        </select></label>
        <button class="btn-primary-big" data-search>${S!.loading ? 'Searching…' : 'Search'}</button>
      </div>
    </div>
    ${renderSearchResults()}`;
}

function renderSearchResults(): string {
  if (!S!.searched) {
    return `<div class="trace-empty">Enter a job number, a date range, or both — then Search.</div>`;
  }
  if (S!.results.length === 0) {
    return `<div class="trace-empty">No production records match this query.</div>`;
  }
  // Same day cards the KPI job popup draws — a search result and a
  // drill-down onto the same order used to be two different pictures of
  // it. Results can mix orders and presses, so each card names its own
  // (the popup gets that from its title instead).
  const cards = groupByDay(S!.results).map((g) => {
    const part = g.rows.find((r) => r.partNumber || r.partDescription);
    const partMeta = part?.partNumber
      ? `<span class="trace-meta">${escapeHtml(part.partNumber)}${
          part.partDescription ? ' — ' + escapeHtml(part.partDescription) : ''
        }</span>`
      : '';
    return renderDayCard(
      g.date,
      `<span class="trace-job">${escapeHtml(g.jobNumber || '(no job)')}</span>` +
        `<span class="trace-meta">${escapeHtml(g.machineCode)}</span>${partMeta}`,
      g.rows,
    );
  });
  return `<div class="trace-results">${cards.join('')}</div>`;
}

/**
 * The three aligned 16-column rows for one shift: QC sign-offs, the
 * status timeline (each slot's tooltip names any reject in it), and the
 * per-slot reject-code annotation (positioned under the status it
 * happened in, e.g. 09:00 D07×2). Shared by the per-shift card and the
 * day-grouped popup card so both stay in lock-step.
 *
 * `sheet` welds the QC row onto the timeline as one Excel-style table —
 * they are two views of the same 16 half-hours, so a signature and the
 * status it signs off must share a column edge, not float 2px apart in
 * two strips of separately rounded chips. The wrapper matters: the Live
 * card is a flex column with a gap, which no margin can close.
 */
function traceGrids(r: TraceRow): { sheet: string; rej: string } {
  const rejBySlot: Record<number, Array<{ code: string; qty: number }>> = {};
  for (const p of r.rejects) {
    let obj: Record<string, number> = {};
    try {
      obj = p.rejects ? JSON.parse(p.rejects) : {};
    } catch {
      obj = {};
    }
    const parts = Object.entries(obj)
      .filter(([, v]) => Number(v) > 0)
      .map(([code, qty]) => ({ code, qty: Number(qty) }))
      .sort((a, b) => b.qty - a.qty);
    if (parts.length) rejBySlot[p.slotIndex] = parts;
  }
  const qtyIn = (parts: Array<{ code: string; qty: number }>): number =>
    parts.reduce((a, x) => a + x.qty, 0);
  /** "D07 ShortShot × 1" — the code alone when the tenant's
   *  PMD_RejectCategories has no description for it. */
  const spellOut = (p: { code: string; qty: number }): string => {
    const label = rejectLabels.get(p.code.trim().toUpperCase());
    return `${p.code}${label ? ' ' + label : ''} × ${p.qty}`;
  };
  const hasRejects = Object.keys(rejBySlot).length > 0;
  // The cell shows the half-hour's TOTAL and nothing else. Codes used to
  // be printed in it ("D07×1" over "D09×3"), which at 9px in a 22px-wide
  // slot was unreadable and made the row's height depend on how many
  // codes a slot happened to carry. The number answers "how bad, when";
  // the tooltip answers "which defects" for the one slot being asked
  // about.
  const rej = hasRejects
    ? `<div class="trace-rej-row">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
        const parts = rejBySlot[i];
        if (!parts) return `<div class="trace-rej-slot"></div>`;
        const total = qtyIn(parts);
        const tip = [
          `${slotClock(r.shiftId, i)} · ${total} reject${total === 1 ? '' : 's'}`,
          ...parts.map(spellOut),
        ].join('\n');
        return `<div class="trace-rej-slot has-rej" title="${escapeHtml(tip)}">${total}</div>`;
      }).join('')}</div>`
    : '';

  const timeline = `<div class="trace-timeline">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const ch = r.timeline[i] ?? '·';
    const def = ch === '·' ? null : STATUS_MAP[ch];
    const style = def
      ? `background:${def.color};color:${def.text};border-color:${def.border}`
      : 'background:#f1f5f9;color:#94a3b8';
    const parts = rejBySlot[i];
    const rejTip = parts ? `\nReject ${qtyIn(parts)}\n${parts.map(spellOut).join('\n')}` : '';
    const record = r.records.find((x) => x.slotIndex === i);
    const breakdownTip = ch === 'B'
      ? (() => {
          const detail = breakdownDetailFor(record?.bdIssue ?? '');
          return [
            `Job ${r.jobNumber || '—'}`,
            `Breakdown code: ${detail.code || 'not recorded'}`,
            `Category: ${detail.category}`,
            `Cause: ${detail.cause}`,
            `Likely owner: ${detail.owner}`,
            record?.mangoTicket ? `Note / Mango ticket: ${record.mangoTicket}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })()
      : '';
    const tip = [
      `${slotClock(r.shiftId, i)} · ${def?.label ?? 'Empty'}`,
      breakdownTip,
    ]
      .filter(Boolean)
      .join('\n');
    return `<div class="trace-slot" title="${escapeHtml(
      `${tip}${rejTip}`,
    )}" style="${style}">${ch}</div>`;
  }).join('')}</div>`;

  const qc = `<div class="trace-qc-row">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const p = qcCellPresentation(i, r.qcBySlot[i] ?? '');
    // Read-only here, so the operator sheet's "✓ " tap-affordance prefix
    // is just noise — the green signed tint already says "done"; bare
    // initials keep the cramped popup grids legible.
    const label = p.signed ? p.label.replace(/^✓\s*/, '') : p.label;
    return `<div class="trace-qc-slot qc-${p.role}${p.signed ? ' is-signed' : ''}" title="${p.title}">${label}</div>`;
  }).join('')}</div>`;

  return { sheet: `<div class="trace-sheet">${qc}${timeline}</div>`, rej };
}

function scheduleTime(value: string): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return `${d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString(
    'en-AU',
    { hour: '2-digit', minute: '2-digit', hour12: false },
  )}`;
}

/** Planning.csv Start–Due bars aligned to the same eight-hour shift as the
 * live status grid. Overlapping jobs occupy separate lanes. */
export function renderSchedule(r: TraceRow, now: Date = new Date()): string {
  const { segments, laneCount } = scheduleSegmentsForShift(
    r.schedule ?? [],
    r.machineCode,
    r.shiftId,
  );
  if (!segments.length) return '';
  const thresholds = loadKpiThresholds();
  const rowHeight = 17;
  const bars = segments
    .map(({ order, leftPct, widthPct, lane }) => {
      const piecesPerHour = order.qtyPerHr > 0 ? 1 / order.qtyPerHr : 0;
      const expectedExact = expectedScheduledPiecesForOrder(
        r.shiftId,
        order,
        r.machineCode,
        now,
      );
      const expected = expectedExact == null ? null : Math.floor(expectedExact);
      const actual = r.scheduleGoodByJob?.[order.jobNumber] ?? 0;
      const pct = expected != null && expected > 0 ? Math.round((actual / expected) * 100) : null;
      const kpiClass = planColourClass(pct, thresholds);
      const barClass = kpiClass === 'amber' ? 'orange' : kpiClass || 'future';
      const tip = [
        `Job ${order.jobNumber}`,
        `${order.partNumber}${order.partDescription ? ' — ' + order.partDescription : ''}`,
        `Start ${scheduleTime(order.plannedStart)}`,
        `Due ${scheduleTime(order.plannedEnd)}`,
        `Planned qty ${order.orderQty || '—'}`,
        `Standard ${piecesPerHour > 0 ? piecesPerHour.toFixed(2) + ' pcs/h' : '—'}`,
        pct == null
          ? 'vs Plan: not started yet'
          : `vs Plan: ${actual} actual / ${expected} expected = ${pct}%`,
      ].join('\n');
      return `<div class="trace-schedule-bar is-${barClass}" style="left:${leftPct.toFixed(
        3,
      )}%;width:${widthPct.toFixed(3)}%;top:${lane * rowHeight}px" title="${escapeHtml(tip)}">${escapeHtml(
        order.jobNumber,
      )}</div>`;
    })
    .join('');
  return `<div class="trace-schedule">
    <div class="trace-schedule-head"><b>Schedule</b><span>Planning.csv · Start → Due</span></div>
    <div class="trace-schedule-track" style="height:${Math.max(rowHeight, laneCount * rowHeight)}px">${bars}</div>
  </div>`;
}

/** The shift's breakdowns spelled out under its grids: when, which code,
 *  what it was, and the Mango ticket if one was raised. */
function breakdownLines(r: TraceRow): string {
  if (!r.bdSlots.length) return '';
  return `<div class="trace-section"><b>Breakdowns</b><ul>${r.bdSlots
    .map(
      (b) =>
        `<li><span class="ts">${escapeHtml(slotClock(r.shiftId, b.slot))}</span> <span class="bd-code">${escapeHtml(
          b.code,
        )}</span> ${escapeHtml(bdLabelFor(b.code))}${
          b.ticket ? ` · ${escapeHtml(b.ticket)}` : ''
        }${b.note ? ` — ${escapeHtml(b.note)}` : ''}</li>`,
    )
    .join('')}</ul></div>`;
}

/**
 * One press on the Live Status board. Machine name in plain text on the
 * left for identity, activity badge beside it so the supervisor can scan
 * the floor and see at a glance which line is running, which is in
 * changeover, which is down. The rail + tint carry the colour signal — a
 * dedicated machine swatch was distracting on top.
 *
 * Live only. Job Search and the KPI popup both draw day cards
 * (renderDayCard); this used to serve all three with a second layout
 * behind an `isLive` flag, which is exactly how the two order views
 * drifted apart.
 */
export function renderCard(r: TraceRow): string {
  const activity = activityFor(r);
  const activityCol = ACTIVITY_COLOURS[activity];
  const machineName = `<b class="trace-machine">${escapeHtml(r.machineCode)}</b>`;
  const activityBadge = `<span class="trace-activity" style="background:${activityCol}">${escapeHtml(
    ACTIVITY_LABELS[activity],
  )}</span>`;
  // A press with no order on it has nothing to show: no counts, no
  // operator, and sixteen empty slots that say only what "(no job)"
  // already said. Collapse it to the one line that IS the news — which
  // press is sitting idle — so the presses that ARE running aren't
  // pushed off the screen by the ones that aren't.
  const schedule = renderSchedule(r);
  if (!r.jobNumber && !schedule) {
    return `<div class="trace-card is-idle is-live trace-card-slim act-${activity}" style="--mc:${activityCol}">
      <div class="trace-card-head">
        ${machineName}<span class="trace-job">(no job)</span>${activityBadge}
      </div>
    </div>`;
  }
  if (!r.jobNumber) {
    return `<div class="trace-card is-idle is-live act-${activity}" style="--mc:${activityCol}">
      <div class="trace-card-head">
        ${machineName}<span class="trace-job">(no live job)</span>${activityBadge}
      </div>
      ${schedule}
    </div>`;
  }
  const grids = traceGrids(r);
  const dateLabel = r.shiftId.slice(0, 10);
  const shiftLabel = r.shiftId.slice(11);
  const bdLines = breakdownLines(r);
  // Co-run badge: this order shares its die with another running on the
  // same press at the same time (both flagged CoRun=Yes).
  const coRunBadge = r.coRun
    ? `<span class="trace-corun" title="Co-running with another order on the same die">⛓ Co-run</span>`
    : '';

  return `<div class="trace-card is-live act-${activity}" style="--mc:${activityCol}">
    <div class="trace-card-head">
      ${machineName}<span class="trace-job">${escapeHtml(r.jobNumber)}</span>${activityBadge}${coRunBadge}<span class="trace-meta">${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>
      <span class="trace-meta">${escapeHtml(r.partNumber)}${r.partDescription ? ' — ' + escapeHtml(r.partDescription) : ''}</span>
    </div>
    <div class="trace-card-totals">
      <span>Operator <b>${escapeHtml(r.operator || '—')}</b></span>
      <span>Supervisor <b>${escapeHtml(r.supervisor || '—')}</b></span>
      <span>Order Qty <b>${r.orderQty ?? '—'}</b></span>
      <span>Job Left <b>${r.jobLeft ?? '—'}</b></span>
      <span>Shift Target <b>${r.shiftTarget ?? '—'}</b></span>
      <span class="g">Good <b>${r.good}</b></span>
      <span class="r">Reject <b>${r.reject}</b></span>
    </div>
    ${grids.sheet}
    ${grids.rej}
    ${schedule}
    ${bdLines}
  </div>`;
}

export interface DayGroup {
  jobNumber: string;
  machineCode: string;
  date: string;
  rows: TraceRow[];
}

/**
 * Split rows into the unit a day card draws: one order, on one press,
 * on one date. Insertion order follows the caller's sort, so the cards
 * come out in whatever order the rows were given in.
 *
 * The order has to be part of the key. A press that finished one job and
 * started the next in the same shift would otherwise have both collapsed
 * into a single card, where the two orders' timelines would overwrite
 * each other in the same three blocks.
 */
export function groupByDay(rows: TraceRow[]): DayGroup[] {
  const byDay = new Map<string, DayGroup>();
  for (const r of rows) {
    const date = r.shiftId.slice(0, 10);
    const key = `${r.jobNumber}|${r.machineCode}|${date}`;
    const g = byDay.get(key) ?? { jobNumber: r.jobNumber, machineCode: r.machineCode, date, rows: [] };
    g.rows.push(r);
    byDay.set(key, g);
  }
  return Array.from(byDay.values());
}

/**
 * A whole day for one press: Day | Afternoon | Night side-by-side in one
 * row, so a multi-day job reads day-by-day instead of as a long stack of
 * per-shift cards. Each block carries its own QC / status / reject grids,
 * a compact header (Good, Reject, Shift Target, Job Left) and any
 * breakdowns logged in it.
 *
 * ALL THREE blocks are always rendered, in the same three positions,
 * whether or not the order ran them — a day that only ran Night shows an
 * empty Day and Afternoon rather than letting Night stretch across the
 * row. At a morning meeting the eye finds the problem shift by WHERE it
 * sits on the row; that only works if the position never moves.
 *
 * The date leads the heading because it is the one thing that changes
 * down the page. `headExtra` is whatever else the reader needs to place
 * the card: nothing in the KPI popup (its title already names the order,
 * press and part), the order and press in Job Search, where results can
 * mix both.
 */
function renderDayCard(date: string, headExtra: string, rows: TraceRow[]): string {
  const byCode = new Map(rows.map((r) => [r.shiftId.slice(11), r]));
  const blocks = SHIFTS.map((s) => {
    const r = byCode.get(s.code);
    if (!r) {
      return `<div class="trace-day-shift is-empty" title="${escapeHtml(
        `This order recorded no production in the ${s.label} shift on ${date}`,
      )}">
        <div class="trace-day-shift-hd"><b>${escapeHtml(s.code)}</b></div>
        <div class="trace-day-none">Not run</div>
      </div>`;
    }
    const grids = traceGrids(r);
    // Operator and supervisor ride in the tooltip, not the header line.
    // Names are the one item here of unbounded length ("Trong (Danny)
    // Nguyen" against "Van Minh Ma"), so keeping them inline wrapped one
    // block's header to two lines and not its neighbour's — which pushed
    // that block's grids half a line down and broke the row's alignment,
    // the whole point of the fixed three-column layout.
    return `<div class="trace-day-shift" title="${escapeHtml(
      `${s.label} · Operator ${r.operator || '—'} · Supervisor ${r.supervisor || '—'}`,
    )}">
      <div class="trace-day-shift-hd">
        <b>${escapeHtml(s.code)}</b>
        <span class="g">G ${r.good}</span>
        <span class="r">R ${r.reject}</span>
        <span>Target ${r.shiftTarget ?? '—'}</span>
        <span>Left ${r.jobLeft ?? '—'}</span>
      </div>
      ${grids.sheet}
      ${grids.rej}
      ${breakdownLines(r)}
    </div>`;
  }).join('');
  return `<div class="trace-card trace-day-card">
    <div class="trace-card-head">
      <b>${escapeHtml(date)}</b>
      ${headExtra}
    </div>
    <div class="trace-day-shifts">${blocks}</div>
  </div>`;
}

function wire(): void {
  const host = hostEl;
  if (!host) return;
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-q]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.q as keyof TraceState['query'];
      (S!.query as Record<string, string>)[k] = (el as HTMLInputElement).value;
    }),
  );
  host.querySelector('[data-search]')?.addEventListener('click', () => void doSearch());
  host.querySelectorAll<HTMLInputElement>('input[data-q="jobNumber"]').forEach((el) =>
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doSearch();
    }),
  );
}

/**
 * Per-machine snapshot of the current live shift. One card per machine —
 * machines with no production row yet get an Idle placeholder so the
 * dashboard reads "we have these N presses, here's what they're doing
 * right now" rather than just listing what already exists.
 */
async function loadLive(opts: { silent?: boolean } = {}): Promise<void> {
  if (!S) return;
  const state = S;
  const version = ++liveLoadVersion;
  const errors: string[] = [];
  lastLiveLoadMs = Date.now();
  if (!opts.silent) {
    state.loading = true;
    state.errors = [];
    render();
  }
  const live = currentShift(new Date());
  const [rows, planning, dieList] = await Promise.all([
    dalRef.listProduction({ shiftId: live.shiftId }).catch((err) => {
      console.warn('[pmd] live trace listProduction failed:', err);
      errors.push(`Live production: ${(err as Error).message || 'read failed'}`);
      return null;
    }),
    dalRef.listPlanning({}).catch((err) => {
      console.warn('[pmd] live trace planning failed:', err);
      errors.push(`Planning: ${(err as Error).message || 'read failed'}`);
      return [] as PlanningOrder[];
    }),
    dalRef.listProductDieColors
      ? dalRef.listProductDieColors().catch((err) => {
          console.warn('[pmd] live trace part/die mapping failed:', err);
          errors.push(`Part/die mapping: ${(err as Error).message || 'read failed'}`);
          return [];
        })
      : Promise.resolve([]),
  ]);
  if (version !== liveLoadVersion || S !== state || state.view !== 'live') return;
  if (rows == null) {
    // Keep the last known cards and timestamp. Replacing them with one Idle
    // placeholder per machine would turn a network failure into a false
    // operational statement about the floor.
    state.errors = errors;
    state.loading = false;
    render();
    drawNowLines();
    return;
  }
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));
  // Part # → die / CoRun, so the board can keep every co-running order
  // visible instead of collapsing the press to one job.
  const dieByPart = new Map<string, DieCoRun>(
    dieList.map((c) => [
      c.partNumber.trim().toUpperCase(),
      { dieNumber: c.dieNumber, coRun: c.coRun },
    ]),
  );
  const dieFor = (part: string): DieCoRun | undefined =>
    dieByPart.get(part.trim().toUpperCase());
  // Cross-shift Good per job so Job Left / Shift Target on the live cards
  // count the whole order, not just this shift's output.
  const jobGoodTotals = await loadJobGoodTotals(
    rows.map((r) => r.jobNumber).filter(Boolean),
    (job, err) => {
      errors.push(`Job total ${job}: ${(err as Error).message || 'read failed'}`);
    },
  );
  if (version !== liveLoadVersion || S !== state || state.view !== 'live') return;
  const byMachine = new Map<string, ProductionRecord[]>();
  for (const r of rows) {
    const arr = byMachine.get(r.machineCode) ?? [];
    arr.push(r);
    byMachine.set(r.machineCode, arr);
  }
  // Sort: machines currently running an order come first (the press
  // the supervisor wants to glance at), idle presses fall to the
  // bottom. Within each bucket, keep the physical floor order as a
  // stable tie-break so the same line doesn't jump positions when
  // an order ends.
  const sortedMachines = state.machines.slice().sort((a, b) => {
    const aActive = (byMachine.get(a.machineCode) ?? []).length > 0 ? 0 : 1;
    const bActive = (byMachine.get(b.machineCode) ?? []).length > 0 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return floorIndex(a.machineCode) - floorIndex(b.machineCode);
  });
  const out: TraceRow[] = [];
  for (const m of sortedMachines) {
    const recs = byMachine.get(m.machineCode) ?? [];
    const machineSchedule = plannedOrdersForShift(planning, m.machineCode, live.shiftId);
    const scheduleGoodByJob: Record<string, number> = {};
    for (const planned of machineSchedule) {
      scheduleGoodByJob[planned.jobNumber] = goodForRecords(
        recs.filter((record) => record.jobNumber === planned.jobNumber),
      );
    }
    if (recs.length === 0) {
      out.push(
        idlePlaceholder(m.machineCode, live.shiftId, machineSchedule, scheduleGoodByJob),
      );
      continue;
    }
    // One card per machine: a press can carry several jobs in the same
    // shift (a job finished, the next started). The Live Status board
    // shows ONLY what the press is doing now / most recently — collapse
    // the per-job rows to the single most-current one. Without this,
    // 1600T showed three cards (one per job logged this shift).
    const machineRows = buildTraceRowsFor(recs, planByJob, jobGoodTotals);
    const latest = latestRow(machineRows);
    // EXCEPT co-running orders: when a die runs 2-3 parts simultaneously
    // (same die, both CoRun=Yes, equal Order Qty) they are all "current", so
    // show every co-runner of the latest job as its own card rather than
    // hiding all but one. Differing-quantity colours that merely share the
    // die run sequentially and stay collapsed, as do earlier jobs.
    const latestDie = dieFor(latest.partNumber);
    const coRunners = machineRows.filter(
      (row) =>
        row.key !== latest.key &&
        ordersCoRun(latestDie, dieFor(row.partNumber), latest.orderQty, row.orderQty),
    );
    if (coRunners.length) {
      out.push({ ...latest, coRun: true, schedule: machineSchedule, scheduleGoodByJob });
      for (const row of coRunners) {
        out.push({ ...row, coRun: true, schedule: machineSchedule, scheduleGoodByJob });
      }
    } else {
      out.push({ ...latest, schedule: machineSchedule, scheduleGoodByJob });
    }
  }
  state.liveRows = out;
  state.lastUpdated = new Date();
  state.errors = errors;
  state.loading = false;
  render();
  drawNowLines();
}

/**
 * Position a half-transparent red vertical line on every Live Status
 * card's 16-slot timeline at the current wall-clock fraction of the
 * shift. Mirrors the operator grid's "NOW" indicator so a supervisor
 * glancing at the cards can immediately see where the press should be
 * along its 8-hour run.
 */
function drawNowLines(): void {
  if (!S || S.view !== 'live') return;
  const live = currentShift(new Date());
  const b = shiftBounds(live.shiftId);
  if (!b) return;
  const frac = Math.max(
    0,
    Math.min(1, (Date.now() - b.start.getTime()) / (b.end.getTime() - b.start.getTime())),
  );
  const pct = (frac * 100).toFixed(2);
  hostEl
    ?.querySelectorAll<HTMLElement>(
      '.trace-card.is-live .trace-timeline, .trace-card.is-live .trace-schedule-track',
    )
    .forEach((tl) => {
    let line = tl.querySelector<HTMLElement>('.trace-now-line');
    if (!line) {
      line = document.createElement('div');
      line.className = 'trace-now-line';
      tl.appendChild(line);
    }
    line.style.left = `${pct}%`;
    line.title = `Now: ${new Date().toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    });
}

function idlePlaceholder(
  machineCode: string,
  shiftId: string,
  schedule: PlanningOrder[] = [],
  scheduleGoodByJob: Record<string, number> = {},
): TraceRow {
  return {
    key: `${machineCode}|${shiftId}|`,
    machineCode,
    shiftId,
    jobNumber: '',
    partNumber: '',
    partDescription: 'No production logged this shift',
    operator: '',
    supervisor: '',
    timeline: '·'.repeat(SLOTS_PER_SHIFT),
    countStart: null,
    countEnd: null,
    good: 0,
    reject: 0,
    orderQty: null,
    jobLeft: null,
    shiftTarget: null,
    qcBySlot: Array.from({ length: SLOTS_PER_SHIFT }, () => ''),
    rejects: [],
    bdSlots: [],
    records: [],
    schedule,
    scheduleGoodByJob,
    idle: true,
  };
}

/** A shift is "past" once its end time is behind the wall clock.
 *  shiftBounds resolves the Day/Afternoon/Night window so this is
 *  correct across the non-lexicographic shift ordering (Day → Afternoon
 *  → Night), unlike a naive shiftId string compare. */
function isShiftPast(shiftId: string): boolean {
  const b = shiftBounds(shiftId);
  return b ? b.end.getTime() < Date.now() : false;
}

/**
 * Rebuild a PlanningOrder from a signed-off PMD_Production canonical row
 * so historical Job Number searches show real Order Qty / Job Left even
 * after Epicor drops the order from Planning.csv. Mirrors operator.ts's
 * synthetic order: PMD_Production denormalises the order TOTAL onto its
 * JobRequired column, and carries no cycle time — so Shift Target stays
 * "—" (qtyPerHr 0 → shiftTargetFor returns null), exactly as the
 * operator sheet renders it for the same dropped order. Returns null
 * when there is no recorded total to build from.
 */
export function syntheticOrderFromRecord(
  canon: ProductionRecord | undefined,
  jobNumber: string,
): PlanningOrder | null {
  const req = canon?.jobRequired ?? 0;
  if (!canon || !req) return null;
  return {
    id: 0,
    jobNumber,
    machineCode: canon.machineCode,
    originalMachine: '',
    partNumber: canon.partNumber ?? '',
    partDescription: canon.partDescription ?? '',
    plannedStart: '',
    plannedEnd: '',
    orderQty: req,
    jobRequired: req,
    // Cycle time persisted on PMD_Production at sign-off → Shift Target
    // recomputes for the historical shift instead of rendering "—".
    qtyPerHr: canon.cycleTime ?? 0,
    duration: 0,
    released: false,
    isDieChange: false,
    manuallyAdded: true,
    source: 'Manual',
  };
}

/**
 * Group a flat list of records into (machine|shift|job) tuples and
 * build a TraceRow for each. Shared by the live snapshot and the
 * search results so the cards always render identically.
 */
function buildTraceRowsFor(
  records: ProductionRecord[],
  planByJob: Map<string, PlanningOrder>,
  jobGoodTotals: Map<string, number>,
): TraceRow[] {
  const groups = new Map<string, ProductionRecord[]>();
  // All jobs' rows per (machine, shift) — the Shift Target recompute
  // deducts the press hours other orders / changeovers held. A Job
  // Number search only loads that job's own rows, so there the
  // deduction naturally sees just the job's own changeover slots (the
  // persisted ShiftTarget column covers signed tuples anyway).
  const byMachineShift = new Map<string, ProductionRecord[]>();
  for (const r of records) {
    const key = `${r.machineCode}|${r.shiftId}|${r.jobNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
    const msKey = `${r.machineCode}|${r.shiftId}`;
    if (!byMachineShift.has(msKey)) byMachineShift.set(msKey, []);
    byMachineShift.get(msKey)!.push(r);
  }
  const out: TraceRow[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.slotIndex - b.slotIndex);
    const [machineCode, shiftId, jobNumber] = key.split('|');
    const canonical = list.find((r) => r.slotIndex === 0) ?? list[0];
    const timeline = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
      const slot = list.find((r) => r.slotIndex === i);
      return slot?.statusCode || '·';
    }).join('');
    let totalRej = 0;
    for (const r of list) {
      try {
        const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
        totalRej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
      } catch {
        totalRej += Number(r.rejectCount) || 0;
      }
    }
    const bdSlots = list
      .filter((r) => r.statusCode === 'B' && r.bdIssue)
      .map((r) => ({
        slot: r.slotIndex,
        code: r.bdIssue,
        ticket: r.mangoTicket,
        note: '',
      }));
    // Source-of-truth selection, identical to operator.ts's selectedOrder:
    // Planning.csv only describes the CURRENT Epicor state, so it is
    // authoritative for live / future shifts. A PAST shift means "show
    // what was recorded", so rebuild the order from the PMD_Production
    // row's denormalised JobRequired (= order total). This keeps Job
    // Number Search consistent with the operator sheet for the same
    // tuple and stops historical jobs Epicor has dropped from rendering
    // "—" for Order Qty / Job Left.
    const planOrder = planByJob.get(jobNumber);
    const synthetic = syntheticOrderFromRecord(canonical, jobNumber);
    const plan = isShiftPast(shiftId)
      ? synthetic ?? planOrder
      : planOrder ?? synthetic;
    // Job-wide Good. Prefer the signed cross-shift total when the caller
    // could compute one; the `has()` guard (not `??`) is deliberate — a
    // failed history fetch stores 0 in the map, and treating that as
    // "good" would render Job Left = full order quantity. Falling back
    // to this tuple's own good keeps the number conservative. An
    // UNSIGNED (live) tuple adds its own in-progress good on top of the
    // signed total so the card matches the operator side panel exactly
    // (a signed tuple is already inside the signed total).
    const grossThis = cavityGross(canonical?.countStart ?? null, canonical?.countEnd ?? null, canonical?.cavities);
    const goodThisTuple = Math.max(0, grossThis - totalRej);
    const signedTuple = list.some((r) => r.locked || r.reopened);
    const jobGood = jobGoodTotals.has(jobNumber)
      ? jobGoodTotals.get(jobNumber)! + (signedTuple ? 0 : goodThisTuple)
      : goodThisTuple;
    // Job Left + Shift Target. SIGNED tuples read the PMD_Production
    // columns — lockShift recomputes them from signed rows at sign-off,
    // so they are the recorded demand-at-start for that row. An UNSIGNED
    // tuple's canonical.jobLeft is different animal entirely: it's the
    // editing device's old client-frozen snapshot mirrored through
    // PMD_LiveStatus — stale by definition and historically contaminated
    // (SFM507147's live card showed a phantom 200 while the signed rows
    // said 656). Live cards therefore ALWAYS derive from the signed
    // cross-shift Good instead.
    const jobLeft =
      signedTuple && canonical?.jobLeft != null
        ? canonical.jobLeft
        : plan
          ? jobLeftPiecesFor(plan, jobGood)
          : null;
    const shiftTargetVal =
      signedTuple && canonical?.shiftTarget != null
        ? canonical.shiftTarget
        : plan && jobLeft != null
          ? shiftTargetFor(
              plan,
              jobLeft,
              hoursUnavailableFor(
                byMachineShift.get(`${machineCode}|${shiftId}`) ?? [],
                jobNumber,
              ),
            )
          : null;
    const qcBySlot = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
      const rec = list.find((r) => r.slotIndex === i);
      return rec?.qcBy ?? '';
    });
    out.push({
      key,
      machineCode,
      shiftId,
      jobNumber,
      partNumber: plan?.partNumber ?? '',
      partDescription: plan?.partDescription ?? '',
      operator: canonical?.operator ?? '',
      supervisor: canonical?.supervisor ?? '',
      timeline,
      countStart: canonical?.countStart ?? null,
      countEnd: canonical?.countEnd ?? null,
      good: goodThisTuple,
      reject: totalRej,
      orderQty: plan && !plan.isDieChange ? plan.orderQty : null,
      jobLeft,
      shiftTarget: shiftTargetVal,
      qcBySlot,
      rejects: list.filter((r) => r.rejectCount > 0 || r.rejects !== '{}'),
      bdSlots,
      records: list,
    });
  }
  return out;
}

/** Good across ALL (machine, shift) tuples in a flat record list — the
 *  same gross−reject rule the operator sheet uses (gross lives on slot 0;
 *  rejects sum across every slot). Used to total a single job's output. */
export function goodForRecords(records: ProductionRecord[]): number {
  const grossByTuple = new Map<string, number>();
  const rejByTuple = new Map<string, number>();
  for (const r of records) {
    const tuple = `${r.machineCode}|${r.shiftId}`;
    if (r.slotIndex === 0) {
      grossByTuple.set(tuple, cavityGross(r.countStart, r.countEnd, r.cavities));
    }
    let rej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      rej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      rej = Number(r.rejectCount) || 0;
    }
    if (rej) rejByTuple.set(tuple, (rejByTuple.get(tuple) ?? 0) + rej);
  }
  let total = 0;
  for (const [tuple, gross] of grossByTuple) {
    total += Math.max(0, gross - (rejByTuple.get(tuple) ?? 0));
  }
  return total;
}

/**
 * Fetch each job's FULL production history (all shifts / machines) and
 * total its Good, so Job Left / Shift Target reflect the whole order and
 * not just the current shift. One query per unique job, in parallel; a
 * failed fetch contributes 0 rather than dropping the row.
 */
/**
 * Job Number Search reads SIGNED-OFF history only — PMD_Production, never
 * the in-progress PMD_LiveStatus mirror or another iPad's local cache. The
 * dedicated DAL method skips those lists entirely; backends that don't
 * model the split (memory DAL) fall back to listProduction filtered to
 * locked (signed-off) rows, which is equivalent.
 */
async function readSignedOff(filter: {
  jobNumber?: string;
  machineCode?: string;
  shiftIdFrom?: string;
  shiftIdTo?: string;
}): Promise<ProductionRecord[]> {
  if (dalRef.listSignedOffProduction) {
    return dalRef.listSignedOffProduction(filter);
  }
  const recs = await dalRef.listProduction(filter);
  return recs.filter((r) => r.locked);
}

async function loadJobGoodTotals(
  jobNumbers: string[],
  onError?: (jobNumber: string, error: unknown) => void,
): Promise<Map<string, number>> {
  const unique = Array.from(new Set(jobNumbers.filter(Boolean)));
  const out = new Map<string, number>();
  await Promise.all(
    unique.map(async (job) => {
      try {
        const recs = await readSignedOff({ jobNumber: job });
        out.set(job, goodForRecords(recs));
      } catch (e) {
        // Deliberately leave the key absent — buildTraceRowsFor uses
        // `has()` to detect this and falls back to the per-tuple good,
        // which keeps Job Left conservative. Setting 0 here would
        // render Job Left = full order quantity (see code review of
        // commit c089da5).
        console.warn('[pmd] job good total fetch failed for', job, e);
        onError?.(job, e);
      }
    }),
  );
  return out;
}

export interface JobTraceView {
  /** The day / per-shift cards. */
  html: string;
  /** Ready-to-inject popup title: order · machine(s) · part — description.
   *  The identity lives here once instead of being repeated on every card. */
  heading: string;
}

/** Order → the machine(s) it ran on → its part number and description.
 *  Machines are listed in the order the cards appear, so a job that moved
 *  presses names both. */
/**
 * Good against order quantity as a whole percent, rounded AWAY from 100
 * in both directions. 100% has to mean "exactly the order", so short of
 * it floors (479 of 480 is 99%, not a 100% that would send the die off
 * the press a piece early) and over it ceils (313 of 310 is 101%, not a
 * 100% that would hide three pieces of overrun). Only good === qty is
 * allowed to print 100.
 */
export function completionPct(good: number, orderQty: number): number {
  if (good === orderQty) return 100;
  const raw = (good / orderQty) * 100;
  return good < orderQty ? Math.floor(raw) : Math.ceil(raw);
}

function jobTraceHeading(job: string, rows: TraceRow[]): string {
  const machines = Array.from(new Set(rows.map((r) => r.machineCode).filter(Boolean)));
  // Part identity can be blank on an early shift (e.g. a die-change-only
  // row) — take it from the first shift that actually carries it.
  const part = rows.find((r) => r.partNumber || r.partDescription);
  const meta = [machines.join(' / '), part?.partNumber ?? ''].filter(Boolean).join(' · ');
  // How big the order is and how much of it is actually made — the two
  // numbers the popup was opened to settle. Order Qty is the same figure
  // on every row of the job (Epicor ProdQty), so take the first row that
  // carries one; Good is summed across every shift and press.
  const orderQty = rows.find((r) => r.orderQty != null)?.orderQty ?? null;
  const good = rows.reduce((a, r) => a + r.good, 0);
  const done = orderQty
    ? ` <span class="trace-head-pct">${completionPct(good, orderQty)}%</span>`
    : '';
  const tally = rows.length
    ? `<span class="trace-head-tally">Qty <b>${orderQty ?? '—'}</b> · Good <b class="g">${good}</b>${done}</span>`
    : '';
  return `<b class="trace-head-job">${escapeHtml(job)}</b>${tally}${
    meta ? `<span class="trace-head-meta">${escapeHtml(meta)}</span>` : ''
  }${
    part?.partDescription
      ? `<span class="trace-head-desc">— ${escapeHtml(part.partDescription)}</span>`
      : ''
  }`;
}

/** Oldest → newest, the order the floor lived it: machine, then date,
 *  then Day → Afternoon → Night. Shift codes must be ranked by SHIFTS
 *  rather than compared as text — "Afternoon" sorts before "Day"
 *  alphabetically, which would put 15:00 ahead of 07:00. */
function chronologically(a: TraceRow, b: TraceRow): number {
  if (a.machineCode !== b.machineCode) return a.machineCode < b.machineCode ? -1 : 1;
  const da = a.shiftId.slice(0, 10);
  const db = b.shiftId.slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  const rank = (id: string): number => {
    const i = SHIFTS.findIndex((s) => s.code === id.slice(11));
    return i < 0 ? SHIFTS.length : i;
  };
  return rank(a.shiftId) - rank(b.shiftId);
}

/**
 * Render the Trace detail cards for a single job as standalone HTML —
 * used by the KPI table's job-number popup. Loads the job's full
 * signed-off history through the passed DAL (works even if the Trace tab
 * was never opened this session).
 *
 * One card per date, each a fixed Day | Afternoon | Night row, oldest
 * first — the same shape whether the order ran one shift or twelve. It
 * used to fall back to a stack of per-shift cards below four shifts,
 * which meant an order that ran only Afternoon and Night was drawn as
 * two lone cards with no Day column to place them against: the reader
 * had to work out which shift each card was rather than see it.
 *
 * Returns an empty-state message when the job has no signed-off records.
 */
export async function renderJobTraceCards(
  dal: PmdDataLayer,
  jobNumber: string,
): Promise<JobTraceView> {
  dalRef = dal;
  const job = jobNumber.trim();
  const all = await readSignedOff({ jobNumber: job });
  if (all.length === 0) {
    return {
      heading: `<b class="trace-head-job">${escapeHtml(job)}</b>`,
      html: `<div class="trace-empty">No signed-off production records for ${escapeHtml(
        job,
      )}.</div>`,
    };
  }
  const [planning] = await Promise.all([dal.listPlanning({}), ensureRejectLabels(dal)]);
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));
  const jobGoodTotals = new Map([[job, goodForRecords(all)]]);
  const rows = buildTraceRowsFor(all, planByJob, jobGoodTotals);
  rows.sort(chronologically);
  const heading = jobTraceHeading(job, rows);
  // The heading already names the press; repeating it on every card is
  // noise — unless the job moved between presses, where the date alone
  // wouldn't say which one a card belongs to.
  const showMachine = new Set(rows.map((r) => r.machineCode)).size > 1;
  const cards = groupByDay(rows).map((g) =>
    renderDayCard(
      g.date,
      showMachine ? `<span class="trace-meta">${escapeHtml(g.machineCode)}</span>` : '',
      g.rows,
    ),
  );
  return { heading, html: `<div class="trace-results">${cards.join('')}</div>` };
}

async function doSearch(): Promise<void> {
  if (!S) return;
  const state = S;
  const q = { ...state.query };
  if (!q.jobNumber && !q.dateFrom && !q.dateTo) {
    return;
  }
  const version = ++searchLoadVersion;
  state.loading = true;
  state.errors = [];
  render();

  try {
    const all: ProductionRecord[] = [];
    if (q.jobNumber) {
      all.push(...(await readSignedOff({ jobNumber: q.jobNumber.trim() })));
    } else {
      const filter: {
        shiftIdFrom?: string;
        shiftIdTo?: string;
        machineCode?: string;
      } = {};
      if (q.dateFrom) filter.shiftIdFrom = `${q.dateFrom}-`;
      if (q.dateTo) filter.shiftIdTo = `${q.dateTo}-￿`;
      if (q.machine) filter.machineCode = q.machine;
      all.push(...(await readSignedOff(filter)));
    }
    if (version !== searchLoadVersion || S !== state || state.view !== 'search') return;

  // Post-filter for machine + date range (in case the backend ignored some hints).
  const dateFrom = q.dateFrom ? `${q.dateFrom}` : '';
  const dateTo = q.dateTo ? `${q.dateTo}` : '';
  const filtered = all.filter((r) => {
    if (q.machine && r.machineCode !== q.machine) return false;
    const datePart = r.shiftId.slice(0, 10);
    if (dateFrom && datePart < dateFrom) return false;
    if (dateTo && datePart > dateTo) return false;
    return true;
  });

    const planning = await dalRef.listPlanning({});
    if (version !== searchLoadVersion || S !== state || state.view !== 'search') return;
    const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));

  // Job-wide Good totals for Job Left / Shift Target. A Job Number search
  // already pulled that job's complete history into `all`, so total it
  // directly; a date-range search only sees a window, so fetch each job's
  // full history to keep the numbers job-wide rather than window-wide.
    let jobGoodTotals: Map<string, number>;
    if (q.jobNumber) {
      jobGoodTotals = new Map([[q.jobNumber.trim(), goodForRecords(all)]]);
    } else {
      const totalErrors: string[] = [];
      jobGoodTotals = await loadJobGoodTotals(filtered.map((r) => r.jobNumber), (job, e) => {
        totalErrors.push(`Job total ${job}: ${(e as Error).message || 'read failed'}`);
      });
      if (totalErrors.length) throw new Error(totalErrors.join(' · '));
    }
    if (version !== searchLoadVersion || S !== state || state.view !== 'search') return;

  const rows = buildTraceRowsFor(filtered, planByJob, jobGoodTotals);
  // Group by machine, then run each press's days forwards — the same
  // order the KPI popup uses, so the two views of one order can't
  // disagree about which way time runs. (This used to be newest-first
  // here and oldest-first there.)
  rows.sort(chronologically);
    state.results = rows;
    state.searched = true;
    state.errors = [];
    state.loading = false;
    render();
  } catch (e) {
    if (version !== searchLoadVersion || S !== state || state.view !== 'search') return;
    console.error('[pmd] Trace search failed:', e);
    state.errors = [`Search: ${(e as Error).message || 'read failed'}`];
    state.loading = false;
    // Preserve the previous successful results rather than replacing them
    // with a false "No production records" conclusion.
    render();
  }
}
