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
import { bdLabelFor } from '../core/breakdown';
import { cavityGross } from '../core/metrics';
import { ordersCoRun, type DieCoRun } from '../core/corun';
import {
  jobLeftPiecesFor,
  qcCellPresentation,
  shiftTargetFor,
} from './operator';
import { escapeHtml } from './modal';

type TraceView = 'live' | 'search';

interface TraceState {
  view: TraceView;
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
}

interface TraceRow {
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
/** Auto-refresh + now-line ticker. Cleared on renderTrace re-entry and
 *  whenever the user switches to the search tab so we don't leak
 *  fetches when no one is looking. */
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

export async function renderTrace(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  stopLivePoll();
  const machines = await dal.listMachines();
  S = {
    view: 'live',
    query: { jobNumber: '', dateFrom: '', dateTo: '', machine: '' },
    machines,
    results: [],
    liveRows: [],
    searched: false,
    loading: true,
    lastUpdated: null,
  };
  document.body.className = 'shift-day'; // neutral theme on trace page
  render();
  await loadLive();
  startLivePoll();
}

function startLivePoll(): void {
  stopLivePoll();
  livePollTimer = setInterval(() => {
    // Bail (and self-cancel) when the user has routed away from
    // trace — renderOperator / renderKpi blow away the `.trace`
    // container, so its absence is a reliable navigation signal.
    if (!document.querySelector('.trace')) {
      stopLivePoll();
      return;
    }
    if (!S || S.view !== 'live') return;
    void loadLive({ silent: true });
  }, LIVE_POLL_MS);
  // Refresh the now-line every 30 s so the red line walks across the
  // timeline in real time even when no new data has arrived.
  nowLineTimer = setInterval(() => {
    if (!document.querySelector('.trace')) {
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
  if (!document.querySelector('.trace') || !S || S.view !== 'live') return;
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
  const app = document.getElementById('app')!;
  const tabs = `
    <div class="trace-tabs">
      <button class="shift-btn${S!.view === 'live' ? ' a' : ''}" data-tab="live">📡 Live Status</button>
      <button class="shift-btn${S!.view === 'search' ? ' a' : ''}" data-tab="search">🔍 Job Number Search</button>
    </div>`;
  const body = S!.view === 'live' ? renderLiveBody() : renderSearchBody();
  app.innerHTML = `<div class="trace">${tabs}${body}</div>`;
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
      <h2>🔍 Production Traceability</h2>
      <p class="bd-sub">Search by Job Number or date range to see what each machine was doing slot-by-slot.</p>
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
  return `<div class="trace-results">${S!.results.map(renderCard).join('')}</div>`;
}

/**
 * The three aligned 16-column rows for one shift: QC sign-offs, the
 * status timeline (each slot's tooltip names any reject in it), and the
 * per-slot reject-code annotation (positioned under the status it
 * happened in, e.g. 09:00 D07×2). Shared by the per-shift card and the
 * day-grouped popup card so both stay in lock-step.
 */
function traceGrids(r: TraceRow): { qc: string; timeline: string; rej: string } {
  const rejBySlot: Record<number, string[]> = {};
  for (const p of r.rejects) {
    let obj: Record<string, number> = {};
    try {
      obj = p.rejects ? JSON.parse(p.rejects) : {};
    } catch {
      obj = {};
    }
    const parts = Object.entries(obj)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}×${v}`);
    if (parts.length) rejBySlot[p.slotIndex] = parts;
  }
  const hasRejects = Object.keys(rejBySlot).length > 0;
  const rej = hasRejects
    ? `<div class="trace-rej-row">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
        const codes = rejBySlot[i];
        if (!codes) return `<div class="trace-rej-slot"></div>`;
        return `<div class="trace-rej-slot has-rej" title="${escapeHtml(
          slotClock(r.shiftId, i),
        )} · ${escapeHtml(codes.join(', '))}">${codes.map(escapeHtml).join('<br>')}</div>`;
      }).join('')}</div>`
    : '';

  const timeline = `<div class="trace-timeline">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const ch = r.timeline[i] ?? '·';
    const def = ch === '·' ? null : STATUS_MAP[ch];
    const style = def
      ? `background:${def.color};color:${def.text};border-color:${def.border}`
      : 'background:#f1f5f9;color:#94a3b8';
    const rejTip = rejBySlot[i] ? ` · Reject ${rejBySlot[i].join(', ')}` : '';
    return `<div class="trace-slot" title="${escapeHtml(slotClock(r.shiftId, i))} · ${escapeHtml(
      (def?.label ?? 'Empty') + rejTip,
    )}" style="${style}">${ch}</div>`;
  }).join('')}</div>`;

  const qc = `<div class="trace-qc-row">${Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const p = qcCellPresentation(i, r.qcBySlot[i] ?? '');
    return `<div class="trace-qc-slot qc-${p.role}${p.signed ? ' is-signed' : ''}" title="${p.title}">${p.label}</div>`;
  }).join('')}</div>`;

  return { qc, timeline, rej };
}

function renderCard(r: TraceRow): string {
  const grids = traceGrids(r);
  const dateLabel = r.shiftId.slice(0, 10);
  const shiftLabel = r.shiftId.slice(11);
  const bdLines = r.bdSlots.length
    ? `<div class="trace-section"><b>Breakdowns</b><ul>${r.bdSlots
        .map(
          (b) =>
            `<li><span class="ts">${escapeHtml(slotClock(r.shiftId, b.slot))}</span> <span class="bd-code">${escapeHtml(
              b.code,
            )}</span> ${escapeHtml(bdLabelFor(b.code))}${
              b.ticket ? ` · ${escapeHtml(b.ticket)}` : ''
            }${b.note ? ` — ${escapeHtml(b.note)}` : ''}</li>`,
        )
        .join('')}</ul></div>`
    : '';
  // Live view: machine name in plain text on the left for identity,
  // activity badge on the right so the supervisor can scan the floor
  // and see at a glance which line is running, which is in
  // changeover, which is down. The rail + tint carry the colour
  // signal — a dedicated machine swatch was distracting on top.
  // Search view keeps the older job-first layout. `S` is null when a card
  // is rendered outside the Trace tab (the KPI job-number popup), which is
  // the search layout too — so default isLive to false there.
  const isLive = S?.view === 'live';
  const activity = activityFor(r);
  const activityCol = ACTIVITY_COLOURS[activity];
  const machineName = `<b class="trace-machine">${escapeHtml(r.machineCode)}</b>`;
  const activityBadge = isLive
    ? `<span class="trace-activity" style="background:${activityCol}">${escapeHtml(ACTIVITY_LABELS[activity])}</span>`
    : r.idle
      ? `<span class="trace-idle">Idle</span>`
      : '';
  // Co-run badge: this order shares its die with another running on the
  // same press at the same time (both flagged CoRun=Yes).
  const coRunBadge = r.coRun
    ? `<span class="trace-corun" title="Co-running with another order on the same die">⛓ Co-run</span>`
    : '';
  const headline = isLive
    ? `${machineName}<span class="trace-job">${escapeHtml(r.jobNumber || '(no job)')}</span>${activityBadge}${coRunBadge}<span class="trace-meta">${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>`
    : `<b>${escapeHtml(r.jobNumber || '(no job)')}</b>${activityBadge}${coRunBadge}<span class="trace-meta">${escapeHtml(r.machineCode)} · ${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>`;

  return `<div class="trace-card${r.idle ? ' is-idle' : ''}${isLive ? ' is-live' : ''} act-${activity}" style="${isLive ? `--mc:${activityCol}` : ''}">
    <div class="trace-card-head">
      ${headline}
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
    ${grids.qc}
    ${grids.timeline}
    ${grids.rej}
    ${bdLines}
  </div>`;
}

/**
 * A whole day for one press: the (up to three) shifts that ran on the
 * same date, laid out side-by-side in one row so a multi-day job reads
 * day-by-day instead of as a long stack of per-shift cards. Each shift
 * block carries its own QC / status / reject grids and a compact header
 * (operator, Good, Reject, Job Left). Shifts that didn't run are omitted.
 */
function renderJobDayCard(machineCode: string, date: string, rows: TraceRow[]): string {
  const byCode = new Map(rows.map((r) => [r.shiftId.slice(11), r]));
  const first = rows[0];
  const partMeta = first.partNumber
    ? `<span class="trace-meta">${escapeHtml(first.partNumber)}${
        first.partDescription ? ' — ' + escapeHtml(first.partDescription) : ''
      }</span>`
    : '';
  const blocks = SHIFTS.map((s) => {
    const r = byCode.get(s.code);
    if (!r) return '';
    const grids = traceGrids(r);
    return `<div class="trace-day-shift">
      <div class="trace-day-shift-hd">
        <b>${escapeHtml(s.code)}</b>
        <span>Op ${escapeHtml(r.operator || '—')}</span>
        <span class="g">G ${r.good}</span>
        <span class="r">R ${r.reject}</span>
        <span>Left ${r.jobLeft ?? '—'}</span>
      </div>
      ${grids.qc}
      ${grids.timeline}
      ${grids.rej}
    </div>`;
  }).join('');
  return `<div class="trace-card trace-day-card">
    <div class="trace-card-head">
      <b>${escapeHtml(first.jobNumber || '(no job)')}</b>
      <span class="trace-meta">${escapeHtml(machineCode)} · ${escapeHtml(date)}</span>
      ${partMeta}
    </div>
    <div class="trace-day-shifts">${blocks}</div>
  </div>`;
}

function wire(): void {
  const app = document.getElementById('app')!;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.tab as TraceView;
      if (v === S!.view) return;
      S!.view = v;
      render();
      if (v === 'live') {
        if (S!.liveRows.length === 0) void loadLive();
        else drawNowLines();
        startLivePoll();
      } else {
        stopLivePoll();
      }
    }),
  );
  app.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-q]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.q as keyof TraceState['query'];
      (S!.query as Record<string, string>)[k] = (el as HTMLInputElement).value;
    }),
  );
  app.querySelector('[data-search]')?.addEventListener('click', () => void doSearch());
  app.querySelectorAll<HTMLInputElement>('input[data-q="jobNumber"]').forEach((el) =>
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
  lastLiveLoadMs = Date.now();
  if (!opts.silent) {
    S!.loading = true;
    render();
  }
  const live = currentShift(new Date());
  const [rows, planning, dieList] = await Promise.all([
    dalRef.listProduction({ shiftId: live.shiftId }).catch((err) => {
      console.warn('[pmd] live trace listProduction failed:', err);
      return [] as ProductionRecord[];
    }),
    dalRef.listPlanning({}).catch(() => [] as PlanningOrder[]),
    dalRef.listProductDieColors
      ? dalRef.listProductDieColors().catch(() => [])
      : Promise.resolve([]),
  ]);
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
  );
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
  const sortedMachines = S!.machines.slice().sort((a, b) => {
    const aActive = (byMachine.get(a.machineCode) ?? []).length > 0 ? 0 : 1;
    const bActive = (byMachine.get(b.machineCode) ?? []).length > 0 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return floorIndex(a.machineCode) - floorIndex(b.machineCode);
  });
  const out: TraceRow[] = [];
  for (const m of sortedMachines) {
    const recs = byMachine.get(m.machineCode) ?? [];
    if (recs.length === 0) {
      out.push(idlePlaceholder(m.machineCode, live.shiftId));
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
      out.push({ ...latest, coRun: true });
      for (const row of coRunners) out.push({ ...row, coRun: true });
    } else {
      out.push(latest);
    }
  }
  S!.liveRows = out;
  S!.lastUpdated = new Date();
  S!.loading = false;
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
  document.querySelectorAll<HTMLElement>('.trace-card.is-live .trace-timeline').forEach((tl) => {
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

function idlePlaceholder(machineCode: string, shiftId: string): TraceRow {
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
  for (const r of records) {
    const key = `${r.machineCode}|${r.shiftId}|${r.jobNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
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
          ? shiftTargetFor(plan, jobLeft)
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

async function loadJobGoodTotals(jobNumbers: string[]): Promise<Map<string, number>> {
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
      }
    }),
  );
  return out;
}

/**
 * Render the Trace detail card(s) for a single job as standalone HTML —
 * used by the KPI table's job-number popup. Loads the job's full
 * signed-off history through the passed DAL (works even if the Trace tab
 * was never opened this session). Up to 3 shifts render as the usual
 * detailed per-shift cards; a longer job switches to day-grouped cards —
 * each date's Day/Afternoon/Night shifts laid side-by-side in one row so
 * it reads day-by-day. Sorted machine → newest date first. Returns an
 * empty-state message when the job has no signed-off records.
 */
export async function renderJobTraceCards(
  dal: PmdDataLayer,
  jobNumber: string,
): Promise<string> {
  dalRef = dal;
  const job = jobNumber.trim();
  const all = await readSignedOff({ jobNumber: job });
  if (all.length === 0) {
    return `<div class="trace-empty">No signed-off production records for ${escapeHtml(
      job,
    )}.</div>`;
  }
  const planning = await dal.listPlanning({});
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));
  const jobGoodTotals = new Map([[job, goodForRecords(all)]]);
  const rows = buildTraceRowsFor(all, planByJob, jobGoodTotals);
  const byMachineNewest = (a: TraceRow, b: TraceRow): number =>
    a.machineCode !== b.machineCode
      ? a.machineCode < b.machineCode
        ? -1
        : 1
      : a.shiftId < b.shiftId
        ? 1
        : -1;
  rows.sort(byMachineNewest);
  // ≤3 shifts: the detailed per-shift cards read fine and carry the full
  // Order Qty / Job Left / Shift Target line. Beyond that the stack gets
  // long, so group each (machine, date) into one day card with its shifts
  // side-by-side — one row per day is more scannable.
  if (rows.length <= 3) {
    return `<div class="trace-results">${rows.map(renderCard).join('')}</div>`;
  }
  const byDay = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const key = `${r.machineCode}|${r.shiftId.slice(0, 10)}`;
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(r);
  }
  // Map insertion order already follows the machine→newest-date sort.
  const cards = Array.from(byDay.entries()).map(([key, dayRows]) => {
    const [machineCode, date] = key.split('|');
    return renderJobDayCard(machineCode, date, dayRows);
  });
  return `<div class="trace-results">${cards.join('')}</div>`;
}

async function doSearch(): Promise<void> {
  const q = S!.query;
  if (!q.jobNumber && !q.dateFrom && !q.dateTo) {
    return;
  }
  S!.loading = true;
  render();

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
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));

  // Job-wide Good totals for Job Left / Shift Target. A Job Number search
  // already pulled that job's complete history into `all`, so total it
  // directly; a date-range search only sees a window, so fetch each job's
  // full history to keep the numbers job-wide rather than window-wide.
  let jobGoodTotals: Map<string, number>;
  if (q.jobNumber) {
    jobGoodTotals = new Map([[q.jobNumber.trim(), goodForRecords(all)]]);
  } else {
    jobGoodTotals = await loadJobGoodTotals(filtered.map((r) => r.jobNumber));
  }

  const rows = buildTraceRowsFor(filtered, planByJob, jobGoodTotals);
  // Group by machine, then newest shift first within each machine, so a
  // multi-machine / multi-day search reads as one press's timeline at a
  // time (D01 newest→oldest, then D02, …) instead of the whole floor
  // interleaved by date.
  rows.sort((a, b) =>
    a.machineCode !== b.machineCode
      ? a.machineCode < b.machineCode
        ? -1
        : 1
      : a.shiftId < b.shiftId
        ? 1
        : -1,
  );
  S!.results = rows;
  S!.searched = true;
  S!.loading = false;
  render();
}
