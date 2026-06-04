import type { PmdDataLayer } from '../dal';
import type { Machine, PlanningOrder, ProductionRecord } from '../types';
import { STATUS_MAP } from '../core/status';
import { SLOTS_PER_SHIFT, currentShift, slotClock } from '../core/shifts';
import { bdLabelFor } from '../core/breakdown';
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
  rejects: ProductionRecord[];
  bdSlots: { slot: number; code: string; ticket: string; note: string }[];
  records: ProductionRecord[];
  /** True when this row is just a placeholder for an idle machine on
   *  the live view — render the card with a muted "Idle" badge. */
  idle?: boolean;
}

let S: TraceState | null = null;
let dalRef: PmdDataLayer;

export async function renderTrace(dal: PmdDataLayer): Promise<void> {
  dalRef = dal;
  const machines = await dal.listMachines();
  S = {
    view: 'live',
    query: { jobNumber: '', dateFrom: '', dateTo: '', machine: '' },
    machines,
    results: [],
    liveRows: [],
    searched: false,
    loading: true,
  };
  document.body.className = 'shift-day'; // neutral theme on trace page
  render();
  await loadLive();
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
  const head = `
    <div class="trace-search">
      <h2>📡 Live Status — every press right now</h2>
      <p class="bd-sub">What each machine is on this shift. Tap <b>🔍 Job Number Search</b> above to look up a past order.</p>
    </div>`;
  if (S!.loading) {
    return head + `<div class="trace-empty">Loading live status…</div>`;
  }
  if (S!.liveRows.length === 0) {
    return head + `<div class="trace-empty">No machines configured.</div>`;
  }
  return head + `<div class="trace-results">${S!.liveRows.map(renderCard).join('')}</div>`;
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

  const idleBadge = r.idle ? `<span class="trace-idle">Idle</span>` : '';

  return `<div class="trace-card${r.idle ? ' is-idle' : ''}">
    <div class="trace-card-head">
      <b>${escapeHtml(r.jobNumber || '(no job)')}</b>
      ${idleBadge}
      <span class="trace-meta">${escapeHtml(r.machineCode)} · ${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel)}</span>
      <span class="trace-meta">${escapeHtml(r.partNumber)}${r.partDescription ? ' — ' + escapeHtml(r.partDescription) : ''}</span>
    </div>
    <div class="trace-card-people">
      Operator: <b>${escapeHtml(r.operator || '—')}</b> · Supervisor: <b>${escapeHtml(r.supervisor || '—')}</b>
    </div>
    <div class="trace-card-totals">
      <span>Count Start <b>${r.countStart ?? '—'}</b></span>
      <span>Count End <b>${r.countEnd ?? '—'}</b></span>
      <span class="g">Good <b>${r.good}</b></span>
      <span class="r">Reject <b>${r.reject}</b></span>
    </div>
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
      if (v === 'live' && S!.liveRows.length === 0) void loadLive();
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
async function loadLive(): Promise<void> {
  S!.loading = true;
  render();
  const live = currentShift(new Date());
  const [rows, planning] = await Promise.all([
    dalRef.listProduction({ shiftId: live.shiftId }).catch((err) => {
      console.warn('[pmd] live trace listProduction failed:', err);
      return [] as ProductionRecord[];
    }),
    dalRef.listPlanning({}).catch(() => [] as PlanningOrder[]),
  ]);
  const planByJob = new Map(planning.map((p) => [p.jobNumber, p]));
  const byMachine = new Map<string, ProductionRecord[]>();
  for (const r of rows) {
    const arr = byMachine.get(r.machineCode) ?? [];
    arr.push(r);
    byMachine.set(r.machineCode, arr);
  }
  const out: TraceRow[] = [];
  for (const m of S!.machines) {
    const recs = byMachine.get(m.machineCode) ?? [];
    if (recs.length === 0) {
      out.push(idlePlaceholder(m.machineCode, live.shiftId));
      continue;
    }
    out.push(...buildTraceRowsFor(recs, planByJob));
  }
  S!.liveRows = out;
  S!.loading = false;
  render();
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
    rejects: [],
    bdSlots: [],
    records: [],
    idle: true,
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
    const plan = planByJob.get(jobNumber);
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
      rejects: list.filter((r) => r.rejectCount > 0 || r.rejects !== '{}'),
      bdSlots,
      records: list,
    });
  }
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

  const rows = buildTraceRowsFor(filtered, planByJob);
  rows.sort((a, b) => (a.shiftId < b.shiftId ? 1 : -1));
  S!.results = rows;
  S!.searched = true;
  S!.loading = false;
  render();
}
