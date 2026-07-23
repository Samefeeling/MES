// 🛠 Tool / Die Management — dedicated top-level tool board. A Fabrico-style
// tool-management board for the die shop:
//   · per-die usage rolled up from production history (shots / pieces /
//     good / rejects, joined via PMD_ProductDieColor's DieNumber),
//   · a per-die defect database (reject codes charged to the die that
//     made them, with the D01-D10 descriptions),
//   · maintenance work orders: MANGO is the system of record (management
//     decision, 2026-07) — every "raise a request" action deep-links to
//     Mango's form, and the work-order list here is a READ-ONLY mirror
//     fed by the Mango CSV report sync (scripts/sync-mango-csv.mjs →
//     OneDrive → SharePoint file → listDieMaintenance).

import type { PmdDataLayer } from '../dal';
import type {
  DieMaintenanceRequest,
  DieMaster,
  MaintPriority,
  MaintStatus,
  MaintType,
  PlanningOrder,
  ProductDieColor,
  ProductionCounterRecord,
  ToolStatus,
} from '../types';
import {
  aggregateDieServiceUsage,
  aggregateDies,
  buildDieTrend,
  DEFAULT_TOOL_MAINTENANCE_LEVEL,
  defaultPmPlanText,
  DIE_CONDITION_META,
  dieHealth,
  dieServiceStatus,
  goodByJob,
  latestConditionByDie,
  machineWorkOrderLevel,
  machineWorkOrdersFor,
  nextPlannedFor,
  parsePmPlan,
  pmShotLevel,
  TOOL_MAINTENANCE_RULES,
  TOOL_STATUS_META,
  type DieAgg,
  type DieConditionSummary,
  type DiePlanned,
  type DieServiceUsage,
  type DieServiceStatus,
} from '../core/die';
import { closeModal, escapeHtml, openModal } from './modal';
import { toast } from './toast';
import { isSupervisor } from './supervisor-auth';
import { STATUS_MAP } from '../core/status';

/** 'smart' = the aggregate's attention-first order (open requests, then
 *  reject-%, then shots). Any other key is a user-picked column sort. */
type DieSortKey =
  | 'smart'
  | 'die'
  | 'description'
  | 'toolStatus'
  | 'lastService'
  | 'parts'
  | 'machines'
  | 'runs'
  | 'medRun'
  | 'shots'
  | 'pieces'
  | 'good'
  | 'rejects'
  | 'rejPct'
  | 'lastRun'
  | 'scheduled'
  | 'available';

interface DieState {
  from: string; // YYYY-MM-DD inclusive
  to: string;
  filter: string;
  sortKey: DieSortKey;
  sortDir: 1 | -1;
  dies: DieAgg[];
  requests: DieMaintenanceRequest[];
  rejectLabels: Map<string, string>;
  /** Machine/plant work orders (Mango mirror), for the Machine column's
   *  per-press colour + drilldown. Empty on backends without the CSV. */
  machineRequests: DieMaintenanceRequest[];
  dieColors: ProductDieColor[];
  /** Die (trimmed, UPPERCASED) → its PMD_DieMaster row (asset facts +
   *  ToolStatus). Absent = the toolroom hasn't registered the tool. */
  masterByDie: Map<string, DieMaster>;
  /** Die → its place in the production schedule (running / next start),
   *  from PMD_Planning via the die's parts. Absent = not scheduled. */
  planByDie: Map<string, DiePlanned>;
  /** Die (trimmed, UPPERCASED) → latest die-change condition report from
   *  PMD_DieChangeLog. Worn/damaged components flag priority service. */
  condByDie: Map<string, DieConditionSummary>;
  /** Independent rolling service ledger (not tied to the visible 7/30/90
   *  day analysis range), keyed by normalised DieNumber. */
  serviceUsageByDie: Map<string, DieServiceUsage>;
  serviceHistoryFrom: string;
  serviceHistoryAvailable: boolean;
  loading: boolean;
  /** Read failures for the current range. The board may still render the
   *  sources that succeeded, but these labels prevent missing data from
   *  masquerading as genuine zero usage / zero work orders. */
  errors: string[];
}

let S: DieState | null = null;
let dalRef: PmdDataLayer;
let hostEl: HTMLElement | null = null;
let loadVersion = 0;
let stickyColumnObserver: ResizeObserver | null = null;

const STATUS_LABELS: Record<MaintStatus, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  done: 'Done',
};
const TYPE_LABELS: Record<MaintType, string> = {
  repair: '🔧 Repair',
  cleaning: '🧽 Cleaning',
  inspection: '🔍 Inspection',
  other: '📋 Other',
};
const PRIORITY_LABELS: Record<MaintPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'URGENT',
};

/** Mango's plant-equipment maintenance request form — the system of
 *  record for work orders (management decision: no separate PMD form).
 *  Every "raise a request" action deep-links here; statuses flow back
 *  via the CSV report sync (scripts/sync-mango-csv.mjs). */
const MANGO_REQUEST_URL = 'https://my.mangolive.com/plant-equipment/request-maintenance';
const mangoLink = (label: string, cls = ''): string =>
  `<a class="die-mango-open${cls ? ' ' + cls : ''}" href="${MANGO_REQUEST_URL}" target="_blank" rel="noopener" title="Open Mango — Request Maintenance (new tab)">🥭 ${label} ↗</a>`;

/** Service-rule position for a die. Usage comes from the independent
 *  maintenance ledger, never the visible analysis window. */
function svcFor(d: DieAgg): DieServiceStatus | null {
  const key = d.dieNumber.trim().toUpperCase();
  const m = masterFor(d.dieNumber);
  const usage = S!.serviceUsageByDie.get(key) ?? d;
  // MaintenanceLevel now stores the multi-level PM plan text, so the
  // shot-based rule always starts from the site baseline; a worn/
  // damaged latest inspection still escalates it.
  return dieServiceStatus(
    usage,
    S!.requests,
    m?.lastServiceDate || undefined,
    DEFAULT_TOOL_MAINTENANCE_LEVEL,
    (condFor(d.dieNumber)?.flags.length ?? 0) > 0,
  );
}

function svcTitle(s: DieServiceStatus): string {
  const sinceTxt = s.sinceIsService
    ? `since service on ${s.since}`
    : `since ${s.since} (first ledger record — no completed service on record, so this is AT LEAST)`;
  const override = s.conditionTriggered
    ? ` · Die Change Log rating >1 escalates the rule to ${TOOL_MAINTENANCE_RULES.C.label}`
    : '';
  return `Service rule: ${s.intervalShots.toLocaleString()} shots · ${s.shotsSince.toLocaleString()} shots ${sinceTxt} (${(s.shotPct * 100).toFixed(0)}%)${override}`;
}

/** "2026-07-12T07:00:00" → "07-12 07:00" (planned starts are local ISO). */
export function fmtPlanned(iso: string): string {
  // Local wall-time strings are deliberately stored without a suffix; read
  // their components directly. Legacy/foreign values carrying Z or an
  // explicit offset must go through Date so Sydney sees local time rather
  // than the UTC digits embedded in the source string.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso.trim());
  const m = zoned ? null : /^\d{4}-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (m) return `${m[1]}-${m[2]} ${m[3]}:${m[4]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Master lookup with a normalised key — PMD_DieMaster and
 *  PMD_ProductDieColor are hand-edited lists, so "280 " vs "280" or
 *  case drift must not break the join. */
function masterFor(dieNumber: string): DieMaster | undefined {
  return S!.masterByDie.get(dieNumber.trim().toUpperCase());
}

/** Work orders for a die, tolerant of trim/case drift between the Mango
 *  mirror's numbers and PMD_ProductDieColor's DieNumber. */
function requestsFor(dieNumber: string): DieMaintenanceRequest[] {
  const key = dieNumber.trim().toUpperCase();
  return S!.requests.filter((r) => r.dieNumber.trim().toUpperCase() === key);
}

/** Latest die-change condition report (PMD_DieChangeLog, keyed on the
 *  die that came OUT). Undefined = no report filed yet. */
function condFor(dieNumber: string): DieConditionSummary | undefined {
  return S!.condByDie.get(dieNumber.trim().toUpperCase());
}

/** Traffic-light on a die's OPEN work orders, from the earliest Mango "To
 *  be completed by" date: red = overdue (passed), amber = due within a
 *  week, green = comfortably ahead. Null when no open order carries a due
 *  date (nothing to colour). Days = how far past due (red only). */
const WO_SOON_DAYS = 7;
function woDueLevel(
  dieNumber: string,
): { level: 'overdue' | 'soon' | 'ok'; due: string; days: number } | null {
  const today = isoDay(new Date());
  const dues = requestsFor(dieNumber)
    .filter((r) => r.status !== 'done')
    .map((r) => (r.dueDate ?? '').slice(0, 10))
    .filter(Boolean)
    .sort();
  if (dues.length === 0) return null;
  const due = dues[0]; // earliest promise governs the light
  const dayMs = 86_400_000;
  const diff = Math.round(
    (new Date(`${due}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / dayMs,
  );
  const level = diff < 0 ? 'overdue' : diff <= WO_SOON_DAYS ? 'soon' : 'ok';
  return { level, due, days: Math.max(0, -diff) };
}

/** Completed orders remain available in each die's maintenance history,
 *  but the board-level work-order list is an action queue. */
export function activeMaintenanceRequests(
  requests: readonly DieMaintenanceRequest[],
): DieMaintenanceRequest[] {
  return requests.filter((r) => r.status !== 'done');
}

/** Mango keeps the lifecycle status; overdue is a live display status
 *  derived from its promised completion date. Due today is not overdue. */
export function isWorkOrderOverdue(
  request: Pick<DieMaintenanceRequest, 'status' | 'dueDate'>,
  today = isoDay(new Date()),
): boolean {
  const due = (request.dueDate ?? '').slice(0, 10);
  return request.status !== 'done' && due !== '' && due < today;
}

export interface MangoActionComment {
  date: string;
  comment: string;
}

/** Turn Mango's verbose audit trail into the useful operator comments.
 *  Lifecycle noise (Created / Completed / Change Stage and the stage in
 *  parentheses) has no Comment: marker, so it is deliberately omitted. */
export function parseMangoActionComments(actionsTaken?: string): MangoActionComment[] {
  if (!actionsTaken?.trim()) return [];
  const entryHeader = /(?:^|\r?\n)\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{1,2})\/(\d{1,2})\/(\d{4}),[^\r\n]*?:[ \t]*/gi;
  const headers = Array.from(actionsTaken.matchAll(entryHeader));
  return headers
    .map((header, index) => {
      const bodyStart = (header.index ?? 0) + header[0].length;
      const bodyEnd = headers[index + 1]?.index ?? actionsTaken.length;
      const body = actionsTaken.slice(bodyStart, bodyEnd);
      const marker = /(?:^|\r?\n)\s*Comment:\s*/i.exec(body);
      if (!marker) return null;
      const comment = body
        .slice(marker.index + marker[0].length)
        .replace(/\s+/g, ' ')
        .trim();
      if (!comment) return null;
      const day = Number(header[1]);
      const month = Number(header[2]);
      const year = Number(header[3]);
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      return {
        date: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
        comment,
        sortKey: year * 10_000 + month * 100 + day,
        sourceIndex: index,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.sortKey - a.sortKey || b.sourceIndex - a.sourceIndex)
    .map(({ date, comment }) => ({ date, comment }));
}

function actionCommentsHtml(actionsTaken?: string): string {
  const comments = parseMangoActionComments(actionsTaken);
  if (comments.length === 0) return '';
  return `<ol class="die-action-comments">${comments
    .map(
      (entry) =>
        `<li><time>${escapeHtml(entry.date)}:</time><span>${escapeHtml(entry.comment)}</span></li>`,
    )
    .join('')}</ol>`;
}

/** One work-order row (Mango mirror) — the full detail card used in both
 *  the drilldown's Maintenance Track and the focused open-WO popup. */
export function woRow(r: DieMaintenanceRequest): string {
  const opened = r.createdAt ? r.createdAt.slice(0, 10) : '';
  const closed = r.closedAt ? r.closedAt.slice(0, 10) : '';
  const days =
    opened && closed
      ? Math.max(
          0,
          Math.round(
            (new Date(`${closed}T00:00:00`).getTime() -
              new Date(`${opened}T00:00:00`).getTime()) / 86_400_000,
          ),
        )
      : null;
  // "To be completed by" — always retain Mango's promised completion date,
  // including after closure. Open work uses today's overdue signal; closed
  // work compares the actual closure date with the promise so history says
  // whether it was completed on time or late (never "OVERDUE" today).
  const dueIso = (r.dueDate ?? '').slice(0, 10);
  const overdue = !closed && dueIso !== '' && dueIso < isoDay(new Date());
  const completion =
    closed && dueIso
      ? ` · ${closed > dueIso ? 'Completed late' : 'Completed on time'}`
      : '';
  const dueTxt = dueIso
    ? `<span class="die-hist-due${overdue ? ' overdue' : ''}">To be completed by ${ddmmyyyy(dueIso)}${overdue ? ' · OVERDUE' : completion}</span>`
    : 'no due date';
  const span = closed
    ? `${escapeHtml(opened)} → ${escapeHtml(closed)}${days != null ? ` · ${days === 0 ? '<1' : days} d` : ''} · ${dueTxt}`
    : `${escapeHtml(opened)} · ${dueTxt} · still open`;
  // Numbers line: downtime / labour / cost as recorded in Mango.
  const nums = [
    r.downtime ? `Downtime <b>${escapeHtml(r.downtime)} h</b>` : '',
    r.labourHours ? `Labour <b>${escapeHtml(r.labourHours)} h</b>` : '',
    r.cost ? `Cost <b>${escapeHtml(r.cost)}</b>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // Narrative lines: what was wrong, what was done, what stops it
  // recurring — the judgement material next to the trend.
  const line = (label: string, v?: string): string =>
    v ? `<div class="die-hist-line"><i>${label}</i>${escapeHtml(v)}</div>` : '';
  const actionComments = actionCommentsHtml(r.actionsTaken);
  return `<li class="die-hist-row">
    <span class="die-req-st st-${r.status}">${STATUS_LABELS[r.status]}</span>
    <span class="die-req-type">${TYPE_LABELS[r.maintType]}</span>
    ${r.priority === 'high' || r.priority === 'urgent' ? `<span class="die-req-pr pr-${r.priority}">${PRIORITY_LABELS[r.priority]}</span>` : ''}
    ${r.mangoTicket ? `<span class="die-mango">🥭 ${escapeHtml(r.mangoTicket)}</span>` : ''}
    <span class="die-hist-span">${span}</span>
    ${nums ? `<span class="die-hist-nums">${nums}</span>` : ''}
    <span class="die-hist-desc">${escapeHtml(r.description || '—')}</span>
    ${line('Issue', r.issueDetail !== r.description ? r.issueDetail : undefined)}
    ${actionComments ? `<div class="die-hist-line die-hist-actions"><i>Actions taken</i>${actionComments}</div>` : ''}
    ${line('Work done', r.workSummary)}
    ${line('Corrective', r.correctiveAction)}
    ${line('Preventative', r.preventativeAction)}
    ${line('Summary', r.summary)}
    ${r.requestedBy ? `<span class="die-hist-who">from ${escapeHtml(r.requestedBy)}</span>` : ''}
    ${r.contact ? `<span class="die-hist-who">→ ${escapeHtml(r.contact)}</span>` : ''}
  </li>`;
}

/**
 * Focused popup listing just the OPEN (not-done) work orders for a die —
 * opened by tapping the 🛠 badge in the Maint column, so the floor can
 * read a ticket's full detail without opening the whole die drilldown.
 */
function openWorkOrders(dieNumber: string): void {
  const open = requestsFor(dieNumber)
    .filter((r) => r.status !== 'done')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = masterFor(dieNumber);
  const title = [dieNumber, m?.description].filter(Boolean).join(' · ');
  openModal(`<div class="die-detail die-wo-modal">
    <div class="kpi-trace-head die-detail-head">
      <h3>🛠 Open Work Orders <span class="die-detail-sub">${escapeHtml(title)}</span></h3>
      <div class="die-detail-head-actions">
        ${mangoLink('Request in Mango', 'hd')}
        <button class="die-detail-close" data-mod="close" title="Close">✕ Close</button>
      </div>
    </div>
    ${
      open.length
        ? `<div class="die-wo-sub">🔧 In progress <span class="die-wo-count">${open.length}</span></div>
           <ul class="die-detail-hist">${open.map(woRow).join('')}</ul>`
        : `<div class="die-wo-empty">No open work orders for this die — it's clear. 🎉</div>`
    }
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
}

/** The Machine column's cell: each press that ran the die, rendered as a
 *  drill-down link the same way Die # is. A press with an OPEN Mango work
 *  order is coloured (green, or red when one is overdue); otherwise it's
 *  the default blue link. Tapping opens that press's work-order history. */
function machineCellHtml(d: DieAgg): string {
  if (d.machines.length === 0) return '<span class="die-tstat none">—</span>';
  const today = isoDay(new Date());
  return d.machines
    .map((mc) => {
      const level = machineWorkOrderLevel(mc, S!.machineRequests, today);
      const openCount = machineWorkOrdersFor(mc, S!.machineRequests).filter(
        (r) => r.status !== 'done',
      ).length;
      const cls =
        level === 'overdue' ? ' wo-overdue' : level === 'open' ? ' wo-open' : '';
      const tip = level
        ? `${mc} · ${openCount} open work order${openCount === 1 ? '' : 's'}${
            level === 'overdue' ? ' · OVERDUE' : ''
          } — tap for machine work-order history`
        : `${mc} — tap for machine work-order history`;
      return `<button class="die-link mc-link${cls}" data-machine-wo="${escapeHtml(
        mc,
      )}" title="${escapeHtml(tip)}">${escapeHtml(mc)}</button>`;
    })
    .join(' ');
}

/**
 * Machine work-order history popup — opened by tapping a press in the
 * Machine column. Mirrors the die drilldown's Maintenance Track: OPEN
 * (in-progress) orders first, then closed History, all from the Mango
 * machine mirror (matched to the press by code — see assetNamesMachine).
 */
function openMachineWorkOrders(machineCode: string): void {
  const all = machineWorkOrdersFor(machineCode, S!.machineRequests);
  const open = all
    .filter((r) => r.status !== 'done')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const history = all
    .filter((r) => r.status === 'done')
    .sort((a, b) => ((a.closedAt || a.createdAt) < (b.closedAt || b.createdAt) ? 1 : -1));
  // Show the plant name Mango uses for this press (first matched asset), so
  // the toolroom can confirm the code resolved to the right equipment.
  const assetName = all.find((r) => r.asset)?.asset ?? '';
  const title = [machineCode, assetName].filter(Boolean).join(' · ');
  const group = (label: string, rows: DieMaintenanceRequest[], empty: string): string =>
    `<div class="die-wo-group">
      <div class="die-wo-sub">${label} <span class="die-wo-count">${rows.length}</span></div>
      ${rows.length ? `<ul class="die-detail-hist">${rows.map(woRow).join('')}</ul>` : `<div class="die-wo-empty">${empty}</div>`}
    </div>`;
  openModal(`<div class="die-detail die-wo-modal">
    <div class="kpi-trace-head die-detail-head">
      <h3>🏭 Machine Work Orders <span class="die-detail-sub">${escapeHtml(title)}</span></h3>
      <div class="die-detail-head-actions">
        ${mangoLink('Request in Mango', 'hd')}
        <button class="die-detail-close" data-mod="close" title="Close">✕ Close</button>
      </div>
    </div>
    ${
      all.length
        ? group('🔧 In progress', open, 'None open — nothing on this machine right now.') +
          group('📓 History', history, 'No closed work orders yet.')
        : `<div class="die-wo-empty">No Mango work orders on record for <b>${escapeHtml(machineCode)}</b>. (The Machine column matches a press to Mango's Plant/Equipment by code.)</div>`
    }
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
}

/** ToolStatus for DISPLAY: PMD_DieMaster's value, overridden to Problems
 *  when the latest die-change report rated any component "3. Damaged" —
 *  the setter's fresh inspection outranks a stale master row. */
function effectiveStatus(dieNumber: string): { st: ToolStatus | ''; overridden: boolean } {
  const st = masterFor(dieNumber)?.toolStatus ?? '';
  if (condFor(dieNumber)?.hasDamaged && st !== 'problems')
    return { st: 'problems', overridden: true };
  return { st, overridden: false };
}

/** Availability comes from the toolroom's own record (PMD_DieMaster),
 *  driven by the EFFECTIVE ToolStatus (incl. the damaged-component
 *  override from the die-change log):
 *    Problems   → Unavailable (can't run at all)
 *    In service → the maintenance-confirmed return date from the
 *                 DieMaster Available column; 'In maint' until the
 *                 toolroom fills it in, ⚠ once that date has passed
 *    otherwise  → Available */
function availableFor(d: DieAgg): { html: string; sort: string | null } {
  const m = masterFor(d.dieNumber);
  const eff = effectiveStatus(d.dieNumber);
  const st = eff.st;
  if (st === 'problems')
    return {
      html: `<span class="die-avail late" title="${eff.overridden ? 'Damaged component in the latest Die Change Log — the die cannot be used' : 'ToolStatus is Problems — the die cannot be used'}">Unavailable</span>`,
      sort: '9999-99-99',
    };
  if (st === 'in-service') {
    const back = (m?.availableDate ?? '').slice(0, 10);
    if (!back)
      return {
        html: '<span class="die-avail maint" title="In service — no return date on record (PMD_DieMaster Available column is empty; this row predates the mandatory date). Tap the Status badge and re-pick In service to record it">In maint</span>',
        sort: '9998-99-99',
      };
    const late = back < isoDay(new Date());
    return {
      html: `<span class="die-avail${late ? ' late' : ''}" title="Return date confirmed by the maintenance team (PMD_DieMaster Available)${late ? ' — DATE HAS PASSED, chase the toolroom' : ''}">${late ? '⚠ ' : ''}${escapeHtml(back.slice(5))}</span>`,
      sort: back,
    };
  }
  return {
    html: '<span class="die-avail now" title="ToolStatus is not In service / Problems — the die is available">Available</span>',
    sort: '0000-00-00',
  };
}

/** The badge is a BUTTON when the backend can write PMD_DieMaster —
 *  tapping it opens the status picker. A die with no master row stays a
 *  plain dash (the app can't invent asset rows) — unless the die-change
 *  log reports a damaged component, which shows as Problems regardless. */
function toolStatusBadge(dieNumber: string, editable = false): string {
  const m = masterFor(dieNumber);
  const eff = effectiveStatus(dieNumber);
  if (!m && !eff.overridden) {
    return `<span class="die-tstat none" title="No PMD_DieMaster row for this die yet">—</span>`;
  }
  const meta = eff.st ? TOOL_STATUS_META[eff.st] : null;
  const c = condFor(dieNumber);
  const src = eff.overridden
    ? `"3. Damaged" in the Die Change Log of ${c!.date} (${c!.flags
        .filter((f) => f.condition === 'damaged')
        .map((f) => f.label)
        .join(', ')}) — priority service` +
      (m ? '. Tap to set PMD_DieMaster to match' : '')
    : `PMD_DieMaster ToolStatus${m?.dateStamp ? ` · updated ${m.dateStamp.slice(0, 10)}` : ''}`;
  const inner = meta ? `● ${meta.label}${eff.overridden ? ' ⚠' : ''}` : '—';
  const cls = meta ? `die-tstat ${meta.cls}` : 'die-tstat none';
  if (editable && m && dalRef.updateDieMaster) {
    return `<button class="${cls} die-tstat-btn" data-die-status="${escapeHtml(dieNumber)}" title="${escapeHtml(
      `${src}${eff.overridden ? '' : ' — tap to change'}`,
    )}">${inner} ▾</button>`;
  }
  return `<span class="${cls}" title="${escapeHtml(src)}">${inner}</span>`;
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Present a stored ISO date (yyyy-mm-dd) in the site's dd/mm/yyyy form —
 *  the same format Mango's "To be completed by" column uses, so the
 *  operators read dates the way the source file writes them. '' passes
 *  through unchanged. */
function ddmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Mount (or re-mount) the Die Management board into `host`. Owns its
 *  own state + re-render loop; the Tool route provides the div. */
export async function mountDieTab(dal: PmdDataLayer, host: HTMLElement): Promise<void> {
  dalRef = dal;
  hostEl = host;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29); // default window: last 30 days
  S = {
    from: isoDay(from),
    to: isoDay(to),
    filter: '',
    sortKey: 'smart',
    sortDir: 1,
    dies: [],
    requests: [],
    rejectLabels: new Map(),
    machineRequests: [],
    dieColors: [],
    masterByDie: new Map(),
    planByDie: new Map(),
    condByDie: new Map(),
    serviceUsageByDie: new Map(),
    serviceHistoryFrom: '',
    serviceHistoryAvailable: false,
    loading: true,
    errors: [],
  };
  render();
  await loadAll();
}

async function loadAll(): Promise<void> {
  if (!S) return;
  const state = S;
  const version = ++loadVersion;
  const from = state.from;
  const to = state.to;
  const errors: string[] = [];
  const safe = async <T>(label: string, promise: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await promise;
    } catch (e) {
      console.error(`[die] ${label} failed:`, e);
      errors.push(`${label}: ${(e as Error).message || 'read failed'}`);
      return fallback;
    }
  };
  state.loading = true;
  state.errors = [];
  render();
  // Maintenance is independent of the visible 7/30/90-day analysis. A
  // 400-day ledger covers the full Level-A annual interval plus a buffer;
  // a service older than that is already calendar-due, so older shot detail
  // cannot change the action.
  const serviceFromDate = new Date();
  serviceFromDate.setDate(serviceFromDate.getDate() - 399);
  const serviceFrom = isoDay(serviceFromDate);
  const serviceTo = isoDay(new Date());
  const serviceCountersPromise: Promise<ProductionCounterRecord[]> =
    dalRef.listProductionCounters
      ? safe(
          'Service shot history',
          dalRef.listProductionCounters({
            shiftIdFrom: `${serviceFrom}-`,
            shiftIdTo: `${serviceTo}-￿`,
          }),
          [],
        )
      : safe(
          'Service shot history',
          dalRef
            .listProduction({
              shiftIdFrom: `${serviceFrom}-`,
              shiftIdTo: `${serviceTo}-￿`,
            })
            .then((rows) => rows.filter((r) => r.slotIndex === 0)),
          [],
        );
  const [dieColors, requests, machineRequests, rejCats, records, planning, master, changeLogs, serviceCounters] = await Promise.all([
    dalRef.listProductDieColors
      ? safe('Die/part mapping', dalRef.listProductDieColors(), [])
      : Promise.resolve([]),
    dalRef.listDieMaintenance
      ? safe('Maintenance work orders', dalRef.listDieMaintenance(), [])
      : Promise.resolve([]),
    dalRef.listMachineMaintenance
      ? safe('Machine work orders', dalRef.listMachineMaintenance(), [])
      : Promise.resolve([]),
    safe('Reject categories', dalRef.listRejectCategories(), []),
    safe(
      'Production history',
      dalRef.listProduction({ shiftIdFrom: `${from}-`, shiftIdTo: `${to}-￿` }),
      [],
    ),
    safe('Planning', dalRef.listPlanning({}), []),
    dalRef.listDieMaster
      ? safe('Die master', dalRef.listDieMaster(), [])
      : Promise.resolve([]),
    dalRef.listDieChangeLog
      ? safe('Die-change condition logs', dalRef.listDieChangeLog(), [])
      : Promise.resolve([]),
    serviceCountersPromise,
  ]);
  // A slower response for an old date range must never overwrite the range
  // the user picked afterwards (or a newly-mounted tab instance).
  if (version !== loadVersion || S !== state) return;
  state.dieColors = dieColors;
  state.masterByDie = new Map(master.map((m) => [m.dieNumber.trim().toUpperCase(), m]));
  state.condByDie = latestConditionByDie(changeLogs);
  state.serviceUsageByDie = aggregateDieServiceUsage(dieColors, serviceCounters);
  state.serviceHistoryFrom = serviceFrom;
  state.serviceHistoryAvailable = !errors.some((e) => e.startsWith('Service shot history:'));
  state.requests = requests;
  state.machineRequests = machineRequests;
  state.rejectLabels = new Map(rejCats.map((c) => [c.code, c.label]));
  state.dies = aggregateDies(dieColors, records, requests);
  // Description: PMD_DieMaster's DieDescription is the toolroom's own name
  // for the tool — prefer it wherever a master row exists. The
  // PMD_ProductDieColor Die text stays as the fallback for dies the
  // toolroom hasn't registered yet.
  for (const d of state.dies) {
    const masterDesc = state.masterByDie.get(d.dieNumber.trim().toUpperCase())?.description;
    if (masterDesc?.trim()) d.description = masterDesc.trim();
  }
  state.errors = errors;
  // Join health check: master rows loaded but NONE matched a die means
  // the two lists' DieNumber values disagree — dump samples so the
  // mismatch is visible ("280" vs "DIE-280" vs "280.0"…).
  if (master.length > 0) {
    const matched = state.dies.filter((d) =>
      state.masterByDie.has(d.dieNumber.trim().toUpperCase()),
    ).length;
    if (matched === 0) {
      console.warn(
        '[pmd] PMD_DieMaster ↔ PMD_ProductDieColor join matched 0 dies.',
        'DieMaster DieNumbers (first 5):', master.slice(0, 5).map((m) => JSON.stringify(m.dieNumber)),
        '· ProductDieColor DieNumbers (first 5):',
        state.dies.slice(0, 5).map((d) => JSON.stringify(d.dieNumber)),
      );
    }
  }
  // Scheduled column: what the Epicor plan has lined up for each die.
  // An order PMD already shows as fully produced (good ≥ order qty) is
  // treated as finished even if Epicor hasn't dropped it from the plan
  // yet — so it stops reading "▶ Now" and the die shows the next order.
  const now = new Date();
  const good = goodByJob(records);
  const isComplete = (o: PlanningOrder): boolean =>
    o.orderQty > 0 && (good.get(o.jobNumber.trim()) ?? 0) >= o.orderQty;
  state.planByDie = new Map();
  for (const d of state.dies) {
    const p = nextPlannedFor(d.parts.map((x) => x.partNumber), planning, now, isComplete);
    if (p) state.planByDie.set(d.dieNumber, p);
  }
  state.loading = false;
  render();
}

function rejLabel(code: string): string {
  return S?.rejectLabels.get(code) ?? '';
}

// ---------------------------------------------------------------------
// rendering

function render(): void {
  if (!S || !hostEl || !hostEl.isConnected) return;
  // The table is replaced wholesale on every filter / sort render. Stop
  // observing the old Die # header before its DOM is detached.
  stickyColumnObserver?.disconnect();
  stickyColumnObserver = null;
  hostEl.innerHTML = `
    ${renderHead()}
    ${renderDataErrors(S.errors)}
    ${S.loading ? `<div class="trace-empty">Loading die usage…</div>` : renderBody()}
  `;
  wire();
}

function renderDataErrors(errors: string[]): string {
  if (errors.length === 0) return '';
  return `<div class="data-error-banner" role="alert"><b>⚠ Partial data only.</b> ${errors
    .map((e) => escapeHtml(e))
    .join(' · ')}</div>`;
}

/** Same visual language as the KPI page head: compact preset tabs (the
 *  active range highlighted) + the same From/To date pickers, in one
 *  white card. */
function renderHead(): string {
  const today = isoDay(new Date());
  const activeDays =
    S!.to === today
      ? Math.round(
          (new Date(`${S!.to}T00:00:00`).getTime() - new Date(`${S!.from}T00:00:00`).getTime()) /
            86_400_000,
        ) + 1
      : 0;
  const preset = (days: number, label: string): string =>
    `<button class="shift-btn${days === activeDays ? ' a' : ''}" data-die-preset="${days}">${label}</button>`;
  return `<div class="kpi-head die-head">
    <div class="shift-tabs">
      ${preset(7, '7 days')}${preset(30, '30 days')}${preset(90, '90 days')}
    </div>
    <div class="kpi-range">
      <label>From <input type="date" data-die-from value="${escapeHtml(S!.from)}"></label>
      <label>To <input type="date" data-die-to value="${escapeHtml(S!.to)}"></label>
    </div>
    <input type="text" class="die-filter" data-die-filter placeholder="Filter die / part…" value="${escapeHtml(S!.filter)}">
    ${mangoLink('Raise Request in Mango', 'lg')}
  </div>`;
}

function renderBody(): string {
  const open = S!.requests.filter((r) => r.status !== 'done');
  const active = S!.dies.filter((d) => d.runs > 0).length;
  const attention = S!.dies.filter((d) => dieHealth(d.rejectPct) === 'red').length;
  const svcDue = S!.dies.filter((d) => svcFor(d)?.level === 'due').length;
  // Status-source health chip: makes a broken PMD_DieMaster hookup
  // visible ON the page (the floor doesn't open F12). Three states:
  // list unreachable/empty → warn; loaded but zero DieNumbers match →
  // warn with counts; healthy → matched count, no drama.
  const masterLoaded = S!.masterByDie.size;
  const matched = S!.dies.filter((d) => masterFor(d.dieNumber)).length;
  const statusChip =
    masterLoaded === 0
      ? `<span class="die-chip is-bad" title="PMD_DieMaster returned no rows, so every Status shows '—'. Most common cause: the list was created under 'My lists' in the Lists app (personal space) instead of on THIS SharePoint site — recreate it via Site contents → New → List on the site. Details in the F12 console ([pmd] PMD_DieMaster…).">Status source <b>⚠ no data</b></span>`
      : matched === 0
        ? `<span class="die-chip is-warn" title="PMD_DieMaster loaded ${masterLoaded} tools but not one DieNumber matches PMD_ProductDieColor's — compare the two columns' values (e.g. '280' vs 'DIE-280'). The F12 console logs 5 samples from each side.">Status join <b>0/${masterLoaded}</b></span>`
        : `<span class="die-chip" title="Dies with a PMD_DieMaster ToolStatus">Status <b>${matched}/${S!.dies.length}</b></span>`;
  // Work-order source chip: is the Mango CSV mirror actually feeding
  // this page, or are we on the PMD_DieMaintenance fallback?
  const woSrc = dalRef.workOrderSource ? dalRef.workOrderSource() : null;
  const woChip =
    woSrc === 'mango-csv'
      ? `<span class="die-chip" title="Work orders mirrored from the Mango CSV report">WO <b>Mango CSV · ${S!.requests.length}</b></span>`
      : `<span class="die-chip is-warn" title="Work orders are coming from the PMD_DieMaintenance list — the Mango CSV mirror is NOT active. Either set VITE_MANGO_CSV_PATH, or drop MangoWorkOrders.csv into the same folder as the Planning CSV (it's auto-found there). Rebuild; F12 shows '[pmd] Mango work-order CSV' messages.">WO <b>PMD list — no Mango CSV</b></span>`;
  const chips = `<div class="die-chips">
    <span class="die-chip">Dies <b>${S!.dies.length}</b></span>
    <span class="die-chip">Ran in window <b>${active}</b></span>
    <span class="die-chip${attention ? ' is-bad' : ''}">High reject <b>${attention}</b></span>
    <span class="die-chip${svcDue ? ' is-bad' : ''}" title="Dual-trigger tool policy — A: yearly OR 50,000 shots · B: quarterly OR 15,000 · C: monthly OR 5,000. The first limit reached wins; any latest Die Change Log rating above 1 forces Level C.">Service due <b>${svcDue}</b></span>
    <span class="die-chip${open.length ? ' is-warn' : ''}">Open requests <b>${open.length}</b></span>
    ${statusChip}
    ${woChip}
  </div>`;
  return `${chips}${renderDieTable()}${renderRequests()}`;
}

function filteredDies(): DieAgg[] {
  const f = S!.filter.trim().toUpperCase();
  if (!f) return S!.dies;
  return S!.dies.filter(
    (d) =>
      d.dieNumber.toUpperCase().includes(f) ||
      d.parts.some(
        (p) => p.partNumber.toUpperCase().includes(f) || p.name.toUpperCase().includes(f),
      ),
  );
}

/** Natural sort key for die numbers: every digit run is zero-padded to a
 *  fixed width, so "280" comes before "1050" (numeric value) while any
 *  prefix/suffix ("DIE-280", "280A") still compares alphabetically around
 *  the digits. A plain string compare put 1050 ahead of 280 — die numbers
 *  are numbers to the toolroom, so the column sorts them that way. */
export function dieNumberSortKey(dieNumber: string): string {
  return dieNumber
    .trim()
    .toUpperCase()
    .replace(/\d+/g, (run) => run.padStart(12, '0'));
}

/** Column sort accessors. Strings compare case-insensitively; numeric
 *  nulls (a die that never ran) always sink to the bottom. */
const SORT_ACCESSORS: Record<Exclude<DieSortKey, 'smart'>, (d: DieAgg) => string | number | null> = {
  die: (d) => dieNumberSortKey(d.dieNumber),
  description: (d) => (d.description || '￿').toUpperCase(),
  // Worst-first rank (Problems 0 → Serviced 3), on the EFFECTIVE status
  // (incl. the damaged-component override); unregistered dies last.
  toolStatus: (d) => {
    const st = effectiveStatus(d.dieNumber).st;
    return st ? TOOL_STATUS_META[st].rank : null;
  },
  // Ascending = longest since service first (the actionable order).
  lastService: (d) => masterFor(d.dieNumber)?.lastServiceDate?.slice(0, 10) || null,
  parts: (d) => d.parts.length,
  // Count first, then the machine names alphabetically — a bare
  // machines.length looked "broken" whenever several dies ran on the
  // same number of presses (every click was a no-op tie).
  machines: (d) =>
    d.machines.length === 0
      ? null
      : `${String(d.machines.length).padStart(3, '0')}|${d.machines.join(',')}`,
  runs: (d) => d.runs,
  medRun: (d) => d.medianRunShots,
  shots: (d) => d.shots,
  pieces: (d) => d.pieces,
  good: (d) => d.good,
  rejects: (d) => d.rejects,
  rejPct: (d) => d.rejectPct,
  lastRun: (d) => d.lastRun || null,
  scheduled: (d) => S!.planByDie.get(d.dieNumber)?.start ?? null,
  // Available (0000…) first, then confirmed return dates, then dateless
  // In-maint (9998…), Unavailable (9999…) last.
  available: (d) => availableFor(d).sort,
};

function sortedDies(dies: DieAgg[]): DieAgg[] {
  if (S!.sortKey === 'smart') return dies; // aggregate's attention-first order
  const get = SORT_ACCESSORS[S!.sortKey];
  const dir = S!.sortDir;
  return [...dies].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last regardless of direction
    if (bv == null) return -1;
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

// ---------------------------------------------------------------------
// column resizing — the die table carries 16 columns, and what's a
// comfortable width on the iPad is cramped on a PC monitor. Dragging a
// header's right edge resizes that column; widths persist per device in
// localStorage and are re-applied on every render. Double-tap resets.

/** One key per table column, in header order — the localStorage map and
 *  the <colgroup> are both keyed by these, so a future column insert
 *  invalidates nothing (unknown keys are simply ignored). */
const DIE_COL_KEYS = [
  'die', 'description', 'toolStatus', 'lastService', 'parts', 'machines',
  'runs', 'medRun', 'shots', 'pieces', 'good', 'rejects', 'rejPct', 'trend',
  'lastRun', 'scheduled', 'available', 'maint',
] as const;
const COLW_KEY = 'pmd.die.colw';

function savedColWidths(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(COLW_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, number>;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** Re-apply saved widths after a render. Fixed layout only kicks in once
 *  the user has resized something — before that the browser's automatic
 *  layout stays in charge. */
function applyColWidths(table: HTMLTableElement): void {
  const saved = savedColWidths();
  if (!saved) return;
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup col'));
  let total = 0;
  let allSaved = true;
  for (const c of cols) {
    const w = saved[c.dataset.ck ?? ''];
    if (typeof w === 'number' && w > 0) {
      c.style.width = `${Math.round(w)}px`;
      total += Math.round(w);
    } else {
      allSaved = false;
    }
  }
  if (total > 0) {
    table.style.tableLayout = 'fixed';
    table.classList.add('resized');
    // With every column pinned the table's own width must be the sum,
    // otherwise fixed layout re-squeezes to the container.
    if (allSaved) table.style.width = `${total}px`;
  }
}

/** Description is the second pinned column, so its `left` offset must
 * follow the rendered Die # width. That first column is user-resizable
 * and can also change with viewport / font sizing. */
function syncStickyColumnOffset(table: HTMLTableElement): void {
  const first = table.querySelector<HTMLTableCellElement>('thead th:first-child');
  const width = first?.getBoundingClientRect().width ?? 0;
  if (width > 0) table.style.setProperty('--die-sticky-first-width', `${width}px`);
}

function wireColResize(table: HTMLTableElement): void {
  applyColWidths(table);
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'));
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup col'));
  syncStickyColumnOffset(table);
  if (ths[0] && typeof ResizeObserver !== 'undefined') {
    stickyColumnObserver = new ResizeObserver(() => syncStickyColumnOffset(table));
    stickyColumnObserver.observe(ths[0]);
  }
  table.querySelectorAll<HTMLElement>('[data-die-rz]').forEach((rz) => {
    // The handle lives inside a sortable <th> — swallow clicks so a
    // resize never doubles as a sort.
    rz.addEventListener('click', (e) => e.stopPropagation());
    rz.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      localStorage.removeItem(COLW_KEY);
      render();
    });
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = rz.closest('th');
      const idx = th ? ths.indexOf(th as HTMLTableCellElement) : -1;
      if (idx < 0 || !cols[idx]) return;
      // Freeze every column at its current rendered width first — under
      // automatic layout, growing one column would rebalance the rest.
      const widths = ths.map((t) => Math.round(t.getBoundingClientRect().width));
      cols.forEach((c, i) => (c.style.width = `${widths[i]}px`));
      table.style.tableLayout = 'fixed';
      table.classList.add('resized');
      const totalRest = widths.reduce((a, b) => a + b, 0) - widths[idx];
      table.style.width = `${totalRest + widths[idx]}px`;
      const startX = e.clientX;
      const startW = widths[idx];
      rz.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        cols[idx].style.width = `${w}px`;
        table.style.width = `${totalRest + w}px`;
        syncStickyColumnOffset(table);
      };
      const up = (): void => {
        rz.removeEventListener('pointermove', move);
        const out: Record<string, number> = {};
        cols.forEach((c, i) => {
          out[c.dataset.ck ?? String(i)] =
            Math.round(parseFloat(c.style.width)) || widths[i];
        });
        try {
          localStorage.setItem(COLW_KEY, JSON.stringify(out));
        } catch {
          /* storage full / private mode — the resize still applies for this page */
        }
      };
      rz.addEventListener('pointermove', move);
      rz.addEventListener('pointerup', up, { once: true });
      rz.addEventListener('pointercancel', up, { once: true });
    });
  });
}

/** Defect-trend sparkline: one bar per day (per week on >35-day windows),
 *  bar height = reject qty, bar colour = that bucket's reject-% health.
 *  Grey baseline dot = ran clean; empty = didn't run. This is the
 *  "should we service it?" picture — a die drifting amber→red
 *  left-to-right is asking for a repair before the KPI page notices. */
function sparkline(d: DieAgg): string {
  const buckets = buildDieTrend(d.daily, S!.from, S!.to);
  if (buckets.length === 0 || d.runs === 0) return '<span class="die-spark-none">—</span>';
  const max = Math.max(1, ...buckets.map((b) => b.rejects));
  const bars = buckets
    .map((b) => {
      const pct = b.pieces > 0 ? (b.rejects / b.pieces) * 100 : null;
      const health = dieHealth(pct);
      const label = b.span === 1 ? b.day.slice(5) : `wk ${b.day.slice(5)}`;
      if (b.pieces === 0 && b.rejects === 0)
        return `<i class="empty" title="${escapeHtml(label)} · no production"></i>`;
      const split = Object.entries(b.rejByStatus)
        .sort((x, y) => y[1] - x[1])
        .map(([s, q]) => `${s}×${q}`)
        .join(' ');
      const h = b.rejects === 0 ? 8 : Math.max(14, Math.round((b.rejects / max) * 100));
      return `<i class="${health || 'green'}" style="height:${h}%" title="${escapeHtml(
        `${label} · ${b.rejects} rej / ${b.pieces} pcs${pct != null ? ` (${pct.toFixed(1)}%)` : ''}${split ? ` · ${split}` : ''}`,
      )}"></i>`;
    })
    .join('');
  return `<span class="die-spark" data-die-detail="${escapeHtml(d.dieNumber)}" title="Reject trend ${escapeHtml(
    S!.from,
  )} → ${escapeHtml(S!.to)} — tap for detail">${bars}</span>`;
}

function renderDieTable(): string {
  const dies = sortedDies(filteredDies());
  if (dies.length === 0) {
    return `<div class="trace-empty">No dies match. Die numbers come from the PMD_ProductDieColor list's DieNumber column — fill it in there to see a die here.</div>`;
  }
  const rows = dies
    .map((d) => {
      const health = dieHealth(d.rejectPct);
      const svc = svcFor(d);
      const svcBadge =
        svc && svc.level !== 'ok'
          ? `<span class="die-svc-badge ${svc.level}" title="${escapeHtml(svcTitle(svc))}">${
              svc.level === 'due' ? '🔧 Service due' : '⏳ Service soon'
            }</span>`
          : '';
      // Worn / damaged components from the latest die-change condition
      // report — anything rated >1 queues the die for priority service.
      const cond = condFor(d.dieNumber);
      const condChips = cond && cond.flags.length
        ? cond.flags
            .slice(0, 2)
            .map(
              (f) =>
                `<span class="die-cond-chip ${f.condition}" title="${escapeHtml(
                  `${f.label} — ${DIE_CONDITION_META[f.condition].label} · Die Change Log ${cond.date} ${cond.shift} · ${cond.dieSetter}`,
                )}">${escapeHtml(f.label)} ${DIE_CONDITION_META[f.condition].short}</span>`,
            )
            .join('') +
          (cond.flags.length > 2
            ? `<span class="die-cond-chip more" title="${escapeHtml(
                cond.flags
                  .slice(2)
                  .map((f) => `${f.label} ${DIE_CONDITION_META[f.condition].short}`)
                  .join(' · '),
              )}">+${cond.flags.length - 2}</span>`
            : '')
        : '';
      // Traffic-light the open-work-order badge by its Mango due date:
      // red = overdue, amber = due within a week, green = comfortably ahead
      // (no extra text — the colour is the signal).
      const wo = woDueLevel(d.dieNumber);
      const woTip = wo
        ? wo.level === 'overdue'
          ? `${d.openRequests} open · OVERDUE — 'To be completed by' ${ddmmyyyy(wo.due)} (${wo.days}d ago). Tap for details.`
          : wo.level === 'soon'
            ? `${d.openRequests} open · due soon — 'To be completed by' ${ddmmyyyy(wo.due)}. Tap for details.`
            : `${d.openRequests} open · due ${ddmmyyyy(wo.due)}. Tap for details.`
        : `${d.openRequests} open work order${d.openRequests === 1 ? '' : 's'} — tap for details`;
      const maintBadge = d.openRequests
        ? `<button class="die-maint-badge${wo ? ` wo-${wo.level}` : ''}" data-die-wo="${escapeHtml(d.dieNumber)}" title="${escapeHtml(woTip)}">🛠 ${d.openRequests}</button>`
        : '';
      const maint = condChips + maintBadge + svcBadge;
      const partsTip = d.parts
        .map((p) => `${p.partNumber}${p.name ? ` (${p.name})` : ''}`)
        .join(', ');
      // Scheduled: is the die on the Epicor plan? Running now / next
      // start / free. A free die is the safe one to pull for service.
      const plan = S!.planByDie.get(d.dieNumber);
      const planTip = plan
        ? `${plan.jobNumber}${plan.machineCode ? ` on ${plan.machineCode}` : ''} · planned start ${fmtPlanned(plan.start)}`
        : 'Not on the production schedule — safe window for service';
      const planCell = plan
        ? plan.running
          ? `<span class="die-plan running" title="${escapeHtml(planTip)}">▶ Now · ${escapeHtml(fmtPlanned(plan.start))}</span>`
          : `<span class="die-plan" title="${escapeHtml(planTip)}">${escapeHtml(fmtPlanned(plan.start))}</span>`
        : `<span class="die-plan free" title="${escapeHtml(planTip)}">Free</span>`;
      return `<tr data-die-row="${escapeHtml(d.dieNumber)}">
        <td class="die-num"><button class="die-link" data-die-detail="${escapeHtml(d.dieNumber)}">${escapeHtml(d.dieNumber)}</button></td>
        <td class="die-desc" title="${escapeHtml(d.description || '')}">${escapeHtml(d.description || '—')}</td>
        <td>${toolStatusBadge(d.dieNumber, true)}</td>
        <td>${(() => {
          const ls = masterFor(d.dieNumber)?.lastServiceDate;
          return ls
            ? `<span title="PMD_DieMaster LastServiceDate">${escapeHtml(ls.slice(0, 10))}</span>`
            : '<span class="die-tstat none">—</span>';
        })()}</td>
        <td title="${escapeHtml(partsTip)}">${d.parts.length}</td>
        <td class="die-mc-cell">${machineCellHtml(d)}</td>
        <td class="num">${d.runs}</td>
        <td class="num">${d.medianRunShots == null ? '—' : d.medianRunShots.toLocaleString()}</td>
        <td class="num">${d.shots.toLocaleString()}</td>
        <td class="num">${d.pieces.toLocaleString()}</td>
        <td class="num">${d.good.toLocaleString()}</td>
        <td class="num">${d.rejects.toLocaleString()}</td>
        <td class="num ${health}">${d.rejectPct == null ? '—' : d.rejectPct + '%'}</td>
        <td class="die-trend-cell">${sparkline(d)}</td>
        <td>${escapeHtml(d.lastRun || '—')}</td>
        <td>${planCell}</td>
        <td>${availableFor(d).html}</td>
        <td>${maint}</td>
      </tr>`;
    })
    .join('');
  // Drag the right edge of any header to resize that column (widths are
  // remembered per device — the PC monitor wants a wider table than the
  // iPad); double-tap an edge to reset every column back to automatic.
  const rz = `<span class="die-rz" data-die-rz title="Drag to resize · double-tap to reset all columns"></span>`;
  const th = (key: DieSortKey | '', label: string, title = ''): string => {
    if (!key)
      return `<th${title ? ` title="${escapeHtml(title)}"` : ''}>${label}${rz}</th>`;
    const active = S!.sortKey === key;
    const ind = active ? (S!.sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="die-sort${active ? ' a' : ''}" data-die-sort="${key}"${
      title ? ` title="${escapeHtml(title)}"` : ''
    }>${label}${ind}${rz}</th>`;
  };
  const colgroup = `<colgroup>${DIE_COL_KEYS.map((k) => `<col data-ck="${k}">`).join('')}</colgroup>`;
  return `<div class="die-table-wrap"><table class="kpi-table die-table">
    ${colgroup}
    <thead><tr>
      ${th('die', 'Die #')}
      ${th('description', 'Description', "The tool's name — PMD_DieMaster's DieDescription (falls back to PMD_ProductDieColor's Die text when the tool isn't registered there)")}
      ${th('toolStatus', 'Status', 'Tool condition from PMD_DieMaster.ToolStatus: 🔴 Problems · 🟠 To be Serviced · 🔵 In service · 🟢 Serviced — tap a badge to change it')}
      ${th('lastService', 'Last service', 'PMD_DieMaster.LastServiceDate — stamped automatically when Status is set to Serviced. Sorting ascending puts the longest-unserviced tools first')}
      ${th('parts', 'Parts', 'Part numbers that run on this die')}
      ${th('machines', 'Machines', "Presses this die ran on. Each is a link to that machine's Mango work-order history — 🟢 green = an open order, 🔴 red = an open order overdue, blue = no open order")}
      ${th('runs', 'Runs', '(machine, shift, job) runs in the window')}
      ${th('medRun', 'Med run', 'Median shots per run — the typical campaign size, for planning how big a service window needs to be')}
      ${th('shots', 'Shots', 'Press cycles = Σ (Count End − Count Start) — the die-wear number')}
      ${th('pieces', 'Pieces', 'Shots × cavities')}
      ${th('good', 'Good')}
      ${th('rejects', 'Reject')}
      ${th('rejPct', 'Rej %', 'Reject ÷ Pieces — 🟢 <2% · 🟡 2-5% · 🔴 >5%')}
      ${th('', 'Defect trend', 'Rejects per day (per week on long windows); bar colour = that day’s reject-% band — tap for the code Pareto')}
      ${th('lastRun', 'Last run')}
      ${th('scheduled', 'Scheduled', 'Next planned production (Epicor JobHead_StartDate). ▶ Now = running per plan · Free = not scheduled, safe to pull for service')}
      ${th('available', 'Available', 'From ToolStatus + PMD_DieMaster: Available = ready to run · a date = maintenance-confirmed return (Available column) while In service · In maint = in service, no date confirmed yet · ⚠ = confirmed date has passed · Unavailable = ToolStatus Problems')}
      ${th('', 'Maint')}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="kpi-note">Usage inside the selected window. <b>Shots</b> = press cycles (Count End − Count Start) — the number that wears the die; <b>Pieces</b> = shots × cavities. <b>Status</b> is the toolroom's verdict from PMD_DieMaster. <b>Defect trend</b>: bar height = reject qty per day, colour = that day's reject-% band — a die drifting 🟡→🔴 left-to-right is due for service. The header, <b>Die #</b> and <b>Description</b> stay pinned while scrolling. Tap a column header to sort; drag a header's right edge to resize the column (double-tap the edge to reset); tap Die # or the trend for detail.</p>`;
}

/** READ-ONLY work-order mirror. Mango owns the lifecycle — this list
 *  just shows where each order stands (fed by the CSV report sync, or by
 *  legacy PMD_DieMaintenance rows on tenants without the sync yet). */
function renderRequests(): string {
  const note = `<p class="die-req-note">Work orders live in <b>Mango</b> — raise and progress them there; this list is a read-only mirror refreshed by the report sync.</p>`;
  const today = isoDay(new Date());
  const active = activeMaintenanceRequests(S!.requests);
  if (active.length === 0) {
    return `<div class="die-req-section"><h3>🛠 Maintenance Work Orders ${mangoLink('Mango', 'sm')}</h3>
      ${note}
      <div class="trace-empty">No open work orders for these dies.</div></div>`;
  }
  const order: Record<MaintStatus, number> = { open: 0, 'in-progress': 1, done: 2 };
  const detail = (label: string, value?: string): string =>
    value
      ? `<div class="die-req-detail"><b>${label}</b><span>${escapeHtml(value)}</span></div>`
      : '';
  const actionDetail = (value?: string): string => {
    const comments = actionCommentsHtml(value);
    return comments
      ? `<div class="die-req-detail die-req-actions"><b>Actions taken</b>${comments}</div>`
      : '';
  };
  const rows = [...active]
    .sort(
      (a, b) =>
        Number(isWorkOrderOverdue(b, today)) - Number(isWorkOrderOverdue(a, today)) ||
        order[a.status] - order[b.status] ||
        (a.createdAt < b.createdAt ? 1 : -1),
    )
    .map((r) => {
      const overdue = isWorkOrderOverdue(r, today);
      const displayStatus = overdue ? 'Overdue' : STATUS_LABELS[r.status];
      const displayClass = overdue ? 'overdue' : r.status;
      const mango = r.mangoTicket
        ? `<span class="die-mango" title="Mango work order">🥭 ${escapeHtml(r.mangoTicket)}</span>`
        : '';
      const when = r.createdAt ? r.createdAt.slice(0, 10) : '';
      const due = (r.dueDate ?? '').slice(0, 10);
      const dueText = due
        ? ` · <span class="die-req-due${overdue ? ' overdue' : ''}">Due ${ddmmyyyy(due)}</span>`
        : '';
      return `<div class="die-req st-${displayClass} pr-${r.priority}">
        <div class="die-req-hd">
          <b class="die-req-die">${escapeHtml(r.dieNumber)}</b>
          <span class="die-req-type">${TYPE_LABELS[r.maintType]}</span>
          <span class="die-req-pr pr-${r.priority}">${PRIORITY_LABELS[r.priority]}</span>
          <span class="die-req-st">${displayStatus}</span>
          ${mango}
          <span class="die-req-meta">Opened ${escapeHtml(when || '—')}${dueText}</span>
        </div>
        <div class="die-req-details">
          ${detail('Brief description', r.description || '—')}
          ${detail('Issue', r.issueDetail !== r.description ? r.issueDetail : undefined)}
          ${actionDetail(r.actionsTaken)}
        </div>
        <div class="die-req-ft">To <b>${escapeHtml(r.contact || '—')}</b> · from ${escapeHtml(
          r.requestedBy || '—',
        )}${r.machineCode ? ` · on ${escapeHtml(r.machineCode)}` : ''}${
          r.jobNumber ? ` · job ${escapeHtml(r.jobNumber)}` : ''
        }</div>
      </div>`;
    })
    .join('');
  return `<div class="die-req-section"><h3>🛠 Maintenance Work Orders ${mangoLink('Mango', 'sm')}</h3>${note}${rows}</div>`;
}

// ---------------------------------------------------------------------
// ToolStatus picker — tap the badge, pick the tool's new condition. The
// change writes straight to PMD_DieMaster (ToolStatus + DateStamp), and
// setting "Serviced" also stamps LastServiceDate so the A/B/C service
// counter restarts from today. "In service" is a two-field event — the
// toolroom must also give the Available (return) date and is reminded
// that the Mango work order is required — so it detours through
// openInServiceStep instead of writing straight away.

function openStatusPicker(dieNumber: string): void {
  const m = masterFor(dieNumber);
  if (!m || !dalRef.updateDieMaster) return;
  const order: Array<keyof typeof TOOL_STATUS_META> = [
    'serviced', 'in-service', 'to-be-serviced', 'problems',
  ];
  const opts = order
    .map((st) => {
      const meta = TOOL_STATUS_META[st];
      const current = m.toolStatus === st;
      return `<button class="die-st-opt${current ? ' cur' : ''}" data-die-st="${st}">
        <span class="die-tstat ${meta.cls}">● ${meta.label}</span>
        ${st === 'serviced' ? '<em>stamps Last service = today</em>' : ''}
        ${st === 'in-service' ? '<em>asks for the return date · Mango ticket required</em>' : ''}
        ${current ? '<b>current</b>' : ''}
      </button>`;
    })
    .join('');
  openModal(`<div class="die-st-pick">
    <div class="kpi-trace-head">
      <h3>🛠 ${escapeHtml(dieNumber)} — Tool Status</h3>
      <button class="btn-ghost-big" data-mod="close">Cancel</button>
    </div>
    <p class="die-req-note">Writes to PMD_DieMaster (ToolStatus + DateStamp).</p>
    ${opts}
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  mc.querySelectorAll<HTMLButtonElement>('[data-die-st]').forEach((b) =>
    b.addEventListener('click', () => {
      const st = b.dataset.dieSt as keyof typeof TOOL_STATUS_META;
      if (st === 'in-service') {
        openInServiceStep(dieNumber);
        return;
      }
      void applyToolStatus(dieNumber, st);
    }),
  );
}

/** Write a ToolStatus change to PMD_DieMaster, optimistically updating
 *  the cached master row (rolled back on failure). `availableDate`
 *  accompanies the 'in-service' transition — see openInServiceStep. */
async function applyToolStatus(
  dieNumber: string,
  st: keyof typeof TOOL_STATUS_META,
  availableDate?: string,
): Promise<void> {
  const m = masterFor(dieNumber);
  if (!m || !dalRef.updateDieMaster) return;
  const changedAt = new Date();
  const now = changedAt.toISOString();
  const patch: Partial<
    Pick<DieMaster, 'toolStatus' | 'dateStamp' | 'lastServiceDate' | 'availableDate'>
  > = { toolStatus: st, dateStamp: now };
  // LastServiceDate is a calendar-day reset, not an instant. Stamp
  // midnight UTC of the Sydney/browser day so an early-morning
  // service does not become "yesterday" when ISO is sliced.
  if (st === 'serviced') patch.lastServiceDate = `${isoDay(changedAt)}T00:00:00.000Z`;
  if (availableDate !== undefined) patch.availableDate = availableDate;
  const prev = {
    toolStatus: m.toolStatus,
    dateStamp: m.dateStamp,
    lastServiceDate: m.lastServiceDate,
    availableDate: m.availableDate,
  };
  // Optimistic — the row updates immediately; a failed write rolls back.
  m.toolStatus = st;
  m.dateStamp = now;
  if (patch.lastServiceDate) m.lastServiceDate = patch.lastServiceDate;
  if (patch.availableDate !== undefined) m.availableDate = patch.availableDate;
  closeModal();
  render();
  try {
    await dalRef.updateDieMaster(dieNumber, patch);
    const back = availableDate ? ` · back ${ddmmyyyy(availableDate.slice(0, 10))}` : '';
    toast(`${dieNumber} → ${TOOL_STATUS_META[st].label}${back}`, 'ok');
  } catch (e) {
    Object.assign(m, prev);
    render();
    console.error('[pmd] ToolStatus update failed:', e);
    toast(`Could not update: ${e instanceof Error ? e.message : e}`, 'err');
  }
}

/** Second step when the toolroom sets a die to In service: the Available
 *  (return) date is REQUIRED — it feeds the board's Available column so
 *  planning sees when the tool comes back instead of a dateless
 *  "In maint" — and the Mango work order reminder is front and centre
 *  (Mango is the system of record for the maintenance job itself).
 *  Re-picking In service on a die already in service reopens this step,
 *  which is the repair path for legacy dateless rows. */
function openInServiceStep(dieNumber: string): void {
  const m = masterFor(dieNumber);
  if (!m || !dalRef.updateDieMaster) return;
  const meta = TOOL_STATUS_META['in-service'];
  const today = isoDay(new Date());
  const cur = (m.availableDate ?? '').slice(0, 10);
  openModal(`<div class="die-st-pick die-insvc">
    <div class="kpi-trace-head">
      <h3>🛠 ${escapeHtml(dieNumber)} — <span class="die-tstat ${meta.cls}">● ${meta.label}</span></h3>
      <button class="btn-ghost-big" data-mod="close">Cancel</button>
    </div>
    <div class="die-insvc-mango" role="alert">🥭 <b>Mango Ticket Required</b> — raise the maintenance
      work order in Mango before the tool goes in. ${mangoLink('Open Mango')}</div>
    <label class="die-insvc-date">Available — when will maintenance have the die back?
      <input type="date" data-insvc-date min="${today}" value="${escapeHtml(cur >= today ? cur : '')}" required>
    </label>
    <p class="die-req-note">Required. The Die board's <b>Available</b> column shows this date so
      planning knows when the tool returns (writes PMD_DieMaster ToolStatus + Available + DateStamp).</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-insvc-back>← Back</button>
      <button class="btn-primary-big" data-insvc-save>✓ Set In service</button>
    </div>
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  mc.querySelector('[data-insvc-back]')?.addEventListener('click', () => openStatusPicker(dieNumber));
  const input = mc.querySelector<HTMLInputElement>('[data-insvc-date]')!;
  input.focus();
  mc.querySelector('[data-insvc-save]')?.addEventListener('click', () => {
    const date = input.value;
    if (!date) {
      toast('Enter the Available date — when maintenance will have the die back.', 'err');
      input.focus();
      return;
    }
    if (date < today) {
      toast('That Available date has already passed — pick today or later.', 'err');
      input.focus();
      return;
    }
    // Midnight UTC of the picked day, same convention as LastServiceDate,
    // so slicing the ISO string always returns the day the toolroom chose.
    void applyToolStatus(dieNumber, 'in-service', `${date}T00:00:00.000Z`);
  });
}

// ---------------------------------------------------------------------
// die detail popup

/** Full-size defect trend for the detail popup: same buckets as the row
 *  sparkline, taller bars, sparse date labels along the x-axis. Days a
 *  service was completed (DONE work order closed / LastServiceDate) are
 *  marked 🔧 under the axis — defects that keep climbing AFTER a wrench
 *  mark mean the repair didn't take. */
function trendChart(d: DieAgg): string {
  const buckets = buildDieTrend(d.daily, S!.from, S!.to);
  if (buckets.length === 0 || d.runs === 0)
    return `<div class="trace-empty">No production in the window.</div>`;
  const svcDays = new Set<string>();
  for (const r of requestsFor(d.dieNumber))
    if (r.status === 'done' && r.closedAt) svcDays.add(r.closedAt.slice(0, 10));
  const ls = masterFor(d.dieNumber)?.lastServiceDate;
  if (ls) svcDays.add(ls.slice(0, 10));
  const bucketHasService = (day: string, span: number): boolean => {
    if (span === 1) return svcDays.has(day);
    const start = new Date(`${day}T00:00:00`).getTime();
    const end = start + span * 86_400_000;
    for (const s of svcDays) {
      const t = new Date(`${s}T00:00:00`).getTime();
      if (t >= start && t < end) return true;
    }
    return false;
  };
  const max = Math.max(1, ...buckets.map((b) => b.rejects));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const bars = buckets
    .map((b, i) => {
      const pct = b.pieces > 0 ? (b.rejects / b.pieces) * 100 : null;
      const health = dieHealth(pct);
      const name = b.span === 1 ? b.day.slice(5) : `wk ${b.day.slice(5)}`;
      const serviced = bucketHasService(b.day, b.span);
      const tip = `${name} · ${b.rejects} rej / ${b.pieces} pcs${
        pct != null ? ` (${pct.toFixed(1)}%)` : ''
      }${serviced ? ' · 🔧 service completed' : ''}`;
      const idle = b.pieces === 0 && b.rejects === 0;
      const h = idle ? 0 : b.rejects === 0 ? 4 : Math.max(8, Math.round((b.rejects / max) * 100));
      const label = i % labelEvery === 0 ? name : '';
      return `<div class="die-trend-col${serviced ? ' svc' : ''}" title="${escapeHtml(tip)}">
        <b>${b.rejects > 0 ? b.rejects : ''}</b>
        <span class="die-trend-bar"><i class="${idle ? 'empty' : health || 'green'}" style="height:${h}%"></i></span>
        <em>${serviced ? '🔧' : ''}${escapeHtml(label)}</em>
      </div>`;
    })
    .join('');
  const legend = svcDays.size
    ? `<p class="kpi-note">Bar height = rejects that ${buckets[0].span === 1 ? 'day' : 'week'}; colour = the reject-% band. 🔧 = service completed (closed work order / Last service) — rejects that keep climbing after a 🔧 mean the repair didn't take. See <b>Defects Cause</b> below for the machine-status split.</p>`
    : `<p class="kpi-note">Bar height = rejects that ${buckets[0].span === 1 ? 'day' : 'week'}; colour = the reject-% band. See <b>Defects Cause</b> below for the machine-status split.</p>`;
  return `<div class="die-trend-lg">${bars}</div>${legend}`;
}

/** Shot-based preventive-maintenance position in the detail popup.
 *  Below it, the die's multi-level PM plan block (renderPmPlan). */
function renderServiceSection(d: DieAgg): string {
  const s = svcFor(d);
  const h = `<h4>② Service Plan</h4>`;
  if (!s) {
    const condTriggered = (condFor(d.dieNumber)?.flags.length ?? 0) > 0;
    const rule = TOOL_MAINTENANCE_RULES[condTriggered ? 'C' : DEFAULT_TOOL_MAINTENANCE_LEVEL];
    return `${h}
      <div class="die-svc-none"><b>${escapeHtml(rule.label)}</b> — ${S!.serviceHistoryAvailable ? `no completed-service baseline and no production in the independent ${escapeHtml(S!.serviceHistoryFrom)} → today shot ledger` : 'the independent shot ledger could not be loaded (see the data-source warning above)'}. Set Status to <b>Serviced</b> when maintenance is completed to reset the shot counter.</div>${renderPmPlan(d, s)}`;
  }
  const shotWidth = Math.min(100, Math.round(s.shotPct * 100));
  const row = (label: string, detail: string, pct: number, width: number): string => {
    const level = pct >= 1 ? 'due' : pct >= 0.8 ? 'soon' : 'ok';
    return `<div class="die-svc-metric">
      <span class="die-svc-kind">${label}</span>
      <span class="die-svc-detail">${detail}</span>
      <span class="die-svc-bar"><i class="${level}" style="width:${width}%"></i></span>
      <b class="die-svc-pct ${level}">${(pct * 100).toFixed(0)}%</b>
    </div>`;
  };
  const trigger =
    s.level === 'due'
      ? '<span class="die-svc-flag">🔧 DUE — shot limit reached</span>'
      : s.level === 'soon'
        ? '<span class="die-svc-flag soon">⏳ Service soon</span>'
        : '<span class="die-svc-ok">Within plan</span>';
  const conditionNote = s.conditionTriggered
    ? `<div class="die-svc-condition">⚠ Latest Die Change Log has a worn/damaged rating (&gt;1), so the service rule is escalated to <b>${escapeHtml(TOOL_MAINTENANCE_RULES.C.label)}</b> until a newer all-good inspection clears it.</div>`
    : '';
  return `${h}
    <div class="die-svc-panel ${s.level}" title="${escapeHtml(svcTitle(s))}">
      <div class="die-svc-rule"><b>${escapeHtml(TOOL_MAINTENANCE_RULES[s.maintenanceLevel].label)}</b>${trigger}</div>
      ${row(
        'Shots',
        `<b>${s.shotsSince.toLocaleString()}</b> / ${s.intervalShots.toLocaleString()} since ${escapeHtml(ddmmyyyy(s.since))}${s.sinceIsService ? '' : '+'}`,
        s.shotPct,
        shotWidth,
      )}
      ${conditionNote}
      <div class="die-svc-foot">${S!.serviceHistoryAvailable ? 'Shot counter uses a separate 400-day production ledger.' : '⚠ Independent shot history failed; this temporary value falls back to the visible analysis range.'} Production recorded on the service date is included conservatively because service time-of-day is not stored.</div>
    </div>${renderPmPlan(d, s)}`;
}

/** The die's multi-level PM plan (L1 in-press wipe-down · L2 general bench
 *  service · L3 major teardown). Custom text from
 *  PMD_DieMaster.MaintenanceLevel when the toolroom has tuned this die;
 *  otherwise the default template with L2 = the die's governing
 *  shot interval and L3 at 10×. Shot-based levels get their
 *  own progress against the same 400-day ledger counter the headline
 *  rule uses. Supervisor ON + writable backend → ✎ Edit. */
function renderPmPlan(d: DieAgg, s: DieServiceStatus | null): string {
  const m = masterFor(d.dieNumber);
  const custom = (m?.maintenanceLevel ?? '').trim();
  const planText = custom || defaultPmPlanText(s?.intervalShots ?? 10_000);
  const levels = parsePmPlan(planText);
  const canEdit = isSupervisor() && !!m && !!dalRef.updateDieMaster;
  const editBtn = canEdit
    ? `<button class="die-pm-edit" data-die-pm="${escapeHtml(d.dieNumber)}" title="Customise this die's PM plan — writes PMD_DieMaster.MaintenanceLevel">✎ Edit plan</button>`
    : '';
  const srcChip = custom
    ? `<span class="die-pm-src custom" title="Customised for this die — PMD_DieMaster.MaintenanceLevel">custom plan</span>`
    : `<span class="die-pm-src" title="Industry-standard 3-level mould PM baseline (L1 in-press / L2 general / L3 major teardown). L2 from the die's governing service rule${s ? ` (${s.intervalShots.toLocaleString()} shots)` : ''}, L3 at 10×. ${canEdit ? 'Tap ✎ Edit plan to customise for this die.' : 'Turn Supervisor ON to customise per die.'}">default template</span>`;
  const noMaster =
    !m && custom === ''
      ? `<div class="die-pm-note">No PMD_DieMaster row for this die yet — add one to save a customised plan.</div>`
      : '';
  const rows = levels.length
    ? levels
        .map((lv) => {
          const st = lv.intervalShots && s ? pmShotLevel(s.shotsSince, lv.intervalShots) : null;
          const prog = st
            ? `<span class="die-pm-prog ${st.level}" title="${s!.shotsSince.toLocaleString()} shots since ${escapeHtml(s!.since)} vs this level's ${lv.intervalShots!.toLocaleString()}-shot interval">${s!.shotsSince.toLocaleString()} / ${lv.intervalShots!.toLocaleString()} · ${Math.round(st.pct * 100)}%${st.level === 'due' ? ' · 🔧 DUE' : st.level === 'soon' ? ' · ⏳ soon' : ''}</span>`
            : '';
          return `<div class="die-pm-row${st ? ` ${st.level}` : ''}">
            <span class="die-pm-lv l${lv.level}">L${lv.level}</span>
            <span class="die-pm-int">${escapeHtml(lv.interval || 'as required')}</span>
            ${prog}
            <ul class="die-pm-tasks">${lv.tasks.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
          </div>`;
        })
        .join('')
    : // Free-form custom text (no recognisable L<n> lines) — show verbatim
      // rather than dropping what the supervisor wrote.
      `<div class="die-pm-free">${escapeHtml(custom)}</div>`;
  return `<div class="die-pm-plan">
    <div class="die-pm-head"><b>PM levels</b>${srcChip}${editBtn}</div>
    ${noMaster}${rows}
  </div>`;
}

/** Supervisor editor for the die's PM plan. Prefilled with the custom
 *  text (or the default template ready to tune); Save writes
 *  PMD_DieMaster.MaintenanceLevel and re-opens the drilldown. */
function openPmPlanEditor(dieNumber: string): void {
  const m = masterFor(dieNumber);
  if (!m || !dalRef.updateDieMaster) return;
  const d = S!.dies.find((x) => x.dieNumber === dieNumber);
  const s = d ? svcFor(d) : null;
  const dflt = defaultPmPlanText(s?.intervalShots ?? 10_000);
  const cur = (m.maintenanceLevel ?? '').trim() || dflt;
  openModal(`<div class="bd-modal die-pm-editor">
    <h3 class="bd-title">✎ ${escapeHtml(dieNumber)} — PM plan (maintenance levels)</h3>
    <p class="bd-sub">One level per line: <code>L2 | 10,000 shots | task; task; task</code> — separate tasks with “;”.
      Shot-based levels track against the die's shot counter; “every die change” levels are event-based.
      Saved to <b>PMD_DieMaster.MaintenanceLevel</b>, so the toolroom sees the same text in SharePoint.</p>
    <textarea class="die-pm-text" rows="9" spellcheck="false">${escapeHtml(cur)}</textarea>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-pm-default title="Replace the text with the standard 3-level template (L2 from the die's governing service interval)">↺ Default template</button>
      <button class="btn-ghost-big" data-pm-cancel>Cancel</button>
      <button class="btn-primary-big" data-pm-save>💾 Save plan</button>
    </div>
  </div>`);
  const mc = document.getElementById('mc')!;
  const ta = mc.querySelector<HTMLTextAreaElement>('.die-pm-text')!;
  mc.querySelector('[data-pm-default]')?.addEventListener('click', () => {
    ta.value = dflt;
    ta.focus();
  });
  mc.querySelector('[data-pm-cancel]')?.addEventListener('click', () => openDieDetail(dieNumber));
  mc.querySelector('[data-pm-save]')?.addEventListener('click', () => {
    const text = ta.value.trim();
    void (async () => {
      const prev = m.maintenanceLevel;
      m.maintenanceLevel = text; // optimistic — rolled back on failure
      try {
        await dalRef.updateDieMaster!(dieNumber, { maintenanceLevel: text });
        toast(`${dieNumber} PM plan saved`, 'ok');
      } catch (e) {
        m.maintenanceLevel = prev;
        console.error('[pmd] PM plan save failed:', e);
        toast(`Could not save PM plan: ${e instanceof Error ? e.message : e}`, 'err');
      }
      openDieDetail(dieNumber);
    })();
  });
}

/** Asset facts from the die's PMD_DieMaster row, shown in the detail
 *  popup. Empty string (no section) when the tool isn't registered. */
function renderMasterSection(d: DieAgg): string {
  const m = masterFor(d.dieNumber);
  if (!m) return '';
  const cell = (label: string, v: string | number | null, suffix = ''): string =>
    v == null || v === ''
      ? ''
      : `<span>${label} <b>${escapeHtml(
          typeof v === 'number' ? v.toLocaleString() : v,
        )}${suffix}</b></span>`;
  return `<h4>① Die Master</h4>
    <div class="die-detail-stats die-master-stats">
      ${cell('Cavities', m.cavities)}
      ${cell('Cycle time', m.cycleTime, ' s')}
      ${cell('Weight', m.dieWeightKg, ' kg')}
      ${cell('C/O in', m.changeOverIn, ' h')}
      ${cell('C/O out', m.changeOverOut, ' h')}
      ${m.leanReady == null ? '' : `<span>Lean ready <b>${m.leanReady ? 'Yes' : 'No'}</b></span>`}
      ${cell('Injector plate', m.toolInjectorPlate)}
      ${cell('Life cycle', m.lifeCycle, ' shots')}
      ${cell('Last service', m.lastServiceDate ? m.lastServiceDate.slice(0, 10) : '')}
      ${cell('Back from maint', m.availableDate ? m.availableDate.slice(0, 10) : '')}
      ${cell('Updated', m.dateStamp ? m.dateStamp.slice(0, 10) : '')}
    </div>`;
}

function openDieDetail(dieNumber: string): void {
  const d = S!.dies.find((x) => x.dieNumber === dieNumber);
  if (!d) return;
  // Only real, labelled defect codes belong in the Pareto — drop the '—'
  // placeholder bucket (rejects logged with no code) and any blank / unknown
  // code that has no reject-category label, so nothing fabricated shows.
  const codes = d.rejByCode.filter(
    (x) => x.code && x.code !== '—' && rejLabel(x.code),
  );
  const maxQty = codes[0]?.qty ?? 0;
  // Each code's bar is stacked by the machine status that logged the
  // scrap (letters in the operator-timeline colours) — a ShortShot bar
  // that's mostly S is a startup problem, mostly R points at the tool.
  const bars = codes.length
    ? codes
        .map((x) => {
          const split = Object.entries(x.byStatus).sort((a, b) => b[1] - a[1]);
          const tip = split
            .map(([s, q]) => `${STATUS_MAP[s]?.label ?? s} ×${q}`)
            .join(' · ');
          const segs = split
            .map(([s, q]) => {
              const meta = STATUS_MAP[s];
              const w = x.qty ? (q / x.qty) * 100 : 0;
              const paint = meta
                ? `;background:${meta.color};border-color:${meta.border};color:${meta.text}`
                : '';
              // Letter only when the segment is wide enough to carry it.
              return `<i class="die-bar-seg" style="width:${w}%${paint}">${w >= 8 ? escapeHtml(s) : ''}</i>`;
            })
            .join('');
          return `<div class="die-bar-row" title="${escapeHtml(
            `${x.code} ${rejLabel(x.code) || ''} · ${x.qty} — ${tip}`,
          )}">
            <span class="die-bar-code">${escapeHtml(x.code)}</span>
            <span class="die-bar-label">${escapeHtml(rejLabel(x.code) || '—')}</span>
            <span class="die-bar-track"><span class="die-bar-fill" style="width:${maxQty ? Math.max(4, (x.qty / maxQty) * 100) : 0}%">${segs}</span></span>
            <b class="die-bar-qty">${x.qty}</b>
          </div>`;
        })
        .join('')
    : `<div class="trace-empty">No rejects recorded for this die in the window. 🎉</div>`;
  // Work orders mirrored from Mango, split by stage: anything NOT closed
  // (Stage 1-3) is In progress; Stage 4 Closed → 'done' is History. This is
  // the "what have we already tried on this tool" record read next to the
  // defect trend when judging repair vs run-on.
  const all = requestsFor(dieNumber);
  const inProgress = all
    .filter((r) => r.status !== 'done')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const history = all
    .filter((r) => r.status === 'done')
    .sort((a, b) => ((a.closedAt || a.createdAt) < (b.closedAt || b.createdAt) ? 1 : -1));
  const woGroup = (label: string, rows: DieMaintenanceRequest[], empty: string): string =>
    `<div class="die-wo-group">
      <div class="die-wo-sub">${label} <span class="die-wo-count">${rows.length}</span></div>
      ${rows.length ? `<ul class="die-detail-hist">${rows.map(woRow).join('')}</ul>` : `<div class="die-wo-empty">${empty}</div>`}
    </div>`;
  const maintTrackHtml = all.length
    ? woGroup('🔧 In progress', inProgress, 'None open — nothing on the bench right now.') +
      woGroup('📓 History', history, 'No closed work orders yet.')
    : '<div class="die-wo-empty">No maintenance work orders on record for this die (Mango CSV mirror).</div>';
  // Most recent die change inside the window (status 'D' slots).
  const dcRec = d.lastDieChange;
  const dieChangeHtml = dcRec
    ? `<div class="die-dc">🔁 <b>${escapeHtml(dcRec.day)}</b> · ${escapeHtml(dcRec.shift)} shift
        · <b>${escapeHtml(dcRec.machine)}</b> · job ${escapeHtml(dcRec.jobNumber)}
        · <b>${(dcRec.slots * 0.5).toLocaleString()} h</b> (${dcRec.slots} × 30 min slots on Die Change)</div>`
    : `<div class="die-dc none">No die change recorded in the selected window (${escapeHtml(S!.from)} → ${escapeHtml(S!.to)}).</div>`;
  // Latest setter's condition report (PMD_DieChangeLog) — the 13-component
  // check filed when this die last came OUT of a press. Worn/damaged
  // components are the toolroom's priority-service queue.
  const cond = condFor(d.dieNumber);
  const condHtml = !cond
    ? `<div class="die-dc none">No die-change condition report on record yet (PMD_DieChangeLog) — filed by the setter when the die comes out of the press.</div>`
    : `<div class="die-cond${cond.hasDamaged ? ' bad' : cond.flags.length ? ' warn' : ''}">
        <div class="die-cond-meta">📋 <b>${escapeHtml(cond.date)}</b> · ${escapeHtml(cond.shift)} shift
          · <b>${escapeHtml(cond.machineCode)}</b> · job ${escapeHtml(cond.jobNumber)}
          · by <b>${escapeHtml(cond.dieSetter || '—')}</b></div>
        ${
          cond.flags.length
            ? `<div class="die-cond-flags">${cond.flags
                .map(
                  (f) =>
                    `<span class="die-cond-chip ${f.condition}">${escapeHtml(f.label)} — ${escapeHtml(
                      DIE_CONDITION_META[f.condition].label,
                    )}</span>`,
                )
                .join('')}</div>
              ${cond.hasDamaged ? '<div class="die-cond-note bad">⚠ Component damaged — the die shows as <b>Problems</b> and service is PRIORITY.</div>' : '<div class="die-cond-note">Rated 2 — operational, but queue for priority service at the next window.</div>'}`
            : '<div class="die-cond-ok">All 13 components rated “1. Good work order” ✓</div>'
        }
        ${cond.problemDescription ? `<div class="die-cond-desc">“${escapeHtml(cond.problemDescription)}”</div>` : ''}
      </div>`;
  const health = dieHealth(d.rejectPct);
  openModal(`<div class="die-detail">
    <div class="kpi-trace-head die-detail-head">
      <h3>🛠 ${escapeHtml(d.dieNumber)} <span class="die-detail-sub">${escapeHtml(
        [d.description, d.category].filter(Boolean).join(' · ') || '',
      )} · ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}</span></h3>
      <div class="die-detail-head-actions">
        <button class="die-detail-print" data-die-print title="Print this die's page">🖨 Print</button>
        ${mangoLink('Request in Mango', 'hd')}
        <button class="die-detail-close" data-mod="close" title="Close">✕ Close</button>
      </div>
    </div>
    <div class="die-detail-stats die-detail-topstats">
      <span>Status ${toolStatusBadge(d.dieNumber)}</span>
      <span>Runs <b>${d.runs}</b></span>
      <span>Shots <b>${d.shots.toLocaleString()}</b></span>
      <span>Pieces <b>${d.pieces.toLocaleString()}</b></span>
      <span class="g">Good <b>${d.good.toLocaleString()}</b></span>
      <span class="r">Reject <b>${d.rejects.toLocaleString()}</b></span>
      <span class="${health}">Rej % <b>${d.rejectPct == null ? '—' : d.rejectPct + '%'}</b></span>
      <span>Machines <b>${escapeHtml(d.machines.join(', ') || '—')}</b></span>
      <span>Last run <b>${escapeHtml(d.lastRun || '—')}</b></span>
      <span>Scheduled <b>${(() => {
        const p = S!.planByDie.get(d.dieNumber);
        if (!p) return 'Free';
        return `${p.running ? '▶ Now · ' : ''}${escapeHtml(fmtPlanned(p.start))} (${escapeHtml(p.jobNumber)})`;
      })()}</b></span>
    </div>
    ${renderMasterSection(d)}
    ${renderServiceSection(d)}
    <h4>③ Defect Trend <span class="die-h4-sub">${escapeHtml(S!.from)} → ${escapeHtml(S!.to)}</span></h4>
    ${trendChart(d)}
    <h4>④ Defects Cause</h4>
    ${bars}
    <h4>⑤ Maintenance Track</h4>
    ${maintTrackHtml}
    <h4>⑥ Last Die Change</h4>
    ${dieChangeHtml}
    <h4>⑦ Die Condition <span class="die-h4-sub">latest setter check</span></h4>
    ${condHtml}
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  // Supervisor's ✎ Edit plan in the Service Plan section.
  mc.querySelectorAll<HTMLButtonElement>('[data-die-pm]').forEach((b) =>
    b.addEventListener('click', () => openPmPlanEditor(b.dataset.diePm!)),
  );
  // Print just this drilldown. The app can be mounted deep inside the host
  // page (SPFx web-part container, not a direct child of <body>), so a
  // "hide every sibling of the modal" rule would hide the modal too and
  // print a blank page. Instead CLONE the die page into a print area that
  // IS a direct child of <body>, and the @media print rule hides everything
  // else. Cleaned up on afterprint (+ a fallback in case it never fires).
  mc.querySelector('[data-die-print]')?.addEventListener('click', () => {
    const detail = mc.querySelector('.die-detail');
    if (!detail) return;
    document.getElementById('die-print-area')?.remove();
    const area = document.createElement('div');
    area.id = 'die-print-area';
    const clone = detail.cloneNode(true) as HTMLElement;
    clone.querySelector('.die-detail-head-actions')?.remove(); // no buttons on paper
    area.appendChild(clone);
    document.body.appendChild(area);
    let cleaned = false;
    const done = (): void => {
      if (cleaned) return;
      cleaned = true;
      area.remove();
      document.body.classList.remove('die-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    document.body.classList.add('die-printing');
    window.print();
    setTimeout(done, 60_000); // belt-and-braces if afterprint is missed
  });
}

// ---------------------------------------------------------------------
// wiring

function wire(): void {
  const h = hostEl;
  if (!h || !S) return;
  h.querySelector<HTMLInputElement>('[data-die-from]')?.addEventListener('change', (e) => {
    S!.from = (e.target as HTMLInputElement).value;
    void loadAll();
  });
  h.querySelector<HTMLInputElement>('[data-die-to]')?.addEventListener('change', (e) => {
    S!.to = (e.target as HTMLInputElement).value;
    void loadAll();
  });
  h.querySelectorAll<HTMLButtonElement>('[data-die-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const days = Number(b.dataset.diePreset);
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - (days - 1));
      S!.from = isoDay(from);
      S!.to = isoDay(to);
      void loadAll();
    }),
  );
  h.querySelector<HTMLInputElement>('[data-die-filter]')?.addEventListener('input', (e) => {
    S!.filter = (e.target as HTMLInputElement).value;
    // Re-render only the table+requests, keeping the filter input focused.
    const keep = e.target as HTMLInputElement;
    const pos = keep.selectionStart;
    render();
    const again = hostEl?.querySelector<HTMLInputElement>('[data-die-filter]');
    if (again) {
      again.focus();
      if (pos != null) again.setSelectionRange(pos, pos);
    }
  });
  h.querySelectorAll<HTMLTableCellElement>('[data-die-sort]').forEach((el) =>
    el.addEventListener('click', () => {
      const key = el.dataset.dieSort as DieSortKey;
      if (S!.sortKey === key) {
        S!.sortDir = S!.sortDir === 1 ? -1 : 1;
      } else {
        S!.sortKey = key;
        // Numeric columns read best worst-first (descending); text /
        // date-like ones ascending (A→Z, soonest first).
        S!.sortDir =
          key === 'die' ||
          key === 'description' ||
          key === 'machines' ||
          key === 'scheduled' ||
          key === 'toolStatus' || // rank 0 = Problems, so ascending is worst-first
          key === 'lastService' // oldest service first = needs attention first
            ? 1
            : -1;
      }
      render();
    }),
  );
  const table = h.querySelector<HTMLTableElement>('.die-table');
  if (table) wireColResize(table);
  h.querySelectorAll<HTMLButtonElement>('[data-die-detail]').forEach((b) =>
    b.addEventListener('click', () => openDieDetail(b.dataset.dieDetail!)),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-die-status]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openStatusPicker(b.dataset.dieStatus!);
    }),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-die-wo]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkOrders(b.dataset.dieWo!);
    }),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-machine-wo]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openMachineWorkOrders(b.dataset.machineWo!);
    }),
  );
}
