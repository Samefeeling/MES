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

import type { DieMaintenanceRequest, MachineMaster, MachinePmEvent, ToolStatus } from '../types';
import { TOOL_STATUS_META } from '../core/die';
import {
  UNASSIGNED,
  bucketDone,
  bucketEnd,
  buildMachineRows,
  daysUntil,
  doneOrders,
  dueLevel,
  earliestOrder,
  isBreakdown,
  machineFigures,
  openWork,
  unitFor,
  type BucketUnit,
  type DoneOrder,
  type DueLevel,
  type MachineRow,
  type OpenItem,
} from '../core/maint';
import { closeModal, escapeHtml, openModal } from './modal';
import { RESIZE_HANDLE, syncStickyOffset, wireColumnResize } from './col-resize';

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
  /** The press's row on PMD_Machine, if the list has one. */
  machineMaster(code: string): MachineMaster | undefined;
  /** Set a press's Status on PMD_Machine; undefined when the backend can't write it. */
  setMachineStatus?(code: string, status: ToolStatus): void;
  /** What the last save of the figures to PMD_Machine did, for the page's note. */
  machineSyncNote: string;
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

/** An open request with no due date yet: when it was raised, and how long ago. */
function undatedBadge(raised: string, today: string): string {
  if (!raised) return '<span class="mt-due none">No date</span>';
  const ago = -daysUntil(raised, today);
  const rel = ago <= 0 ? 'today' : `${ago} d ago`;
  return `<span class="mt-due none" title="No &quot;To be completed by&quot; date yet">Raised ${ddmmyyyy(raised)} · ${rel}</span>`;
}

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

type MachineSort =
  | 'default'
  | 'machine'
  | 'name'
  | 'state'
  | 'lastService'
  | 'dies'
  | 'open'
  | 'next'
  | 'detail'
  | 'breakdowns'
  | 'mtbf'
  | 'mttr'
  | 'avail';
/** Column keys of the Machine table, in order: its <colgroup> and the saved widths. */
const MACHINE_COLS = [
  'machine', 'name', 'state', 'lastService', 'dies', 'open', 'next', 'detail', 'breakdowns', 'mtbf', 'mttr', 'avail',
] as const;
const MACHINE_COLW_KEY = 'pmd.machine.colw';
let machineSort: MachineSort = 'default';
let machineDir: 1 | -1 = 1;
/** Status chip filter — '' shows every machine. */
let machineStatus: ToolStatus | '' = '';

/** The order of the four statuses, worst first — the Tool page's. */
const STATUS_ORDER: ToolStatus[] = ['problems', 'to-be-serviced', 'in-service', 'serviced'];

function machineRows(ctx: MaintCtx): MachineRow[] {
  return buildMachineRows(ctx.pm, ctx.machineOrders, ctx.today, earliestOrder([...ctx.machineOrders, ...ctx.dieOrders]));
}

function machineAccess(
  key: Exclude<MachineSort, 'default'>,
  ctx: MaintCtx,
): (r: MachineRow) => string | number | null {
  switch (key) {
    // The code for a press ("125T" before "1300T" by tonnage), the name for the rest.
    case 'machine':
      return (r) => (r.code ? `0|${r.code.replace(/\d+/g, (n) => n.padStart(6, '0'))}` : `1|${r.asset.toUpperCase()}`);
    case 'name':
      return (r) => (r.code ? r.asset : r.description || r.department || r.asset).toUpperCase() || null;
    case 'state':
      return (r) => {
        const st = r.code ? ctx.machineMaster(r.code)?.status : '';
        return st ? TOOL_STATUS_META[st].rank : null;
      };
    case 'lastService':
      return (r) => lastServiceOf(r, ctx) || null;
    case 'dies':
      return (r) => (r.code ? ctx.diesFor(r.code).length : 0);
    case 'open':
      return (r) => r.openOrders;
    case 'next':
      return (r) => r.nextPm?.dueDate || null;
    case 'detail':
      return (r) => r.nextPm?.detail.toUpperCase() || null;
    case 'breakdowns':
      return (r) => r.reliability.breakdowns;
    case 'mtbf':
      return (r) => r.reliability.mtbfH;
    case 'mttr':
      return (r) => r.reliability.mttrH;
    case 'avail':
      return (r) => r.reliability.availability;
  }
}

/** Last service: PMD_Machine's (stamped when someone sets Serviced) or the
 *  last preventive / calibration order Mango closed, whichever is later. */
function lastServiceOf(r: MachineRow, ctx: MaintCtx): string {
  const m = r.code ? ctx.machineMaster(r.code) : undefined;
  return m ? machineFigures(r, m).lastService : r.lastService;
}

/** The Status cell: PMD_Machine.Status as the Tool page shows a die's, a
 *  button that opens the picker where the list can be written. Equipment
 *  without a PMD_Machine row has none. An open breakdown in Mango is
 *  flagged beside it, whatever the status says. */
function statusCell(r: MachineRow, ctx: MaintCtx): string {
  const m = r.code ? ctx.machineMaster(r.code) : undefined;
  const breakdowns = r.orders
    .filter((o) => o.status !== 'done' && isBreakdown(o))
    .map((o) => o.mangoTicket)
    .filter(Boolean);
  const flag =
    r.state === 'breakdown'
      ? ` <span class="mt-flag" title="${escapeHtml(`Open breakdown in Mango${breakdowns.length ? `: ${breakdowns.join(', ')}` : ''}`)}">⚠</span>`
      : '';
  if (!m) {
    return `<span class="die-tstat none" title="${r.code ? 'No PMD_Machine row for this press' : 'Not on PMD_Machine'}">—</span>${flag}`;
  }
  const meta = m.status ? TOOL_STATUS_META[m.status] : null;
  const inner = meta ? `● ${meta.label}` : '— set';
  const cls = meta ? `die-tstat ${meta.cls}` : 'die-tstat none';
  if (ctx.setMachineStatus) {
    return `<button class="${cls} die-tstat-btn" data-mt-status="${escapeHtml(r.code)}" title="PMD_Machine.Status — tap to change">${inner} ▾</button>${flag}`;
  }
  return `<span class="${cls}" title="PMD_Machine.Status">${inner}</span>${flag}`;
}

export function renderMachineBoard(ctx: MaintCtx): string {
  const all = machineRows(ctx);
  const f = ctx.filter.trim().toUpperCase();
  const statusOf = (r: MachineRow): ToolStatus | '' => (r.code ? ctx.machineMaster(r.code)?.status ?? '' : '');
  let rows = all.filter(
    (r) =>
      (!machineStatus || statusOf(r) === machineStatus) &&
      (!f ||
        r.asset.toUpperCase().includes(f) ||
        r.code.toUpperCase().includes(f) ||
        r.description.toUpperCase().includes(f) ||
        (r.code && ctx.diesFor(r.code).some((d) => d.die.toUpperCase().includes(f)))),
  );
  if (machineSort !== 'default') {
    const get = machineAccess(machineSort, ctx);
    rows = [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -machineDir : av > bv ? machineDir : 0;
    });
  }
  // One chip per status, as on the Tool page: tap to show only those.
  const chip = (st: ToolStatus): string => {
    const meta = TOOL_STATUS_META[st];
    const n = all.filter((r) => statusOf(r) === st).length;
    const on = machineStatus === st;
    return `<button type="button" class="die-chip die-chip-st ${meta.cls}${on ? ' on' : ''}" data-mt-state="${st}" aria-pressed="${on}"
      title="${on ? 'Showing' : 'Show'} only machines whose PMD_Machine Status is ${meta.label}${on ? ' — tap again to show all' : ''}">${meta.label} <b>${n}</b></button>`;
  };
  const noPm = ctx.pm.length === 0;
  const chips = `<div class="die-chips">
    <span class="die-chip">Equipment <b>${rows.length === all.length ? all.length : `${rows.length} of ${all.length}`}</b></span>
    ${STATUS_ORDER.map(chip).join('')}
    <a class="die-chip die-chip-btn" href="${MANGO_HOME}" target="_blank" rel="noopener">🥭 Mango</a>
  </div>${
    noPm
      ? '<div class="data-error-banner">MachinePM.csv was not read — Next service is empty. It is read from the Planning.csv folder (or VITE_MACHINE_PM_CSV_PATH).</div>'
      : ''
  }`;
  // Every column sorts (tap again to reverse) and resizes (drag a header's
  // right edge; double-tap the edge to reset), like the Tool table.
  const th = (key: Exclude<MachineSort, 'default'>, label: string, title = ''): string => {
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    const on = machineSort === key;
    return `<th class="die-sort${on ? ' a' : ''}" data-mt-sort="${key}"${t}>${label}${on ? (machineDir === 1 ? ' ▲' : ' ▼') : ''}${RESIZE_HANDLE}</th>`;
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
        <td class="mt-st">${statusCell(r, ctx)}</td>
        <td>${lastServiceOf(r, ctx) ? ddmmyyyy(lastServiceOf(r, ctx)) : '<span class="die-tstat none">—</span>'}</td>
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
    <colgroup>${MACHINE_COLS.map((k) => `<col data-ck="${k}">`).join('')}</colgroup>
    <thead><tr>
      ${th('machine', 'Machine')}
      ${th('name', 'Name', "MachinePM.csv's Name — the same as Mango's Plant/Equipment")}
      ${th('state', 'Status', 'PMD_Machine.Status: 🔴 Problems · 🟠 To be Serviced · 🔵 In service · 🟢 Serviced — tap a badge to change it. ⚠ = an open breakdown in Mango')}
      ${th('lastService', 'Last service', 'PMD_Machine.LastService — stamped when Status is set to Serviced — or the last preventive or calibration order closed in Mango, whichever is later')}
      ${th('dies', 'Die #', 'Dies that ran on the press in the last 90 days or are planned on it — ▶ = running now. Tap a die for its detail')}
      ${th('open', 'Open MR', 'Open Mango maintenance requests — tap for the machine’s PM plan and work orders')}
      ${th('next', 'Next service', "MachinePM.csv Event Due Date — the soonest live PM event")}
      ${th('detail', 'Event detail', 'MachinePM.csv Event Detail of that event')}
      ${th('breakdowns', 'Breakdowns', 'Mango "2. Breakdown" orders raised in the last 12 months (or since the export begins)')}
      ${th('mtbf', 'MTBF', 'Mean time between failures: calendar hours in the window, less downtime, ÷ breakdowns')}
      ${th('mttr', 'MTTR', 'Mean time to repair: Mango Downtime ÷ breakdowns that recorded it')}
      ${th('avail', 'Avail.', 'MTBF ÷ (MTBF + MTTR)')}
    </tr></thead>
    <tbody>${body || '<tr><td colspan="12" class="trace-empty">No equipment matches.</td></tr>'}</tbody>
  </table></div>
  <p class="kpi-note"><b>Status</b> is set by hand and saved to PMD_Machine; Last service, Breakdowns, MTBF, MTTR and Avail. are saved there too whenever they change.${ctx.machineSyncNote ? ` <i>${escapeHtml(ctx.machineSyncNote)}</i>` : ''}<br>The nine presses first, then the rest of the equipment in MachinePM.csv, worst first. <b>Next service</b> and <b>Event detail</b> come from MachinePM.csv; work orders from MangoWorkOrders.csv, joined on the equipment's name. <b>MTBF</b> and <b>MTTR</b> are from the Mango breakdowns over the last 12 months (or since the export begins) on calendar time — they read high against running hours, but compare machine to machine.</p>`;
}

export function wireMachineBoard(root: HTMLElement, ctx: MaintCtx): void {
  root.querySelectorAll<HTMLButtonElement>('[data-mt-state]').forEach((b) =>
    b.addEventListener('click', () => {
      const st = b.dataset.mtState as ToolStatus;
      machineStatus = machineStatus === st ? '' : st;
      ctx.rerender();
    }),
  );
  root.querySelectorAll<HTMLElement>('[data-mt-sort]').forEach((el) =>
    el.addEventListener('click', () => {
      const key = el.dataset.mtSort as MachineSort;
      if (machineSort === key) machineDir = machineDir === 1 ? -1 : 1;
      else {
        machineSort = key;
        // Worst first: soonest due, most open, most breakdowns, shortest MTBF,
        // longest MTTR, lowest availability; names A→Z.
        machineDir = key === 'open' || key === 'breakdowns' || key === 'mttr' || key === 'dies' ? -1 : 1;
      }
      ctx.rerender();
    }),
  );
  const table = root.querySelector<HTMLTableElement>('.mt-table');
  if (table) {
    wireColumnResize(table, {
      storageKey: MACHINE_COLW_KEY,
      onReset: ctx.rerender,
      onResize: () => syncStickyOffset(table),
    });
    syncStickyOffset(table);
  }
  root.querySelectorAll<HTMLButtonElement>('[data-mt-status]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openMachineStatusPicker(b.dataset.mtStatus!, ctx);
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

/** Pick a press's Status — the Tool page's picker, writing PMD_Machine. */
function openMachineStatusPicker(code: string, ctx: MaintCtx): void {
  const m = ctx.machineMaster(code);
  if (!m || !ctx.setMachineStatus) return;
  const opts = (['serviced', 'in-service', 'to-be-serviced', 'problems'] as ToolStatus[])
    .map((st) => {
      const meta = TOOL_STATUS_META[st];
      const current = m.status === st;
      return `<button class="die-st-opt${current ? ' cur' : ''}" data-mt-st="${st}">
        <span class="die-tstat ${meta.cls}">● ${meta.label}</span>
        ${st === 'serviced' ? '<em>stamps Last service = today</em>' : ''}
        ${current ? '<b>current</b>' : ''}
      </button>`;
    })
    .join('');
  openModal(`<div class="die-st-pick">
    <div class="kpi-trace-head">
      <h3>🏭 ${escapeHtml(code)} — Status</h3>
      <button class="btn-ghost-big" data-mod="close">Cancel</button>
    </div>
    <p class="die-req-note">Writes to PMD_Machine.Status.</p>
    ${opts}
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  mc.querySelectorAll<HTMLButtonElement>('[data-mt-st]').forEach((b) =>
    b.addEventListener('click', () => {
      closeModal();
      ctx.setMachineStatus?.(code, b.dataset.mtSt as ToolStatus);
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
      ${stat('Status', (() => {
        const st = row.code ? ctx.machineMaster(row.code)?.status : '';
        return st ? TOOL_STATUS_META[st].label : '—';
      })(), 'PMD_Machine.Status')}
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
  /** Owners shown; empty = everyone. */
  owners: Set<string>;
  from: string;
  to: string;
  /** Overdue / due-soon filter on the open-work table ('' = all). */
  level: DueLevel | '';
  /** The orders listed under the chart: a tapped bar's bucket (its first
   *  day), 'all' for the whole range, null for none. */
  pick: string | null;
}
let team: TeamState | null = null;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function teamState(ctx: MaintCtx): TeamState {
  if (!team) {
    team = {
      owners: new Set(),
      from: addDays(ctx.today, -89),
      to: ctx.today,
      level: '',
      pick: null,
    };
  }
  return team;
}

function teamData(ctx: MaintCtx) {
  // Minto only: the other sites' orders were left out at load.
  const orders = [...ctx.dieOrders, ...ctx.machineOrders];
  const st = teamState(ctx);
  const done = doneOrders(orders);
  const open = openWork(orders, ctx.pm, ctx.today);
  const owners = [...new Set([...done.map((d) => d.owner), ...open.map((o) => o.owner)])].sort((a, b) =>
    a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b),
  );
  // An owner picked before a reload may no longer have any orders.
  for (const o of [...st.owners]) if (!owners.includes(o)) st.owners.delete(o);
  const picked = (owner: string): boolean => st.owners.size === 0 || st.owners.has(owner);
  return { st, owners, done, open, picked };
}

export function renderTeam(ctx: MaintCtx): string {
  const { st, owners, done, open, picked } = teamData(ctx);
  const f = ctx.filter.trim().toUpperCase();
  const match = (...v: string[]): boolean => !f || v.some((x) => x.toUpperCase().includes(f));
  const doneShown = done.filter(
    (d) => picked(d.owner) && match(d.asset, d.title, d.detail, d.summary, d.prevention, ...d.notes.map((n) => n.comment), d.ticket, d.owner),
  );
  const inRange = doneShown.filter((d) => d.day >= st.from && d.day <= st.to);
  const unit = unitFor(st.from, st.to);
  const buckets = bucketDone(doneShown, st.from, st.to, unit);
  const totalH = inRange.reduce((n, d) => n + d.hours, 0);
  const booked = inRange.filter((d) => d.booked).length;
  // A tapped bar whose bucket the range or its unit no longer has is dropped.
  if (st.pick && st.pick !== 'all' && !buckets.some((b) => b.start === st.pick)) st.pick = null;
  const listFrom = st.pick === 'all' ? st.from : st.pick ?? '';
  const listTo = st.pick === 'all' ? st.to : st.pick ? bucketEnd(st.pick, unit) : '';
  const listed = st.pick ? inRange.filter((d) => d.day >= listFrom && d.day <= listTo) : [];
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
        <td>${o.due ? dueBadge(o.due, ctx.today) : undatedBadge(o.raised, ctx.today)}</td>
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
        <div class="mt-stat"><span>Labour hours</span><b>${totalH.toFixed(1)}</b>${
          booked < inRange.length ? `<em class="tm-cov">booked on ${booked} of ${inRange.length} orders</em>` : ''
        }</div>
        <div class="mt-stat"><span>Hours / order</span><b>${booked ? (totalH / booked).toFixed(1) : '—'}</b>${
          booked < inRange.length ? '<em class="tm-cov">of the orders with hours</em>' : ''
        }</div>
      </div>
      ${teamChart(buckets, unit, st.pick)}
      <p class="kpi-note">Bars: labour hours booked on the orders closed in each ${unit}; line: how many orders closed. <b>Tap a bar</b> to list its orders below. ＋ / － zoom, ◀ ▶ move. An order's day is the day Mango closed it (Stage 4), else the day it was raised. Owner is Mango's "Assign to Action".
        <button type="button" class="die-chip die-chip-btn" data-tm-pick="all">📋 List all ${inRange.length} in range</button></p>
      ${st.pick ? doneTable(listed, listFrom, listTo) : ''}
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
      <p class="kpi-note"><b>MR</b> = an open Mango maintenance request, due by its "To be completed by"; <b>PM</b> = a live event in MachinePM.csv, due by its Event Due Date. Due ≤ 7 d is within the coming week. Mango leaves "To be completed by" empty until the coordinator assesses a request, so an undated request shows how long ago it was raised, the longest-waiting first.</p>
    </section>
  </div>`;
}

/** The closed orders behind a tapped bar (or the whole range). */
function doneTable(rows: DoneOrder[], from: string, to: string): string {
  const hoursSum = rows.reduce((n, d) => n + d.hours, 0);
  const span = from === to ? ddmmyyyy(from) : `${ddmmyyyy(from)} – ${ddmmyyyy(to)}`;
  const body = rows
    .map(
      (d) => `<tr>
        <td>${ddmmyyyy(d.day)}</td>
        <td>${escapeHtml(d.ticket || '—')}</td>
        <td title="${escapeHtml(d.asset)}">${escapeHtml(d.asset || '—')}</td>
        <td class="tm-text"><b>${escapeHtml(d.title || '—')}</b>${d.detail ? `<div>${escapeHtml(d.detail)}</div>` : ''}</td>
        <td class="tm-text">${escapeHtml(d.summary || (d.notes.length ? '' : '—'))}${
          d.prevention ? `<div>Prevent: ${escapeHtml(d.prevention)}</div>` : ''
        }${d.notes.map((n) => `<div class="tm-note"><time>${escapeHtml(n.date.slice(0, 5))}</time> ${escapeHtml(n.comment)}</div>`).join('')}</td>
        <td>${escapeHtml(d.owner)}</td>
        <td class="num">${d.hours ? d.hours.toFixed(2).replace(/\.?0+$/, '') : '—'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="tm-picked" data-tm-picked>
    <div class="tm-picked-head">
      <b>Orders closed ${span}</b> · ${rows.length} order${rows.length === 1 ? '' : 's'} · ${hoursSum.toFixed(1)} h
      <button type="button" class="die-detail-close" data-tm-pick="" title="Close the list">✕</button>
    </div>
    ${
      rows.length
        ? `<div class="die-table-wrap"><table class="kpi-table tm-done-table"><thead><tr>
            <th>Closed</th><th>Ticket</th><th>Machine</th><th>Detail</th><th>Summary</th><th>Owner</th><th>Hours</th>
          </tr></thead><tbody>${body}</tbody></table></div>`
        : '<div class="trace-empty">No orders closed in this period for this selection.</div>'
    }
  </div>`;
}

/** Hours as bars, order count as a line, on one time axis. Each period is a
 *  tap target the full height of the chart, so a short bar is as easy to hit
 *  as a tall one. */
function teamChart(
  buckets: { start: string; count: number; hours: number }[],
  unit: BucketUnit,
  pick: string | null,
): string {
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
      const tip = escapeHtml(
        `${ddmmyyyy(b.start)}${unit === 'day' ? '' : ` (${unit})`} · ${b.count} order${b.count === 1 ? '' : 's'} · ${b.hours.toFixed(1)} h — tap to list`,
      );
      return `<g class="tm-col${b.start === pick ? ' on' : ''}" data-tm-pick="${b.start}" role="button" tabindex="0">
        <rect class="tm-hit" x="${x(i)}" y="${T}" width="${bw}" height="${ih}"></rect>
        <rect class="tm-hbar" x="${x(i) + bw * 0.12}" y="${T + ih - h}" width="${Math.max(1, bw * 0.76)}" height="${h}"></rect>
        <title>${tip}</title>
      </g>`;
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
    st.pick = null;
    ctx.rerender();
  };
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
  // A tapped bar lists its orders; tapping it again (or ✕) closes the list.
  root.querySelectorAll<Element>('[data-tm-pick]').forEach((el) => {
    const pick = (): void => {
      const v = el.getAttribute('data-tm-pick') || null;
      st.pick = st.pick === v ? null : v;
      ctx.rerender();
      if (st.pick) root.querySelector('[data-tm-picked]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        pick();
      }
    });
  });
}
