import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord } from '../types';
import { STATUS_MAP } from '../core/status';
import {
  SLOTS_PER_SHIFT,
  currentShift,
  currentSlotIndex,
  shiftBounds,
  slotClock,
} from '../core/shifts';
import { bdLabelFor } from '../core/breakdown';
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
 *  5 min is a management-pace refresh — the per-job cross-shift Good
 *  fetches needed by Job Left / Shift Target make a tighter poll
 *  expensive against SharePoint, and supervisors using this view want
 *  a stable picture, not a per-keystroke ticker. */
const LIVE_POLL_MS = 5 * 60_000;

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

function renderCard(r: TraceRow): string {
  const slots = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const ch = r.timeline[i] ?? '·';
    const def = ch === '·' ? null : STATUS_MAP[ch];
    const style = def
      ? `background:${def.color};color:${def.text};border-color:${def.border}`
      : 'background:#f1f5f9;color:#94a3b8';
    return `<div class="trace-slot" title="${escapeHtml(slotClock(r.shiftId, i))} · ${escapeHtml(
      def?.label ?? 'Empty',
    )}" style="${style}">${ch}</div>`;
  }).join('');

  const dateLabel = r.shiftId.slice(0, 10);
  const shiftLabel = r.shiftId.slice(11);
  const rejLines = r.rejects.length
    ? `<div class="trace-section"><b>Rejects</b><ul>${r.rejects
        .map((p) => {
          let obj: Record<string, number> = {};
          try {
            obj = p.rejects ? JSON.parse(p.rejects) : {};
          } catch {
            obj = {};
          }
          const parts = Object.entries(obj)
            .filter(([, v]) => v)
            .map(([k, v]) => `${escapeHtml(k)} × ${v}`)
            .join(', ');
          if (!parts) return '';
          return `<li><span class="ts">${escapeHtml(slotClock(r.shiftId, p.slotIndex))}</span> ${parts}</li>`;
        })
        .filter(Boolean)
        .join('')}</ul></div>`
    : '';
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
  // Per-slot Quality Checks row — rendered above the status timeline in
  // a matching 16-column grid so a signed cell sits directly over the
  // status it confirmed (e.g. `GM` above an `R` block, just like the
  // operator sheet). Read-only here; the operator sheet owns editing.
  const qcCells = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    const p = qcCellPresentation(i, r.qcBySlot[i] ?? '');
    return `<div class="trace-qc-slot qc-${p.role}${p.signed ? ' is-signed' : ''}" title="${p.title}">${p.label}</div>`;
  }).join('');

  // Live view: machine name in plain text on the left for identity,
  // activity badge on the right so the supervisor can scan the floor
  // and see at a glance which line is running, which is in
  // changeover, which is down. The rail + tint carry the colour
  // signal — a dedicated machine swatch was distracting on top.
  // Search view keeps the older job-first layout.
  const isLive = S!.view === 'live';
  const activity = activityFor(r);
  const activityCol = ACTIVITY_COLOURS[activity];
  const machineName = `<b class="trace-machine">${escapeHtml(r.machineCode)}</b>`;
  const activityBadge = isLive
    ? `<span class="trace-activity" style="background:${activityCol}">${escapeHtml(ACTIVITY_LABELS[activity])}</span>`
    : r.idle
      ? `<span class="trace-idle">Idle</span>`
      : '';
  const headline = isLive
    ? `${machineName}<span class="trace-job">${escapeHtml(r.jobNumber || '(no job)')}</span>${activityBadge}<span class="trace-meta">${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>`
    : `<b>${escapeHtml(r.jobNumber || '(no job)')}</b>${activityBadge}<span class="trace-meta">${escapeHtml(r.machineCode)} · ${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>`;

  return `<div class="trace-card${r.idle ? ' is-idle' : ''}${isLive ? ' is-live' : ''} act-${activity}" style="${isLive ? `--mc:${activityCol}` : ''}">
    <div class="trace-card-head">
      ${headline}
      <span class="trace-meta">${escapeHtml(r.partNumber)}${r.partDescription ? ' — ' + escapeHtml(r.partDescription) : ''}</span>
    </div>
    <div class="trace-card-people">
      Operator: <b>${escapeHtml(r.operator || '—')}</b> · Supervisor: <b>${escapeHtml(r.supervisor || '—')}</b>
    </div>
    <div class="trace-card-totals">
      <span>Order Qty <b>${r.orderQty ?? '—'}</b></span>
      <span>Job Left <b>${r.jobLeft ?? '—'}</b></span>
      <span>Shift Target <b>${r.shiftTarget ?? '—'}</b></span>
      <span class="g">Good <b>${r.good}</b></span>
      <span class="r">Reject <b>${r.reject}</b></span>
    </div>
    <div class="trace-qc-row">${qcCells}</div>
    <div class="trace-timeline">${slots}</div>
    ${rejLines}
    ${bdLines}
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
  if (!opts.silent) {
    S!.loading = true;
    render();
  }
  const live = currentShift(new Date());
  const [rows, planning] = await Promise.all([
    dalRef.listProduction({ shiftId: live.shiftId }).catch((err) => {
      console.warn('[pmd] live trace listProduction failed:', err);
      return [] as ProductionRecord[];
    }),
    dalRef.listPlanning({}).catch(() => [] as PlanningOrder[]),
  ]);
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));
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
    out.push(latestRow(machineRows));
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
    const cs = Number(canonical?.countStart ?? 0);
    const ce = Number(canonical?.countEnd ?? 0);
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
    // Job-wide Good. Prefer the cross-shift total when the caller could
    // compute one; the `has()` guard (not `??`) is deliberate — a failed
    // history fetch stores 0 in the map, and treating that as "good"
    // would render Job Left = full order quantity. Falling back to this
    // tuple's own good keeps the number conservative.
    const jobGood = jobGoodTotals.has(jobNumber)
      ? jobGoodTotals.get(jobNumber)!
      : Math.max(0, ce - cs - totalRej);
    // Job Left + Shift Target come from the same pure formulas the
    // operator side panel uses, so the two pages cannot drift apart.
    const jobLeft = plan ? jobLeftPiecesFor(plan, jobGood) : null;
    const shiftTargetVal =
      plan && jobLeft != null ? shiftTargetFor(plan, jobLeft) : null;
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
      good: Math.max(0, ce - cs - totalRej),
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
      const cs = Number(r.countStart ?? 0);
      const ce = Number(r.countEnd ?? 0);
      grossByTuple.set(tuple, Math.max(0, ce - cs));
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
async function loadJobGoodTotals(jobNumbers: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(jobNumbers.filter(Boolean)));
  const out = new Map<string, number>();
  await Promise.all(
    unique.map(async (job) => {
      try {
        const recs = await dalRef.listProduction({ jobNumber: job });
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

async function doSearch(): Promise<void> {
  const q = S!.query;
  if (!q.jobNumber && !q.dateFrom && !q.dateTo) {
    return;
  }
  S!.loading = true;
  render();

  const all: ProductionRecord[] = [];
  if (q.jobNumber) {
    all.push(...(await dalRef.listProduction({ jobNumber: q.jobNumber.trim() })));
  } else {
    const filter: {
      shiftIdFrom?: string;
      shiftIdTo?: string;
      machineCode?: string;
    } = {};
    if (q.dateFrom) filter.shiftIdFrom = `${q.dateFrom}-`;
    if (q.dateTo) filter.shiftIdTo = `${q.dateTo}-￿`;
    if (q.machine) filter.machineCode = q.machine;
    all.push(...(await dalRef.listProduction(filter)));
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
  rows.sort((a, b) => (a.shiftId < b.shiftId ? 1 : -1));
  S!.results = rows;
  S!.searched = true;
  S!.loading = false;
  render();
}
