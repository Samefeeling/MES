// 🛠 Maint → Machine and Team. The Tool page (die.ts) owns the shared load
// and hands these two what they need through `MaintCtx`, so a die tapped on
// the Machine page opens the same die drilldown the Tool page does.
//
//   Machine  one row per piece of equipment (MachinePM.csv's Name, the nine
//            presses first): its dies, open work orders, next PM from
//            MachinePM.csv, and MTBF / MTTR from the Mango breakdowns.
//   Team     what the maintenance team closed — labour hours per owner over
//            Last Week or a From–To range, the orders beside the chart with
//            their cycle time — and everything still open, work orders and
//            PM, with when it was raised and whether it is due.

import type { DieMaintenanceRequest, MachineMaster, MachinePmEvent, ToolStatus } from '../types';
import { TOOL_STATUS_META } from '../core/die';
import {
  MAINT_COORDINATOR,
  UNASSIGNED,
  bucketDone,
  bucketEnd,
  buildMachineRows,
  cycleTime,
  daysUntil,
  doneOrders,
  dueLevel,
  earliestOrder,
  isBreakdown,
  lastWeek,
  machineFigures,
  openWork,
  pressCodeOf,
  unitFor,
  type Bucket,
  type BucketUnit,
  type DoneOrder,
  type DueLevel,
  type MachineRow,
  type OpenItem,
} from '../core/maint';
import { closeModal, escapeHtml, openModal } from './modal';
import { RESIZE_HANDLE, syncStickyOffset, wireColumnResize } from './col-resize';
import { toast } from './toast';

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
  /** Set a press's Status on PMD_Machine — with its return date when it
   *  goes In service; undefined when the backend can't write it. */
  setMachineStatus?(code: string, status: ToolStatus, availableDate?: string): void;
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
  | 'available'
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
  'machine', 'name', 'state', 'lastService', 'available', 'dies', 'open', 'next', 'detail', 'breakdowns', 'mtbf', 'mttr', 'avail',
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
    case 'available':
      return (r) => availableOf(r, ctx, ctx.today).sort;
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

/**
 * Whether the press can run, as the Tool page says it of a die, from its
 * PMD_Machine Status: Problems → Unavailable; In service → the return date
 * maintenance gave (AvailableDate), "In maint" without one, ⚠ once it has
 * passed; otherwise Available. Sorts unavailable last.
 */
function availableOf(r: MachineRow, ctx: MaintCtx, today: string): { html: string; sort: string | null } {
  const m = r.code ? ctx.machineMaster(r.code) : undefined;
  if (!m || !m.status) return { html: '<span class="die-tstat none">—</span>', sort: null };
  if (m.status === 'problems') {
    return { html: '<span class="die-avail late" title="Status is Problems — the press cannot run">Unavailable</span>', sort: '9999-99-99' };
  }
  if (m.status === 'in-service') {
    const back = m.availableDate;
    if (!back) {
      return {
        html: '<span class="die-avail maint" title="In service — no return date on PMD_Machine.AvailableDate. Tap the Status badge and pick In service again to give one">In maint</span>',
        sort: '9998-99-99',
      };
    }
    const late = back < today;
    return {
      html: `<span class="die-avail${late ? ' late' : ' maint'}" title="Back from maintenance by ${ddmmyyyy(back)} (PMD_Machine.AvailableDate)${late ? ' — DATE HAS PASSED, chase maintenance' : ''}">${late ? '⚠ ' : ''}${ddmmyyyy(back).slice(0, 5)}</span>`,
      sort: back,
    };
  }
  return { html: '<span class="die-avail now" title="Status is not In service / Problems — the press can run">Available</span>', sort: '0000-00-00' };
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
        <td>${availableOf(r, ctx, ctx.today).html}</td>
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
      ${th('available', 'Available', 'From the Status: Available = can run · a date = when maintenance will have it back (PMD_Machine.AvailableDate, given when it is set In service) · In maint = in service, no date given · ⚠ = that date has passed · Unavailable = Problems')}
      ${th('dies', 'Die #', 'Dies that ran on the press in the last 90 days or are planned on it — ▶ = running now. Tap a die for its detail')}
      ${th('open', 'Open MR', 'Open Mango maintenance requests — tap for the machine’s PM plan and work orders')}
      ${th('next', 'Next service', "MachinePM.csv Event Due Date — the soonest live PM event")}
      ${th('detail', 'Event detail', 'MachinePM.csv Event Detail of that event')}
      ${th('breakdowns', 'Breakdowns', 'Mango "2. Breakdown" orders raised in the last 12 months (or since the export begins)')}
      ${th('mtbf', 'MTBF', 'Mean time between failures: calendar hours in the window, less downtime, ÷ breakdowns')}
      ${th('mttr', 'MTTR', 'Mean time to repair: Mango Downtime ÷ breakdowns that recorded it')}
      ${th('avail', 'Avail. %', 'Availability: MTBF ÷ (MTBF + MTTR) — saved to PMD_Machine.Available')}
    </tr></thead>
    <tbody>${body || '<tr><td colspan="${MACHINE_COLS.length}" class="trace-empty">No equipment matches.</td></tr>'}</tbody>
  </table></div>
  <p class="kpi-note"><b>Status</b> is set by hand and saved to PMD_Machine, with the return date (AvailableDate) when a press goes In service; Last service, Breakdowns, MTBF, MTTR and Avail. are saved there too whenever they change.${ctx.machineSyncNote ? ` <i>${escapeHtml(ctx.machineSyncNote)}</i>` : ''}<br>The nine presses first, then the rest of the equipment in MachinePM.csv, worst first. <b>Next service</b> and <b>Event detail</b> come from MachinePM.csv; work orders from MangoWorkOrders.csv, joined on the equipment's name. <b>MTBF</b> and <b>MTTR</b> are from the Mango breakdowns over the last 12 months (or since the export begins) on calendar time — they read high against running hours, but compare machine to machine.</p>`;
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
        ${st === 'in-service' ? '<em>asks for the return date · Mango ticket required</em>' : ''}
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
      const st = b.dataset.mtSt as ToolStatus;
      if (st === 'in-service') {
        openMachineInServiceStep(code, ctx);
        return;
      }
      closeModal();
      ctx.setMachineStatus?.(code, st);
    }),
  );
}

/** Second step of In service, as for a die: the date maintenance will have
 *  the press back is required — it fills the Available column and
 *  PMD_Machine.AvailableDate — and the Mango work order comes first.
 *  Picking In service again on a press already in service changes the date. */
function openMachineInServiceStep(code: string, ctx: MaintCtx): void {
  const m = ctx.machineMaster(code);
  if (!m || !ctx.setMachineStatus) return;
  const meta = TOOL_STATUS_META['in-service'];
  const today = ctx.today;
  const cur = m.availableDate;
  openModal(`<div class="die-st-pick die-insvc">
    <div class="kpi-trace-head">
      <h3>🏭 ${escapeHtml(code)} — <span class="die-tstat ${meta.cls}">● ${meta.label}</span></h3>
      <button class="btn-ghost-big" data-mod="close">Cancel</button>
    </div>
    <div class="die-insvc-mango" role="alert">🥭 <b>Mango Ticket Required</b> — raise the maintenance
      work order in Mango before the press goes in. <a href="${MANGO_HOME}" target="_blank" rel="noopener">Open Mango</a></div>
    <label class="die-insvc-date">Available — when will maintenance have the press back?
      <input type="date" data-insvc-date min="${today}" value="${escapeHtml(cur >= today ? cur : '')}" required>
    </label>
    <p class="die-req-note">Required. The Machine page's <b>Available</b> column shows this date so
      planning knows when the press returns (writes PMD_Machine Status + AvailableDate).</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-insvc-back>← Back</button>
      <button class="btn-primary-big" data-insvc-save>✓ Set In service</button>
    </div>
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  mc.querySelector('[data-insvc-back]')?.addEventListener('click', () => openMachineStatusPicker(code, ctx));
  const input = mc.querySelector<HTMLInputElement>('[data-insvc-date]')!;
  input.focus();
  mc.querySelector('[data-insvc-save]')?.addEventListener('click', () => {
    const date = input.value;
    if (!date) {
      toast('Enter the Available date — when maintenance will have the press back.', 'err');
      input.focus();
      return;
    }
    if (date < today) {
      toast('That Available date has already passed — pick today or later.', 'err');
      input.focus();
      return;
    }
    closeModal();
    ctx.setMachineStatus?.(code, 'in-service', date);
  });
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
        const m = row.code ? ctx.machineMaster(row.code) : undefined;
        if (!m?.status) return '—';
        const back = m.status === 'in-service' && m.availableDate ? ` · back ${ddmmyyyy(m.availableDate)}` : '';
        return `${TOOL_STATUS_META[m.status].label}${back}`;
      })(), 'PMD_Machine.Status and AvailableDate')}
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
  /** A tapped bar's bucket (its first day): the list beside the chart
   *  narrows to it. null lists the whole range. */
  pick: string | null;
}
let team: TeamState | null = null;

function teamState(ctx: MaintCtx): TeamState {
  if (!team) team = { owners: new Set(), ...lastWeek(ctx.today), level: '', pick: null };
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

/** Categorical slots, in their validated order (adjacent pairs stay apart
 *  for colour-blind readers when stacked). */
const OWNER_HUES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER_OWNERS = 'Other';
const OTHER_HUE = '#cbd5e1';
const UNASSIGNED_HUE = '#94a3b8';

interface OwnerPaint {
  /** The series an owner is drawn in: itself, or "Other" past the eighth. */
  series(owner: string): string;
  colour(series: string): string;
  /** Stack order, bottom first. */
  rank(series: string): number;
}

/** Each owner's colour for the page, ranked by every hour they have closed —
 *  so a filter or another range never repaints anyone. Past eight named
 *  owners the rest share "Other"; Unassigned is grey, on top. */
function ownerPaint(done: readonly DoneOrder[]): OwnerPaint {
  const total = new Map<string, number>();
  for (const d of done) if (d.owner !== UNASSIGNED) total.set(d.owner, (total.get(d.owner) ?? 0) + d.hours + 1e-6);
  const named = [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o]) => o);
  const slot = new Map(named.slice(0, OWNER_HUES.length).map((o, i) => [o, i]));
  return {
    series: (o) => (o === UNASSIGNED || slot.has(o) ? o : OTHER_OWNERS),
    colour: (s) => (s === UNASSIGNED ? UNASSIGNED_HUE : s === OTHER_OWNERS ? OTHER_HUE : OWNER_HUES[slot.get(s) ?? 0]),
    rank: (s) => (s === UNASSIGNED ? 1e3 + 1 : s === OTHER_OWNERS ? 1e3 : slot.get(s) ?? 999),
  };
}

/** A machine as the list has room for it: the press code, else the Mango
 *  name without its "AU - ". */
const shortAsset = (a: string): string => pressCodeOf(a) || a.replace(/^AU\s*-\s*/i, '') || '—';

/** dd/mm/yy — the list beside the chart is narrow. */
const ddmmyy = (iso: string): string => {
  const m = /^\d{2}(\d{2})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
};

const swatch = (colour: string): string => `<i class="tm-sw" style="background:${colour}"></i>`;

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
  const paint = ownerPaint(done);
  const totalH = inRange.reduce((n, d) => n + d.hours, 0);
  const booked = inRange.filter((d) => d.booked).length;
  const cycle = cycleTime(inRange);
  // A tapped bar whose bucket the range or its unit no longer has is dropped.
  if (st.pick && !buckets.some((b) => b.start === st.pick)) st.pick = null;
  const listFrom = st.pick ?? st.from;
  const listTo = st.pick ? bucketEnd(st.pick, unit) : st.to;
  const listed = inRange.filter((d) => d.day >= listFrom && d.day <= listTo);
  const week = lastWeek(ctx.today);
  const isLastWeek = st.from === week.from && st.to === week.to;
  const ownerChip = (o: string): string => {
    const on = st.owners.has(o);
    return `<button type="button" class="die-chip tm-owner${on ? ' on' : ''}" data-tm-owner="${escapeHtml(o)}" aria-pressed="${on}">${escapeHtml(o)}</button>`;
  };
  // Legend: every owner with an order closed in range, in stack order.
  const per = new Map<string, { n: number; h: number }>();
  for (const d of inRange) {
    const k = paint.series(d.owner);
    const p = per.get(k) ?? { n: 0, h: 0 };
    p.n += 1;
    p.h += d.hours;
    per.set(k, p);
  }
  const legend = [...per.entries()]
    .sort((a, b) => paint.rank(a[0]) - paint.rank(b[0]))
    .map(
      ([o, p]) => `<li title="${escapeHtml(`${o}: ${p.h.toFixed(1)} h on ${p.n} order${p.n === 1 ? '' : 's'} closed`)}">${swatch(paint.colour(o))}<span>${escapeHtml(o)}</span><b>${p.h.toFixed(1)} h</b><em>${p.n} order${p.n === 1 ? '' : 's'}</em></li>`,
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
    .map((o: OpenItem) => {
      const age = o.raised ? -daysUntil(o.raised, ctx.today) : null;
      return `<tr class="tm-${o.level}">
        <td><span class="tm-kind ${o.kind}">${o.kind}</span></td>
        <td class="tm-date">${o.raised ? `${ddmmyyyy(o.raised)}<div class="tm-sub">${age! <= 0 ? 'today' : `${age} d open`}</div>` : '—'}</td>
        <td>${o.due ? dueBadge(o.due, ctx.today) : '<span class="mt-due none">Not set</span>'}</td>
        <td><span class="mt-due ${o.level}">${LEVEL_TEXT[o.level]}</span></td>
        <td title="${escapeHtml(o.asset)}">${escapeHtml(o.asset)}</td>
        <td>${escapeHtml(o.title)}</td>
        <td>${escapeHtml(o.owner)}</td>
        <td>${escapeHtml(o.ticket || o.note)}</td>
      </tr>`;
    })
    .join('');
  const cov = (shown: number, of: number, what: string): string =>
    shown < of ? `<em class="tm-cov">${what} ${shown} of ${of} orders</em>` : '';
  return `<div class="tm">
    <div class="kpi-head tm-head">
      <div class="tm-owners"><span class="tm-lbl">Owner</span>
        <button type="button" class="die-chip tm-owner${st.owners.size === 0 ? ' on' : ''}" data-tm-owner="">Everyone</button>
        ${owners.map(ownerChip).join('')}
      </div>
    </div>

    <section class="tm-card">
      <div class="kpi-head tm-range">
        <h3>✅ Completed work orders</h3>
        <div class="shift-tabs"><button type="button" class="shift-btn${isLastWeek ? ' a' : ''}" data-tm-lastweek>Last Week</button></div>
        <div class="kpi-range">
          <label>From <input type="date" data-tm-date="from" value="${st.from}"></label>
          <label>To <input type="date" data-tm-date="to" value="${st.to}"></label>
        </div>
      </div>
      <div class="tm-tiles">
        <div class="mt-stat"><span>Orders closed</span><b>${inRange.length}</b></div>
        <div class="mt-stat"><span>Labour hours</span><b>${totalH.toFixed(1)}</b>${cov(booked, inRange.length, 'booked on')}</div>
        <div class="mt-stat"><span>Hours / order</span><b>${booked ? (totalH / booked).toFixed(1) : '—'}</b>${booked < inRange.length ? '<em class="tm-cov">of the orders with hours</em>' : ''}</div>
        <div class="mt-stat" title="Days from Mango's Created Date to the day it closed"><span>Cycle time (median)</span><b>${
          cycle.median == null ? '—' : `${cycle.median.toFixed(cycle.median % 1 ? 1 : 0)} d`
        }</b>${cycle.mean == null ? '' : `<em class="tm-cov">mean ${cycle.mean.toFixed(1)} d${cycle.n < inRange.length ? ` · ${cycle.n} of ${inRange.length} orders` : ''}</em>`}</div>
      </div>
      <div class="tm-split">
        <div class="tm-left">
          ${legend ? `<ul class="tm-legend" aria-label="Labour hours by owner">${legend}</ul>` : ''}
          ${teamChart(buckets, unit, st.pick, paint)}
          <p class="kpi-note">Labour hours booked on the orders closed each ${unit}, by owner. <b>Tap a bar</b> to list its orders; tap it again for the whole range. An order counts on the day Mango closed it (Stage 4). Owner is Mango's "Assign to Action" — with two or more people on it, the first who is not ${escapeHtml(MAINT_COORDINATOR)}. Cycle time is the days from its Created Date to that close.</p>
        </div>
        <div class="tm-right">${doneTable(listed, listFrom, listTo, !!st.pick, paint)}</div>
      </div>
    </section>

    <section class="tm-card">
      <h3>📋 Open maintenance requests and PM</h3>
      <div class="die-chips">${(['overdue', 'soon', 'ok', 'none'] as const).map(levelChip).join('')}</div>
      ${
        openRows
          ? `<div class="die-table-wrap"><table class="kpi-table tm-open-table"><thead><tr>
              <th>Type</th><th>Created</th><th>Due</th><th>Status</th><th>Equipment</th><th>What</th><th>Owner</th><th>Ticket / frequency</th>
            </tr></thead><tbody>${openRows}</tbody></table></div>`
          : '<div class="trace-empty">Nothing open for this selection.</div>'
      }
      <p class="kpi-note"><b>MR</b> = an open Mango maintenance request: Created is its Created Date, due by its "To be completed by"; <b>PM</b> = a live event in MachinePM.csv, due by its Event Due Date. Due ≤ 7 d is within the coming week. Mango leaves "To be completed by" empty until the coordinator assesses a request; those come last, the longest-open first.</p>
    </section>
  </div>`;
}

/** The orders closed in the range, or in a tapped bar's period. */
function doneTable(rows: DoneOrder[], from: string, to: string, narrowed: boolean, paint: OwnerPaint): string {
  const hoursSum = rows.reduce((n, d) => n + d.hours, 0);
  const span = from === to ? ddmmyyyy(from) : `${ddmmyyyy(from)} – ${ddmmyyyy(to)}`;
  const body = rows
    .map((d) => {
      const more = [
        d.detail,
        d.summary && `Done: ${d.summary}`,
        d.prevention && `Prevent: ${d.prevention}`,
        ...d.notes.map((n) => `${n.date} ${n.comment}`),
      ].filter(Boolean);
      return `<tr>
        <td class="tm-nowrap">${escapeHtml(d.ticket || '—')}<div class="tm-sub tm-asset" title="${escapeHtml(d.asset)}">${escapeHtml(shortAsset(d.asset))}</div></td>
        <td class="tm-text" title="${escapeHtml([d.title, ...more].join('\n'))}"><b>${escapeHtml(d.title || '—')}</b>${
          d.detail ? `<div>${escapeHtml(d.detail)}</div>` : ''
        }</td>
        <td class="tm-nowrap">${swatch(paint.colour(paint.series(d.owner)))}${escapeHtml(d.owner)}</td>
        <td class="tm-date">${ddmmyy(d.created)}</td>
        <td class="tm-date">${ddmmyy(d.closed)}</td>
        <td class="num">${d.cycleDays == null ? '—' : d.cycleDays}</td>
        <td class="num">${d.hours ? d.hours.toFixed(2).replace(/\.?0+$/, '') : '—'}</td>
      </tr>`;
    })
    .join('');
  return `<div class="tm-list">
    <div class="tm-list-head">
      <b>Closed ${span}</b><span>${rows.length} order${rows.length === 1 ? '' : 's'} · ${hoursSum.toFixed(1)} h</span>
      ${narrowed ? '<button type="button" class="die-chip die-chip-btn" data-tm-pick="" title="List the whole range again">Whole range</button>' : ''}
    </div>
    ${
      rows.length
        ? `<div class="tm-list-wrap"><table class="kpi-table tm-done-table"><thead><tr>
            <th>Ticket</th><th>What</th><th>Owner</th><th>Created</th><th>Closed</th>
            <th class="num" title="Days from Created to Closed">Cycle d</th><th class="num">Hours</th>
          </tr></thead><tbody>${body}</tbody></table></div>`
        : '<div class="trace-empty">No orders closed in this period for this selection.</div>'
    }
  </div>`;
}

/** Clean axis steps (1, 2, 2.5, 5 × 10ⁿ), about four of them. */
function niceTop(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Labour hours per period as columns stacked by owner, on one axis. Each
 *  period is a tap target the full height of the plot; hovering one shows
 *  its owners in a tooltip (wireTeam). */
function teamChart(buckets: Bucket[], unit: BucketUnit, pick: string | null, paint: OwnerPaint): string {
  if (buckets.length === 0) return '';
  const W = 560;
  const H = 280;
  const L = 38;
  const R = 8;
  const T = 16;
  const B = unit === 'day' && buckets.length <= 8 ? 34 : 22;
  const iw = W - L - R;
  const ih = H - T - B;
  const { top, step } = niceTop(Math.max(0, ...buckets.map((b) => b.hours)));
  const y = (v: number): number => T + ih - (v / top) * ih;
  const bw = iw / buckets.length;
  const barW = Math.max(3, Math.min(24, bw * 0.62));
  const GAP = 2;
  const grid: string[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid.push(
      `<line class="${v === 0 ? 'tm-base' : 'tm-grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"></line>` +
        `<text class="tm-tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(1)}${v + step > top + 1e-9 ? ' h' : ''}</text>`,
    );
  }
  const every = Math.max(1, Math.ceil(buckets.length / 10));
  const cols = buckets
    .map((b, i) => {
      const cx = L + i * bw + bw / 2;
      const x0 = cx - barW / 2;
      const series = new Map<string, { hours: number; count: number }>();
      for (const [o, p] of b.byOwner) {
        const k = paint.series(o);
        const q = series.get(k) ?? { hours: 0, count: 0 };
        q.hours += p.hours;
        q.count += p.count;
        series.set(k, q);
      }
      const stack = [...series.entries()].sort((a, z) => paint.rank(a[0]) - paint.rank(z[0]));
      const drawn = stack.filter(([, p]) => p.hours > 0);
      let cum = 0;
      const segs = drawn
        .map(([o, p], j) => {
          const y1 = y(cum + p.hours);
          const y0 = y(cum) - (j === 0 ? 0 : GAP);
          cum += p.hours;
          const h = y0 - y1;
          if (h < 0.5) return '';
          const fill = paint.colour(o);
          if (j < drawn.length - 1) return `<rect class="tm-seg" x="${x0}" y="${y1}" width="${barW}" height="${h}" fill="${fill}"></rect>`;
          const r = Math.min(4, h, barW / 2);
          return `<path class="tm-seg" fill="${fill}" d="M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + barW - r}Q${x0 + barW},${y1} ${x0 + barW},${y1 + r}V${y0}Z"></path>`;
        })
        .join('');
      const [yy, mm, dd] = b.start.split('-');
      const period =
        unit === 'day'
          ? `${WEEKDAY[new Date(`${b.start}T00:00:00`).getDay()]} ${dd}/${mm}/${yy}`
          : unit === 'week'
            ? `Week of ${dd}/${mm}/${yy}`
            : new Date(`${b.start}T00:00:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      const tip = {
        period,
        total: `${b.hours.toFixed(1)} h · ${b.count} order${b.count === 1 ? '' : 's'}`,
        rows: stack.reverse().map(([o, p]) => [o, paint.colour(o), `${p.hours.toFixed(1)} h`, String(p.count)]),
      };
      const tick =
        i % every !== 0
          ? ''
          : unit === 'day' && buckets.length <= 8
            ? `<text class="tm-tick" x="${cx}" y="${H - 20}" text-anchor="middle">${WEEKDAY[new Date(`${b.start}T00:00:00`).getDay()]}</text><text class="tm-tick" x="${cx}" y="${H - 6}" text-anchor="middle">${dd}/${mm}</text>`
            : `<text class="tm-tick" x="${cx}" y="${H - 6}" text-anchor="middle">${unit === 'month' ? `${mm}/${yy.slice(2)}` : `${dd}/${mm}`}</text>`;
      return `<g class="tm-col${b.start === pick ? ' on' : ''}" data-tm-pick="${b.start}" data-tm-tip="${escapeHtml(JSON.stringify(tip))}" role="button" tabindex="0" aria-label="${escapeHtml(`${period}: ${tip.total}`)}">
        <rect class="tm-hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih}"></rect>
        ${segs}${tick}
      </g>`;
    })
    .join('');
  const empty = buckets.every((b) => b.hours === 0)
    ? `<text class="tm-empty" x="${L + iw / 2}" y="${T + ih / 2}" text-anchor="middle">${
        buckets.some((b) => b.count) ? 'No labour hours booked on these orders' : 'No orders closed'
      }</text>`
    : '';
  return `<div class="tm-chart${pick ? ' has-pick' : ''}" data-tm-chart>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Labour hours by owner, per ${unit}">
      ${grid.join('')}
      ${cols}
      ${empty}
    </svg>
    <div class="tm-tip" hidden></div>
  </div>`;
}

export function wireTeam(root: HTMLElement, ctx: MaintCtx): void {
  if (!team) return;
  const st = team;
  const setRange = (from: string, to: string): void => {
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
  root.querySelector<HTMLButtonElement>('[data-tm-lastweek]')?.addEventListener('click', () => {
    const w = lastWeek(ctx.today);
    setRange(w.from, w.to);
  });
  root.querySelectorAll<HTMLInputElement>('[data-tm-date]').forEach((el) =>
    el.addEventListener('change', () => {
      const v = el.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      // Keep From ≤ To: moving one past the other drags it along.
      if (el.dataset.tmDate === 'from') setRange(v, st.to < v ? v : st.to);
      else setRange(st.from > v ? v : st.from, v);
    }),
  );
  // A tapped bar lists its orders beside the chart; tapping it again (or
  // "Whole range") lists the range again.
  root.querySelectorAll<Element>('[data-tm-pick]').forEach((el) => {
    const pick = (): void => {
      const v = el.getAttribute('data-tm-pick') || null;
      st.pick = st.pick === v ? null : v;
      ctx.rerender();
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
  // Hover: the period's owners, largest on top as in the stack.
  const chart = root.querySelector<HTMLElement>('[data-tm-chart]');
  const tip = chart?.querySelector<HTMLElement>('.tm-tip');
  if (!chart || !tip) return;
  const show = (col: Element): void => {
    let data: { period: string; total: string; rows: string[][] };
    try {
      data = JSON.parse(col.getAttribute('data-tm-tip') ?? '');
    } catch {
      return;
    }
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tm-tip-head';
    head.textContent = data.period;
    const total = document.createElement('div');
    total.className = 'tm-tip-total';
    total.textContent = data.total;
    tip.append(head, total);
    for (const [owner, colour, hours, count] of data.rows) {
      const row = document.createElement('div');
      row.className = 'tm-tip-row';
      const sw = document.createElement('i');
      sw.className = 'tm-sw';
      sw.style.background = colour;
      const name = document.createElement('span');
      name.textContent = owner;
      const val = document.createElement('b');
      val.textContent = `${hours} (${count})`;
      row.append(sw, name, val);
      tip.append(row);
    }
    tip.hidden = false;
    const box = chart.getBoundingClientRect();
    const hit = (col.querySelector('.tm-hit') ?? col).getBoundingClientRect();
    const left = Math.min(Math.max(0, hit.left - box.left + hit.width / 2 - tip.offsetWidth / 2), box.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  chart.querySelectorAll('.tm-col').forEach((col) => {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('pointerleave', () => (tip.hidden = true));
    col.addEventListener('blur', () => (tip.hidden = true));
  });
}
