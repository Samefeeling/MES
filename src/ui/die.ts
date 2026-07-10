// 🛠 Die Management — third tab on the Trace page. A Fabrico-style
// tool-management board for the die shop:
//   · per-die usage rolled up from production history (shots / pieces /
//     good / rejects, joined via PMD_ProductDieColor's DieNumber),
//   · a per-die defect database (reject codes charged to the die that
//     made them, with the D01-D10 descriptions),
//   · maintenance requests (open → in-progress → done) persisted to
//     PMD_DieMaintenance, addressed to the built-in contacts, with a
//     MangoTicket slot for the future Mango integration.

import type { PmdDataLayer } from '../dal';
import type {
  DieMaintenanceRequest,
  MaintPriority,
  MaintStatus,
  MaintType,
  ProductDieColor,
} from '../types';
import { aggregateDies, dieHealth, MAINTENANCE_CONTACTS, type DieAgg } from '../core/die';
import { closeModal, escapeHtml, openModal } from './modal';
import { toast } from './toast';

interface DieState {
  from: string; // YYYY-MM-DD inclusive
  to: string;
  filter: string;
  dies: DieAgg[];
  requests: DieMaintenanceRequest[];
  rejectLabels: Map<string, string>;
  dieColors: ProductDieColor[];
  supervisors: string[];
  loading: boolean;
}

let S: DieState | null = null;
let dalRef: PmdDataLayer;
let hostEl: HTMLElement | null = null;

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

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Mount (or re-mount) the Die Management board into `host`. Owns its
 *  own state + re-render loop; the Trace page just provides the div. */
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
    dies: [],
    requests: [],
    rejectLabels: new Map(),
    dieColors: [],
    supervisors: [],
    loading: true,
  };
  render();
  await loadAll();
}

async function loadAll(): Promise<void> {
  if (!S) return;
  S.loading = true;
  render();
  const [dieColors, requests, rejCats, sups, records] = await Promise.all([
    dalRef.listProductDieColors ? dalRef.listProductDieColors().catch(() => []) : Promise.resolve([]),
    dalRef.listDieMaintenance ? dalRef.listDieMaintenance().catch(() => []) : Promise.resolve([]),
    dalRef.listRejectCategories().catch(() => []),
    dalRef.listSupervisors().catch(() => []),
    dalRef
      .listProduction({ shiftIdFrom: `${S.from}-`, shiftIdTo: `${S.to}-￿` })
      .catch(() => []),
  ]);
  if (!S) return;
  S.dieColors = dieColors;
  S.requests = requests;
  S.rejectLabels = new Map(rejCats.map((c) => [c.code, c.label]));
  S.supervisors = sups.map((s) => s.operatorName).filter((v, i, a) => a.indexOf(v) === i);
  S.dies = aggregateDies(dieColors, records, requests);
  S.loading = false;
  render();
}

function rejLabel(code: string): string {
  return S?.rejectLabels.get(code) ?? '';
}

// ---------------------------------------------------------------------
// rendering

function render(): void {
  if (!S || !hostEl || !hostEl.isConnected) return;
  hostEl.innerHTML = `
    ${renderHead()}
    ${S.loading ? `<div class="trace-empty">Loading die usage…</div>` : renderBody()}
  `;
  wire();
}

function renderHead(): string {
  const preset = (days: number, label: string): string =>
    `<button class="shift-btn" data-die-preset="${days}">${label}</button>`;
  return `<div class="die-head">
    <span class="die-range">
      <label>From <input type="date" data-die-from value="${escapeHtml(S!.from)}"></label>
      <label>To <input type="date" data-die-to value="${escapeHtml(S!.to)}"></label>
    </span>
    ${preset(7, '7 days')}${preset(30, '30 days')}${preset(90, '90 days')}
    <input type="text" class="die-filter" data-die-filter placeholder="Filter die / part…" value="${escapeHtml(S!.filter)}">
    <button class="btn-primary-big die-new-req" data-die-new-req>📝 Maintenance Request</button>
  </div>`;
}

function renderBody(): string {
  const open = S!.requests.filter((r) => r.status !== 'done');
  const active = S!.dies.filter((d) => d.runs > 0).length;
  const attention = S!.dies.filter((d) => dieHealth(d.rejectPct) === 'red').length;
  const chips = `<div class="die-chips">
    <span class="die-chip">Dies <b>${S!.dies.length}</b></span>
    <span class="die-chip">Ran in window <b>${active}</b></span>
    <span class="die-chip${attention ? ' is-bad' : ''}">High reject <b>${attention}</b></span>
    <span class="die-chip${open.length ? ' is-warn' : ''}">Open requests <b>${open.length}</b></span>
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

function renderDieTable(): string {
  const dies = filteredDies();
  if (dies.length === 0) {
    return `<div class="trace-empty">No dies match. Die numbers come from the PMD_ProductDieColor list's DieNumber column — fill it in there to see a die here.</div>`;
  }
  const rows = dies
    .map((d) => {
      const health = dieHealth(d.rejectPct);
      const top = d.rejByCode
        .slice(0, 3)
        .map(
          (x) =>
            `<span class="die-defect" title="${escapeHtml(rejLabel(x.code))}">${escapeHtml(x.code)}×${x.qty}</span>`,
        )
        .join(' ');
      const maint = d.openRequests
        ? `<span class="die-maint-badge">🛠 ${d.openRequests}</span>`
        : '';
      const partsTip = d.parts
        .map((p) => `${p.partNumber}${p.name ? ` (${p.name})` : ''}`)
        .join(', ');
      return `<tr data-die-row="${escapeHtml(d.dieNumber)}">
        <td class="die-num"><button class="die-link" data-die-detail="${escapeHtml(d.dieNumber)}">${escapeHtml(d.dieNumber)}</button></td>
        <td>${escapeHtml(d.category || '—')}</td>
        <td title="${escapeHtml(partsTip)}">${d.parts.length}</td>
        <td>${escapeHtml(d.machines.join(', ') || '—')}</td>
        <td class="num">${d.runs}</td>
        <td class="num">${d.shots.toLocaleString()}</td>
        <td class="num">${d.pieces.toLocaleString()}</td>
        <td class="num">${d.good.toLocaleString()}</td>
        <td class="num">${d.rejects.toLocaleString()}</td>
        <td class="num ${health}">${d.rejectPct == null ? '—' : d.rejectPct + '%'}</td>
        <td>${top || '—'}</td>
        <td>${escapeHtml(d.lastRun || '—')}</td>
        <td>${maint}</td>
        <td><button class="die-req-btn" data-die-req="${escapeHtml(d.dieNumber)}" title="New maintenance request for this die">📝</button></td>
      </tr>`;
    })
    .join('');
  return `<div class="die-table-wrap"><table class="kpi-table die-table">
    <thead><tr>
      <th>Die #</th><th>Category</th><th title="Part numbers that run on this die">Parts</th><th>Machines</th>
      <th title="(machine, shift, job) runs in the window">Runs</th>
      <th title="Press cycles = Σ (Count End − Count Start) — the die-wear number">Shots</th>
      <th title="Shots × cavities">Pieces</th><th>Good</th><th>Reject</th>
      <th title="Reject ÷ Pieces — 🟢 <2% · 🟡 2-5% · 🔴 >5%">Rej %</th>
      <th>Top defects</th><th>Last run</th><th>Maint</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="kpi-note">Usage inside the selected window. <b>Shots</b> = press cycles (Count End − Count Start) — the number that wears the die; <b>Pieces</b> = shots × cavities. Rejects are charged to the die that made them via each part's DieNumber (PMD_ProductDieColor).</p>`;
}

function renderRequests(): string {
  if (S!.requests.length === 0) {
    return `<div class="die-req-section"><h3>🛠 Maintenance Requests</h3>
      <div class="trace-empty">No maintenance requests yet. Tap 📝 on a die (or the button above) to raise one.</div></div>`;
  }
  const order: Record<MaintStatus, number> = { open: 0, 'in-progress': 1, done: 2 };
  const rows = [...S!.requests]
    .sort((a, b) => order[a.status] - order[b.status] || (a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => {
      const advance =
        r.status === 'open'
          ? `<button class="die-adv" data-die-adv="${r.id}" data-next="in-progress">▶ Start</button>`
          : r.status === 'in-progress'
            ? `<button class="die-adv" data-die-adv="${r.id}" data-next="done">✔ Complete</button>`
            : '';
      const mango = r.mangoTicket
        ? `<span class="die-mango" title="Mango ticket">🥭 ${escapeHtml(r.mangoTicket)}</span>`
        : r.status !== 'done'
          ? `<button class="die-mango-link" data-die-mango="${r.id}" title="Attach the Mango ticket id once it exists there">+ Mango #</button>`
          : '';
      const when = r.createdAt ? r.createdAt.slice(0, 10) : '';
      const closed = r.closedAt ? ` · closed ${escapeHtml(r.closedAt.slice(0, 10))}` : '';
      return `<div class="die-req st-${r.status} pr-${r.priority}">
        <div class="die-req-hd">
          <b class="die-req-die">${escapeHtml(r.dieNumber)}</b>
          <span class="die-req-type">${TYPE_LABELS[r.maintType]}</span>
          <span class="die-req-pr pr-${r.priority}">${PRIORITY_LABELS[r.priority]}</span>
          <span class="die-req-st">${STATUS_LABELS[r.status]}</span>
          ${mango}
          <span class="die-req-meta">${escapeHtml(when)}${closed}</span>
          ${advance}
        </div>
        <div class="die-req-bd">${escapeHtml(r.description || '—')}</div>
        <div class="die-req-ft">To <b>${escapeHtml(r.contact || '—')}</b> · from ${escapeHtml(
          r.requestedBy || '—',
        )}${r.machineCode ? ` · on ${escapeHtml(r.machineCode)}` : ''}${
          r.jobNumber ? ` · job ${escapeHtml(r.jobNumber)}` : ''
        }</div>
      </div>`;
    })
    .join('');
  return `<div class="die-req-section"><h3>🛠 Maintenance Requests</h3>${rows}</div>`;
}

// ---------------------------------------------------------------------
// die detail popup

function openDieDetail(dieNumber: string): void {
  const d = S!.dies.find((x) => x.dieNumber === dieNumber);
  if (!d) return;
  const maxQty = d.rejByCode[0]?.qty ?? 0;
  const bars = d.rejByCode.length
    ? d.rejByCode
        .map(
          (x) => `<div class="die-bar-row">
            <span class="die-bar-code">${escapeHtml(x.code)}</span>
            <span class="die-bar-label">${escapeHtml(rejLabel(x.code) || '—')}</span>
            <span class="die-bar-track"><i style="width:${maxQty ? Math.max(4, (x.qty / maxQty) * 100) : 0}%"></i></span>
            <b class="die-bar-qty">${x.qty}</b>
          </div>`,
        )
        .join('')
    : `<div class="trace-empty">No rejects recorded for this die in the window. 🎉</div>`;
  const parts = d.parts
    .map(
      (p) =>
        `<li>${escapeHtml(p.partNumber)}${p.name ? ` — ${escapeHtml(p.name)}` : ''}${
          p.coRun ? ' <span class="trace-corun">⛓ Co-run</span>' : ''
        }</li>`,
    )
    .join('');
  const hist = S!.requests.filter((r) => r.dieNumber === dieNumber);
  const histHtml = hist.length
    ? hist
        .map(
          (r) =>
            `<li><span class="die-req-st st-${r.status}">${STATUS_LABELS[r.status]}</span> ${
              TYPE_LABELS[r.maintType]
            } · ${escapeHtml(r.createdAt.slice(0, 10))} — ${escapeHtml(r.description)}${
              r.mangoTicket ? ` (🥭 ${escapeHtml(r.mangoTicket)})` : ''
            }</li>`,
        )
        .join('')
    : '<li>No maintenance history.</li>';
  const health = dieHealth(d.rejectPct);
  openModal(`<div class="die-detail">
    <div class="kpi-trace-head">
      <h3>🛠 ${escapeHtml(d.dieNumber)} <span class="die-detail-sub">${escapeHtml(
        d.category || '',
      )} · ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}</span></h3>
      <button class="btn-ghost-big" data-mod="close">Close</button>
    </div>
    <div class="die-detail-stats">
      <span>Runs <b>${d.runs}</b></span>
      <span>Shots <b>${d.shots.toLocaleString()}</b></span>
      <span>Pieces <b>${d.pieces.toLocaleString()}</b></span>
      <span class="g">Good <b>${d.good.toLocaleString()}</b></span>
      <span class="r">Reject <b>${d.rejects.toLocaleString()}</b></span>
      <span class="${health}">Rej % <b>${d.rejectPct == null ? '—' : d.rejectPct + '%'}</b></span>
      <span>Machines <b>${escapeHtml(d.machines.join(', ') || '—')}</b></span>
      <span>Last run <b>${escapeHtml(d.lastRun || '—')}</b></span>
    </div>
    <h4>Defects (${escapeHtml(S!.from)} → ${escapeHtml(S!.to)})</h4>
    ${bars}
    <h4>Parts on this die</h4>
    <ul class="die-detail-parts">${parts}</ul>
    <h4>Maintenance history</h4>
    <ul class="die-detail-hist">${histHtml}</ul>
    <div class="bd-actions">
      <button class="btn-primary-big" data-die-detail-req="${escapeHtml(d.dieNumber)}">📝 New Maintenance Request</button>
    </div>
  </div>`);
  const mc = document.getElementById('mc')!;
  mc.querySelector('[data-mod="close"]')?.addEventListener('click', () => closeModal());
  mc.querySelector<HTMLButtonElement>('[data-die-detail-req]')?.addEventListener('click', () => {
    closeModal();
    openRequestForm(dieNumber);
  });
}

// ---------------------------------------------------------------------
// maintenance request form

function openRequestForm(dieNumber?: string): void {
  const dieOpts = S!.dies
    .map(
      (d) =>
        `<option value="${escapeHtml(d.dieNumber)}"${
          d.dieNumber === dieNumber ? ' selected' : ''
        }>${escapeHtml(d.dieNumber)}${d.category ? ` — ${escapeHtml(d.category)}` : ''}</option>`,
    )
    .join('');
  const contactOpts = MAINTENANCE_CONTACTS.map(
    (c) =>
      `<option value="${escapeHtml(c.name)}">${escapeHtml(c.role)} — ${escapeHtml(c.name)}${
        c.phone ? ` (${escapeHtml(c.phone)})` : ''
      }</option>`,
  ).join('');
  const byOpts = S!.supervisors
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
    .join('');
  const machineOpts = Array.from(new Set(S!.dies.flatMap((d) => d.machines)))
    .sort()
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join('');
  openModal(`<div class="die-req-form">
    <div class="kpi-trace-head">
      <h3>📝 Die Maintenance Request</h3>
      <button class="btn-ghost-big" data-mod="close">Close</button>
    </div>
    <label>Die<select data-rf="die">${dieOpts}</select></label>
    <div class="die-req-form-row">
      <label>Type<select data-rf="type">
        <option value="repair">🔧 Repair</option>
        <option value="cleaning">🧽 Cleaning</option>
        <option value="inspection">🔍 Inspection</option>
        <option value="other">📋 Other</option>
      </select></label>
      <label>Priority<select data-rf="priority">
        <option value="normal">Normal</option>
        <option value="low">Low</option>
        <option value="high">High</option>
        <option value="urgent">URGENT</option>
      </select></label>
      <label>Machine<select data-rf="machine"><option value="">—</option>${machineOpts}</select></label>
    </div>
    <label>Problem / work needed<textarea data-rf="desc" rows="3" placeholder="What's wrong, which cavity, what the parts look like…"></textarea></label>
    <div class="die-req-form-row">
      <label>Contact (to)<select data-rf="contact">${contactOpts}</select></label>
      <label>Requested by<select data-rf="by"><option value="">— name —</option>${byOpts}</select></label>
    </div>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-mod="close2">Cancel</button>
      <button class="btn-primary-big" data-rf-save>Send Request</button>
    </div>
  </div>`);
  const mc = document.getElementById('mc')!;
  const val = (k: string): string =>
    (mc.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[data-rf="${k}"]`,
    )?.value ?? '').trim();
  mc.querySelectorAll('[data-mod="close"],[data-mod="close2"]').forEach((b) =>
    b.addEventListener('click', () => closeModal()),
  );
  mc.querySelector<HTMLButtonElement>('[data-rf-save]')?.addEventListener('click', () => {
    void (async () => {
      const die = val('die');
      const desc = val('desc');
      const by = val('by');
      if (!die) return toast('Pick a die', 'err');
      if (!desc) return toast('Describe the problem / work needed', 'err');
      if (!by) return toast('Pick who is requesting', 'err');
      if (!dalRef.createDieMaintenance) return toast('This backend cannot save requests', 'err');
      const btn = mc.querySelector<HTMLButtonElement>('[data-rf-save]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving…';
      }
      try {
        const created = await dalRef.createDieMaintenance({
          dieNumber: die,
          status: 'open',
          maintType: (val('type') || 'repair') as MaintType,
          priority: (val('priority') || 'normal') as MaintPriority,
          description: desc,
          contact: val('contact'),
          requestedBy: by,
          machineCode: val('machine'),
          jobNumber: '',
          mangoTicket: '',
        });
        S!.requests.unshift(created);
        // Re-aggregate so the die's 🛠 badge updates immediately.
        for (const d of S!.dies)
          if (d.dieNumber === die)
            d.openRequests = S!.requests.filter(
              (q) => q.dieNumber === die && q.status !== 'done',
            ).length;
        closeModal();
        toast(`Request sent to ${created.contact || 'maintenance'}`, 'ok');
        render();
      } catch (e) {
        console.error('[pmd] die maintenance save failed:', e);
        toast(`Could not save: ${e instanceof Error ? e.message : e}`, 'err');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Send Request';
        }
      }
    })();
  });
}

async function advanceRequest(id: number, next: MaintStatus): Promise<void> {
  if (!dalRef.updateDieMaintenance) return;
  const req = S!.requests.find((r) => r.id === id);
  if (!req) return;
  const patch: { status: MaintStatus; closedAt?: string } = { status: next };
  if (next === 'done') patch.closedAt = new Date().toISOString();
  try {
    await dalRef.updateDieMaintenance(id, patch);
    req.status = next;
    if (patch.closedAt) req.closedAt = patch.closedAt;
    for (const d of S!.dies)
      if (d.dieNumber === req.dieNumber)
        d.openRequests = S!.requests.filter(
          (q) => q.dieNumber === d.dieNumber && q.status !== 'done',
        ).length;
    toast(next === 'done' ? 'Request completed' : 'Request started', 'ok');
    render();
  } catch (e) {
    console.error('[pmd] die maintenance update failed:', e);
    toast(`Could not update: ${e instanceof Error ? e.message : e}`, 'err');
  }
}

function attachMango(id: number): void {
  const ticket = window.prompt('Mango ticket id (e.g. MAN-31234):', '');
  if (ticket == null) return;
  void (async () => {
    try {
      await dalRef.updateDieMaintenance?.(id, { mangoTicket: ticket.trim() });
      const req = S!.requests.find((r) => r.id === id);
      if (req) req.mangoTicket = ticket.trim();
      render();
    } catch (e) {
      toast(`Could not update: ${e instanceof Error ? e.message : e}`, 'err');
    }
  })();
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
  h.querySelector('[data-die-new-req]')?.addEventListener('click', () => openRequestForm());
  h.querySelectorAll<HTMLButtonElement>('[data-die-detail]').forEach((b) =>
    b.addEventListener('click', () => openDieDetail(b.dataset.dieDetail!)),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-die-req]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openRequestForm(b.dataset.dieReq!);
    }),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-die-adv]').forEach((b) =>
    b.addEventListener('click', () =>
      void advanceRequest(Number(b.dataset.dieAdv), b.dataset.next as MaintStatus),
    ),
  );
  h.querySelectorAll<HTMLButtonElement>('[data-die-mango]').forEach((b) =>
    b.addEventListener('click', () => attachMango(Number(b.dataset.dieMango))),
  );
}
