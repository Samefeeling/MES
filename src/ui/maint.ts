// 🛠 Maint → Machine and Team. The Tool page (die.ts) owns the shared load
// and hands these two what they need through `MaintCtx`, so a die tapped on
// the Machine page opens the same die drilldown the Tool page does.
//
//   Machine  one row per piece of equipment (MachinePM.csv's Name, the nine
//            presses first): its dies, open work orders, next PM from
//            MachinePM.csv, and MTBF / MTTR from the Mango breakdowns.
//   Team     what the maintenance team closed — orders and labour hours per
//            owner on a zoomable time axis — and everything still open,
//            work orders and PM, with whether it is due.

import type { DieMaintenanceRequest, MachinePmEvent } from '../types';
import {
  MACHINE_STATE_META,
  UNASSIGNED,
  bucketDone,
  buildMachineRows,
  daysUntil,
  doneOrders,
  dueLevel,
  earliestOrder,
  openWork,
  unitFor,
  type BucketUnit,
  type DueLevel,
  type MachineRow,
  type OpenItem,
} from '../core/maint';
import { closeModal, escapeHtml, openModal } from './modal';

export interface MachineDie {
  die: string;
  /** Running on this press now, per the plan. */
  running: boolean;
  /** Hover text: when it ran / is next planned. */
  title: string;
}

export interface MaintCtx {
  today: string;
  pm: MachinePmEvent[];
  /** Plant/equipment work orders (Mango, not dies). */
  machineOrders: DieMaintenanceRequest[];
  /** Die work orders (Mango). With the machine ones, the team's whole workload. */
  dieOrders: DieMaintenanceRequest[];
  /** Typed into the bar's filter box. */
  filter: string;
  /** The dies that ran on, or are planned for, a press. */
  diesFor(code: string): MachineDie[];
  openDie(die: string): void;
  /** The Tool page's work-order card, for the machine popup. */
  woRow(r: DieMaintenanceRequest): string;
  rerender(): void;
}

const MANGO_HOME = 'https://my.mangolive.com/';

const ddmmyyyy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || '—';
};

const LEVEL_TEXT: Record<DueLevel, string> = {
  overdue: 'Overdue',
  soon: 'Due ≤ 7 d',
  ok: 'Not due',
  none: 'No date',
};

function dueBadge(due: string, today: string): string {
  const level = dueLevel(due, today);
  if (level === 'none') return '<span class="mt-due none">No date</span>';
  const d = daysUntil(due, today);
  const rel = d < 0 ? `${-d} d late` : d === 0 ? 'today' : `in ${d} d`;
  return `<span class="mt-due ${level}" title="${escapeHtml(`${LEVEL_TEXT[level]} · ${rel}`)}">${ddmmyyyy(due)} · ${rel}</span>`;
}

const fmtH = (h: number | null): string =>
  h == null ? '—' : h >= 48 ? `${(h / 24).toFixed(h >= 240 ? 0 : 1)} d` : `${h.toFixed(h >= 10 ? 0 : 1)} h`;

// ---------------------------------------------------------------------
// Machine

type MachineSort = 'default' | 'machine' | 'state' | 'next' | 'open' | 'breakdowns' | 'mtbf' | 'mttr';
let machineSort: MachineSort = 'default';
let machineDir: 1 | -1 = 1;
let machineState: MachineRow['state'] | '' = '';

function machineRows(ctx: MaintCtx): MachineRow[] {
  return buildMachineRows(ctx.pm, ctx.machineOrders, ctx.today, earliestOrder([...ctx.machineOrders, ...ctx.dieOrders]));
}

const MACHINE_ACCESS: Record<Exclude<MachineSort, 'default'>, (r: MachineRow) => string | number | null> = {
  machine: (r) => r.asset.toUpperCase(),
  state: (r) => MACHINE_STATE_META[r.state].rank,
  next: (r) => r.nextPm?.dueDate || null,
  open: (r) => r.openOrders,
  breakdowns: (r) => r.reliability.breakdowns,
  mtbf: (r) => r.reliability.mtbfH,
  mttr: (r) => r.reliability.mttrH,
};

export function renderMachineBoard(ctx: MaintCtx): string {
  const all = machineRows(ctx);
  const f = ctx.filter.trim().toUpperCase();
  let rows = all.filter(
    (r) =>
      (!machineState || r.state === machineState) &&
      (!f ||
        r.asset.toUpperCase().includes(f) ||
        r.code.toUpperCase().includes(f) ||
        r.description.toUpperCase().includes(f) ||
        (r.code && ctx.diesFor(r.code).some((d) => d.die.toUpperCase().includes(f)))),
  );
  if (machineSort !== 'default') {
    const get = MACHINE_ACCESS[machineSort];
    rows = [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -machineDir : av > bv ? machineDir : 0;
    });
  }
  const chip = (st: MachineRow['state']): string => {
    const n = all.filter((r) => r.state === st).length;
    const on = machineState === st;
    return `<button type="button" class="die-chip mt-chip ${MACHINE_STATE_META[st].cls}${on ? ' on' : ''}" data-mt-state="${st}" aria-pressed="${on}">${MACHINE_STATE_META[st].label} <b>${n}</b></button>`;
  };
  const noPm = ctx.pm.length === 0;
  const chips = `<div class="die-chips">
    <span class="die-chip">Equipment <b>${rows.length === all.length ? all.length : `${rows.length} of ${all.length}`}</b></span>
    ${(['breakdown', 'overdue', 'soon', 'ok'] as const).map(chip).join('')}
    <a class="die-chip die-chip-btn" href="${MANGO_HOME}" target="_blank" rel="noopener">🥭 Mango</a>
  </div>${
    noPm
      ? '<div class="data-error-banner">MachinePM.csv was not read — Next service is empty. It is read from the Planning.csv folder (or VITE_MACHINE_PM_CSV_PATH).</div>'
      : ''
  }`;
  const th = (key: MachineSort | '', label: string, title = ''): string => {
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    if (!key) return `<th${t}>${label}</th>`;
    const on = machineSort === key;
    return `<th class="die-sort${on ? ' a' : ''}" data-mt-sort="${key}"${t}>${label}${on ? (machineDir === 1 ? ' ▲' : ' ▼') : ''}</th>`;
  };
  const body = rows
    .map((r) => {
      const dies = r.code ? ctx.diesFor(r.code) : [];
      const dieCell = dies.length
        ? dies
            .map(
              (d) =>
                `<button class="die-link${d.running ? ' mt-die-now' : ''}" data-mt-die="${escapeHtml(d.die)}" title="${escapeHtml(d.title)}">${d.running ? '▶ ' : ''}${escapeHtml(d.die)}</button>`,
            )
            .join(' ')
        : '<span class="die-tstat none">—</span>';
      const rel = r.reliability;
      const relTip = `${rel.breakdowns} breakdown${rel.breakdowns === 1 ? '' : 's'} in ${rel.windowDays} d · ${rel.downtimeH.toFixed(1)} h downtime`;
      const next = r.nextPm;
      const open = r.orders.filter((o) => o.status !== 'done');
      const openOverdue = open.some((o) => dueLevel(o.dueDate, ctx.today) === 'overdue');
      return `<tr class="${r.code ? 'mt-press' : ''}">
        <td class="die-num"><button class="die-link mt-link" data-mt-machine="${escapeHtml(r.asset)}" title="PM plan and work orders">${escapeHtml(r.code || r.asset)}</button></td>
        <td class="die-desc" title="${escapeHtml(r.asset)}">${escapeHtml(r.code ? r.asset : r.description || r.department || '—')}</td>
        <td><span class="mt-state ${MACHINE_STATE_META[r.state].cls}">${MACHINE_STATE_META[r.state].label}</span></td>
        <td>${r.lastService ? ddmmyyyy(r.lastService) : '<span class="die-tstat none">—</span>'}</td>
        <td class="mt-dies">${dieCell}</td>
        <td class="num">${
          open.length
            ? `<button class="die-maint-badge${openOverdue ? ' wo-overdue' : ' wo-ok'}" data-mt-machine="${escapeHtml(r.asset)}">🛠 ${open.length}</button>`
            : '0'
        }</td>
        <td>${next?.dueDate ? dueBadge(next.dueDate, ctx.today) : '<span class="die-tstat none">—</span>'}</td>
        <td class="mt-detail" title="${escapeHtml(next ? [next.detail, next.frequency && `every ${next.frequency}`, next.owner].filter(Boolean).join(' · ') : '')}">${escapeHtml(next?.detail || '—')}</td>
        <td class="num" title="${escapeHtml(relTip)}">${rel.breakdowns}</td>
        <td class="num" title="${escapeHtml(`Mean time between failures — ${relTip}`)}">${rel.breakdowns ? fmtH(rel.mtbfH) : `> ${rel.windowDays} d`}</td>
        <td class="num" title="Mean time to repair — Mango Downtime per breakdown">${fmtH(rel.mttrH)}</td>
        <td class="num">${rel.availability == null ? '—' : `${(rel.availability * 100).toFixed(1)}%`}</td>
      </tr>`;
    })
    .join('');
  return `${chips}<div class="die-table-wrap"><table class="kpi-table die-table mt-table">
    <thead><tr>
      ${th('machine', 'Machine')}
      ${th('', 'Name', "MachinePM.csv's Name — the same as Mango's Plant/Equipment")}
      ${th('state', 'Status', '🔴 an open breakdown · 🟠 a PM or work order overdue · 🟡 one due within 7 days · 🟢 nothing due')}
      ${th('', 'Last service', 'The last preventive or calibration work order closed in Mango')}
      ${th('', 'Die #', 'Dies that ran on the press in the last 90 days or are planned on it — ▶ = running now. Tap a die for its detail')}
      ${th('open', 'Open MR', 'Open Mango maintenance requests — tap for the machine’s PM plan and work orders')}
      ${th('next', 'Next service', "MachinePM.csv Event Due Date — the soonest live PM event")}
      ${th('', 'Event detail', 'MachinePM.csv Event Detail of that event')}
      ${th('breakdowns', 'Breakdowns', 'Mango "2. Breakdown" orders raised in the last 12 months (or since the export begins)')}
      ${th('mtbf', 'MTBF', 'Mean time between failures: calendar hours in the window, less downtime, ÷ breakdowns')}
      ${th('mttr', 'MTTR', 'Mean time to repair: Mango Downtime ÷ breakdowns that recorded it')}
      ${th('', 'Avail.', 'MTBF ÷ (MTBF + MTTR)')}
    </tr></thead>
    <tbody>${body || '<tr><td colspan="12" class="trace-empty">No equipment matches.</td></tr>'}</tbody>
  </table></div>
  <p class="kpi-note">The nine presses first, then the rest of the equipment in MachinePM.csv, worst first. <b>Next service</b> and <b>Event detail</b> come from MachinePM.csv; work orders from MangoWorkOrders.csv, joined on the equipment's name. <b>MTBF</b> and <b>MTTR</b> are from the Mango breakdowns over the last 12 months (or since the export begins) on calendar time — they read high against running hours, but compare machine to machine.</p>`;
}

export function wireMachineBoard(root: HTMLElement, ctx: MaintCtx): void {
  root.querySelectorAll<HTMLButtonElement>('[data-mt-state]').forEach((b) =>
    b.addEventListener('click', () => {
      const st = b.dataset.mtState as MachineRow['state'];
      machineState = machineState === st ? '' : st;
      ctx.rerender();
    }),
  );
  root.querySelectorAll<HTMLElement>('[data-mt-sort]').forEach((el) =>
    el.addEventListener('click', () => {
      const key = el.dataset.mtSort as MachineSort;
      if (machineSort === key) machineDir = machineDir === 1 ? -1 : 1;
      else {
        machineSort = key;
        // Worst first: soonest due, most open, most breakdowns, shortest MTBF, longest MTTR.
        machineDir = key === 'open' || key === 'breakdowns' || key === 'mttr' ? -1 : 1;
      }
      ctx.rerender();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-mt-die]').forEach((b) =>
    b.addEventListener('click', () => ctx.openDie(b.dataset.mtDie!)),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-mt-machine]').forEach((b) =>
    b.addEventListener('click', () => {
      const row = machineRows(ctx).find((r) => r.asset === b.dataset.mtMachine);
      if (row) openMachineDetail(row, ctx);
    }),
  );
}

function openMachineDetail(row: MachineRow, ctx: MaintCtx): void {
  const open = row.orders.filter((r) => r.status !== 'done');
  const done = row.orders.filter((r) => r.status === 'done');
  const rel = row.reliability;
  const pmRows = row.pm
    .map(
      (e) => `<tr>
        <td>${e.dueDate ? dueBadge(e.dueDate, ctx.today) : '<span class="mt-due none">No date</span>'}</td>
        <td>${escapeHtml(e.detail || e.eventType || '—')}</td>
        <td>${escapeHtml(e.frequency ? `every ${e.frequency}` : '—')}</td>
        <td>${escapeHtml(e.owner || '—')}</td>
      </tr>`,
    )
    .join('');
  const group = (label: string, rows: DieMaintenanceRequest[], empty: string): string =>
    `<div class="die-wo-group">
      <div class="die-wo-sub">${label} <span class="die-wo-count">${rows.length}</span></div>
      ${rows.length ? `<ul class="die-detail-hist">${rows.map(ctx.woRow).join('')}</ul>` : `<div class="die-wo-empty">${empty}</div>`}
    </div>`;
  const stat = (label: string, value: string, tip = ''): string =>
    `<div class="mt-stat"${tip ? ` title="${escapeHtml(tip)}"` : ''}><span>${label}</span><b>${value}</b></div>`;
  openModal(`<div class="die-detail die-wo-modal mt-modal">
    <div class="kpi-trace-head die-detail-head">
      <h3>🏭 ${escapeHtml(row.code || row.asset)} <span class="die-detail-sub">${escapeHtml(row.code ? row.asset : row.description)}</span></h3>
      <div class="die-detail-head-actions">
        <a class="die-chip die-chip-btn" href="${MANGO_HOME}" target="_blank" rel="noopener">🥭 Mango</a>
        <button class="die-detail-close" data-mod="close" title="Close">✕ Close</button>
      </div>
    </div>
    <div class="mt-stats">
      ${stat('Status', MACHINE_STATE_META[row.state].label)}
      ${stat('Breakdowns', String(rel.breakdowns), `In the last ${rel.windowDays} days`)}
      ${stat('Downtime', `${rel.downtimeH.toFixed(1)} h`)}
      ${stat('MTBF', rel.breakdowns ? fmtH(rel.mtbfH) : `> ${rel.windowDays} d`, 'Calendar time between breakdowns')}
      ${stat('MTTR', fmtH(rel.mttrH), 'Downtime per breakdown')}
      ${stat('Availability', rel.availability == null ? '—' : `${(rel.availability * 100).toFixed(1)}%`)}
    </div>
    <div class="die-wo-group">
      <div class="die-wo-sub">📅 PM plan (MachinePM.csv) <span class="die-wo-count">${row.pm.length}</span></div>
      ${
        row.pm.length
          ? `<div class="mt-pm-wrap"><table class="kpi-table mt-pm-table"><thead><tr><th>Due</th><th>Event detail</th><th>Frequency</th><th>Owner</th></tr></thead><tbody>${pmRows}</tbody></table></div>`
          : '<div class="die-wo-empty">No PM events for this equipment in MachinePM.csv.</div>'
      }
    </div>
    ${group('🔧 Open maintenance requests', open, 'None open.')}
    ${group('📓 History', done, 'No closed work orders in the export.')}
  </div>`);
  document.getElementById('mc')?.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
}

// ---------------------------------------------------------------------
// Team

interface TeamState {
  branch: string;
  /** Owners shown; empty = everyone. */
  owners: Set<string>;
  from: string;
  to: string;
  /** Overdue / due-soon filter on the open-work table ('' = all). */
  level: DueLevel | '';
}
let team: TeamState | null = null;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function teamState(ctx: MaintCtx, branches: string[]): TeamState {
  if (!team) {
    team = {
      // The export covers every site; the MES is Minto's, so start there.
      branch: branches.find((b) => /minto/i.test(b)) ?? '',
      owners: new Set(),
      from: addDays(ctx.today, -89),
      to: ctx.today,
      level: '',
    };
  }
  return team;
}

function teamData(ctx: MaintCtx) {
  const orders = [...ctx.dieOrders, ...ctx.machineOrders];
  const branches = [...new Set([...orders.map((o) => o.branch ?? ''), ...ctx.pm.map((e) => e.branch)].filter(Boolean))].sort();
  const st = teamState(ctx, branches);
  const inBranch = (b: string | undefined): boolean => !st.branch || !b || b === st.branch;
  const scoped = orders.filter((o) => inBranch(o.branch));
  const pm = ctx.pm.filter((e) => inBranch(e.branch));
  const done = doneOrders(scoped);
  const open = openWork(scoped, pm, ctx.today);
  const owners = [...new Set([...done.map((d) => d.owner), ...open.map((o) => o.owner)])].sort((a, b) =>
    a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b),
  );
  // An owner picked under another branch may not exist under this one.
  for (const o of [...st.owners]) if (!owners.includes(o)) st.owners.delete(o);
  const picked = (owner: string): boolean => st.owners.size === 0 || st.owners.has(owner);
  return { st, branches, owners, done, open, picked };
}

export function renderTeam(ctx: MaintCtx): string {
  const { st, branches, owners, done, open, picked } = teamData(ctx);
  const f = ctx.filter.trim().toUpperCase();
  const match = (...v: string[]): boolean => !f || v.some((x) => x.toUpperCase().includes(f));
  const doneShown = done.filter((d) => picked(d.owner) && match(d.asset, d.title, d.ticket, d.owner));
  const inRange = doneShown.filter((d) => d.day >= st.from && d.day <= st.to);
  const unit = unitFor(st.from, st.to);
  const buckets = bucketDone(doneShown, st.from, st.to, unit);
  const totalH = inRange.reduce((n, d) => n + d.hours, 0);
  const earliest = done.length ? done[done.length - 1].day : addDays(ctx.today, -364);
  const preset = (days: number | 'all', label: string): string => {
    const from = days === 'all' ? earliest : addDays(ctx.today, -(days - 1));
    const on = st.to === ctx.today && st.from === from;
    return `<button class="shift-btn${on ? ' a' : ''}" data-tm-range="${days}">${label}</button>`;
  };
  const ownerChip = (o: string): string => {
    const on = st.owners.has(o);
    return `<button type="button" class="die-chip tm-owner${on ? ' on' : ''}" data-tm-owner="${escapeHtml(o)}" aria-pressed="${on}">${escapeHtml(o)}</button>`;
  };
  // Per owner in range.
  const per = new Map<string, { n: number; h: number }>();
  for (const d of inRange) {
    const p = per.get(d.owner) ?? { n: 0, h: 0 };
    p.n += 1;
    p.h += d.hours;
    per.set(d.owner, p);
  }
  const maxH = Math.max(1, ...[...per.values()].map((p) => p.h));
  const ownerRows = [...per.entries()]
    .sort((a, b) => b[1].h - a[1].h || b[1].n - a[1].n)
    .map(
      ([o, p]) => `<tr><td>${escapeHtml(o)}</td><td class="num">${p.n}</td><td class="num">${p.h.toFixed(1)}</td>
        <td class="tm-barcell"><span class="tm-bar" style="width:${Math.round((p.h / maxH) * 100)}%"></span></td></tr>`,
    )
    .join('');
  const openShown = open.filter(
    (o) => picked(o.owner) && (!st.level || o.level === st.level) && match(o.asset, o.title, o.ticket, o.owner),
  );
  const levelCount = (l: DueLevel): number => open.filter((o) => picked(o.owner) && o.level === l).length;
  const levelChip = (l: DueLevel): string => {
    const on = st.level === l;
    return `<button type="button" class="die-chip tm-level ${l}${on ? ' on' : ''}" data-tm-level="${l}" aria-pressed="${on}">${LEVEL_TEXT[l]} <b>${levelCount(l)}</b></button>`;
  };
  const openRows = openShown
    .map(
      (o: OpenItem) => `<tr class="tm-${o.level}">
        <td><span class="tm-kind ${o.kind}">${o.kind}</span></td>
        <td>${o.due ? dueBadge(o.due, ctx.today) : '<span class="mt-due none">No date</span>'}</td>
        <td><span class="mt-due ${o.level}">${LEVEL_TEXT[o.level]}</span></td>
        <td title="${escapeHtml(o.asset)}">${escapeHtml(o.asset)}</td>
        <td>${escapeHtml(o.title)}</td>
        <td>${escapeHtml(o.owner)}</td>
        <td>${escapeHtml(o.ticket || o.note)}</td>
      </tr>`,
    )
    .join('');
  return `<div class="tm">
    <div class="kpi-head tm-head">
      <label class="tm-branch">Branch <select data-tm-branch>
        <option value=""${st.branch ? '' : ' selected'}>All</option>
        ${branches.map((b) => `<option${b === st.branch ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
      </select></label>
      <div class="tm-owners"><span class="tm-lbl">Owner</span>
        <button type="button" class="die-chip tm-owner${st.owners.size === 0 ? ' on' : ''}" data-tm-owner="">Everyone</button>
        ${owners.map(ownerChip).join('')}
      </div>
    </div>

    <section class="tm-card">
      <h3>✅ Completed work orders</h3>
      <div class="kpi-head tm-range">
        <div class="shift-tabs">${preset(28, '4 weeks')}${preset(91, '3 months')}${preset(182, '6 months')}${preset(365, '12 months')}${preset('all', 'All')}</div>
        <div class="tm-zoom">
          <button class="shift-btn" data-tm-pan="-1" title="Earlier">◀</button>
          <button class="shift-btn" data-tm-zoom="in" title="Zoom in">＋</button>
          <button class="shift-btn" data-tm-zoom="out" title="Zoom out">－</button>
          <button class="shift-btn" data-tm-pan="1" title="Later">▶</button>
        </div>
        <span class="tm-span">${ddmmyyyy(st.from)} – ${ddmmyyyy(st.to)} · per ${unit}</span>
      </div>
      <div class="tm-tiles">
        <div class="mt-stat"><span>Orders closed</span><b>${inRange.length}</b></div>
        <div class="mt-stat"><span>Labour hours</span><b>${totalH.toFixed(1)}</b></div>
        <div class="mt-stat"><span>Hours / order</span><b>${inRange.length ? (totalH / inRange.length).toFixed(1) : '—'}</b></div>
      </div>
      ${teamChart(buckets, unit)}
      <p class="kpi-note">Bars: labour hours booked on the orders closed in each ${unit}; line: how many orders closed. Scroll on the chart, or ＋ / －, to zoom; ◀ ▶ to move. An order's day is the day Mango closed it (Stage 4), else the day it was raised. Owner is Mango's "Assign to Action".</p>
      ${
        ownerRows
          ? `<table class="kpi-table tm-owner-table"><thead><tr><th>Owner</th><th>Orders</th><th>Hours</th><th></th></tr></thead><tbody>${ownerRows}</tbody></table>`
          : '<div class="trace-empty">No closed work orders in this range.</div>'
      }
    </section>

    <section class="tm-card">
      <h3>📋 Open maintenance requests and PM</h3>
      <div class="die-chips">${(['overdue', 'soon', 'ok', 'none'] as const).map(levelChip).join('')}</div>
      ${
        openRows
          ? `<div class="die-table-wrap"><table class="kpi-table tm-open-table"><thead><tr>
              <th>Type</th><th>Due</th><th>Status</th><th>Equipment</th><th>What</th><th>Owner</th><th>Ticket / frequency</th>
            </tr></thead><tbody>${openRows}</tbody></table></div>`
          : '<div class="trace-empty">Nothing open for this selection.</div>'
      }
      <p class="kpi-note"><b>MR</b> = an open Mango maintenance request, due by its "To be completed by"; <b>PM</b> = a live event in MachinePM.csv, due by its Event Due Date. Due ≤ 7 d is within the coming week.</p>
    </section>
  </div>`;
}

/** Hours as bars, order count as a line, on one time axis. */
function teamChart(buckets: { start: string; count: number; hours: number }[], unit: BucketUnit): string {
  if (buckets.length === 0) return '';
  const W = 1000;
  const H = 240;
  const L = 44;
  const R = 36;
  const T = 12;
  const B = 34;
  const iw = W - L - R;
  const ih = H - T - B;
  const maxH = Math.max(1, ...buckets.map((b) => b.hours));
  const maxN = Math.max(1, ...buckets.map((b) => b.count));
  const bw = iw / buckets.length;
  const x = (i: number): number => L + i * bw;
  const label = (s: string): string => {
    const [y, m, d] = s.split('-');
    return unit === 'month' ? `${m}/${y.slice(2)}` : `${d}/${m}`;
  };
  const every = Math.max(1, Math.ceil(buckets.length / 12));
  const bars = buckets
    .map((b, i) => {
      const h = (b.hours / maxH) * ih;
      return `<rect class="tm-hbar" x="${x(i) + bw * 0.12}" y="${T + ih - h}" width="${Math.max(1, bw * 0.76)}" height="${h}"><title>${escapeHtml(
        `${ddmmyyyy(b.start)}${unit === 'day' ? '' : ` (${unit})`} · ${b.count} order${b.count === 1 ? '' : 's'} · ${b.hours.toFixed(1)} h`,
      )}</title></rect>`;
    })
    .join('');
  const pts = buckets.map((b, i) => `${x(i) + bw / 2},${T + ih - (b.count / maxN) * ih}`).join(' ');
  const dots = buckets
    .map((b, i) => (b.count ? `<circle class="tm-dot" cx="${x(i) + bw / 2}" cy="${T + ih - (b.count / maxN) * ih}" r="3"></circle>` : ''))
    .join('');
  const ticks = buckets
    .map((b, i) => (i % every === 0 ? `<text class="tm-tick" x="${x(i) + bw / 2}" y="${H - 12}" text-anchor="middle">${label(b.start)}</text>` : ''))
    .join('');
  return `<div class="tm-chart" data-tm-chart>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Labour hours and orders closed over time">
      <line class="tm-axis" x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}"></line>
      <text class="tm-tick" x="${L - 6}" y="${T + 10}" text-anchor="end">${maxH.toFixed(0)} h</text>
      <text class="tm-tick tm-n" x="${W - R + 6}" y="${T + 10}">${maxN}</text>
      ${bars}
      <polyline class="tm-line" points="${pts}"></polyline>
      ${dots}
      ${ticks}
    </svg>
  </div>`;
}

export function wireTeam(root: HTMLElement, ctx: MaintCtx): void {
  if (!team) return;
  const st = team;
  const span = (): number => Math.max(1, daysUntil(st.to, st.from));
  const setRange = (from: string, to: string): void => {
    // Never past today, never under a week.
    if (to > ctx.today) {
      from = addDays(from, -daysUntil(to, ctx.today));
      to = ctx.today;
    }
    if (daysUntil(to, from) < 6) from = addDays(to, -6);
    st.from = from;
    st.to = to;
    ctx.rerender();
  };
  root.querySelector<HTMLSelectElement>('[data-tm-branch]')?.addEventListener('change', (e) => {
    st.branch = (e.target as HTMLSelectElement).value;
    ctx.rerender();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-tm-owner]').forEach((b) =>
    b.addEventListener('click', () => {
      const o = b.dataset.tmOwner ?? '';
      if (!o) st.owners.clear();
      else if (st.owners.has(o)) st.owners.delete(o);
      else st.owners.add(o);
      ctx.rerender();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-tm-level]').forEach((b) =>
    b.addEventListener('click', () => {
      const l = b.dataset.tmLevel as DueLevel;
      st.level = st.level === l ? '' : l;
      ctx.rerender();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-tm-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.tmRange!;
      const { done } = teamData(ctx);
      const from = v === 'all' ? (done.length ? done[done.length - 1].day : addDays(ctx.today, -364)) : addDays(ctx.today, -(Number(v) - 1));
      setRange(from, ctx.today);
    }),
  );
  const zoom = (factor: number, at = 0.5): void => {
    const s = span();
    const next = Math.max(6, Math.round(s * factor));
    const pivot = addDays(st.from, Math.round(s * at));
    setRange(addDays(pivot, -Math.round(next * at)), addDays(pivot, next - Math.round(next * at)));
  };
  root.querySelectorAll<HTMLButtonElement>('[data-tm-zoom]').forEach((b) =>
    b.addEventListener('click', () => zoom(b.dataset.tmZoom === 'in' ? 0.5 : 2)),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-tm-pan]').forEach((b) =>
    b.addEventListener('click', () => {
      const shift = Math.round(span() / 2) * Number(b.dataset.tmPan);
      setRange(addDays(st.from, shift), addDays(st.to, shift));
    }),
  );
  const chart = root.querySelector<HTMLElement>('[data-tm-chart]');
  chart?.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const box = chart.getBoundingClientRect();
      const at = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
      zoom(e.deltaY < 0 ? 0.7 : 1 / 0.7, at);
    },
    { passive: false },
  );
}
